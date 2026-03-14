import { getDb } from "../config/mongdodb.config";
import { postToNetsuite } from "./netsuite.client";
import { SYNC_MODE, TEST_MODE, STOP_ON_ERROR, MAX_RETRIES } from "../config/sync.config";

export const syncSalesOrdersToNetsuite = async (): Promise<any[]> => {
    console.log(`[NS Sync] Starting sales order sync — mode: ${SYNC_MODE}, stopOnError: ${STOP_ON_ERROR}`);

    const ns_db = await getDb("netsuite");
    const collection = ns_db.collection("suite_sales_order");

    // In "update" mode, re-process all orders (including previously synced ones).
    // In "skip" mode, only pick up unsynced orders.
    // Always exclude permanently failed orders (retry count exceeded).
    const filter = SYNC_MODE === "update"
        ? { ns_failed: { $ne: true } }
        : { ns_synced: { $ne: true }, ns_failed: { $ne: true } };

    const orders = await collection.find(filter).toArray();

    if (orders.length === 0) {
        console.log("[NS Sync] No orders to process. Skipping.");
        return [];
    }

    let sent = 0;
    let errors = 0;
    let skipped = 0;
    const results: any[] = [];

    console.log(`[NS SO Sync] Found ${orders.length} orders to process${TEST_MODE ? " (TEST MODE)" : ""}`);

    for (const order of orders) {
        console.log(`[NS SO Sync] Sending order: ${order.otherrefnum}`);
        try {
            const result = await postToNetsuite({
                action:              SYNC_MODE,
                otherrefnum:         order.otherrefnum,
                trandate:            order.trandate,
                store_type:          order.store_type || "amazon",
                order_status:        order.order_status,
                fulfillment_channel: order.fulfillment_channel,
                ship_date:           order.ship_date,
                items:               order.items,
                po:                  order.po
            });

            const entry = { otherrefnum: order.otherrefnum, ...result };
            results.push(entry);

            // no_items = SKUs not found in NetSuite — mark as synced so we don't retry
            if (result.action === "no_items") {
                await collection.updateOne(
                    { _id: order._id },
                    { $set: { ns_synced: true, ns_synced_at: new Date(), ns_result: "no_items" } }
                );
                console.log(`[NS SO Sync] No matching items — marked & skipped: ${order.otherrefnum}`);
                skipped++;
                continue;
            }

            // If NetSuite returned success: false
            if (result.success === false) {
                console.error(`[NS SO Sync] Failed in NetSuite: ${order.otherrefnum} → ${result.error}`);
                await markFailed(collection, order, result.error);
                errors++;

                if (STOP_ON_ERROR) {
                    console.error(`[NS SO Sync] STOP_ON_ERROR is true — halting batch.`);
                    break;
                }
                continue;
            }

            // Mark as synced so it won't be picked up again
            await collection.updateOne(
                { _id: order._id },
                {
                    $set: { ns_synced: true, ns_synced_at: new Date(), ns_result: result.action },
                    $unset: { ns_error: "", ns_retry_count: "", ns_failed: "" }
                }
            );
            console.log(`[NS SO Sync] Synced & marked: ${order.otherrefnum} → ${result.action}`);

            if (result.action === "skipped") {
                skipped++;
                continue;
            }

            sent++;
            if (TEST_MODE) {
                console.log(`[NS SO Sync] TEST_MODE — stopping after first insert/update`);
                break;
            }
        } catch (e: any) {
            const errMsg = e?.response?.data || e.message;
            console.error(`[NS Sync] Failed for order ${order.otherrefnum}:`, errMsg);
            results.push({ otherrefnum: order.otherrefnum, success: false, error: errMsg });
            await markFailed(collection, order, errMsg);
            errors++;

            if (STOP_ON_ERROR) {
                console.error(`[NS SO Sync] STOP_ON_ERROR is true — halting batch.`);
                break;
            }
        }
    }

    console.log(`[NS Sync] Done — sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${orders.length}`);
    return results;
};

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
        console.error(`[NS SO Sync] Order ${order.otherrefnum} exceeded ${MAX_RETRIES} retries — marked as permanently failed.`);
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
