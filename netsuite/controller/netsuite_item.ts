import { Request, Response } from "express";
import { getDb } from "../config/mongdodb.config";
import { callDiagnostic } from "../services/netsuite.client";
import log from "../config/logger.config";

const trim = (v: any) => (v == null ? "" : String(v).trim());
const toNum = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const normalizeValue = (v: any) => trim(v).toLowerCase().replace(/[\s\-]+/g, "");

/**
 * Maps a NetSuite item (from the RESTlet) to the netsuite_product_list schema.
 */
export function mapItem(ns: any) {
    const sku = trim(ns.itemid);
    const upc = trim(ns.upccode);

    // Synnex warehouse quantities
    const synnexWh = [
        toNum(ns.custitem22), toNum(ns.custitem23), toNum(ns.custitem24),
        toNum(ns.custitem25), toNum(ns.custitem27), toNum(ns.custitem28),
        toNum(ns.custitem51), toNum(ns.custitem52), toNum(ns.custitem53),
        toNum(ns.custitem54), toNum(ns.custitem55),
    ].filter((v): v is number => v !== null);
    const synnexQty = synnexWh.length ? synnexWh.reduce((a, b) => a + b, 0) : null;

    // D&H total
    const dandhWh = [
        toNum(ns.custitem29), toNum(ns.custitem30), toNum(ns.custitem31), toNum(ns.custitem32)
    ].filter((v): v is number => v !== null);
    const dandhQty = toNum(ns.custitem58) ?? (dandhWh.length ? dandhWh.reduce((a, b) => a + b, 0) : null);

    // Ingram total
    const ingramWh = [
        toNum(ns.custitem33), toNum(ns.custitem34), toNum(ns.custitem35),
        toNum(ns.custitem49), toNum(ns.custitem50)
    ].filter((v): v is number => v !== null);
    const ingramQty = toNum(ns.custitem57) ?? (ingramWh.length ? ingramWh.reduce((a, b) => a + b, 0) : null);

    // Supplies total
    const suppliesWh = [
        toNum(ns.custitem18), toNum(ns.custitem19), toNum(ns.custitem20), toNum(ns.custitem21)
    ].filter((v): v is number => v !== null);
    const suppliesCount = toNum(ns.custitem59) ?? (suppliesWh.length ? suppliesWh.reduce((a, b) => a + b, 0) : null);

    // Build distributor list from available quantities
    const distributors: string[] = [];
    if (synnexQty && synnexQty > 0) distributors.push("synnex");
    if (dandhQty && dandhQty > 0) distributors.push("dandh");
    if (ingramQty && ingramQty > 0) distributors.push("ingram");
    if (suppliesCount && suppliesCount > 0) distributors.push("supplies");

    // Category from class text (may have L1:L2:L3 format)
    const classText = trim(ns.class_text || ns.class);
    const classParts = classText ? classText.split(":").map((s: string) => s.trim()) : [];

    return {
        netsuite_internal_id: toNum(ns.internalid),
        sku,
        normalized_sku: normalizeValue(sku),
        upc,
        normalized_upc: normalizeValue(upc),
        manufacturer_map: trim(ns.custitem2) || null,

        synnex_response: null,
        synnex_price: null,
        synnex_quantity: synnexQty,

        dandh_response: null,
        dandh_price: null,
        dandh_quantity: dandhQty,

        almo_response: null,
        almo_price: null,
        almo_quantity: null,

        ingram_response: null,
        ingram_price: null,
        ingram_quantity: ingramQty,

        supplies_response: null,
        supplies_price: null,
        supplies_count: suppliesCount,

        distributor_list: distributors.length ? distributors : null,

        category_class: classParts[0] || null,
        category_class_l2: classParts[1] || null,
        category_class_l3: classParts[2] || null,
        category_supplies: null,
        category_dandh: null,
        category_ingram: null,

        condition: trim(ns.custitem1) || null,
        name: trim(ns.displayname) || null,
        name_source: "netsuite",
        uploaded_file_url: null,
        priority: null,

        item_type: trim(ns.type_text || ns.type) || null,
        base_price: toNum(ns.baseprice),
        cost: toNum(ns.cost),
        vendor_name: trim(ns.vendor_text) || null,
        vendor_id: ns.vendor || null,
        synnex_sku: trim(ns.custitem36) || null,
        dandh_part_number: trim(ns.custitem38) || null,
        supplies_sku: trim(ns.custitem39) || null,
        ingram_part_number: trim(ns.custitem40) || null,
    };
}

/**
 * GET /netsuite-items?pageSize=500
 *
 * Fetches ALL items from NetSuite ERP via the diagnostic RESTlet's
 * fetch_all_items section, then upserts into netsuite.netsuite_product_list.
 */
export const syncNetsuiteItems = async (req: Request, res: Response) => {
    const pageSize = Math.min(Number(req.query.pageSize) || 500, 1000);

    try {
        const nsDb = await getDb("netsuite");
        const col = nsDb.collection("netsuite_product_list");

        await col.createIndex({ sku: 1 }, { unique: true });

        let page = 0;
        let totalInserted = 0;
        let totalUpdated = 0;
        let totalPulled = 0;
        let done = false;

        while (!done) {
            log.info(`[ITEM-SYNC] Fetching page ${page} (pageSize: ${pageSize})...`);

            const response = await callDiagnostic({
                sections: ["fetch_all_items"],
                page,
                pageSize,
            });

            const batch = response?.fetch_all_items;

            if (!batch || batch.error) {
                return res.status(500).json({
                    success: false,
                    error: batch?.error || "RESTlet returned failure",
                    pagesCompleted: page,
                    totalInserted,
                    totalUpdated,
                    totalPulled,
                });
            }

            const items: any[] = batch.items || [];
            totalPulled += items.length;

            if (items.length > 0) {
                const ops = items
                    .map(mapItem)
                    .filter((doc) => doc.sku)
                    .map((doc) => ({
                        updateOne: {
                            filter: { sku: doc.sku },
                            update: {
                                $set: { ...doc, updated_at: new Date() },
                                $setOnInsert: { created_at: new Date() },
                            },
                            upsert: true,
                        },
                    }));

                if (ops.length > 0) {
                    const bulkResult: any = await col.bulkWrite(ops, { ordered: false });
                    totalInserted += bulkResult.upsertedCount ?? 0;
                    totalUpdated += bulkResult.modifiedCount ?? 0;
                }
            }

            log.info(`[ITEM-SYNC] Page ${page}: ${items.length} items (total: ${totalPulled}/${batch.total})`);

            done = batch.done || items.length === 0;
            page++;
        }

        log.info(`[ITEM-SYNC] Done. Pulled: ${totalPulled}, inserted: ${totalInserted}, updated: ${totalUpdated}`);

        return res.json({
            success: true,
            totalPulled,
            inserted: totalInserted,
            updated: totalUpdated,
            pages: page,
        });
    } catch (err: any) {
        log.error("[ITEM-SYNC] Error:", err);
        return res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
};
