import { Router } from "express";
import log from "../config/logger.config";
import { callDiagnostic, callCleanup, postToNetsuiteForBill } from "../services/netsuite.client";

const router = Router();

// ─── Diagnostic ─────────────────────────────────────────────────────────────
router.get("/diagnostic", async (_req: any, res: any) => {
    try {
        const result = await callDiagnostic({
            sections: ["account", "subsidiaries", "locations", "custom_fields", "forms"],
        });
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

router.post("/diagnostic", async (req: any, res: any) => {
    try {
        const result = await callDiagnostic(req.body);
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

// ─── Delete All SOs (Pending Fulfillment) ───────────────────────────────────
// GET  /delete-all-so → dry-run
// POST /delete-all-so → delete in batches
router.get("/delete-all-so", async (_req: any, res: any) => {
    try {
        const result = await callDiagnostic({ sections: ["delete_all_so"], confirm: false });
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

router.post("/delete-all-so", async (req: any, res: any) => {
    try {
        const batchSize = parseInt(req.query.batch) || 200;
        let totalDeleted = 0, totalFailed = 0, batchNum = 0, done = false;

        log.info(`[DELETE-SO] Starting bulk delete (batch size: ${batchSize})`);

        while (!done) {
            batchNum++;
            log.info(`[DELETE-SO] Batch ${batchNum}...`);
            const result = await callDiagnostic({ sections: ["delete_all_so"], confirm: true, batch_size: batchSize });
            const batch = result?.delete_all_so;

            if (!batch || batch.error) {
                return res.status(500).json({
                    success: false, error: batch?.error || "Unknown error",
                    batches_completed: batchNum - 1, total_deleted: totalDeleted, total_failed: totalFailed,
                });
            }

            totalDeleted += batch.deleted_count || 0;
            totalFailed += batch.failed_count || 0;
            done = batch.done || batch.found_in_batch === 0;

            log.info(`[DELETE-SO] Batch ${batchNum}: deleted ${batch.deleted_count}, failed ${batch.failed_count}, remaining ${batch.remaining}`);
        }

        log.info(`[DELETE-SO] Done. Total deleted: ${totalDeleted}, failed: ${totalFailed}`);
        res.json({
            success: true, status_filter: "Pending Fulfillment",
            total_deleted: totalDeleted, total_failed: totalFailed,
            batches: batchNum, message: "All Pending Fulfillment Sales Orders deleted.",
        });
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

// ─── Cleanup (test SOs + all POs) ──────────────────────────────────────────
// GET  /cleanup → dry-run
// POST /cleanup → delete
router.get("/cleanup", async (_req: any, res: any) => {
    try {
        const result = await callCleanup({ action: "list_all" });
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

router.post("/cleanup", async (_req: any, res: any) => {
    try {
        let totalDeletedPO = 0, totalDeletedSO = 0, batchNum = 0;
        let poDone = false, soDone = false;

        while (!poDone || !soDone) {
            batchNum++;
            log.info(`[CLEANUP] Batch ${batchNum}...`);
            const result = await callCleanup({ action: "delete_all" });
            const po = result?.purchase_orders;
            const so = result?.test_sales_orders;

            if (po) {
                totalDeletedPO += po.deleted || 0;
                poDone = po.done || (po.deleted === 0 && po.remaining <= 0);
            } else { poDone = true; }

            if (so) {
                totalDeletedSO += so.deleted || 0;
                soDone = so.done || (so.deleted === 0 && so.remaining <= 0);
            } else { soDone = true; }

            log.info(`[CLEANUP] Batch ${batchNum}: PO deleted ${po?.deleted || 0} (remaining ~${po?.remaining || 0}), SO deleted ${so?.deleted || 0} (remaining ~${so?.remaining || 0})`);
        }

        res.json({ success: true, total_deleted_po: totalDeletedPO, total_deleted_so: totalDeletedSO, batches: batchNum });
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

// ─── Bill ───────────────────────────────────────────────────────────────────
router.post("/bill-test", async (req: any, res: any) => {
    try {
        const result = await postToNetsuiteForBill(req.body);
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

router.get("/test-bill-flow", async (req: any, res: any) => {
    try {
        const poNumber = req.query.po || "987612345";
        const result = await postToNetsuiteForBill({
            action:         "create",
            po_number:      poNumber,
            invoice_number: "INV-TEST-" + Date.now(),
            invoice_date:   new Date().toISOString().split("T")[0],
            memo:           "Test bill created from PO " + poNumber,
        });
        res.json({ success: true, ...result });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e?.response?.data || e.message });
    }
});

export default router;
