import { Request, Response } from "express";
import { getDb } from "../config/mongdodb.config";

/* ============================
   Interfaces
============================ */

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
    po_vendor: number | null;   // ✅ Added
    order_items: SimplePOItem[];
}

interface SalesOrder {
    otherrefnum: string;
    trandate: Date;
    location: string;
    items: SalesItem[];
    po: SimplePO[];
}

/* ============================
   Controller
============================ */

export const sales_order = async (req: Request, res: Response) => {
    try {

        const DATE_FILTER = "2026-01-01T00:00:00Z";
        const DATE_FILTER_SQL = "2026-01-01 00:00:00";

        /* ============================
           1️⃣ AMAZON ORDERS
        ============================ */

        const ebp_db = await getDb("ebp_marketplace");
        const amazon_orders = ebp_db.collection("amazon_orders_v3");

        const amazon_cursor = amazon_orders.find({
            PurchaseDate: { $gt: DATE_FILTER }
        });

        /* ============================
           2️⃣ TPX MAP
        ============================ */

        const tpx_db = await getDb("tpx_orders");
        const tpx_table = tpx_db.collection("tpx_orders");

        const tpx_cursor = tpx_table.find(
            {
                $or: [
                    { created_at: { $gt: DATE_FILTER_SQL } },
                    { created_at: null }
                ]
            },
            { projection: { txn_id: 1, to: 1 } }
        );

        const tpxMap = new Map<string, any>();

        for await (const tpx of tpx_cursor) {
            if (tpx?.txn_id) {
                tpxMap.set(tpx.txn_id, tpx.to);
            }
        }

        /* ============================
           3️⃣ LOAD SKU → VENDOR MAP
        ============================ */

        const ns_db = await getDb("netsuite");
        const suite_list = ns_db.collection("suite_list");

        const suite_cursor = suite_list.find(
            {},
            { projection: { vendorname: 1, vendor: 1 } }
        );

        const skuVendorMap = new Map<string, number>();

        for await (const item of suite_cursor) {
            if (item?.vendorname && item?.vendor) {
                skuVendorMap.set(
                    String(item.vendorname).trim().toUpperCase(),
                    item.vendor
                );
            }
        }

        /* ============================
           4️⃣ BUILD PO MAP (WITH VENDOR)
        ============================ */

        const po_db = await getDb("ebp_pomanager");
        const po_table = po_db.collection("po_management");

        const po_cursor = po_table.find({
            created_at: { $gt: DATE_FILTER_SQL }
        });

        const po_map = new Map<string, SimplePO[]>();

        for await (const po of po_cursor) {

            const orderId = po.website_order_number;
            if (!orderId) continue;

            let poVendor: number | null = null;

            // Resolve vendor from first SKU in PO
            if (Array.isArray(po.order_items) && po.order_items.length > 0) {

                const firstSku = String(po.order_items[0]?.sku || "")
                    .trim()
                    .toUpperCase();

                poVendor = skuVendorMap.get(firstSku) || null;
            }

            const simplePO: SimplePO = {
                po_number: po.po_number,
                po_vendor: poVendor,
                order_items: po.order_items || []
            };

            if (!po_map.has(orderId)) {
                po_map.set(orderId, []);
            }

            po_map.get(orderId)!.push(simplePO);
        }

        /* ============================
           5️⃣ BUILD SALES ORDERS
        ============================ */

        const sales_orders: SalesOrder[] = [];

        for await (const order of amazon_cursor) {

            const orderId = order?.AmazonOrderId;
            if (!orderId) continue;

            const tpxAddress = tpxMap.get(orderId);

            const location = [
                tpxAddress?.Street,
                tpxAddress?.City,
                tpxAddress?.State,
                tpxAddress?.ZipCode
            ]
                .filter(Boolean)
                .map((v: string) => v.trim().toUpperCase())
                .join(", ");

            const items: SalesItem[] = (order.OrderItems || []).map((i: any) => ({
                item: i?.SellerSKU,
                quantity: Number(i?.QuantityOrdered || 0),
                amount: Number(i?.ItemPrice?.Amount || 0)
            }));

            const po_entries = po_map.get(orderId) || [];

            const sales_item: SalesOrder = {
                otherrefnum: orderId,
                trandate: new Date(order.PurchaseDate),
                location,
                items,
                po: po_entries
            };

            sales_orders.push(sales_item);
        }

        /* ============================
           6️⃣ SAVE TO NETSUITE
        ============================ */

        const suite_sales_order =
            ns_db.collection<SalesOrder>("suite_sales_order");

        if (sales_orders.length > 0) {

            const bulkOps = sales_orders.map(order => ({
                updateOne: {
                    filter: { otherrefnum: order.otherrefnum },
                    update: { $set: order },
                    upsert: true
                }
            }));

            await suite_sales_order.bulkWrite(bulkOps);
        }

        return res.json({
            success: true,
            processed: sales_orders.length
        });

    } catch (e: any) {

        console.error("Sales Order Error:", e);

        return res.status(500).json({
            success: false,
            message: "Internal Server Error",
            error: e.message
        });
    }
};