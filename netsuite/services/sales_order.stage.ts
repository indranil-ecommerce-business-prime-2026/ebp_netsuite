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
    otherrefnum: string;
    trandate: Date;
    order_status: string;
    fulfillment_channel: string;
    ship_date: string | null;
    items_shipped: number;
    items_unshipped: number;
    location: string;
    ship_from: string;
    items: SalesItem[];
    po: SimplePO[];
}

export const stageSalesOrders = async (): Promise<{ processed: number }> => {
    console.log("[SO Stage] Starting...");

    const DATE_FILTER     = "2026-01-01T00:00:00Z";
    const DATE_FILTER_SQL = "2026-01-01 00:00:00";

    const SYNC_STATUSES = ["Unshipped", "PartiallyShipped", "Shipped", "InvoiceUnconfirmed"];

    // 1️⃣ Amazon orders
    console.log("[SO Stage] Step 1 — Fetching amazon_orders_v3...");
    const ebp_db = await getDb("ebp_marketplace");
    const amazon_cursor = ebp_db.collection("amazon_orders_v3").find({
        PurchaseDate: { $gt: DATE_FILTER },
        OrderStatus: { $in: SYNC_STATUSES }
    });

    // 2️⃣ TPX map (ship-to address)
    console.log("[SO Stage] Step 2 — Building TPX address map...");
    const tpx_cursor = (await getDb("tpx_orders")).collection("tpx_orders").find(
        { $or: [{ created_at: { $gt: DATE_FILTER_SQL } }, { created_at: null }] },
        { projection: { txn_id: 1, to: 1 } }
    );
    const tpxMap = new Map<string, any>();
    for await (const tpx of tpx_cursor) {
        if (tpx?.txn_id) tpxMap.set(tpx.txn_id, tpx.to);
    }
    console.log(`[SO Stage] TPX map: ${tpxMap.size} entries`);

    // 3️⃣ SKU → vendor map
    console.log("[SO Stage] Step 3 — Building SKU→vendor map...");
    const ns_db = await getDb("netsuite");
    const suite_cursor = ns_db.collection("suite_list").find({}, { projection: { vendorname: 1, vendor: 1 } });
    const skuVendorMap = new Map<string, number>();
    for await (const item of suite_cursor) {
        if (item?.vendorname && item?.vendor)
            skuVendorMap.set(String(item.vendorname).trim().toUpperCase(), item.vendor);
    }
    console.log(`[SO Stage] SKU→vendor map: ${skuVendorMap.size} entries`);

    // 4️⃣ PO map
    console.log("[SO Stage] Step 4 — Building PO map...");
    const po_cursor = (await getDb("ebp_pomanager")).collection("po_management").find({
        created_at: { $gt: DATE_FILTER_SQL }
    });
    const po_map = new Map<string, SimplePO[]>();
    for await (const po of po_cursor) {
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

    console.log(`[SO Stage] PO map: ${po_map.size} order IDs`);

    // 5️⃣ Build sales orders
    console.log("[SO Stage] Step 5 — Building sales orders...");
    const sales_orders: SalesOrder[] = [];
    for await (const order of amazon_cursor) {
        const orderId = order?.AmazonOrderId;
        if (!orderId) continue;

        const tpxAddress = tpxMap.get(orderId);
        const location = [tpxAddress?.Street, tpxAddress?.City, tpxAddress?.State, tpxAddress?.ZipCode]
            .filter(Boolean).map((v: string) => v.trim().toUpperCase()).join(", ");

        const shipFrom = order.DefaultShipFromLocationAddress;
        const ship_from = [shipFrom?.AddressLine1, shipFrom?.City, shipFrom?.StateOrRegion, shipFrom?.PostalCode]
            .filter(Boolean).map((v: string) => String(v).trim().toUpperCase()).join(", ");

        sales_orders.push({
            otherrefnum:        orderId,
            trandate:           new Date(order.PurchaseDate),
            order_status:       order.OrderStatus || "",
            fulfillment_channel: order.FulfillmentChannel || "",
            ship_date:          order.LatestShipDate || null,
            items_shipped:      Number(order.NumberOfItemsShipped || 0),
            items_unshipped:    Number(order.NumberOfItemsUnshipped || 0),
            location,
            ship_from,
            items: (order.OrderItems || []).map((i: any) => ({
                item:     i?.SellerSKU,
                quantity: Number(i?.QuantityOrdered || 0),
                amount:   Number(i?.ItemPrice?.Amount || 0)
            })),
            po: po_map.get(orderId) || []
        });
    }

    // 6️⃣ Upsert into netsuite.suite_sales_order (staging)
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
