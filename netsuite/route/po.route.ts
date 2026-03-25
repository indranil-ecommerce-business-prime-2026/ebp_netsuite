import { Router } from "express";
import log from "../config/logger.config";
import { getDb } from "../config/mongdodb.config";
import { syncPurchaseOrdersToNetsuite, retryFailedPurchaseOrders } from "../services/po.sync";
import { stagePurchaseOrders } from "../services/po.stage";
import { postToNetsuiteForPO } from "../services/netsuite.client";

const router = Router();

// ─── Direct PO RESTlet call ─────────────────────────────────────────────────
router.post("/po-test", async (req: any, res: any) => {
    try {
        const result = await postToNetsuiteForPO(req.body);
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

// ─── Stage POs (ebp_pomanager → suite_purchase_order) ───────────────────────
router.get("/stage-po", async (_req: any, res: any) => {
    try {
        const result = await stagePurchaseOrders();
        res.json({ success: true, ...result });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Sync POs (suite_purchase_order → NetSuite ERP) ─────────────────────────
router.get("/sync-po", async (_req: any, res: any) => {
    try {
        const results = await syncPurchaseOrdersToNetsuite();
        res.json({ success: true, count: results.length, results });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Reset PO sync flags (clean sync) ───────────────────────────────────────
// GET  /reset-po-sync → dry-run (count docs with ns_ flags)
// POST /reset-po-sync → unset all ns_ fields
router.get("/reset-po-sync", async (_req: any, res: any) => {
    try {
        const nsDb = await getDb("netsuite");
        const col = nsDb.collection("suite_purchase_order");
        const count = await col.countDocuments({
            $or: [
                { ns_synced: true },
                { ns_failed: true },
                { ns_error: { $exists: true } },
                { ns_retry_count: { $exists: true } },
            ]
        });
        res.json({ success: true, action: "dry_run", orders_with_sync_flags: count });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post("/reset-po-sync", async (_req: any, res: any) => {
    try {
        const nsDb = await getDb("netsuite");
        const col = nsDb.collection("suite_purchase_order");
        const result = await col.updateMany(
            {},
            {
                $set: { ns_synced: false },
                $unset: {
                    ns_synced_at: "", ns_result: "", ns_error: "",
                    ns_error_at: "", ns_retry_count: "", ns_failed: "",
                }
            }
        );
        log.info(`[RESET-PO-SYNC] Reset ${result.modifiedCount} POs`);
        res.json({ success: true, action: "reset", matched: result.matchedCount, modified: result.modifiedCount });
    } catch (e: any) {
        log.error("[RESET-PO-SYNC] Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Retry failed POs ──────────────────────────────────────────────────────
router.get("/retry-failed-po", async (req: any, res: any) => {
    try {
        const resetAll = req.query.all === "1" || req.query.all === "true";
        const result = await retryFailedPurchaseOrders(resetAll);
        res.json({ success: true, ...result });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Test PO Flow — create SO → create PO + update SO ──────────────────────
// POST /test-po-flow?type=dropship    → Dropship PO + SO location update
// POST /test-po-flow?type=stocking    → Stocking PO (no SO link)
router.post("/test-po-flow", async (req: any, res: any) => {
    try {
        const poType = req.query.type || "dropship";
        const testId = "TEST-SO-" + 542865234;
        const testPoNum = 542865234;

        const poPayload: any = {
            action:   "update",
            po_type:  poType === "stocking" ? "Stocking" : "Dropship",
        };

        if (poType === "stocking") {
            Object.assign(poPayload, {
                po_number: testPoNum, otherrefnum: String(testPoNum),
                vendor_id: 117, distributor: "Synnex",
                distributor_order_number: "159016653",
                status: "Open PO", invoice: [], tracking: null,
                website_order_number: "", stocking_warehouse: "W2G-IL",
                order_items: [
                    { sku: "29S0500", qty: 80, cost: 487.74 },
                    { sku: "29S0100", qty: 80, cost: 346.16 },
                    { sku: "40N9020", qty: 50, cost: 299.54 },
                    { sku: "40N9070", qty: 20, cost: 452.07 },
                ],
            });
        } else {
            Object.assign(poPayload, {
                po_number: testPoNum, otherrefnum: String(testPoNum),
                vendor_id: 116, distributor: "suppliesnetwork",
                distributor_order_number: "322209601",
                status: "Open PO", invoice: [], tracking: null,
                website_order_number: testId, stocking_warehouse: "",
                order_items: [
                    { sku: "29S0100", qty: 1, cost: 68.81 },
                ],
            });
        }

        log.info(`[TEST-PO-FLOW] Sending ${poPayload.po_type} PO ${poPayload.po_number} (website_order_number: ${poPayload.website_order_number})`);
        const poResult = await postToNetsuiteForPO(poPayload);
        log.info(`[TEST-PO-FLOW] Done. PO action: ${poResult?.action}`);

        res.json({ success: true, type: poType, po: poResult });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e?.response?.data || e.message });
    }
});

// ─── Delete All POs ─────────────────────────────────────────────────────────
// GET  /delete-all-po → dry-run
// POST /delete-all-po → delete
import { callCleanup } from "../services/netsuite.client";

router.get("/delete-all-po", async (_req: any, res: any) => {
    log.info("[DELETE-PO] GET dry-run — calling cleanup RESTlet");
    try {
        const result = await callCleanup({ action: "list_po" });
        res.json(result);
    } catch (e: any) {
        log.error("[DELETE-PO] ERROR", { status: e?.response?.status, data: e?.response?.data, message: e.message });
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

router.post("/delete-all-po", async (_req: any, res: any) => {
    log.info("[DELETE-PO] POST execute — looping batches via cleanup RESTlet");
    try {
        let totalDeleted = 0, totalErrors = 0, batchNum = 0, done = false;

        while (!done) {
            batchNum++;
            log.info(`[DELETE-PO] Batch ${batchNum}...`);
            const result = await callCleanup({ action: "delete_po" });
            const batch = result?.purchase_orders;

            if (!batch) {
                return res.status(500).json({ error: "No purchase_orders in response", raw: result });
            }

            totalDeleted += batch.deleted || 0;
            totalErrors += batch.errors || 0;
            done = batch.done || (batch.deleted === 0 && batch.remaining <= 0);

            log.info(`[DELETE-PO] Batch ${batchNum}: deleted ${batch.deleted}, errors ${batch.errors}, remaining ~${batch.remaining}`);
        }

        log.info(`[DELETE-PO] Done. Total deleted: ${totalDeleted}, errors: ${totalErrors}, batches: ${batchNum}`);
        res.json({ success: true, total_deleted: totalDeleted, total_errors: totalErrors, batches: batchNum });
    } catch (e: any) {
        log.error("[DELETE-PO] ERROR", { status: e?.response?.status, data: e?.response?.data, message: e.message });
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

export default router;
