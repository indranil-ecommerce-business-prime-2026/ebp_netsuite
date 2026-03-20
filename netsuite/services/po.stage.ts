import { getDb } from "../config/mongdodb.config";
import log from "../config/logger.config";

// Distributor (DB value) + payment_type → { vendor name, NetSuite vendor ID }
// Default = non-DLL variant (NET/TERM)
const VENDOR_MAP: Record<string, { default: { name: string; id: number }; dll: { name: string; id: number } }> = {
    "dandh": {
        default: { name: "D&H",                          id: 119 },
        dll:     { name: "D&H - DLL",                    id: 118 }
    },
    "ingram": {
        default: { name: "Ingram Micro - NET",           id: 133 },
        dll:     { name: "Ingram Micro - DLL",            id: 269 }
    },
    "suppliesnetwork": {
        default: { name: "Distribution Management",      id: 268 },
        dll:     { name: "Distribution Management - DLL", id: 131 }
    },
    "synnex": {
        default: { name: "TD Synnex - Term",             id: 116 },
        dll:     { name: "TD Synnex - DLL",               id: 117 }
    }
};

function resolveVendor(distributor: string, payment_type: string): { name: string; id: number | null } {
    const key = (distributor || "").trim().toLowerCase();
    const isDLL = (payment_type || "").trim().toUpperCase() === "DLL";

    const entry = VENDOR_MAP[key];
    if (!entry) {
        log.warn(`[PO Stage] Unknown distributor: "${distributor}" — vendor_id will be null`);
        return { name: distributor || "", id: null };
    }

    return isDLL ? entry.dll : entry.default;
}

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
    po_type:                  string;         // "Dropship" | "Stocking" | ""
    stocking_warehouse:       string;         // "MW" | "W2G-PA" | "W2G-IL" | "W2G-KY" | "W2G-TX" | ""
    created_at:               string;
    updated_at:               string;
}

export const stagePurchaseOrders = async (): Promise<{ processed: number }> => {
    log.info("[PO Stage] Starting...");

    const po_db = await getDb("ebp_pomanager");
    log.info("[PO Stage] Connected to ebp_pomanager");
    const ns_db = await getDb("netsuite");
    log.info("[PO Stage] Connected to netsuite");

    // ── Filter: only POs after 2026-01-01 with status Shipped or Invoiced ──
    log.info("[PO Stage] Querying po_management (Shipped/Invoiced, created >= 2026-01-01)...");
    const po_cursor = po_db.collection("po_management").find({
        status: { $in: ["Shipped", "Invoiced"] },
        created_at: { $gte: "2026-01-01" }
    });

    const staged: StagedPO[] = [];

    for await (const po of po_cursor) {
        if (!po.po_number) continue;

        // Resolve vendor from distributor + payment_type (e.g. "dandh" + "DLL" → D&H - DLL, 118)
        const vendor = resolveVendor(po.distributor, po.payment_type);

        if (!po.po_type) {
            log.warn(`[PO Stage] PO ${po.po_number} has no po_type — will not trigger Dropship flow`);
        }

        staged.push({
            po_number:                po.po_number,
            website_order_number:     po.website_order_number     || "",
            distributor:              vendor.name,
            distributor_order_number: po.distributor_order_number  ?? null,
            status:                   po.status                    || "",
            invoice:                  Array.isArray(po.invoice) ? po.invoice : [],
            vendor_id:                vendor.id,
            tracking:                 po.tracking ?? null,
            order_items:              po.order_items || [],
            po_type:                  po.po_type                  || "",
            stocking_warehouse:       po.stocking_warehouse       || "",
            created_at:               po.created_at  || "",
            updated_at:               po.updated_at  || ""
        });
    }

    log.info(`[PO Stage] Found ${staged.length} POs matching filter`);

    if (staged.length > 0) {
        log.info("[PO Stage] Upserting to netsuite.suite_purchase_order...");
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

    log.info(`[PO Stage] Staged ${staged.length} purchase orders to netsuite.suite_purchase_order`);
    return { processed: staged.length };
};
