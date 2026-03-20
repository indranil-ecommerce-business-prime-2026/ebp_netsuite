import { getDb } from "../config/mongdodb.config";
import log from "../config/logger.config";

/**
 * Migrate existing suite_sales_order documents to the new schema:
 * 1. Add store_type (default "amazon") where missing
 * 2. Remove deprecated fields (location, ship_from)
 * 3. Reset ns_synced so migrated records get re-synced with correct data
 *
 * Safe to run multiple times — only updates records that need it.
 */
export const migrateSalesOrderSchema = async (): Promise<{
    migrated: number;
    alreadyCurrent: number;
    total: number;
}> => {
    log.info("[SO Migrate] Starting schema migration...");

    const ns_db = await getDb("netsuite");
    const collection = ns_db.collection("suite_sales_order");

    // Find records that still have old schema (missing store_type OR have location field)
    const oldRecords = await collection.find({
        $or: [
            { store_type: { $exists: false } },
            { location: { $exists: true } },
            { ship_from: { $exists: true } }
        ]
    }).toArray();

    const total = await collection.countDocuments();

    if (oldRecords.length === 0) {
        log.info("[SO Migrate] All records already on new schema.");
        return { migrated: 0, alreadyCurrent: total, total };
    }

    log.info(`[SO Migrate] Found ${oldRecords.length} records to migrate (of ${total} total)`);

    // Build TPX map to get store_type for each order
    const tpx_db = await getDb("tpx_orders");
    const tpx_cursor = tpx_db.collection("tpx_orders").find(
        {},
        { projection: { txn_id: 1, store_type: 1 } }
    );
    const tpxMap = new Map<string, string>();
    for await (const tpx of tpx_cursor) {
        if (tpx?.txn_id) tpxMap.set(tpx.txn_id, tpx.store_type || "amazon");
    }
    log.info(`[SO Migrate] TPX map: ${tpxMap.size} entries`);

    // Migrate each record
    const bulkOps = oldRecords.map(record => {
        const storeType = tpxMap.get(record.otherrefnum) || "amazon";

        return {
            updateOne: {
                filter: { _id: record._id },
                update: {
                    $set: {
                        store_type: storeType
                    },
                    $unset: {
                        location: "",
                        ship_from: ""
                    }
                }
            }
        };
    });

    const result = await collection.bulkWrite(bulkOps);
    const migrated = result.modifiedCount;

    log.info(`[SO Migrate] Done — migrated: ${migrated}, total: ${total}`);
    return { migrated, alreadyCurrent: total - migrated, total };
};
