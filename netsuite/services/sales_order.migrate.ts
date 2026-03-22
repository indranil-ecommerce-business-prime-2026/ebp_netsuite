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

/**
 * Backfill order_source and shipping_address on existing staged documents.
 *
 * 1. Sets order_source based on store_type (amazon/newegg/walmart → same, ebay/shopify → "tpx")
 * 2. Backfills shipping_address from source DBs for records missing it
 * 3. Resets ns_synced=false on backfilled records so they get re-pushed to NetSuite with address
 *
 * Safe to run multiple times — only updates records that need it.
 */
export const migrateMultiVendorSchema = async (): Promise<{
    backfilledOrderSource: number;
    backfilledAddress: number;
    resetForResync: number;
    total: number;
}> => {
    log.info("[SO Migrate MV] Starting multi-vendor + address backfill...");

    const ns_db = await getDb("netsuite");
    const collection = ns_db.collection("suite_sales_order");
    const total = await collection.countDocuments();

    // ── Step 1: Backfill order_source where missing ──────────────────────────
    const missingSource = await collection.find({ order_source: { $exists: false } }).toArray();
    let backfilledOrderSource = 0;

    if (missingSource.length > 0) {
        const sourceOps = missingSource.map(doc => {
            const st = (doc.store_type || "").toLowerCase();
            let orderSource = "amazon"; // default
            if (st === "newegg")  orderSource = "newegg";
            if (st === "walmart") orderSource = "walmart";
            if (st === "ebay" || st === "shopify") orderSource = "tpx";

            return {
                updateOne: {
                    filter: { _id: doc._id },
                    update: { $set: { order_source: orderSource } }
                }
            };
        });

        const sourceResult = await collection.bulkWrite(sourceOps);
        backfilledOrderSource = sourceResult.modifiedCount;
        log.info(`[SO Migrate MV] Backfilled order_source on ${backfilledOrderSource} records`);
    }

    // ── Step 2: Backfill shipping_address from source DBs ────────────────────
    const missingAddr = await collection.find({
        $or: [
            { shipping_address: { $exists: false } },
            { shipping_address: null }
        ]
    }).toArray();

    let backfilledAddress = 0;

    if (missingAddr.length > 0) {
        // Group by order_source to batch lookups
        const amazonIds: string[] = [];
        const neweggIds: string[] = [];
        const walmartIds: string[] = [];
        const tpxIds: string[] = [];

        for (const doc of missingAddr) {
            const src = doc.order_source || (doc.store_type === "ebay" || doc.store_type === "shopify" ? "tpx" :
                         doc.store_type === "newegg" ? "newegg" : doc.store_type === "walmart" ? "walmart" : "amazon");
            if (src === "amazon")  amazonIds.push(doc.otherrefnum);
            if (src === "newegg")  neweggIds.push(doc.otherrefnum);
            if (src === "walmart") walmartIds.push(doc.otherrefnum);
            if (src === "tpx")     tpxIds.push(doc.otherrefnum);
        }

        // Fetch addresses from source DBs in parallel
        const [ebp_db, newegg_db, walmart_db, tpx_db] = await Promise.all([
            amazonIds.length > 0  ? getDb("ebp_marketplace") : Promise.resolve(null),
            neweggIds.length > 0  ? getDb("new_eggs")        : Promise.resolve(null),
            walmartIds.length > 0 ? getDb("walmart")         : Promise.resolve(null),
            tpxIds.length > 0     ? getDb("tpx_orders")      : Promise.resolve(null),
        ]);

        // Build address lookup maps
        const addrMap = new Map<string, any>();

        if (ebp_db && amazonIds.length > 0) {
            const amazonDocs = await ebp_db.collection("amazon_orders_v3").find(
                { AmazonOrderId: { $in: amazonIds } },
                { projection: { AmazonOrderId: 1, ShippingAddress: 1 } }
            ).toArray();
            for (const doc of amazonDocs) {
                const addr = doc.ShippingAddress;
                if (addr) {
                    addrMap.set(`amazon:${doc.AmazonOrderId}`, {
                        addressee: addr.Name || "",
                        company:   addr.CompanyName || "",
                        addr1:     addr.AddressLine1 || "",
                        addr2:     addr.AddressLine2 || "",
                        city:      addr.City || "",
                        state:     addr.StateOrRegion || "",
                        zip:       addr.PostalCode || "",
                        country:   addr.CountryCode || "US",
                    });
                }
            }
            log.info(`[SO Migrate MV] Amazon address lookup: ${amazonDocs.length} found for ${amazonIds.length} orders`);
        }

        if (newegg_db && neweggIds.length > 0) {
            const neweggDocs = await newegg_db.collection("newegg_bb_orders_v2").find(
                { OrderNumber: { $in: neweggIds.map(id => Number(id) || id) } },
                { projection: { OrderNumber: 1, ShipToFirstName: 1, ShipToLastName: 1, ShipToCompany: 1, ShipToAddress1: 1, ShipToAddress2: 1, ShipToCityName: 1, ShipToStateCode: 1, ShipToZipCode: 1, ShipToCountryCode: 1 } }
            ).toArray();
            for (const doc of neweggDocs) {
                addrMap.set(`newegg:${doc.OrderNumber}`, {
                    addressee: [doc.ShipToFirstName, doc.ShipToLastName].filter(Boolean).join(" "),
                    company:   doc.ShipToCompany || "",
                    addr1:     doc.ShipToAddress1 || "",
                    addr2:     doc.ShipToAddress2 || "",
                    city:      doc.ShipToCityName || "",
                    state:     doc.ShipToStateCode || "",
                    zip:       doc.ShipToZipCode || "",
                    country:   doc.ShipToCountryCode || "US",
                });
            }
            log.info(`[SO Migrate MV] Newegg address lookup: ${neweggDocs.length} found for ${neweggIds.length} orders`);
        }

        if (walmart_db && walmartIds.length > 0) {
            const walmartDocs = await walmart_db.collection("walmart_orders_v2").find(
                { orderNumber: { $in: walmartIds.map(id => Number(id) || id) } },
                { projection: { orderNumber: 1, "shippingInfo.postalAddress": 1 } }
            ).toArray();
            for (const doc of walmartDocs) {
                const addr = doc.shippingInfo?.postalAddress;
                if (addr) {
                    let countryCode = addr.country || "US";
                    if (countryCode === "USA") countryCode = "US";
                    if (countryCode === "CAN") countryCode = "CA";
                    addrMap.set(`walmart:${doc.orderNumber}`, {
                        addressee: addr.name || "",
                        company:   "",
                        addr1:     addr.address1 || "",
                        addr2:     addr.address2 || "",
                        city:      addr.city || "",
                        state:     addr.state || "",
                        zip:       addr.postalCode || "",
                        country:   countryCode,
                    });
                }
            }
            log.info(`[SO Migrate MV] Walmart address lookup: ${walmartDocs.length} found for ${walmartIds.length} orders`);
        }

        if (tpx_db && tpxIds.length > 0) {
            const tpxDocs = await tpx_db.collection("tpx_orders").find(
                { txn_id: { $in: tpxIds } },
                { projection: { txn_id: 1, to: 1 } }
            ).toArray();
            for (const doc of tpxDocs) {
                const addr = doc.to;
                if (addr) {
                    addrMap.set(`tpx:${doc.txn_id}`, {
                        addressee: addr.Name || "",
                        company:   addr.Company || "",
                        addr1:     addr.Street || "",
                        addr2:     addr.Street2 || "",
                        city:      addr.City || "",
                        state:     addr.State || "",
                        zip:       addr.ZipCode || "",
                        country:   addr.CountryCode || "US",
                    });
                }
            }
            log.info(`[SO Migrate MV] TPX address lookup: ${tpxDocs.length} found for ${tpxIds.length} orders`);
        }

        // Apply address backfill
        const addrOps = [];
        for (const doc of missingAddr) {
            const src = doc.order_source || (doc.store_type === "ebay" || doc.store_type === "shopify" ? "tpx" :
                         doc.store_type === "newegg" ? "newegg" : doc.store_type === "walmart" ? "walmart" : "amazon");
            const addr = addrMap.get(`${src}:${doc.otherrefnum}`);
            if (addr) {
                addrOps.push({
                    updateOne: {
                        filter: { _id: doc._id },
                        update: { $set: { shipping_address: addr } }
                    }
                });
            }
        }

        if (addrOps.length > 0) {
            const addrResult = await collection.bulkWrite(addrOps);
            backfilledAddress = addrResult.modifiedCount;
        }
        log.info(`[SO Migrate MV] Backfilled shipping_address on ${backfilledAddress}/${missingAddr.length} records`);
    }

    // ── Step 3: Reset ns_synced on records that got address backfilled ────────
    // These need to be re-pushed to NetSuite so the SO gets the shipping address
    let resetForResync = 0;
    if (backfilledAddress > 0) {
        const resetResult = await collection.updateMany(
            {
                ns_synced: true,
                shipping_address: { $exists: true, $ne: null }
            },
            {
                $set: { ns_synced: false },
                $unset: { ns_result: "", ns_synced_at: "" }
            }
        );
        resetForResync = resetResult.modifiedCount;
        log.info(`[SO Migrate MV] Reset ns_synced on ${resetForResync} records for re-sync with address`);
    }

    log.info(`[SO Migrate MV] Done — order_source: ${backfilledOrderSource}, address: ${backfilledAddress}, reset: ${resetForResync}, total: ${total}`);
    return { backfilledOrderSource, backfilledAddress, resetForResync, total };
};
