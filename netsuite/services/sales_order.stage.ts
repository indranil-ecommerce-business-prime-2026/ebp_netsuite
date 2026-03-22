import { getDb } from "../config/mongdodb.config";
import log from "../config/logger.config";

// ── Interfaces ──────────────────────────────────────────────────────────────

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

interface ShippingAddress {
    addressee: string;      // recipient name
    company: string;        // company name
    addr1: string;          // street line 1
    addr2: string;          // street line 2
    city: string;
    state: string;          // state/region code
    zip: string;            // postal code
    country: string;        // 2-letter country code (US, CA, etc.)
}

interface SalesOrder {
    otherrefnum: string;                    // Order ID (unique key, maps to PO # in NetSuite)
    trandate: Date;                         // Order purchase date
    store_type: string;                     // drives Customer + Channel lookups in NetSuite
    order_source: string;                   // "amazon" | "newegg" | "walmart" | "tpx"
    order_status: string;
    fulfillment_channel: string;
    ship_date: string | null;
    items_shipped: number;
    items_unshipped: number;
    items: SalesItem[];
    po: SimplePO[];
    shipping_address: ShippingAddress | null;
}

// ── Source Adapters ─────────────────────────────────────────────────────────

function buildAmazonOrders(
    amazonDocs: any[],
    tpxMap: Map<string, { store_type: string }>,
    po_map: Map<string, SimplePO[]>
): SalesOrder[] {
    const orders: SalesOrder[] = [];
    for (const order of amazonDocs) {
        const orderId = order?.AmazonOrderId;
        if (!orderId) continue;

        const tpxData = tpxMap.get(orderId);
        const addr = order.ShippingAddress;

        orders.push({
            otherrefnum:        orderId,
            trandate:           new Date(order.PurchaseDate),
            store_type:         tpxData?.store_type || "amazon",
            order_source:       "amazon",
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
            po: po_map.get(orderId) || [],
            shipping_address: addr ? {
                addressee: "",
                company:   addr.CompanyName || "",
                addr1:     "",
                addr2:     "",
                city:      addr.City || "",
                state:     addr.StateOrRegion || "",
                zip:       addr.PostalCode || "",
                country:   addr.CountryCode || "US",
            } : null,
        });
    }
    return orders;
}

function buildNeweggOrders(
    neweggDocs: any[],
    po_map: Map<string, SimplePO[]>
): SalesOrder[] {
    const orders: SalesOrder[] = [];
    for (const order of neweggDocs) {
        const orderId = order?.OrderNumber != null ? String(order.OrderNumber) : null;
        if (!orderId) continue;

        const itemList = Array.isArray(order.ItemInfoList) ? order.ItemInfoList : [];
        const orderQty = Number(order.OrderQty || itemList.length || 1);
        const orderAmount = Number(order.OrderItemAmount || order.OrderTotalAmount || 0);

        orders.push({
            otherrefnum:        orderId,
            trandate:           order.OrderDate ? new Date(order.OrderDate) : new Date(),
            store_type:         "newegg",
            order_source:       "newegg",
            order_status:       order.OrderStatusDescription || order.OrderStatus || "",
            fulfillment_channel: order.FulfillmentOption || "MFN",
            ship_date:          order.ShipDate || null,
            items_shipped:      Number(order.ItemsShipped || 0),
            items_unshipped:    Number(order.ItemsUnshipped || orderQty),
            items: itemList.length > 0
                ? itemList.map((i: any) => ({
                    item:     i?.SellerPartNumber || i?.MfrPartNumber || "",
                    quantity: Number(i?.Quantity || (itemList.length === 1 ? orderQty : 1)),
                    amount:   Number(i?.UnitPrice || (itemList.length === 1 ? orderAmount : 0)),
                }))
                : [],
            po: po_map.get(orderId) || [],
            shipping_address: {
                addressee: [order.ShipToFirstName, order.ShipToLastName].filter(Boolean).join(" "),
                company:   order.ShipToCompany || "",
                addr1:     order.ShipToAddress1 || "",
                addr2:     order.ShipToAddress2 || "",
                city:      order.ShipToCityName || "",
                state:     order.ShipToStateCode || "",
                zip:       order.ShipToZipCode || "",
                country:   order.ShipToCountryCode || "US",
            },
        });
    }
    return orders;
}

function buildWalmartOrders(
    walmartDocs: any[],
    po_map: Map<string, SimplePO[]>
): SalesOrder[] {
    const orders: SalesOrder[] = [];
    for (const order of walmartDocs) {
        const orderId = order?.orderNumber != null ? String(order.orderNumber) : null;
        if (!orderId) continue;

        // orderDate can be "0000-00-00 00:00:00" — fall back to createdAt
        let trandate = order.orderDate ? new Date(order.orderDate) : null;
        if (!trandate || isNaN(trandate.getTime()) || trandate.getFullYear() < 2000) {
            trandate = order.createdAt ? new Date(order.createdAt) : new Date();
        }

        // Extract line items from orderLines.orderLine[]
        const lineItems = Array.isArray(order.orderLines?.orderLine) ? order.orderLines.orderLine : [];
        const items: SalesItem[] = lineItems.map((line: any) => {
            const sku = line?.item?.sku || "";
            const qty = Number(line?.orderLineQuantity?.amount || 1);
            // Find PRODUCT charge for the item price
            const charges = Array.isArray(line?.charges?.charge) ? line.charges.charge : [];
            const productCharge = charges.find((c: any) => c.chargeType === "PRODUCT");
            const amount = Number(productCharge?.chargeAmount?.amount || 0);
            return { item: sku, quantity: qty, amount };
        });

        // Resolve top-level status from line statuses or top-level
        const topStatus = order.status || "";

        // Ship date from shippingInfo.estimatedShipDate (epoch ms)
        let shipDate: string | null = null;
        if (order.shippingInfo?.estimatedShipDate) {
            shipDate = new Date(order.shippingInfo.estimatedShipDate).toISOString();
        }

        // Shipping address from shippingInfo.postalAddress
        const addr = order.shippingInfo?.postalAddress;
        // Walmart uses "USA" (3-letter) — normalize to 2-letter
        let countryCode = addr?.country || "US";
        if (countryCode === "USA") countryCode = "US";
        if (countryCode === "CAN") countryCode = "CA";

        orders.push({
            otherrefnum:        orderId,
            trandate,
            store_type:         "walmart",
            order_source:       "walmart",
            order_status:       topStatus,
            fulfillment_channel: lineItems[0]?.fulfillment?.shipMethod || "MFN",
            ship_date:          shipDate,
            items_shipped:      topStatus === "Delivered" || topStatus === "Shipped" ? items.length : 0,
            items_unshipped:    topStatus === "Delivered" || topStatus === "Shipped" ? 0 : items.length,
            items,
            po: po_map.get(orderId) || [],
            shipping_address: addr ? {
                addressee: addr.name || "",
                company:   "",
                addr1:     addr.address1 || "",
                addr2:     addr.address2 || "",
                city:      addr.city || "",
                state:     addr.state || "",
                zip:       addr.postalCode || "",
                country:   countryCode,
            } : null,
        });
    }
    return orders;
}

function buildTpxOrders(
    tpxDocs: any[],
    po_map: Map<string, SimplePO[]>
): SalesOrder[] {
    const orders: SalesOrder[] = [];
    for (const order of tpxDocs) {
        const orderId = order?.txn_id;
        if (!orderId) continue;

        // store_type comes directly from the document (shopify, ebay)
        const storeType = (order.store_type || "").toLowerCase();

        // Date: use order_details.PaymentDate or created_at as fallback
        let trandate = order.order_details?.PaymentDate ? new Date(order.order_details.PaymentDate) : null;
        if (!trandate || isNaN(trandate.getTime())) {
            trandate = order.created_at ? new Date(order.created_at) : new Date();
        }

        // Items from order_items[]
        const rawItems = Array.isArray(order.order_items) ? order.order_items : [];
        const items: SalesItem[] = rawItems.map((i: any) => ({
            item:     i?.Name || "",
            quantity: Number(i?.Quantity || 1),
            amount:   Number(i?.Amount || 0),
        }));

        // Ship date from shipping_details.ShipDate
        const shipDate = order.shipping_details?.ShipDate || null;

        // Shipping address from "to" object
        const addr = order.to;

        orders.push({
            otherrefnum:        orderId,
            trandate,
            store_type:         storeType,
            order_source:       "tpx",
            order_status:       order.payment_status || "",
            fulfillment_channel: order.order_details?.ShipClass || "MFN",
            ship_date:          shipDate,
            items_shipped:      order.shipped ? items.length : 0,
            items_unshipped:    order.shipped ? 0 : items.length,
            items,
            po: po_map.get(orderId) || [],
            shipping_address: addr ? {
                addressee: addr.Name || "",
                company:   addr.Company || "",
                addr1:     addr.Street || "",
                addr2:     addr.Street2 || "",
                city:      addr.City || "",
                state:     addr.State || "",
                zip:       addr.ZipCode || "",
                country:   addr.CountryCode || "US",
            } : null,
        });
    }
    return orders;
}

// ── Main Staging Function ───────────────────────────────────────────────────

export const stageSalesOrders = async (): Promise<{ processed: number }> => {
    log.info("[SO Stage] Starting...");

    const DATE_FILTER     = "2026-01-01T00:00:00Z";
    const DATE_FILTER_SQL = "2026-01-01 00:00:00";

    const SYNC_STATUSES = ["Unshipped", "PartiallyShipped", "Shipped", "InvoiceUnconfirmed"];

    // ── Fetch all DB connections in parallel ────────────────────────────────
    log.info("[SO Stage] Fetching data sources in parallel...");

    const [ebp_db, tpx_db, ns_db, po_db, newegg_db, walmart_db] = await Promise.all([
        getDb("ebp_marketplace"),
        getDb("tpx_orders"),
        getDb("netsuite"),
        getDb("ebp_pomanager"),
        getDb("new_eggs"),
        getDb("walmart"),
    ]);

    // ── Fetch all data sources concurrently ─────────────────────────────────
    const [amazonDocs, tpxDocs, suiteDocs, poDocs, neweggDocs, walmartDocs, tpxOrderDocs] = await Promise.all([
        // 1. Amazon orders
        ebp_db.collection("amazon_orders_v3").find({
            PurchaseDate: { $gt: DATE_FILTER },
            OrderStatus: { $in: SYNC_STATUSES }
        }).toArray(),

        // 2. TPX orders (store_type lookup for Amazon orders)
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
        }).toArray(),

        // 5. Newegg BB orders
        newegg_db.collection("newegg_bb_orders_v2").find({
            OrderDate: { $gt: DATE_FILTER }
        }).toArray(),

        // 6. Walmart orders
        walmart_db.collection("walmart_orders_v2").find({
            createdAt: { $gt: new Date(DATE_FILTER) }
        }).toArray(),

        // 7. TPX orders for Shopify/eBay (full documents, not just store_type lookup)
        tpx_db.collection("tpx_orders").find({
            store_type: { $in: ["shopify", "ebay"] },
            $or: [{ created_at: { $gt: DATE_FILTER_SQL } }, { created_at: null }]
        }).toArray(),
    ]);

    // ── Build shared lookup maps ────────────────────────────────────────────
    const tpxMap = new Map<string, { store_type: string }>();
    for (const tpx of tpxDocs) {
        if (tpx?.txn_id) tpxMap.set(tpx.txn_id, { store_type: tpx.store_type || "" });
    }
    log.info(`[SO Stage] TPX map: ${tpxMap.size} entries`);

    const skuVendorMap = new Map<string, number>();
    for (const item of suiteDocs) {
        if (item?.vendorname && item?.vendor)
            skuVendorMap.set(String(item.vendorname).trim().toUpperCase(), item.vendor);
    }
    log.info(`[SO Stage] SKU→vendor map: ${skuVendorMap.size} entries`);

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

    log.info(`[SO Stage] Sources — Amazon: ${amazonDocs.length}, Newegg: ${neweggDocs.length}, Walmart: ${walmartDocs.length}, TPX(Shopify/eBay): ${tpxOrderDocs.length}, PO map: ${po_map.size} order IDs`);

    // ── Build sales orders from all sources ─────────────────────────────────
    log.info("[SO Stage] Building sales orders from all sources...");

    const amazonOrders  = buildAmazonOrders(amazonDocs, tpxMap, po_map);
    const neweggOrders  = buildNeweggOrders(neweggDocs, po_map);
    const walmartOrders = buildWalmartOrders(walmartDocs, po_map);
    const tpxOrders     = buildTpxOrders(tpxOrderDocs, po_map);

    const sales_orders: SalesOrder[] = [
        ...amazonOrders,
        ...neweggOrders,
        ...walmartOrders,
        ...tpxOrders,
    ];

    log.info(`[SO Stage] Built — Amazon: ${amazonOrders.length}, Newegg: ${neweggOrders.length}, Walmart: ${walmartOrders.length}, TPX: ${tpxOrders.length}, Total: ${sales_orders.length}`);

    // ── Upsert into netsuite.suite_sales_order (staging) ────────────────────
    log.info(`[SO Stage] Upserting ${sales_orders.length} sales orders...`);
    if (sales_orders.length > 0) {
        await ns_db.collection<SalesOrder>("suite_sales_order").bulkWrite(
            sales_orders.map(order => ({
                updateOne: {
                    filter: { otherrefnum: order.otherrefnum, order_source: order.order_source },
                    update: { $set: order },
                    upsert: true
                }
            }))
        );
    }

    log.info(`[SO Stage] Staged ${sales_orders.length} sales orders to netsuite.suite_sales_order`);
    return { processed: sales_orders.length };
};
