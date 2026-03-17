import { getDb } from "../config/mongdodb.config";
import { postToNetsuiteForPO } from "./netsuite.client";
import { SYNC_MODE, TEST_MODE, STOP_ON_ERROR, MAX_RETRIES } from "../config/sync.config";

export const syncPurchaseOrdersToNetsuite = async (): Promise<any[]> => {
    console.log(`[NS PO Sync] Starting purchase order sync — mode: ${SYNC_MODE}, stopOnError: ${STOP_ON_ERROR}`);

    const ns_db = await getDb("netsuite");
    const collection = ns_db.collection("suite_purchase_order");

    // In "update" mode, re-process all orders (including previously synced).
    // In "skip" mode, only pick up unsynced orders.
    // Always exclude permanently failed orders.
    const filter = SYNC_MODE === "update"
        ? { ns_failed: { $ne: true } }
        : { ns_synced: { $ne: true }, ns_failed: { $ne: true } };

    const BATCH_LIMIT = 200;
    const orders = await collection.find(filter).limit(BATCH_LIMIT).toArray();

    if (orders.length === 0) {
        console.log("[NS PO Sync] No unsynced purchase orders. Skipping.");
        return [];
    }

    let sent = 0;
    let errors = 0;
    let skipped = 0;
    const results: any[] = [];

    console.log(`[NS PO Sync] Found ${orders.length} POs to process${TEST_MODE ? " (TEST MODE)" : ""}`);

    for (const po of orders) {
        console.log(`[NS PO Sync] Sending PO: ${po.po_number}`);
        try {
            const result = await postToNetsuiteForPO({
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
                website_order_number:     po.website_order_number
            });

            const entry = { po_number: po.po_number, ...result };
            results.push(entry);

            // no_items = SKUs not found in NetSuite — mark as synced so we don't retry
            if (result.action === "no_items") {
                await collection.updateOne(
                    { _id: po._id },
                    { $set: { ns_synced: true, ns_synced_at: new Date(), ns_result: "no_items" } }
                );
                console.log(`[NS PO Sync] No matching items — marked & skipped: ${po.po_number}`);
                skipped++;
                continue;
            }

            // If NetSuite returned success: false
            if (result.success === false) {
                console.error(`[NS PO Sync] Failed in NetSuite: ${po.po_number} → ${result.error}`);
                await markFailed(collection, po, result.error);
                errors++;

                if (STOP_ON_ERROR) {
                    console.error(`[NS PO Sync] STOP_ON_ERROR is true — halting batch.`);
                    break;
                }
                continue;
            }

            // Mark as synced
            await collection.updateOne(
                { _id: po._id },
                {
                    $set: { ns_synced: true, ns_synced_at: new Date(), ns_result: result.action },
                    $unset: { ns_error: "", ns_retry_count: "", ns_failed: "" }
                }
            );
            console.log(`[NS PO Sync] Synced & marked: ${po.po_number} → ${result.action}`);

            if (result.action === "skipped") {
                skipped++;
                continue;
            }

            sent++;
            if (TEST_MODE) {
                console.log(`[NS PO Sync] TEST_MODE — stopping after first insert/update`);
                break;
            }
        } catch (e: any) {
            const errMsg = e?.response?.data || e.message;
            console.error(`[NS PO Sync] Failed for PO ${po.po_number}:`, errMsg);
            results.push({ po_number: po.po_number, success: false, error: errMsg });
            await markFailed(collection, po, errMsg);
            errors++;

            if (STOP_ON_ERROR) {
                console.error(`[NS PO Sync] STOP_ON_ERROR is true — halting batch.`);
                break;
            }
        }
    }

    console.log(`[NS PO Sync] Done — sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${orders.length}`);
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
        console.error(`[NS PO Sync] PO ${order.po_number} exceeded ${MAX_RETRIES} retries — marked as permanently failed.`);
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
