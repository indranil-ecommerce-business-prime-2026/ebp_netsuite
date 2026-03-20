# Optimization Plan: Item Sublists Sync

## Context

`runItemSublistsSync` (hourly cron, currently disabled) syncs location/vendor sublist data for inventory items. It batches 50 items per RESTlet call — for 5,000 items that's **100 sequential HTTP round-trips** with OAuth overhead. This is the real bottleneck.

`runItemFullSync` (SuiteQL pagination) already works well at 2-3 RESTlet calls total — **not worth the M/R complexity** for marginal gain.

**This plan has two phases:**
- **Phase 1 (Quick Win):** Parallelize existing RESTlet calls in Node.js — immediate 3-5x speedup, zero NetSuite changes
- **Phase 2 (Full Optimization):** Map/Reduce for sublists — eliminates HTTP round-trips entirely

---

## Phase 1: Node.js Parallel RESTlet Calls (Quick Win)

**No NetSuite changes required.** Only modify `netsuite/controller/netsuite_item_full.ts`.

### Current problem (lines 189-221)
```typescript
// Sequential — one batch at a time
for (let i = 0; i < allIds.length; i += batchSize) {
    const slResponse = await callDiagnostic({ ... }); // blocks
}
```

### Fix: Add concurrency-limited parallelism
Replace sequential loop with a pool of N concurrent calls (N=3-5, respecting NetSuite concurrency limits):

```typescript
async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
    const results: T[] = [];
    let index = 0;
    async function worker() {
        while (index < tasks.length) {
            const i = index++;
            results[i] = await tasks[i]();
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
    return results;
}
```

Use `PARALLEL_RESTLET_CALLS = 3` (configurable in `sync.config.ts`).

**Impact:** 100 serial calls at ~3s each = ~300s. With 3 parallel = ~100s. **3x speedup, zero risk.**

### Files to modify
- [netsuite_item_full.ts](netsuite/controller/netsuite_item_full.ts) — replace sequential loop with concurrent pool
- [sync.config.ts](netsuite/config/sync.config.ts) — add `PARALLEL_RESTLET_CALLS` config

---

## Phase 2: Map/Reduce for Item Sublists

### Files to Create

#### 1. `suitescript/ebp_item_sublists_mr.js` (NEW)

Replaces `fetch_item_sublists` RESTlet section + `runItemSublistsSync` batching.

**getInputData (10,000 unit limit):**
- `search.create()` for all active `InvtPart` + `SerializedInventoryItem` (~10 units)
- Returns search object — NetSuite auto-paginates internally, no memory concern

**map(context) (1,000 unit limit per invocation):**
- Parse `context.value` to get `id` and `type` from search result
- Use the `type` field directly to pick the correct record type (no try/catch fallback waste):
  ```javascript
  var recType = (itemType === "SerializedInventoryItem")
      ? record.Type.SERIALIZED_INVENTORY_ITEM
      : record.Type.INVENTORY_ITEM;
  var rec = record.load({ type: recType, id: itemId, isDynamic: false });
  ```
- Read locations sublist (11 fields) + vendors sublist (4 fields) — all free (in-memory)
- `context.write({ key: itemId, value: JSON.stringify(sublistData) })`
- **Cost: 5 units per invocation** (1 record.load). 999 units headroom.

**NO reduce stage** — omit entirely. Map output flows directly to summarize. Avoids unnecessary stage transition overhead.

**summarize (10,000 unit limit):**
- Stream-write chunked files to avoid memory explosion:
  ```javascript
  var chunk = [];
  var chunkIndex = 0;
  var chunkSize = 0;
  var MAX_CHUNK_BYTES = 8 * 1024 * 1024; // 8MB safety margin (limit is 10MB)
  var fileIds = [];

  summary.output.iterator().each(function (key, value) {
      var itemJson = value; // already a JSON string from map()
      var entrySize = itemJson.length + 2; // +2 for comma + newline

      // If adding this entry would exceed chunk limit, flush
      if (chunkSize + entrySize > MAX_CHUNK_BYTES && chunk.length > 0) {
          fileIds.push(flushChunk(chunk, chunkIndex, runId));
          chunk = [];
          chunkSize = 0;
          chunkIndex++;
      }
      chunk.push(itemJson);
      chunkSize += entrySize;
      return true;
  });
  // Flush remaining
  if (chunk.length > 0) {
      fileIds.push(flushChunk(chunk, chunkIndex, runId));
  }

  // Write manifest file listing all chunks
  var manifest = file.create({
      name: "manifest_" + runId + ".json",
      fileType: file.Type.JSON,
      contents: JSON.stringify({
          runId: runId, timestamp: new Date().toISOString(),
          chunks: fileIds, totalItems: successCount + errorCount,
          success: successCount, errors: errorCount
      }),
      folder: folderId
  });
  manifest.save();
  ```
- **Cleanup:** Delete result files older than 24 hours from the folder:
  ```javascript
  var oldFiles = search.create({
      type: "file",
      filters: [["folder", "is", folderId], "AND",
                ["created", "before", "hoursago24"]],
      columns: ["internalid"]
  }).run().getRange({ start: 0, end: 100 });
  oldFiles.forEach(function (f) { file.delete({ id: f.id }); });
  ```

**Script parameter:** `custscript_ebp_mr_run_id` (Free-Form Text) — unique ID per trigger, used in filenames

---

#### 2. `netsuite/controller/netsuite_item_mr.ts` (NEW)

Trigger → poll → fetch pattern:

- `triggerMapReduce(scriptId, runId)` — calls diagnostic RESTlet `trigger_mr` section
- `pollUntilComplete(taskId)` — **exponential backoff**: 5s, 10s, 20s, 40s, 60s, then 60s (not fixed 30s)
- `fetchMRResults(runId)` — fetches manifest, then fetches each chunk file
- `runItemSublistsMR()` — orchestrator: trigger → poll → fetch chunks → upsert to MongoDB
- Express handler: `syncItemSublistsMR`

```typescript
// Exponential backoff polling
const BACKOFF_SCHEDULE = [5000, 10000, 20000, 40000, 60000]; // then 60s repeating
const MAX_POLL_ATTEMPTS = 40; // ~30 min max

async function pollUntilComplete(taskId: string): Promise<string> {
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
        const delay = i < BACKOFF_SCHEDULE.length
            ? BACKOFF_SCHEDULE[i]
            : BACKOFF_SCHEDULE[BACKOFF_SCHEDULE.length - 1];
        await sleep(delay);

        const response = await callDiagnostic({
            sections: ["check_mr_status"],
            taskId,
        });
        const status = response?.check_mr_status;
        console.log(`[MR-POLL] ${taskId}: ${status?.status} (stage: ${status?.stage})`);

        if (status?.status === "COMPLETE") return "COMPLETE";
        if (status?.status === "FAILED") throw new Error(`M/R task failed: ${taskId}`);
    }
    throw new Error("M/R task timed out");
}
```

---

### Files to Modify

#### 3. `suitescript/diagnostic_restlet.js`
**Only additive changes — no existing logic touched:**

- Line 41: Add `"N/task"`, `"N/file"` to AMD `define()` dependencies
- Add 3 new sections before `return result`:

**`trigger_mr`** — with `MAP_REDUCE_ALREADY_RUNNING` handling:
```javascript
if (sections.indexOf("trigger_mr") >= 0) {
    try {
        var mrTask = task.create({
            taskType: task.TaskType.MAP_REDUCE,
            scriptId: payload.mrScript,
            deploymentId: payload.mrDeploy || null,
            params: payload.mrParams || {}
        });
        var taskId = mrTask.submit();
        result.trigger_mr = { success: true, taskId: taskId };
    } catch (e) {
        // Handle "already running" gracefully instead of cryptic error
        if (e.name === "MAP_REDUCE_ALREADY_RUNNING"
            || (e.message && e.message.indexOf("already") >= 0)) {
            result.trigger_mr = {
                success: false,
                alreadyRunning: true,
                message: "A Map/Reduce job for this script is already running."
            };
        } else {
            result.trigger_mr = { error: e.message };
        }
    }
}
```

**`check_mr_status`** — status without unreliable percentComplete:
```javascript
if (sections.indexOf("check_mr_status") >= 0) {
    try {
        var taskStatus = task.checkStatus({ taskId: payload.taskId });
        result.check_mr_status = {
            taskId: payload.taskId,
            status: taskStatus.status,  // PENDING, PROCESSING, COMPLETE, FAILED
            stage: taskStatus.stage || null
        };
    } catch (e) {
        result.check_mr_status = { error: e.message };
    }
}
```

**`fetch_mr_result`** — fetch by file ID (not fragile path):
```javascript
if (sections.indexOf("fetch_mr_result") >= 0) {
    try {
        var mrFile = file.load({ id: parseInt(payload.fileId, 10) });
        result.fetch_mr_result = JSON.parse(mrFile.getContents());
    } catch (e) {
        result.fetch_mr_result = { error: e.message };
    }
}
```

**`list_mr_files`** — find result files by runId:
```javascript
if (sections.indexOf("list_mr_files") >= 0) {
    try {
        var folderId = parseInt(payload.folderId, 10);
        var prefix = payload.prefix || "";  // e.g. "manifest_" + runId
        var files = search.create({
            type: "file",
            filters: [["folder", "is", folderId], "AND",
                      ["name", "startswith", prefix]],
            columns: ["name", "internalid", "created"]
        }).run().getRange({ start: 0, end: 50 });
        result.list_mr_files = files.map(function (f) {
            return { id: f.getValue("internalid"), name: f.getValue("name"),
                     created: f.getValue("created") };
        });
    } catch (e) {
        result.list_mr_files = { error: e.message };
    }
}
```

#### 4. `netsuite/server.ts`
- Add import for `netsuite_item_mr.ts` controller
- Add route: `GET /netsuite-sublists-mr → syncItemSublistsMR`
- Add commented-out M/R cron job alongside existing one

#### 5. `netsuite/config/sync.config.ts`
```typescript
// Phase 1: Parallel RESTlet calls
export const PARALLEL_RESTLET_CALLS = 3;

// Phase 2: Map/Reduce toggle
export const ITEM_SUBLISTS_MODE: "restlet" | "map_reduce" = "restlet"; // flip after testing
```

#### 6. `.env.example`
```
# Map/Reduce (Phase 2)
MR_ITEM_SUBLISTS_SCRIPT_ID=customscript_ebp_item_sublists_mr
MR_RESULTS_FOLDER_ID=
```

---

## Governance Math

### Phase 1 (Parallel RESTlet — unchanged per-call cost)
| Metric | Serial (current) | Parallel (3 workers) |
|---|:---:|:---:|
| RESTlet calls | 100 | 100 |
| Units per call | 250-500 | 250-500 |
| Wall time (~3s/call) | ~300s | **~100s** |

### Phase 2 (Map/Reduce)
| Stage | Units Used | Hard Limit | Notes |
|---|:---:|:---:|---|
| getInputData | ~10 | 10,000 | 1 search, auto-paginated |
| map (per item) | 5 | 1,000 | 1 record.load, type known upfront |
| map (5000 items job-total) | ~25,000 | yields at 10,000 | Auto-reschedules ~3x |
| summarize | ~40 | 10,000 | file.create x chunks + cleanup |
| Trigger RESTlet | ~10 | 5,000 | task.create |
| Poll RESTlet (x10) | ~100 total | 5,000 each | exponential backoff |
| Fetch RESTlet (x chunks) | ~10 each | 5,000 each | file.load per chunk |

**Total Node.js → NetSuite HTTP calls: ~15** (1 trigger + ~10 polls + ~3 chunk fetches) vs current 100.

---

## NetSuite Manual Setup (Phase 2 only)

1. **File Cabinet:** Create `SuiteScripts/EBP/mr_results/` folder, note internal ID → set as `MR_RESULTS_FOLDER_ID`
2. **Deploy `ebp_item_sublists_mr.js`:**
   - Script Type: Map/Reduce
   - Script ID: `customscript_ebp_item_sublists_mr`
   - Deployment ID: `customdeploy_ebp_item_sublists_mr`
   - Status: Released, **NOT scheduled** (triggered on-demand via task.create)
   - Concurrency: 1
   - Add script parameter: `custscript_ebp_mr_run_id` (Free-Form Text)
3. **Update diagnostic RESTlet:** Upload with `N/task` + `N/file` deps and 4 new sections

---

## Implementation Order

### Phase 1 (Quick Win — do first)
1. Add `PARALLEL_RESTLET_CALLS` to [sync.config.ts](netsuite/config/sync.config.ts)
2. Add `runWithConcurrency` helper to [netsuite_item_full.ts](netsuite/controller/netsuite_item_full.ts)
3. Replace sequential loop in `runItemSublistsSync` with parallel batching
4. Test: `GET /netsuite-items-full?sublists=true` — should be ~3x faster

### Phase 2 (Map/Reduce — after Phase 1 validated)
1. Create `suitescript/ebp_item_sublists_mr.js`
2. Add 4 sections to `suitescript/diagnostic_restlet.js` (trigger_mr, check_mr_status, fetch_mr_result, list_mr_files)
3. Create `netsuite/controller/netsuite_item_mr.ts`
4. Add route + config to `server.ts`, `sync.config.ts`, `.env.example`
5. Deploy M/R + updated RESTlet to Sandbox
6. Test: `GET /netsuite-sublists-mr` — compare output with RESTlet version
7. Set `ITEM_SUBLISTS_MODE = "map_reduce"` once validated

---

## Key Design Decisions (from critical review)

| Issue | Decision | Reason |
|---|---|---|
| Skip Item Full Sync M/R | Yes — only build sublists M/R | Current SuiteQL pagination (2-3 calls) is fast enough; M/R adds queue wait + complexity for marginal gain |
| No reduce() stage | Omit entirely | Pass-through reduce wastes a stage transition; map() output goes straight to summarize() |
| Use item type from search | Map directly to record type | Avoids wasted 5-unit record.load from try/catch fallback |
| Chunked file writes in summarize | 8MB chunks | Avoids both memory explosion and 10MB File Cabinet limit |
| Fetch files by ID not path | Use manifest + file IDs | Path-based file.load is fragile across environments |
| Handle MAP_REDUCE_ALREADY_RUNNING | Return `{ alreadyRunning: true }` | Prevents cryptic errors when cron fires during existing run |
| Exponential backoff polling | 5s→10s→20s→40s→60s | Reduces HTTP overhead vs fixed 30s intervals |
| Cleanup old result files | In summarize(), delete files >24h old | Prevents File Cabinet bloat from accumulating runs |
| Drop getPercentageCompleted | Don't expose to Node.js | Unreliable — often 0 until job finishes, then jumps to 100 |

---

## Verification

### Phase 1
1. Run `GET /netsuite-items-full?sublists=true` — observe parallel log lines
2. Compare MongoDB data before/after — should be identical
3. Measure wall time — expect ~3x reduction

### Phase 2
1. Deploy to Sandbox, trigger `GET /netsuite-sublists-mr`
2. Check NetSuite Script Execution Log: M/R status = COMPLETE
3. Check File Cabinet: `mr_results/` has manifest + chunk files
4. Check MongoDB: `netsuite_items_full` docs have `_locations`, `_vendors`, fresh `_sublists_at`
5. Compare output with Phase 1 RESTlet results — data should match
6. Log `runtime.getCurrentScript().getRemainingUsage()` at start/end of each M/R stage to verify governance math
