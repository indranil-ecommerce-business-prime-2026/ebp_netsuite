import { getDb } from "../config/mongdodb.config";

interface SalesItem {
    item: string;
    quantity: number;
    amount: number;
}

interface SimplePOItem {
    sku: string;
    qty: string;
    cost: string;
}

interface SimplePO {
    po_number: number;
    po_vendor: number | null;
    order_items: SimplePOItem[];
}

interface SalesOrder {
    otherrefnum: string;          // Amazon Order ID (unique key, maps to PO # in NetSuite)
    trandate: Date;               // amazon_orders_v3.PurchaseDate
    store_type: string;           // tpx_orders.store_type (e.g., "amazon") — drives Customer + Channel lookups
    order_status: string;
    fulfillment_channel: string;
    ship_date: string | null;
    items_shipped: number;
    items_unshipped: number;
    items: SalesItem[];
    po: SimplePO[];
}

export const stageSalesOrders = async (): Promise<{ processed: number }> => {
    console.log("[SO Stage] Starting...");

    const DATE_FILTER     = "2026-01-01T00:00:00Z";
    const DATE_FILTER_SQL = "2026-01-01 00:00:00";

    const SYNC_STATUSES = ["Unshipped", "PartiallyShipped", "Shipped", "InvoiceUnconfirmed"];

    // ── Fetch all 4 data sources in parallel ──────────────────────────────
    console.log("[SO Stage] Fetching amazon, tpx, sku-vendor, po data in parallel...");

    const [ebp_db, tpx_db, ns_db, po_db] = await Promise.all([
        getDb("ebp_marketplace"),
        getDb("tpx_orders"),
        getDb("netsuite"),
        getDb("ebp_pomanager")
    ]);

    // Kick off all 4 cursor fetches concurrently
    const [amazonDocs, tpxDocs, suiteDocs, poDocs] = await Promise.all([
        // 1. Amazon orders
        ebp_db.collection("amazon_orders_v3").find({
            PurchaseDate: { $gt: DATE_FILTER },
            OrderStatus: { $in: SYNC_STATUSES }
        }).toArray(),

        // 2. TPX orders
        tpx_db.collection("tpx_orders").find(
            { $or: [{ created_at: { $gt: DATE_FILTER_SQL } }, { created_at: null }] },
            { projection: { txn_id: 1, store_type: 1 } }
        ).toArray(),

        // 3. SKU → vendor map
        ns_db.collection("suite_list").find(
            {}, { projection: { vendorname: 1, vendor: 1 } }
        ).toArray(),

        // 4. PO management
        po_db.collection("po_management").find({
            created_at: { $gt: DATE_FILTER_SQL }
        }).toArray()
    ]);

    // ── Build maps ────────────────────────────────────────────────────────
    const tpxMap = new Map<string, { store_type: string }>();
    for (const tpx of tpxDocs) {
        if (tpx?.txn_id) tpxMap.set(tpx.txn_id, { store_type: tpx.store_type || "" });
    }
    console.log(`[SO Stage] TPX map: ${tpxMap.size} entries`);

    const skuVendorMap = new Map<string, number>();
    for (const item of suiteDocs) {
        if (item?.vendorname && item?.vendor)
            skuVendorMap.set(String(item.vendorname).trim().toUpperCase(), item.vendor);
    }
    console.log(`[SO Stage] SKU→vendor map: ${skuVendorMap.size} entries`);

    const po_map = new Map<string, SimplePO[]>();
    for (const po of poDocs) {
        const orderId = po.website_order_number;
        if (!orderId) continue;
        let poVendor: number | null = null;
        if (Array.isArray(po.order_items) && po.order_items.length > 0) {
            const firstSku = String(po.order_items[0]?.sku || "").trim().toUpperCase();
            poVendor = skuVendorMap.get(firstSku) || null;
        }
        if (!po_map.has(orderId)) po_map.set(orderId, []);
        po_map.get(orderId)!.push({ po_number: po.po_number, po_vendor: poVendor, order_items: po.order_items || [] });
    }

    console.log(`[SO Stage] Amazon: ${amazonDocs.length}, PO map: ${po_map.size} order IDs`);

    // 5. Build sales orders
    console.log("[SO Stage] Building sales orders...");
    const sales_orders: SalesOrder[] = [];
    for (const order of amazonDocs) {
        const orderId = order?.AmazonOrderId;
        if (!orderId) continue;

        const tpxData = tpxMap.get(orderId);

        sales_orders.push({
            otherrefnum:        orderId,
            trandate:           new Date(order.PurchaseDate),
            store_type:         tpxData?.store_type || "amazon",
            order_status:       order.OrderStatus || "",
            fulfillment_channel: order.FulfillmentChannel || "",
            ship_date:          order.LatestShipDate || null,
            items_shipped:      Number(order.NumberOfItemsShipped || 0),
            items_unshipped:    Number(order.NumberOfItemsUnshipped || 0),
            items: (order.OrderItems || []).map((i: any) => ({
                item:     i?.SellerSKU,
                quantity: Number(i?.QuantityOrdered || 0),
                amount:   Number(i?.ItemPrice?.Amount || 0)
            })),
            po: po_map.get(orderId) || []
        });
    }

    // 6. Upsert into netsuite.suite_sales_order (staging)
    console.log(`[SO Stage] Step 6 — Upserting ${sales_orders.length} sales orders...`);
    if (sales_orders.length > 0) {
        await ns_db.collection<SalesOrder>("suite_sales_order").bulkWrite(
            sales_orders.map(order => ({
                updateOne: {
                    filter: { otherrefnum: order.otherrefnum },
                    update: { $set: order },
                    upsert: true
                }
            }))
        );
    }

    console.log(`[Stage] Staged ${sales_orders.length} sales orders to netsuite.suite_sales_order`);
    return { processed: sales_orders.length };
};
