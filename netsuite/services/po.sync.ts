import { getDb } from "../config/mongdodb.config";
import { postToNetsuiteForPO } from "./netsuite.client";
import { SYNC_MODE, TEST_MODE } from "../config/sync.config";

export const syncPurchaseOrdersToNetsuite = async (): Promise<void> => {
    console.log(`[NS PO Sync] Starting purchase order sync — mode: ${SYNC_MODE}`);

    const ns_db = await getDb("netsuite");
    const collection = ns_db.collection("suite_purchase_order");
    // Only pick records that haven't been synced yet
    const orders = await collection.find({ ns_synced: { $ne: true } }).toArray();

    if (orders.length === 0) {
        console.log("[NS PO Sync] No unsynced purchase orders. Skipping.");
        return;
    }

    let sent = 0;
    let errors = 0;

    console.log(`[NS PO Sync] Found ${orders.length} unsynced POs to push${TEST_MODE ? " (TEST MODE)" : ""}`);

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

            // Mark as synced so it won't be picked up again
            await collection.updateOne(
                { _id: po._id },
                { $set: { ns_synced: true, ns_synced_at: new Date(), ns_result: result.action } }
            );
            console.log(`[NS PO Sync] ✅ Synced & marked: ${po.po_number} → ${result.action}`);

            if (result.action === "skipped") {
                // Already in NetSuite but not marked locally — mark and continue to next
                continue;
            }

            sent++;
            // TEST_MODE: stop after first real insert/update
            if (TEST_MODE) {
                console.log(`[NS PO Sync] TEST_MODE — stopping after first insert/update`);
                break;
            }
        } catch (e: any) {
            console.error(
                `[NS PO Sync] Failed for PO ${po.po_number}:`,
                e?.response?.data || e.message
            );
            errors++;
        }
    }

    console.log(`[NS PO Sync] Done — sent: ${sent}, errors: ${errors}, total: ${orders.length}`);
};
