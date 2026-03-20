import app from "./app";
import dotenv from "dotenv";
import cron from "node-cron";
import log from "./config/logger.config";
import { stageSalesOrders } from "./services/sales_order.stage";
import { syncSalesOrdersToNetsuite, retryFailedSalesOrders } from "./services/sales_order.sync";
import { migrateSalesOrderSchema } from "./services/sales_order.migrate";
import { stagePurchaseOrders } from "./services/po.stage";
import { syncPurchaseOrdersToNetsuite, retryFailedPurchaseOrders } from "./services/po.sync";
import { callDiagnostic, callCleanup, postToNetsuite, postToNetsuiteForPO, postToNetsuiteForBill } from "./services/netsuite.client";
import { syncNetsuiteItems } from "./controller/netsuite_item";
import { syncNetsuitePOs } from "./controller/netsuite_po";
import { syncNetsuiteItemsFull, runItemSublistsSync } from "./controller/netsuite_item_full";

dotenv.config();

// ─── Diagnostic endpoint ─────────────────────────────────────────────────────
app.get("/diagnostic", async (_req: any, res: any) => {
    try {
        const result = await callDiagnostic({
            sections: ["account", "subsidiaries", "locations", "custom_fields", "forms"],
        });
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

app.post("/diagnostic", async (req: any, res: any) => {
    try {
        const result = await callDiagnostic(req.body);
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

// ─── Direct SO RESTlet call (for testing) ───────────────────────────────────
app.post("/so-test", async (req: any, res: any) => {
    try {
        const result = await postToNetsuite(req.body);
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

// ─── Manual trigger: migrate old records to new schema ───────────────────────
// GET http://localhost:5002/migrate-so
app.get("/migrate-so", async (_req: any, res: any) => {
    try {
        const result = await migrateSalesOrderSchema();
        res.json({ success: true, ...result });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Manual trigger: sync only (for testing) ────────────────────────────────
// GET http://localhost:5002/sync-so
app.get("/sync-so", async (_req: any, res: any) => {
    try {
        const results = await syncSalesOrdersToNetsuite();
        res.json({ success: true, count: results.length, results });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Retry failed SOs ────────────────────────────────────────────────────────
// GET http://localhost:5002/retry-failed-so         → retry orders under MAX_RETRIES
// GET http://localhost:5002/retry-failed-so?all=1   → also reset permanently failed orders
app.get("/retry-failed-so", async (req: any, res: any) => {
    try {
        const resetAll = req.query.all === "1" || req.query.all === "true";
        const result = await retryFailedSalesOrders(resetAll);
        res.json({ success: true, ...result });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Delete All Sales Orders (Pending Fulfillment) from NetSuite ─────────────
// GET  http://localhost:5002/delete-all-so            → dry-run (shows count)
// POST http://localhost:5002/delete-all-so            → deletes ALL in loop (batch 200)
// POST http://localhost:5002/delete-all-so?batch=500  → custom batch size (max 500)
app.get("/delete-all-so", async (_req: any, res: any) => {
    try {
        const result = await callDiagnostic({
            sections: ["delete_all_so"],
            confirm: false,
        });
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

app.post("/delete-all-so", async (req: any, res: any) => {
    try {
        const batchSize = parseInt(req.query.batch) || 200;
        let totalDeleted = 0;
        let totalFailed = 0;
        let batchNum = 0;
        let done = false;

        log.info(`[DELETE-SO] Starting bulk delete (batch size: ${batchSize})`);

        while (!done) {
            batchNum++;
            log.info(`[DELETE-SO] Batch ${batchNum}...`);

            const result = await callDiagnostic({
                sections: ["delete_all_so"],
                confirm: true,
                batch_size: batchSize,
            });

            const batch = result?.delete_all_so;
            if (!batch || batch.error) {
                return res.status(500).json({
                    success: false,
                    error: batch?.error || "Unknown error",
                    batches_completed: batchNum - 1,
                    total_deleted: totalDeleted,
                    total_failed: totalFailed,
                });
            }

            totalDeleted += batch.deleted_count || 0;
            totalFailed += batch.failed_count || 0;
            done = batch.done || batch.found_in_batch === 0;

            log.info(`[DELETE-SO] Batch ${batchNum}: deleted ${batch.deleted_count}, failed ${batch.failed_count}, remaining ${batch.remaining}`);
        }

        log.info(`[DELETE-SO] Done. Total deleted: ${totalDeleted}, failed: ${totalFailed}`);
        res.json({
            success: true,
            status_filter: "Pending Fulfillment",
            total_deleted: totalDeleted,
            total_failed: totalFailed,
            batches: batchNum,
            message: "All Pending Fulfillment Sales Orders deleted.",
        });
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

// ─── Delete All Purchase Orders from NetSuite (via cleanup RESTlet) ──────────
// GET  http://localhost:5002/delete-all-po            → dry-run (list POs)
// POST http://localhost:5002/delete-all-po            → delete all POs
app.get("/delete-all-po", async (_req: any, res: any) => {
    log.info("[DELETE-PO] GET dry-run — calling cleanup RESTlet");
    try {
        const result = await callCleanup({ action: "list_po" });
        log.debug("[DELETE-PO] Response", { data: result });
        res.json(result);
    } catch (e: any) {
        log.error("[DELETE-PO] ERROR", { status: e?.response?.status, data: e?.response?.data, message: e.message });
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

app.post("/delete-all-po", async (_req: any, res: any) => {
    log.info("[DELETE-PO] POST execute — looping batches via cleanup RESTlet");
    try {
        let totalDeleted = 0;
        let totalErrors = 0;
        let batchNum = 0;
        let done = false;

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
        res.json({
            success: true,
            total_deleted: totalDeleted,
            total_errors: totalErrors,
            batches: batchNum,
        });
    } catch (e: any) {
        log.error("[DELETE-PO] ERROR", { status: e?.response?.status, data: e?.response?.data, message: e.message });
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

// ─── Direct Bill RESTlet call (for testing) ──────────────────────────────────
app.post("/bill-test", async (req: any, res: any) => {
    try {
        const result = await postToNetsuiteForBill(req.body);
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

// ─── Test Bill Flow — find a PO and create a bill from it ────────────────────
// GET http://localhost:5002/test-bill-flow              → uses demo PO# 987612345
// GET http://localhost:5002/test-bill-flow?po=10001     → custom PO otherrefnum
app.get("/test-bill-flow", async (req: any, res: any) => {
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

// ─── Direct PO RESTlet call (for testing) ────────────────────────────────────
app.post("/po-test", async (req: any, res: any) => {
    try {
        const result = await postToNetsuiteForPO(req.body);
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

// ─── Manual trigger: sync POs only (for testing) ────────────────────────────
// GET http://localhost:5002/sync-po
app.get("/sync-po", async (_req: any, res: any) => {
    try {
        const results = await syncPurchaseOrdersToNetsuite();
        res.json({ success: true, count: results.length, results });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Retry failed POs ───────────────────────────────────────────────────────
// GET http://localhost:5002/retry-failed-po         → retry orders under MAX_RETRIES
// GET http://localhost:5002/retry-failed-po?all=1   → also reset permanently failed orders
app.get("/retry-failed-po", async (req: any, res: any) => {
    try {
        const resetAll = req.query.all === "1" || req.query.all === "true";
        const result = await retryFailedPurchaseOrders(resetAll);
        res.json({ success: true, ...result });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Fetch All Items from NetSuite ERP → netsuite.netsuite_product_list ───────
// GET http://localhost:5002/netsuite-items              → sync all items
// GET http://localhost:5002/netsuite-items?pageSize=200 → custom page size
app.get("/netsuite-items", syncNetsuiteItems);

// ─── Fetch All POs from NetSuite ERP → netsuite.netsuite_purchase_order ──────
// GET http://localhost:5002/netsuite-po              → sync all POs
// GET http://localhost:5002/netsuite-po?pageSize=100 → custom page size
app.get("/netsuite-po", syncNetsuitePOs);

// ─── Fetch All Items FULL (raw NetSuite fields) → netsuite.netsuite_items_full ─
// GET http://localhost:5002/netsuite-items-full                         → SuiteQL (2000/page, fast)
// GET http://localhost:5002/netsuite-items-full?mode=search             → N/search fallback (500/page)
// GET http://localhost:5002/netsuite-items-full?pageSize=5000           → custom page size (max 5000)
// GET http://localhost:5002/netsuite-items-full?sublists=true           → + Location/Vendor sublists
app.get("/netsuite-items-full", syncNetsuiteItemsFull);

// ─── Cleanup: delete test SOs + all POs (via cleanup RESTlet) ────────────────
// GET  http://localhost:5002/cleanup          → dry-run (list what will be deleted)
// POST http://localhost:5002/cleanup          → actually delete
app.get("/cleanup", async (_req: any, res: any) => {
    try {
        const result = await callCleanup({ action: "list_all" });
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

app.post("/cleanup", async (_req: any, res: any) => {
    try {
        let totalDeletedPO = 0, totalDeletedSO = 0;
        let batchNum = 0;
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

        res.json({
            success: true,
            total_deleted_po: totalDeletedPO,
            total_deleted_so: totalDeletedSO,
            batches: batchNum,
        });
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

// ─── Test PO Flow — end-to-end: create SO (diagnostic) → create PO + update SO (PO RESTlet) ──
// POST http://localhost:5002/test-po-flow?type=dropship    → Dropship PO + SO location update
// POST http://localhost:5002/test-po-flow?type=stocking    → Stocking PO (no SO link)
app.post("/test-po-flow", async (req: any, res: any) => {
    try {
        const poType = req.query.type || "dropship";
        const testId = "TEST-SO-" + 918273645;

        const testPoNum = 987612345;
        const poPayload: any = {
            action:   "update",
            po_type:  poType === "stocking" ? "Stocking" : "Dropship",
        };

        if (poType === "stocking") {
            Object.assign(poPayload, {
                po_number:                testPoNum,
                otherrefnum:              String(testPoNum),
                vendor_id:                117,
                distributor:              "Synnex",
                distributor_order_number: "159016653",
                status:                   "Open PO",
                invoice:                  [],
                tracking:                 null,
                website_order_number:     "",
                stocking_warehouse:       "W2G-IL",
                order_items: [
                    { sku: "29S0500", qty: 80, cost: 487.74 },
                    { sku: "29S0100", qty: 80, cost: 346.16 },
                    { sku: "40N9020", qty: 50, cost: 299.54 },
                    { sku: "40N9070", qty: 20, cost: 452.07 },
                ],
            });
        } else {
            Object.assign(poPayload, {
                po_number:                testPoNum,
                otherrefnum:              String(testPoNum),
                vendor_id:                116,
                distributor:              "suppliesnetwork",
                distributor_order_number: "322209601",
                status:                   "Open PO",
                invoice:                  [],
                tracking:                 null,
                website_order_number:     testId,
                stocking_warehouse:       "",
                order_items: [
                    { sku: "29S0100", qty: 2, cost: 68.81 },
                ],
            });
        }

        log.info(`[TEST-PO-FLOW] Sending ${poPayload.po_type} PO ${poPayload.po_number} (website_order_number: ${poPayload.website_order_number})`);
        const poResult = await postToNetsuiteForPO(poPayload);

        log.info(`[TEST-PO-FLOW] Done. PO action: ${poResult?.action}`);

        res.json({
            success: true,
            type: poType,
            po: poResult,
        });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e?.response?.data || e.message });
    }
});

const PORT = 5002;
app.listen(PORT, () => {
    log.info(`Server running at http://localhost:${PORT}`);
    log.info(`Diagnostic:      http://localhost:${PORT}/diagnostic`);
    log.info(`Migrate SO:      http://localhost:${PORT}/migrate-so`);
    log.info(`Sync SO:         http://localhost:${PORT}/sync-so`);
    log.info(`Retry Failed SO: http://localhost:${PORT}/retry-failed-so`);
    log.info(`Delete All SO:   GET/POST http://localhost:${PORT}/delete-all-so`);
    log.info(`Bill Test:       POST http://localhost:${PORT}/bill-test`);
    log.info(`Test Bill Flow:  GET  http://localhost:${PORT}/test-bill-flow?po=987612345`);
    log.info(`PO Test:         POST http://localhost:${PORT}/po-test`);
    log.info(`Sync PO:         GET  http://localhost:${PORT}/sync-po`);
    log.info(`Retry Failed PO: GET  http://localhost:${PORT}/retry-failed-po`);
    log.info(`Netsuite Items:  GET  http://localhost:${PORT}/netsuite-items`);
    log.info(`Items Full:      GET  http://localhost:${PORT}/netsuite-items-full`);
    log.info(`Netsuite POs:    GET  http://localhost:${PORT}/netsuite-po`);
});

// ─── CRON: Every 30 mins — Sales Orders ──────────────────────────────────────
cron.schedule("*/30 * * * *", async () => {
    log.info("[CRON] [SO] Step 1 — Staging sales orders...");
    await stageSalesOrders();

    log.info("[CRON] [SO] Step 2 — Pushing to NetSuite ERP...");
    await syncSalesOrdersToNetsuite();
});

// // ─── CRON: Every 30 mins — Purchase Orders (shipped or has invoice) ───────────
// cron.schedule("*/30 * * * *", async () => {
//     log.info("[CRON] [PO] Step 1 — Staging purchase orders (shipped / invoiced)...");
//     await stagePurchaseOrders();

//     log.info("[CRON] [PO] Step 2 — Pushing to NetSuite ERP...");
//     await syncPurchaseOrdersToNetsuite();
// });

// ─── CRON: Every hour — Item Sublists (Locations + Vendors) ─────────────────
cron.schedule("0 * * * *", async () => {
    log.info("[CRON] [ITEM-SUBLISTS] Fetching Location/Vendor sublists for inventory items...");
    try {
        const result = await runItemSublistsSync();
        log.info(`[CRON] [ITEM-SUBLISTS] Done. Updated: ${result.updated}/${result.total}`);
    } catch (err: any) {
        log.error("[CRON] [ITEM-SUBLISTS] Error", { error: err.message });
    }
});
