import { getDb } from "../config/mongdodb.config";
import { postToNetsuiteForPO } from "./netsuite.client";
import { SYNC_MODE, TEST_MODE, STOP_ON_ERROR, MAX_RETRIES } from "../config/sync.config";
import { withConcurrency } from "../config/concurrency.config";
import log from "../config/logger.config";

// ── Governance budget ────────────────────────────────────────────────────────
// RESTlet limit: 5,000 units/invocation
// Stocking PO:  ~42 units (4 SKUs)  → ~119 POs per invocation (never hit — 1 PO/call)
// Dropship PO:  ~77 units (1 SKU)   → ~64 POs per invocation  (never hit — 1 PO/call)
// Each HTTP call = 1 RESTlet invocation, so governance is never a concern.
// Batch limits below control server-side concurrency + NetSuite rate limits.
const PARALLEL_WORKERS = 5;
const STOCKING_BATCH = 50;
const DROPSHIP_BATCH = 20;   // lower — each dropship PO touches SO too

// Parse created_at safely — sends "M/D/YYYY" to avoid UTC→timezone date shift.
// NetSuite trandate only needs a date, not a time.
function toSafeISO(raw: any): string {
    if (!raw) return "";
    const d = new Date(String(raw).replace(" ", "T"));
    if (isNaN(d.getTime()) || d.getFullYear() < 2000 || d.getFullYear() > 2030) return "";
    // Extract local date parts to avoid timezone offset shifting the day
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

export const syncPurchaseOrdersToNetsuite = async (): Promise<any[]> => {
    log.info(`[NS PO Sync] Starting purchase order sync — mode: ${SYNC_MODE}, workers: ${PARALLEL_WORKERS}, stopOnError: ${STOP_ON_ERROR}`);

    const ns_db = await getDb("netsuite");
    const collection = ns_db.collection("suite_purchase_order");
    const soCollection = ns_db.collection("suite_sales_order");

    // Base filter: skip permanently failed; in "skip" mode also skip already-synced
    const baseFilter = SYNC_MODE === "update"
        ? { ns_failed: { $ne: true } }
        : { ns_synced: { $ne: true }, ns_failed: { $ne: true } };

    // ── Phase 1: Stocking POs (no SO dependency) ────────────────────────
    const stockingOrders = await collection
        .find({ ...baseFilter, po_type: { $ne: "Dropship" } })
        .limit(STOCKING_BATCH)
        .toArray();

    // ── Phase 2: Dropship POs (only if SO is synced) ────────────────────
    const dropshipCandidates = await collection
        .find({ ...baseFilter, po_type: "Dropship", website_order_number: { $exists: true, $ne: "" } })
        .limit(DROPSHIP_BATCH * 2)  // fetch extra — some may not have synced SOs
        .toArray();

    // Filter to only those whose SO is synced
    let dropshipOrders: any[] = [];
    if (dropshipCandidates.length > 0) {
        const orderNumbers = dropshipCandidates.map((p: any) => p.website_order_number);
        const syncedSOs = await soCollection
            .find({ otherrefnum: { $in: orderNumbers }, ns_synced: true, ns_result: "created" })
            .project({ otherrefnum: 1 })
            .toArray();
        const syncedSet = new Set(syncedSOs.map((s: any) => s.otherrefnum));

        dropshipOrders = dropshipCandidates
            .filter((p: any) => syncedSet.has(p.website_order_number))
            .slice(0, DROPSHIP_BATCH);

        log.info(`[NS PO Sync] Dropship: ${dropshipCandidates.length} candidates, ${syncedSOs.length} with synced SO, ${dropshipOrders.length} ready`);
    }

    const orders = [...stockingOrders, ...dropshipOrders];

    if (orders.length === 0) {
        log.info("[NS PO Sync] No unsynced purchase orders. Skipping.");
        return [];
    }

    log.info(`[NS PO Sync] Found ${orders.length} POs to process${TEST_MODE ? " (TEST MODE)" : ""}`);

    // In TEST_MODE or STOP_ON_ERROR, fall back to serial processing
    if (TEST_MODE || STOP_ON_ERROR) {
        return syncSerial(collection, orders);
    }

    // ── Parallel sync with worker pool ────────────────────────────────────
    let sent = 0;
    let errors = 0;
    let skipped = 0;
    const results: any[] = [];
    let index = 0;

    async function worker() {
        while (index < orders.length) {
            const i = index++;
            const entry = await syncOnePO(collection, orders[i]);
            results[i] = entry;

            if (entry.action === "no_items" || entry.action === "skipped") skipped++;
            else if (entry.success === false) errors++;
            else sent++;
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(PARALLEL_WORKERS, orders.length) }, () => worker())
    );

    log.info(`[NS PO Sync] Done — sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${orders.length}`);
    return results;
};

// ── Process a single PO: RESTlet call + MongoDB status update ─────────────
async function syncOnePO(collection: any, po: any): Promise<any> {
    const t0 = Date.now();
    try {
        const result = await withConcurrency(() => postToNetsuiteForPO({
            action:                   SYNC_MODE,
            po_number:                po.po_number,
            otherrefnum:              String(po.po_number),
            vendor_id:                po.vendor_id,
            distributor:              po.distributor,
            distributor_order_number: po.distributor_order_number,
            status:                   po.status,
            invoice:                  po.invoice,
            tracking:                 po.tracking,
            order_items:              po.order_items,
            website_order_number:     po.website_order_number,
            po_type:                  po.po_type || "",
            stocking_warehouse:       po.stocking_warehouse || "",
            created_at:               toSafeISO(po.created_at)
        }), `PO ${po.po_number}`);

        const ms = Date.now() - t0;

        // no_items = SKUs not found in NetSuite — mark as synced so we don't retry
        if (result.action === "no_items") {
            await collection.updateOne(
                { _id: po._id },
                { $set: { ns_synced: true, ns_synced_at: new Date(), ns_result: "no_items" } }
            );
            log.info(`[NS PO Sync] No items — skipped: ${po.po_number} (${ms}ms)`);
            return { po_number: po.po_number, success: true, action: "no_items", ms };
        }

        // If NetSuite returned success: false
        if (result.success === false) {
            log.error(`[NS PO Sync] Failed: ${po.po_number} → ${result.error} (${ms}ms)`);
            await markFailed(collection, po, result.error);
            return { po_number: po.po_number, success: false, error: result.error, ms };
        }

        // Mark as synced
        await collection.updateOne(
            { _id: po._id },
            {
                $set: { ns_synced: true, ns_synced_at: new Date(), ns_result: result.action },
                $unset: { ns_error: "", ns_retry_count: "", ns_failed: "" }
            }
        );
        log.info(`[NS PO Sync] Synced: ${po.po_number} → ${result.action} (${ms}ms)`);
        return { po_number: po.po_number, ...result, ms };

    } catch (e: any) {
        const ms = Date.now() - t0;
        const errMsg = e?.response?.data || e.message;
        log.error(`[NS PO Sync] Error: ${po.po_number}: ${errMsg} (${ms}ms)`);
        await markFailed(collection, po, errMsg);
        return { po_number: po.po_number, success: false, error: errMsg, ms };
    }
}

// ── Serial fallback for TEST_MODE / STOP_ON_ERROR ─────────────────────────
async function syncSerial(collection: any, orders: any[]): Promise<any[]> {
    let sent = 0, errors = 0, skipped = 0;
    const results: any[] = [];

    for (const po of orders) {
        const entry = await syncOnePO(collection, po);
        results.push(entry);

        if (entry.action === "no_items" || entry.action === "skipped") { skipped++; continue; }
        if (entry.success === false) {
            errors++;
            if (STOP_ON_ERROR) {
                log.error(`[NS PO Sync] STOP_ON_ERROR — halting batch.`);
                break;
            }
            continue;
        }

        sent++;
        if (TEST_MODE) {
            log.info(`[NS PO Sync] TEST_MODE — stopping after first insert/update`);
            break;
        }
    }

    log.info(`[NS PO Sync] Done — sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${orders.length}`);
    return results;
}

// ─── Mark order as failed with retry tracking ────────────────────────────────
async function markFailed(collection: any, order: any, error: any) {
    const retryCount = (order.ns_retry_count || 0) + 1;
    const permanentlyFailed = retryCount >= MAX_RETRIES;

    const update: any = {
        $set: {
            ns_synced: false,
            ns_error: typeof error === "string" ? error : JSON.stringify(error),
            ns_error_at: new Date(),
            ns_retry_count: retryCount,
        }
    };

    if (permanentlyFailed) {
        update.$set.ns_failed = true;
        log.error(`[NS PO Sync] PO ${order.po_number} exceeded ${MAX_RETRIES} retries — marked as permanently failed.`);
    }

    await collection.updateOne({ _id: order._id }, update);
}

// ─── Retry failed POs ────────────────────────────────────────────────────────
export const retryFailedPurchaseOrders = async (resetAll = false): Promise<any> => {
    const ns_db = await getDb("netsuite");
    const collection = ns_db.collection("suite_purchase_order");

    const filter = resetAll
        ? { $or: [{ ns_synced: false, ns_error: { $exists: true } }, { ns_failed: true }] }
        : { ns_synced: false, ns_error: { $exists: true }, ns_failed: { $ne: true } };

    const failedOrders = await collection.find(filter).toArray();

    if (failedOrders.length === 0) {
        return { message: "No failed POs to retry.", count: 0 };
    }

    const result = await collection.updateMany(
        { _id: { $in: failedOrders.map((o: any) => o._id) } },
        {
            $set: { ns_synced: false },
            $unset: { ns_error: "", ns_error_at: "", ns_retry_count: "", ns_failed: "" }
        }
    );

    const orderList = failedOrders.map((o: any) => ({
        po_number: o.po_number,
        previousError: o.ns_error,
        retryCount: o.ns_retry_count || 0
    }));

    return {
        message: `Reset ${result.modifiedCount} failed POs for retry.`,
        count: result.modifiedCount,
        orders: orderList
    };
};
