# Vendor Bill Pipeline — Implementation Plan

## Overview
Create a full bill sync pipeline: stage invoices from MongoDB, sync to NetSuite as Vendor Bills linked to Purchase Orders.

---

## Data Flow

```
ebp_pomanager.po_bills (source)
    |  bill.stage.ts (filter, validate, transform)
    v
netsuite.suite_vendor_bill (staging)
    |  bill.sync.ts (check PO synced, batch, parallel)
    v
vendor_bill_restlet.js (record.transform PO -> Bill)
    |
    v
NetSuite Vendor Bill (linked to PO via createdfrom)
    |
    v
PO Related Records tab shows Bill automatically (linktype: "Order Bill/Invoice")
```

## PO <-> Bill Relationship (Confirmed via XML + Research)

`record.transform` from PO -> Bill automatically:
- Sets `createdfrom` on the bill pointing to the source PO
- Bill appears in PO's **Related Records** sub-tab as `linktype: "Order Bill/Invoice"`
- No extra linking code needed — NetSuite handles this natively
- Verified via PO XML: `<tranid>PO228047-172247356</tranid>`, `<type>Bill</type>`
- One PO can have multiple bills (partial billing — transform only shows **unbilled** lines)
- After full billing: PO shows `ordbilled=T`, `needsbill=F`, lines show `quantitybilled == quantity`

### Partial Billing Flow
1. First transform: Bill A gets full unbilled qty (e.g., 60 units)
2. If Bill A only bills 30 → PO status = "Partially Billed"
3. Second transform: Bill B gets remaining 30 units
4. After Bill B → PO status = "Fully Billed", `isopen=F` on all lines

### Alternative: Standalone Bill with `orderdoc`/`orderline`
If `record.transform` fails (PO closed, Advanced Receiving, etc.), fallback:
```javascript
bill.setCurrentSublistValue({ sublistId: "item", fieldId: "orderdoc", value: poInternalId });
bill.setCurrentSublistValue({ sublistId: "item", fieldId: "orderline", value: poLineUniqueKey });
```
- Does NOT set `createdfrom` — uses line-level linking instead
- Can link lines from **multiple POs** on one bill
- NOT recommended as primary approach — use only as fallback

### Gotchas Specific to Bill Transform (from research)
1. **`defaultValues` restriction**: Cannot pass `trandate`, `duedate`, `location`, `subsidiary` etc. in `defaultValues` — throws `INVALID_RCRD_TRANSFRM`. Must set AFTER transform.
2. **Class auto-sourcing**: Same `INVALID_TRANS_SUB_CLASS` risk as POs — must clear `class` on lines + header, use `enableSourcing: false`.
3. **Fully billed PO**: Transform may succeed with 0 lines OR throw error — must handle both.
4. **Advanced Receiving**: If enabled, flow changes to PO → Item Receipt → Bill (not direct PO → Bill). Check if enabled in account.
5. **SuiteTax**: Tax lines from PO may not carry over correctly — monitor for total discrepancies.

---

## Files to Create

### 1. `netsuite/services/bill.stage.ts`

**Source:** `ebp_pomanager.po_bills`
**Destination:** `netsuite.suite_vendor_bill`

**Filter:**
```javascript
{
  invoiceType: { $in: ["Invoice", "Sales Order", "IN"] },
  invoiceDate: { $gte: "2026-01-01" }
}
```

**Staged Document Shape:**
```typescript
interface StagedBill {
  po_number:          number;       // from poNumber
  invoice_number:     string;       // from invoiceNumber
  reference_number:   string;       // "PO" + poNumber + "-" + invoiceNumber
  distributor:        string;       // resolved vendor name
  vendor_id:          number|null;  // resolved vendor ID (same VENDOR_MAP as PO)
  invoice_type:       string;       // from invoiceType
  invoice_date:       string;       // "M/D/YYYY" safe format
  due_date:           string;       // "M/D/YYYY" safe format
  total_amount:       string;       // from totalAmount
  items:              { sku: string; qty: string; price: string }[];
  summary:            any;          // from summary (as-is)
  terms:              string;       // from terms
  payment_type:       string;       // from paymentType
  po_type:            string;       // from poType ("Dropship"|"Stocking"|"")
  stocking_warehouse: string;       // derived from distributor warehouse mapping
  website_order_number: string;     // from websiteOrderNumber
  // Sync tracking (added by sync service)
  ns_synced?:         boolean;
  ns_synced_at?:      Date;
  ns_result?:         string;
  ns_error?:          string;
  ns_error_at?:       Date;
  ns_retry_count?:    number;
  ns_failed?:         boolean;
  ns_skip?:           boolean;      // true if no dueDate
  ns_skip_reason?:    string;       // "no_dueDate"
}
```

**Unique Key:** `{ po_number, invoice_number }` (composite — one PO can have multiple bills)

**Validation:**
- If `dueDate` is missing/empty/invalid -> stage with `ns_skip: true, ns_skip_reason: "no_dueDate"`
- These are staged but never sent to NetSuite — visible via API for review

**Date Handling:**
- `toSafeDate(raw)` — parses "2026-03-16T23:00:00" or "2026-03-16 23:00:00" -> "M/D/YYYY"
- Handles garbage dates ("0000-00-00"), null, undefined -> returns ""
- Year range check: 2000-2030

---

### 2. `netsuite/services/bill.sync.ts`

**Batch Config:**
```typescript
const PARALLEL_WORKERS = 5;
const BILL_BATCH = 30;
```

**Query Filter:**
```javascript
// Base: not synced, not failed, not skipped
{ ns_synced: { $ne: true }, ns_failed: { $ne: true }, ns_skip: { $ne: true } }
```

**PO Dependency Check:**
- Collect all `po_number` values from bill batch
- Cross-reference `suite_purchase_order` for `ns_synced: true, ns_result: "created"`
- Only sync bills whose PO is confirmed created in NetSuite
- Bills with un-synced POs are simply skipped this cycle (picked up next run)

**Payload to RESTlet:**
```typescript
{
  action:            SYNC_MODE,        // "skip" | "update"
  po_number:         bill.po_number,
  invoice_number:    bill.invoice_number,
  reference_number:  bill.reference_number,  // "PO228047-172247356"
  invoice_date:      bill.invoice_date,      // "M/D/YYYY"
  due_date:          bill.due_date,          // "M/D/YYYY"
  line_items:        bill.items,             // [{ sku, qty, price }]
  po_type:           bill.po_type,
  stocking_warehouse: bill.stocking_warehouse
}
```

**Sync Result Handling:**
- `success: true` -> `ns_synced: true, ns_result: result.action`
- `success: false` -> `markFailed()` with retry tracking (MAX_RETRIES = 3)
- Uses `withConcurrency()` wrapper for all RESTlet calls

**Exports:**
- `syncBillsToNetsuite()` — main sync function
- `retryFailedBills(resetAll)` — reset failed bills for retry

---

### 3. `netsuite/route/bill.route.ts`

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/bill-test` | Direct RESTlet passthrough (req.body) |
| GET | `/stage-bill` | Run `stageBills()` |
| GET | `/sync-bill` | Run `syncBillsToNetsuite()` |
| GET | `/reset-bill-sync` | Dry-run: count docs with ns_ flags |
| POST | `/reset-bill-sync` | Execute: unset all ns_ flags |
| GET | `/retry-failed-bill` | Run `retryFailedBills()` |
| GET | `/bill-ready` | Show bills with synced POs (like /dropship-ready) |

---

## Files to Modify

### 4. `suitescript/vendor_bill_restlet.js`

**Add to define:**
```javascript
define(["N/record", "N/search", "N/query", "N/log"], ...)
```

**Changes:**

| What | Before | After |
|------|--------|-------|
| `findPurchaseOrders` | N/search on `otherrefnum` (false positives) | SuiteQL: `SELECT id, tranid, status FROM transaction WHERE type='PurchOrd' AND otherrefnum=?` |
| Duplicate check | `findExistingBill(poId)` by `createdfrom` | SuiteQL: `SELECT id, tranid FROM transaction WHERE type='VendBill' AND otherrefnum=?` using `reference_number` |
| `tranid` | `invoice_number` | `reference_number` ("PO228047-172247356") |
| `otherrefnum` | `invoice_number` | `reference_number` ("PO228047-172247356") |
| `duedate` | Not set | `bill.setValue({ fieldId: "duedate", value: new Date(due_date) })` |
| Location | Not set | Line-level location from `resolveLocation(po_type, stocking_warehouse)` |
| Class | Not cleared | Clear `class` on each line + header (same fix as PO RESTlet) |
| Save | `enableSourcing: true` | `enableSourcing: false` (prevent class re-sourcing) |

**New payload fields:**
```javascript
var reference_number   = payload.reference_number || "";
var due_date           = payload.due_date || "";
var po_type            = payload.po_type || "";
var stocking_warehouse = payload.stocking_warehouse || "";
```

**Post-transform, pre-save (from research):**
```javascript
// 1. Set header fields AFTER transform (not in defaultValues — throws INVALID_RCRD_TRANSFRM)
bill.setValue({ fieldId: "tranid", value: reference_number });
bill.setValue({ fieldId: "otherrefnum", value: reference_number });
bill.setValue({ fieldId: "trandate", value: new Date(invoice_date) });
bill.setValue({ fieldId: "duedate", value: new Date(due_date) });

// 2. Update line items: match by SKU, set qty/rate/location, clear class
for each line:
    match SKU -> set rate from invoice price
    set location from resolveLocation(po_type, stocking_warehouse)
    clear class (avoid INVALID_TRANS_SUB_CLASS)

// 3. Clear header class
try { bill.setValue({ fieldId: "class", value: "" }); } catch(e) {}

// 4. Save with enableSourcing: false
bill.save({ enableSourcing: false, ignoreMandatoryFields: true });
```

---

### 5. `netsuite/server.ts`

**Add imports:**
```typescript
import { stageBills } from "./services/bill.stage";
import { syncBillsToNetsuite } from "./services/bill.sync";
import billRoutes from "./route/bill.route";
```

**Mount routes:**
```typescript
app.use("/api/v4", billRoutes);
```

**Add cron (offset from SO and PO):**
```typescript
let billSyncRunning = false;
cron.schedule("12,27,42,57 * * * *", async () => {
    if (billSyncRunning) {
        log.warn("[CRON] [BILL] Skipping -- previous sync still running");
        return;
    }
    billSyncRunning = true;
    try {
        log.info("[CRON] [BILL] Step 1 -- Staging bills...");
        await stageBills();
        log.info("[CRON] [BILL] Step 2 -- Pushing to NetSuite...");
        await syncBillsToNetsuite();
    } catch (err: any) {
        log.error("[CRON] [BILL] Error", { error: err.message });
    } finally {
        billSyncRunning = false;
    }
});
```

---

## Final Cron Schedule

| Job | Cron | Fires at | Status |
|-----|------|----------|--------|
| SO stage + sync | `*/15 * * * *` | `:00 :15 :30 :45` | Active |
| PO stage + sync | `7,22,37,52 * * * *` | `:07 :22 :37 :52` | Active |
| **Bill stage + sync** | **`12,27,42,57 * * * *`** | **`:12 :27 :42 :57`** | **New** |
| SO retry | `0 3 * * *` | `3:00 AM` | Active |

**Timeline (one hour):**
```
:00  SO ━━━━━━
:07       PO ━━━━━━
:12            BILL ━━━━
:15  SO ━━━━━━
:22       PO ━━━━━━
:27            BILL ━━━━
:30  SO ━━━━━━
:37       PO ━━━━━━
:42            BILL ━━━━
:45  SO ━━━━━━
:52       PO ━━━━━━
:57            BILL ━━━━
```

No two jobs start at the same minute. All share the 4-slot concurrency semaphore.

---

## Dependency Chain

```
SO must sync first  ->  PO can sync (dropship needs SO)
PO must sync first  ->  Bill can sync (bill transforms from PO)
```

Bill sync checks: `suite_purchase_order.ns_synced === true && ns_result === "created"`
If PO not synced yet, bill waits for next cron cycle.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| No `dueDate` in source | Staged with `ns_skip: true` — never sent to NetSuite |
| PO not synced yet | Bill skipped this cycle, retried next run |
| PO not found in NetSuite | RESTlet returns error, `markFailed()` in MongoDB |
| PO fully billed (0 lines) | RESTlet returns error, `markFailed()` in MongoDB |
| Duplicate bill (same reference_number) | RESTlet returns "skipped" (action=skip) or updates (action=update) |
| NetSuite concurrency limit | Caught by semaphore + `netsuite.client.ts` error detection |
| MAX_RETRIES exceeded (3) | `ns_failed: true` — picked up by future daily retry cron |

---

## Key Observations from PO/Bill XML

**PO (after bill created):**
- `ordbilled=T` — PO knows it has been billed
- `linked=T` — PO has related records
- Each line tracks: `quantitybilled`, `quantityreceived`, `quantity`
- Lines with `quantitybilled == quantity` have `isopen=F` (fully billed)
- Lines with `quantitybilled < quantity` have `isopen=T` (still billable)
- `needsbill=F` after full billing

**Bill (from transform):**
- `customform=201` — Bill form ID
- `transform=purchord` — confirms transform source
- `dbstrantype=PurchOrd` — source transaction type
- `podocnum=297345` — PO internal ID reference
- Line items carry `orderdoc` (PO ID) and `orderline` (PO line number) — auto-set by transform
- `initquantity` = quantity from PO, `quantity` = billable quantity

**Related Records (links machine on PO):**
```
linktype: "Order Bill/Invoice" → Bill
linktype: "Receipt/Fulfillment" → Item Receipt
```

---

## Implementation Order

1. `vendor_bill_restlet.js` — RESTlet updates (SuiteQL, duedate, reference, location, class)
2. `bill.stage.ts` — Staging service
3. `bill.sync.ts` — Sync service with PO dependency check
4. `bill.route.ts` — API routes
5. `server.ts` — Cron + mount routes
