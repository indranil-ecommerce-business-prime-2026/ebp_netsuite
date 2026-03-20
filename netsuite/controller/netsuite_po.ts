import { Request, Response } from "express";
import { getDb } from "../config/mongdodb.config";
import { callDiagnostic } from "../services/netsuite.client";
import log from "../config/logger.config";

const trim = (v: any) => (v == null ? "" : String(v).trim());
const toNum = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/**
 * Maps a NetSuite PO (from the RESTlet) to the netsuite_purchase_order schema.
 */
export function mapPO(ns: any) {
    return {
        netsuite_internal_id: toNum(ns.internalid),
        tranid: trim(ns.tranid) || null,
        otherrefnum: trim(ns.otherrefnum) || null,
        vendor_name: trim(ns.entity_text) || null,
        vendor_id: ns.entity || null,
        subsidiary: trim(ns.subsidiary_text) || null,
        subsidiary_id: ns.subsidiary || null,
        trandate: trim(ns.trandate) || null,
        status: trim(ns.status_text || ns.status) || null,
        status_id: trim(ns.status) || null,
        memo: trim(ns.memo) || null,
        custom_form: trim(ns.customform_text) || null,
        custom_form_id: ns.customform || null,
        custom_status: trim(ns.custbody1) || null,
        distributor_order_number: trim(ns.custbody2) || null,
        line_items: Array.isArray(ns.line_items)
            ? ns.line_items.map(mapPOLine)
            : [],
    };
}

function mapPOLine(line: any) {
    return {
        item_id: line.item || null,
        item_name: trim(line.item_text) || null,
        quantity: toNum(line.quantity),
        rate: toNum(line.rate),
        amount: toNum(line.amount),
    };
}

/**
 * GET /netsuite-po?pageSize=200
 *
 * Fetches ALL purchase orders from NetSuite ERP via the diagnostic RESTlet's
 * fetch_all_po section, then upserts into netsuite.netsuite_purchase_order.
 */
export const syncNetsuitePOs = async (req: Request, res: Response) => {
    const pageSize = Math.min(Number(req.query.pageSize) || 200, 1000);

    try {
        const nsDb = await getDb("netsuite");
        const col = nsDb.collection("netsuite_purchase_order");

        await col.createIndex({ netsuite_internal_id: 1 }, { unique: true });

        let page = 0;
        let totalInserted = 0;
        let totalUpdated = 0;
        let totalPulled = 0;
        let done = false;

        while (!done) {
            log.info(`[PO-FETCH] Fetching page ${page} (pageSize: ${pageSize})...`);

            const response = await callDiagnostic({
                sections: ["fetch_all_po"],
                page,
                pageSize,
            });

            const batch = response?.fetch_all_po;

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

            const pos: any[] = batch.purchase_orders || [];
            totalPulled += pos.length;

            if (pos.length > 0) {
                const ops = pos
                    .map(mapPO)
                    .filter((doc) => doc.netsuite_internal_id)
                    .map((doc) => ({
                        updateOne: {
                            filter: { netsuite_internal_id: doc.netsuite_internal_id },
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

            log.info(`[PO-FETCH] Page ${page}: ${pos.length} POs (total: ${totalPulled}/${batch.total})`);

            done = batch.done || pos.length === 0;
            page++;
        }

        log.info(`[PO-FETCH] Done. Pulled: ${totalPulled}, inserted: ${totalInserted}, updated: ${totalUpdated}`);

        return res.json({
            success: true,
            totalPulled,
            inserted: totalInserted,
            updated: totalUpdated,
            pages: page,
        });
    } catch (err: any) {
        log.error("[PO-FETCH] Error:", err);
        return res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
};
