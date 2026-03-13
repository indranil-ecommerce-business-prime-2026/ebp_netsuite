import { getDb } from "../config/mongdodb.config";

// Distributor name → NetSuite vendor internalId
const VENDOR_MAP: Record<string, number> = {
    "d&h":    118,
    "synnex": 117,
    "ingram": 133,
    "supnet": 131
};

interface POItem {
    sku:  string;
    qty:  string | number;
    cost: string | number;
}

export interface StagedPO {
    po_number:                number;
    website_order_number:     string;
    distributor:              string;
    distributor_order_number: string | number | null;
    status:                   string;
    invoice:                  any[];
    vendor_id:                number | null;
    tracking:                 string | null;
    order_items:              POItem[];
    created_at:               string;
    updated_at:               string;
}

export const stagePurchaseOrders = async (): Promise<{ processed: number }> => {
    console.log("[PO Stage] Starting...");

    const po_db = await getDb("ebp_pomanager");
    console.log("[PO Stage] Connected to ebp_pomanager");
    const ns_db = await getDb("netsuite");
    console.log("[PO Stage] Connected to netsuite");

    // ── Filter: only POs that are shipped OR have at least one invoice entry ──
    console.log("[PO Stage] Querying po_management (shipped or has invoice)...");
    const po_cursor = po_db.collection("po_management").find({
        $or: [
            { status:     { $regex: /shipped/i } },
            { "invoice.0": { $exists: true } }        // array has at least 1 element
        ]
    });

    const staged: StagedPO[] = [];

    for await (const po of po_cursor) {
        if (!po.po_number) continue;

        // Resolve vendor ID from distributor string (e.g. "D&H" → 118)
        const distributorKey = String(po.distributor || "").trim().toLowerCase();
        const vendor_id = VENDOR_MAP[distributorKey] ?? null;

        staged.push({
            po_number:                po.po_number,
            website_order_number:     po.website_order_number     || "",
            distributor:              po.distributor               || "",
            distributor_order_number: po.distributor_order_number  ?? null,
            status:                   po.status                    || "",
            invoice:                  Array.isArray(po.invoice) ? po.invoice : [],
            vendor_id,
            tracking:                 po.tracking ?? null,
            order_items:              po.order_items || [],
            created_at:               po.created_at  || "",
            updated_at:               po.updated_at  || ""
        });
    }

    console.log(`[PO Stage] Found ${staged.length} POs matching filter`);

    if (staged.length > 0) {
        console.log("[PO Stage] Upserting to netsuite.suite_purchase_order...");
        await ns_db.collection<StagedPO>("suite_purchase_order").bulkWrite(
            staged.map(po => ({
                updateOne: {
                    filter: { po_number: po.po_number },
                    update: { $set: po },
                    upsert: true
                }
            }))
        );
    }

    console.log(`[PO Stage] Staged ${staged.length} purchase orders to netsuite.suite_purchase_order`);
    return { processed: staged.length };
};
