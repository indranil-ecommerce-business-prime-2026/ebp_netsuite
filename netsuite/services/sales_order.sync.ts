import { getDb } from "../config/mongdodb.config";
import { postToNetsuite } from "./netsuite.client";
import { SYNC_MODE_SO as SYNC_MODE, TEST_MODE, STOP_ON_ERROR, MAX_RETRIES } from "../config/sync.config";
import { withConcurrency } from "../config/concurrency.config";
import log from "../config/logger.config";

const PARALLEL_WORKERS = 5;
const BATCH_LIMIT = 500;

export const syncSalesOrdersToNetsuite = async (): Promise<any[]> => {
    log.info(`[NS SO Sync] Starting — mode: ${SYNC_MODE}, workers: ${PARALLEL_WORKERS}, stopOnError: ${STOP_ON_ERROR}`);

    const ns_db = await getDb("netsuite");
    const collection = ns_db.collection("suite_sales_order");

    const filter = SYNC_MODE === "update"
        ? { ns_failed: { $ne: true } }
        : { ns_synced: { $ne: true }, ns_failed: { $ne: true } };

    const orders = await collection.find(filter).limit(BATCH_LIMIT).toArray();

    if (orders.length === 0) {
        log.info("[NS SO Sync] No orders to process. Skipping.");
        return [];
    }

    log.info(`[NS SO Sync] Found ${orders.length} orders to process${TEST_MODE ? " (TEST MODE)" : ""}`);

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
            const order = orders[i];
            const t0 = Date.now();
            const entry = await syncOneOrder(collection, order);
            const elapsed = Date.now() - t0;
            entry.ms = elapsed;
            results[i] = entry;

            log.info(`[NS SO Sync] ${order.otherrefnum} took ${elapsed}ms`);
            if (entry.action === "no_items" || entry.action === "skipped") skipped++;
            else if (entry.success === false) errors++;
            else sent++;
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(PARALLEL_WORKERS, orders.length) }, () => worker())
    );

    const times = results.filter((r: any) => r?.ms).map((r: any) => r.ms);
    const avg = times.length > 0 ? Math.round(times.reduce((a: number, b: number) => a + b, 0) / times.length) : 0;
    const max = times.length > 0 ? Math.max(...times) : 0;
    const min = times.length > 0 ? Math.min(...times) : 0;
    log.info(`[NS SO Sync] Done — sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${orders.length} | timing: avg=${avg}ms, min=${min}ms, max=${max}ms`);
    return results;
};

// ── Process a single order: RESTlet call + MongoDB status update ──────────
async function syncOneOrder(collection: any, order: any): Promise<any> {
    try {
        const result = await withConcurrency(() => postToNetsuite({
            action:              SYNC_MODE,
            otherrefnum:         order.otherrefnum,
            trandate:            order.trandate,
            store_type:          order.store_type || "amazon",
            order_status:        order.order_status,
            fulfillment_channel: order.fulfillment_channel,
            ship_date:           order.ship_date,
            items:               order.items,
            po:                  order.po,
            shipping_address:    order.shipping_address || null,
        }), `SO ${order.otherrefnum}`);

        if (result.action === "no_items") {
            await collection.updateOne(
                { _id: order._id },
                { $set: { ns_synced: true, ns_synced_at: new Date(), ns_result: "no_items" } }
            );
            log.info(`[NS SO Sync] No items — skipped: ${order.otherrefnum}`);
            return { otherrefnum: order.otherrefnum, success: true, action: "no_items" };
        }

        if (result.success === false) {
            log.error(`[NS SO Sync] Failed: ${order.otherrefnum} → ${result.error}`);
            await markFailed(collection, order, result.error);
            return { otherrefnum: order.otherrefnum, success: false, error: result.error };
        }

        await collection.updateOne(
            { _id: order._id },
            {
                $set: { ns_synced: true, ns_synced_at: new Date(), ns_result: result.action },
                $unset: { ns_error: "", ns_retry_count: "", ns_failed: "" }
            }
        );
        log.info(`[NS SO Sync] Synced: ${order.otherrefnum} → ${result.action}`);
        return { otherrefnum: order.otherrefnum, ...result };

    } catch (e: any) {
        const errMsg = e?.response?.data || e.message;
        log.error(`[NS SO Sync] Error: ${order.otherrefnum}:`, errMsg);
        await markFailed(collection, order, errMsg);
        return { otherrefnum: order.otherrefnum, success: false, error: errMsg };
    }
}

// ── Serial fallback for TEST_MODE / STOP_ON_ERROR ─────────────────────────
async function syncSerial(collection: any, orders: any[]): Promise<any[]> {
    let sent = 0, errors = 0, skipped = 0;
    const results: any[] = [];

    for (const order of orders) {
        const entry = await syncOneOrder(collection, order);
        results.push(entry);

        if (entry.action === "no_items" || entry.action === "skipped") { skipped++; continue; }
        if (entry.success === false) {
            errors++;
            if (STOP_ON_ERROR) { log.error("[NS SO Sync] STOP_ON_ERROR — halting."); break; }
            continue;
        }
        sent++;
        if (TEST_MODE) { log.info("[NS SO Sync] TEST_MODE — stopping after first."); break; }
    }

    log.info(`[NS SO Sync] Done — sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${orders.length}`);
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
        log.error(`[NS SO Sync] Order ${order.otherrefnum} exceeded ${MAX_RETRIES} retries — marked as permanently failed.`);
    }

    await collection.updateOne({ _id: order._id }, update);
}

// ─── Retry failed orders ─────────────────────────────────────────────────────
// Resets ns_synced, ns_error, ns_retry_count so they get picked up again.
// Optionally pass resetAll=true to also reset permanently failed orders.
export const retryFailedSalesOrders = async (resetAll = false): Promise<any> => {
    const ns_db = await getDb("netsuite");
    const collection = ns_db.collection("suite_sales_order");

    const filter = resetAll
        ? { $or: [{ ns_synced: false, ns_error: { $exists: true } }, { ns_failed: true }] }
        : { ns_synced: false, ns_error: { $exists: true }, ns_failed: { $ne: true } };

    const failedOrders = await collection.find(filter).toArray();

    if (failedOrders.length === 0) {
        return { message: "No failed orders to retry.", count: 0 };
    }

    const result = await collection.updateMany(
        { _id: { $in: failedOrders.map((o: any) => o._id) } },
        {
            $set: { ns_synced: false },
            $unset: { ns_error: "", ns_error_at: "", ns_retry_count: "", ns_failed: "" }
        }
    );

    const orderList = failedOrders.map((o: any) => ({
        otherrefnum: o.otherrefnum,
        previousError: o.ns_error,
        retryCount: o.ns_retry_count || 0
    }));

    return {
        message: `Reset ${result.modifiedCount} failed orders for retry.`,
        count: result.modifiedCount,
        orders: orderList
    };
};
