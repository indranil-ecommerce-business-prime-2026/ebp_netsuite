import { Request, Response } from "express";
import { getDb } from "../config/mongdodb.config";
import { callDiagnostic } from "../services/netsuite.client";
import log from "../config/logger.config";

/**
 * GET /netsuite-items-full?pageSize=2000
 * GET /netsuite-items-full?pageSize=2000&mode=fast   → SuiteQL (default)
 * GET /netsuite-items-full?pageSize=500&mode=search  → N/search fallback
 *
 * Phase 1: Fetches ALL items from NetSuite → netsuite.netsuite_items_full.
 *          Builds _class object { id, text, l1, l2, l3 } from class hierarchy.
 *
 * Default mode=fast uses SuiteQL (up to 5000/page, faster pagination).
 * Falls back to N/search mode if SuiteQL fails on first page.
 */
export const syncNetsuiteItemsFull = async (req: Request, res: Response) => {
    const mode = (req.query.mode as string) || "fast";
    const maxPageSize = mode === "fast" ? 5000 : 1000;
    const defaultPageSize = mode === "fast" ? 4000 : 500;
    const pageSize = Math.min(Number(req.query.pageSize) || defaultPageSize, maxPageSize);

    try {
        const result = await runItemFullSync(pageSize, mode);
        return res.json(result);
    } catch (err: any) {
        log.error("[ITEM-FULL] Error:", err);
        return res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
};

// ── Shared concurrency helper ─────────────────────────────────────────────
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

/**
 * Phase 1 core — callable from both endpoint and cron.
 * mode = "fast"   → SuiteQL via fetch_items_fast (up to 5000/page, OFFSET pagination)
 * mode = "search" → N/search via fetch_all_items_full (up to 1000/page, runPaged)
 *
 * If "fast" fails on page 0, automatically retries with "search" mode.
 *
 * Performance (96k items):
 *   pageSize=4000 + 3 parallel workers → ~24 pages / 3 = ~8 rounds ≈ 35s
 *   vs old serial 2000/page → 48 pages × 4s ≈ 3-4 min
 *
 * Governance: 20 units/call (0.4% of 5,000 limit). Safe for parallel.
 * pageSize capped at 4000 to stay within ~7 MB response payload (limit ~10-15 MB).
 */
const PARALLEL_PAGE_FETCHES = 3;

export async function runItemFullSync(pageSize = 4000, mode = "fast") {
    const nsDb = await getDb("netsuite");
    const col = nsDb.collection("netsuite_items_full");

    await col.createIndex({ itemid: 1 }, { unique: true });
    await col.createIndex({ internalid: 1 });

    const section = mode === "fast" ? "fetch_items_fast" : "fetch_all_items_full";
    const label = mode === "fast" ? "ITEM-FAST" : "ITEM-FULL";

    const PAGE_MAX_RETRIES = 3;

    // ── Incremental: check last sync metadata ──
    const metaCol = nsDb.collection("sync_metadata");
    const lastRun = await metaCol.findOne({ _id: "item_full_sync" } as any);

    // Incremental: only fetch items modified since last completed sync
    // First run (no completedAt) = full sync. Subsequent runs = incremental.
    // Safety: verify DB count is at least 80% of last known total before going incremental.
    let modifiedSince: string | undefined;
    if (lastRun?.completedAt && mode === "fast") {
        const dbCount = await col.countDocuments();
        const lastTotal = lastRun?.total || 0;
        if (lastTotal > 0 && dbCount < lastTotal * 0.8) {
            log.warn(`[${label}] DB has ${dbCount} items but last sync reported ${lastTotal} — forcing full sync`);
            await metaCol.updateOne(
                { _id: "item_full_sync" } as any,
                { $set: { lastCompletedPage: null, completedAt: null } },
                { upsert: true }
            );
        } else {
            const d = new Date(lastRun.completedAt);
            modifiedSince = d.toISOString().replace("T", " ").substring(0, 19);
            log.info(`[${label}] Incremental sync — only items modified since ${modifiedSince} (DB: ${dbCount}, last total: ${lastTotal})`);
        }
    }

    let totalInserted = 0;
    let totalUpdated = 0;
    let totalPulled = 0;
    let failedPages: number[] = [];

    // ── Step 1: Fetch page 0 to get total count + handle fallback ──
    log.info(`[${label}] Fetching page 0 (pageSize: ${pageSize})...`);
    const page0Result = await fetchOnePage(section, label, mode, 0, pageSize, modifiedSince, PAGE_MAX_RETRIES);

    if (page0Result.fallback) {
        return runItemFullSync(Math.min(pageSize, 1000), "search");
    }

    if (!page0Result.success) {
        log.error(`[${label}] Page 0 failed — aborting sync`);
        return { success: false, mode, totalPulled: 0, inserted: 0, updated: 0, pages: 0 };
    }

    const batch0 = page0Result.batch;
    const items0: any[] = batch0.items || [];
    totalPulled += items0.length;

    if (items0.length > 0) {
        const r = await upsertItems(col, items0);
        totalInserted += r.inserted;
        totalUpdated += r.updated;
    }

    if (batch0.skippedFields?.length > 0) {
        log.warn(`[${label}] Skipped fields: ${batch0.skippedFields.join(", ")}`);
    }

    const totalItems = batch0.total || items0.length;
    const totalPages = Math.ceil(totalItems / pageSize);
    log.info(`[${label}] Page 0: ${items0.length} items. Total: ${totalItems} items across ${totalPages} pages`);

    // ── Step 2: Fetch remaining pages in parallel ──
    if (totalPages > 1 && !batch0.done && items0.length > 0) {
        const pageTasks: (() => Promise<void>)[] = [];

        for (let p = 1; p < totalPages; p++) {
            const pageNum = p;
            pageTasks.push(async () => {
                const result = await fetchOnePage(section, label, mode, pageNum, pageSize, modifiedSince, PAGE_MAX_RETRIES);

                if (!result.success) {
                    failedPages.push(pageNum);
                    log.warn(`[${label}] Page ${pageNum} failed after ${PAGE_MAX_RETRIES} retries`);
                    return;
                }

                const items: any[] = result.batch.items || [];
                totalPulled += items.length;

                if (items.length > 0) {
                    const r = await upsertItems(col, items);
                    totalInserted += r.inserted;
                    totalUpdated += r.updated;
                }

                log.info(`[${label}] Page ${pageNum}: ${items.length} items (running total: ${totalPulled}/${totalItems})`);
            });
        }

        log.info(`[${label}] Fetching ${pageTasks.length} remaining pages (${PARALLEL_PAGE_FETCHES} parallel workers)...`);
        await runWithConcurrency(pageTasks, PARALLEL_PAGE_FETCHES);
    }

    // ── Step 3: Retry failed pages once more ──
    if (failedPages.length > 0) {
        log.info(`[${label}] Retrying ${failedPages.length} failed pages: [${failedPages.join(", ")}]`);
        const stillFailed: number[] = [];

        for (const fp of failedPages) {
            const retryResult = await fetchOnePage(section, label, mode, fp, pageSize, modifiedSince, PAGE_MAX_RETRIES);

            if (!retryResult.success || retryResult.fallback) {
                stillFailed.push(fp);
                continue;
            }

            const items: any[] = retryResult.batch.items || [];
            totalPulled += items.length;

            if (items.length > 0) {
                const r = await upsertItems(col, items);
                totalInserted += r.inserted;
                totalUpdated += r.updated;
            }

            log.info(`[${label}] Retry page ${fp}: ${items.length} items recovered`);
        }

        failedPages = stillFailed;
        if (failedPages.length > 0) {
            log.warn(`[${label}] ${failedPages.length} pages still failed after retry: [${failedPages.join(", ")}]`);
        }
    }

    // ── Save completion metadata ──
    await metaCol.updateOne(
        { _id: "item_full_sync" } as any,
        { $set: { lastCompletedPage: null, completedAt: new Date(), total: totalItems, totalPulled, failedPages, pageSize } },
        { upsert: true }
    );

    log.info(`[${label}] Done. Pulled: ${totalPulled}, inserted: ${totalInserted}, updated: ${totalUpdated}, failed pages: ${failedPages.length > 0 ? failedPages.join(",") : "none"}`);

    return {
        success: true,
        mode,
        incremental: !!modifiedSince,
        modifiedSince: modifiedSince || null,
        totalPulled,
        inserted: totalInserted,
        updated: totalUpdated,
        pages: totalPages,
        failedPages: failedPages.length > 0 ? failedPages : undefined,
    };
}

// ── Helper: fetch one page from NetSuite with retries ─────────────────────
async function fetchOnePage(
    section: string,
    label: string,
    mode: string,
    page: number,
    pageSize: number,
    modifiedSince: string | undefined,
    maxRetries: number
): Promise<{ success: boolean; fallback?: boolean; batch?: any }> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const payload: any = { sections: [section], page, pageSize };
            if (modifiedSince && mode === "fast") {
                payload.modifiedSince = modifiedSince;
            }

            const response = await callDiagnostic(payload);
            const batch = response?.[section];

            if (!batch || batch.error) {
                const errMsg = batch?.error || "RESTlet returned no data";
                log.warn(`[${label}] Page ${page} attempt ${attempt}/${maxRetries} failed: ${errMsg}`);

                // SuiteQL failed on first page → fallback to N/search
                if (mode === "fast" && page === 0 && attempt === maxRetries) {
                    log.warn(`[${label}] SuiteQL failed on page 0 after ${maxRetries} attempts — falling back to N/search`);
                    return { success: false, fallback: true };
                }
                continue;
            }

            return { success: true, batch };
        } catch (err: any) {
            log.warn(`[${label}] Page ${page} attempt ${attempt}/${maxRetries} error: ${err.message}`);

            if (mode === "fast" && page === 0 && attempt === maxRetries) {
                log.warn(`[${label}] SuiteQL failed on page 0 after ${maxRetries} attempts — falling back to N/search`);
                return { success: false, fallback: true };
            }
        }
    }

    return { success: false };
}

// ── Helper: upsert items into MongoDB via bulkWrite ───────────────────────
async function upsertItems(col: any, items: any[]): Promise<{ inserted: number; updated: number }> {
    const ops = items
        .filter((item: any) => item.itemid)
        .map((item: any) => ({
            updateOne: {
                filter: { itemid: item.itemid },
                update: {
                    $set: { ...item, _synced_at: new Date() },
                    $setOnInsert: { _created_at: new Date() },
                },
                upsert: true,
            },
        }));

    if (ops.length === 0) return { inserted: 0, updated: 0 };

    const result: any = await col.bulkWrite(ops, { ordered: false });
    return {
        inserted: result.upsertedCount ?? 0,
        updated: result.modifiedCount ?? 0,
    };
}

/**
 * Phase 2: Fetch Location + Vendor sublists for all inventory items
 * in netsuite_items_full that don't yet have _sublists_at (or are stale).
 *
 * Called by hourly cron. Uses record.load (5 governance units each when
 * item type is passed — avoids try/catch fallback waste).
 *
 * Batch size 500 = ~2,500 governance units/call (50% of 5,000 limit).
 * 3 parallel workers = ~3x throughput.
 */
const SUBLISTS_BATCH_SIZE = 500;
const PARALLEL_RESTLET_CALLS = 3;

export async function runItemSublistsSync(batchSize = SUBLISTS_BATCH_SIZE) {
    const nsDb = await getDb("netsuite");
    const col = nsDb.collection("netsuite_items_full");

    // If collection is empty, run Phase 1 first to populate items
    const docCount = await col.countDocuments();
    if (docCount === 0) {
        log.info("[ITEM-SUBLISTS] Collection empty — running Phase 1 (item full sync) first...");
        await runItemFullSync();
    }

    // Find inventory items that need sublists updated
    // Items without _sublists_at, or where _sublists_at is older than 1 hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const itemsDocs = await col.find(
        {
            type: { $in: ["InvtPart", "SerializedInventoryItem"] },
            internalid: { $ne: null },
            $or: [
                { _sublists_at: { $exists: false } },
                { _sublists_at: { $lt: oneHourAgo } },
            ],
        },
        { projection: { internalid: 1, type: 1 } }
    ).toArray();

    // Build ID list + type map for direct record.load (no try/catch waste)
    const allItems = itemsDocs
        .map((d: any) => ({ id: Number(d.internalid), type: d.type as string }))
        .filter((item) => item.id > 0);

    if (allItems.length === 0) {
        log.info("[ITEM-SUBLISTS] No items need sublist update.");
        return { success: true, updated: 0, total: 0 };
    }

    log.info(`[ITEM-SUBLISTS] Fetching sublists for ${allItems.length} inventory items (batch: ${batchSize}, parallel: ${PARALLEL_RESTLET_CALLS})...`);

    let sublistsUpdated = 0;
    let batchErrors = 0;

    // Build batch tasks
    const tasks: (() => Promise<void>)[] = [];
    for (let i = 0; i < allItems.length; i += batchSize) {
        const batchItems = allItems.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;

        const batchIds = batchItems.map((item) => item.id);
        const itemTypes: Record<string, string> = {};
        for (const item of batchItems) {
            itemTypes[String(item.id)] = item.type;
        }

        tasks.push(async () => {
            log.info(`[ITEM-SUBLISTS] Batch ${batchNum}: ${batchIds.length} items...`);
            try {
                const slResponse = await callDiagnostic({
                    sections: ["fetch_item_sublists"],
                    itemIds: batchIds,
                    itemTypes,
                });

                const slBatch = slResponse?.fetch_item_sublists;
                if (slBatch && slBatch.items) {
                    const ops = slBatch.items
                        .filter((slItem: any) => !slItem.error)
                        .map((slItem: any) => ({
                            updateOne: {
                                filter: { internalid: String(slItem.internalid) },
                                update: {
                                    $set: {
                                        _locations: slItem.locations,
                                        _vendors: slItem.vendors,
                                        _sublists_at: new Date(),
                                    },
                                },
                            },
                        }));

                    if (ops.length > 0) {
                        const bulkResult: any = await col.bulkWrite(ops, { ordered: false });
                        sublistsUpdated += bulkResult.modifiedCount + bulkResult.upsertedCount;
                    }
                }
            } catch (slErr: any) {
                log.error(`[ITEM-SUBLISTS] Batch ${batchNum} error:`, slErr.message);
                batchErrors++;
            }
        });
    }

    // Run batches with concurrency limit
    await runWithConcurrency(tasks, PARALLEL_RESTLET_CALLS);

    log.info(`[ITEM-SUBLISTS] Done. Updated: ${sublistsUpdated}/${allItems.length}, batch errors: ${batchErrors}`);

    return {
        success: true,
        updated: sublistsUpdated,
        total: allItems.length,
        batchErrors,
    };
}
