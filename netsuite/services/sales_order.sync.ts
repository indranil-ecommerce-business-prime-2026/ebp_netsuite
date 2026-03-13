import { getDb } from "../config/mongdodb.config";
import { postToNetsuite } from "./netsuite.client";
import { SYNC_MODE, TEST_MODE } from "../config/sync.config";

export const syncSalesOrdersToNetsuite = async (): Promise<void> => {
    console.log(`[NS Sync] Starting sales order sync — mode: ${SYNC_MODE}`);

    const ns_db = await getDb("netsuite");
    const collection = ns_db.collection("suite_sales_order");
    // Only pick records that haven't been synced yet
    // ⚠️ TEST MODE: limit to 1 record. Remove .limit(1) to sync all.
    const orders = await collection.find({ ns_synced: { $ne: true } }).toArray();

    if (orders.length === 0) {
        console.log("[NS Sync] No unsynced sales orders found. Skipping.");
        return;
    }

    let sent = 0;
    let errors = 0;

    console.log(`[NS SO Sync] Found ${orders.length} unsynced orders to push${TEST_MODE ? " (TEST MODE)" : ""}`);

    for (const order of orders) {
        console.log(`[NS SO Sync] Sending order: ${order.otherrefnum}`);
        try {
            const result = await postToNetsuite({
                action: SYNC_MODE,
                otherrefnum:        order.otherrefnum,
                trandate:           order.trandate,
                order_status:       order.order_status,
                fulfillment_channel: order.fulfillment_channel,
                ship_date:          order.ship_date,
                items_shipped:      order.items_shipped,
                items_unshipped:    order.items_unshipped,
                location:           order.location,
                ship_from:          order.ship_from,
                items:              order.items,
                po:                 order.po
            });

            // no_items = SKUs not found in NetSuite — mark as synced so we don't retry
            if (result.action === "no_items") {
                await collection.updateOne(
                    { _id: order._id },
                    { $set: { ns_synced: true, ns_synced_at: new Date(), ns_result: "no_items" } }
                );
                console.log(`[NS SO Sync] ⚠️ No matching items — marked & skipped: ${order.otherrefnum}`);
                continue;
            }

            // Mark as synced so it won't be picked up again
            await collection.updateOne(
                { _id: order._id },
                { $set: { ns_synced: true, ns_synced_at: new Date(), ns_result: result.action } }
            );
            console.log(`[NS SO Sync] ✅ Synced & marked: ${order.otherrefnum} → ${result.action}`);

            if (result.action === "skipped") {
                // Already in NetSuite but not marked locally — mark and continue to next
                continue;
            }

            sent++;
            // TEST_MODE: stop after first real insert/update
            if (TEST_MODE) {
                console.log(`[NS SO Sync] TEST_MODE — stopping after first insert/update`);
                break;
            }
        } catch (e: any) {
            console.error(
                `[NS Sync] Failed for order ${order.otherrefnum}:`,
                e?.response?.data || e.message
            );
            errors++;
        }
    }

    console.log(`[NS Sync] Done — sent: ${sent}, errors: ${errors}, total: ${orders.length}`);
};
