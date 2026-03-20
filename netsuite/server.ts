import app from "./app";
import dotenv from "dotenv";
import cron from "node-cron";
import { stageSalesOrders } from "./services/sales_order.stage";
import { syncSalesOrdersToNetsuite, retryFailedSalesOrders } from "./services/sales_order.sync";
import { migrateSalesOrderSchema } from "./services/sales_order.migrate";
import { stagePurchaseOrders } from "./services/po.stage";
import { syncPurchaseOrdersToNetsuite, retryFailedPurchaseOrders } from "./services/po.sync";
import { callDiagnostic, callCleanup, postToNetsuite, postToNetsuiteForPO } from "./services/netsuite.client";
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

        console.log(`[DELETE-SO] Starting bulk delete (batch size: ${batchSize})...`);

        while (!done) {
            batchNum++;
            console.log(`[DELETE-SO] Batch ${batchNum}...`);

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

            console.log(`[DELETE-SO] Batch ${batchNum}: deleted ${batch.deleted_count}, failed ${batch.failed_count}, remaining ${batch.remaining}`);
        }

        console.log(`[DELETE-SO] Done. Total deleted: ${totalDeleted}, failed: ${totalFailed}`);
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
    console.log("[DELETE-PO] GET dry-run — calling cleanup RESTlet...");
    try {
        const result = await callCleanup({ action: "list_po" });
        console.log("[DELETE-PO] Response:", JSON.stringify(result));
        res.json(result);
    } catch (e: any) {
        console.error("[DELETE-PO] ERROR:", e?.response?.status, JSON.stringify(e?.response?.data), e.message);
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

app.post("/delete-all-po", async (_req: any, res: any) => {
    console.log("[DELETE-PO] POST execute — looping batches via cleanup RESTlet...");
    try {
        let totalDeleted = 0;
        let totalErrors = 0;
        let batchNum = 0;
        let done = false;

        while (!done) {
            batchNum++;
            console.log(`[DELETE-PO] Batch ${batchNum}...`);
            const result = await callCleanup({ action: "delete_po" });
            const batch = result?.purchase_orders;

            if (!batch) {
                return res.status(500).json({ error: "No purchase_orders in response", raw: result });
            }

            totalDeleted += batch.deleted || 0;
            totalErrors += batch.errors || 0;
            done = batch.done || (batch.deleted === 0 && batch.remaining <= 0);

            console.log(`[DELETE-PO] Batch ${batchNum}: deleted ${batch.deleted}, errors ${batch.errors}, remaining ~${batch.remaining}`);
        }

        console.log(`[DELETE-PO] Done. Total deleted: ${totalDeleted}, errors: ${totalErrors}, batches: ${batchNum}`);
        res.json({
            success: true,
            total_deleted: totalDeleted,
            total_errors: totalErrors,
            batches: batchNum,
        });
    } catch (e: any) {
        console.error("[DELETE-PO] ERROR:", e?.response?.status, JSON.stringify(e?.response?.data), e.message);
        res.status(500).json({ error: e?.response?.data || e.message });
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
            console.log(`[CLEANUP] Batch ${batchNum}...`);
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

            console.log(`[CLEANUP] Batch ${batchNum}: PO deleted ${po?.deleted || 0} (remaining ~${po?.remaining || 0}), SO deleted ${so?.deleted || 0} (remaining ~${so?.remaining || 0})`);
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

        // Step 1: Create 1 test SO via diagnostic RESTlet (no location on items)
        // Pass a predictable otherrefnum so the PO can match it via website_order_number
        const testId = "TEST-SO-" + 918273645; // ← use a fixed test ID for easy tracking
        // console.log("[TEST-PO-FLOW] Step 1 — Creating test SO via diagnostic (otherrefnum: " + testId + ")...");
        // const soResult = await callDiagnostic({
        //     sections: ["create_test_so"],
        //     count: 1,
        //     otherrefnum: testId,
        // });

        // const createdSO = soResult?.create_test_so?.orders?.[0];
        // if (!createdSO?.success) {
        //     return res.status(500).json({
        //         success: false,
        //         step: "create_test_so",
        //         error: createdSO?.error || "Failed to create test SO",
        //         soResult,
        //     });
        // }

        // console.log(`[TEST-PO-FLOW] SO created: ${createdSO.soNumber} (ID ${createdSO.internalId}, otherrefnum: ${createdSO.otherrefnum})`);

        // Step 2: Send PO to PO RESTlet with website_order_number = SO's otherrefnum
        const testPoNum = 987612345; // fixed PO number for easy tracking
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
            // Dropship — link to the test SO we just created
            Object.assign(poPayload, {
                po_number:                testPoNum,
                otherrefnum:              String(testPoNum),
                vendor_id:                116,
                distributor:              "suppliesnetwork",
                distributor_order_number: "322209601",
                status:                   "Open PO",
                invoice:                  [],
                tracking:                 null,
                website_order_number:     testId,  // ← PO only knows this from its own data, finds SO by matching otherrefnum
                stocking_warehouse:       "",
                order_items: [
                    { sku: "29S0100", qty: 2, cost: 68.81 },
                ],
            });
        }

        console.log(`[TEST-PO-FLOW] Step 2 — Sending ${poPayload.po_type} PO ${poPayload.po_number} (website_order_number: ${poPayload.website_order_number})...`);
        const poResult = await postToNetsuiteForPO(poPayload);

        console.log(`[TEST-PO-FLOW] Done. PO action: ${poResult?.action}, soSetup: ${JSON.stringify(poResult?.soSetup)}, autoPO: ${JSON.stringify(poResult?.autoPO)}`);

        res.json({
            success: true,
            type: poType,
            // so: {
            //     soNumber:     createdSO.soNumber,
            //     internalId:   createdSO.internalId,
            //     otherrefnum:  createdSO.otherrefnum,
            // },
            po: poResult,
        });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e?.response?.data || e.message });
    }
});

const PORT = 5002;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Diagnostic:      http://localhost:${PORT}/diagnostic`);
    console.log(`Migrate SO:      http://localhost:${PORT}/migrate-so`);
    console.log(`Sync SO:         http://localhost:${PORT}/sync-so`);
    console.log(`Retry Failed SO: http://localhost:${PORT}/retry-failed-so`);
    console.log(`Delete All SO:   GET  http://localhost:${PORT}/delete-all-so  (dry-run)`);
    console.log(`                 POST http://localhost:${PORT}/delete-all-so  (execute)`);
    console.log(`PO Test:         POST http://localhost:${PORT}/po-test`);
    console.log(`Sync PO:         GET  http://localhost:${PORT}/sync-po`);
    console.log(`Retry Failed PO: GET  http://localhost:${PORT}/retry-failed-po`);
    console.log(`Netsuite Items:  GET  http://localhost:${PORT}/netsuite-items`);
    console.log(`Items Full:      GET  http://localhost:${PORT}/netsuite-items-full`);
    console.log(`                      ?sublists=true  (+ Locations/Vendors)`);
    console.log(`Netsuite POs:    GET  http://localhost:${PORT}/netsuite-po`);
});

// ─── CRON: Every 30 mins — Sales Orders ──────────────────────────────────────
cron.schedule("*/30 * * * *", async () => {
    console.log("[CRON] [SO] Step 1 — Staging sales orders...");
    await stageSalesOrders();

    console.log("[CRON] [SO] Step 2 — Pushing to NetSuite ERP...");
    await syncSalesOrdersToNetsuite();
});

// // ─── CRON: Every 30 mins — Purchase Orders (shipped or has invoice) ───────────
// cron.schedule("*/30 * * * *", async () => {
//     console.log("[CRON] [PO] Step 1 — Staging purchase orders (shipped / invoiced)...");
//     await stagePurchaseOrders();

//     console.log("[CRON] [PO] Step 2 — Pushing to NetSuite ERP...");
//     await syncPurchaseOrdersToNetsuite();
// });

// ─── CRON: Every hour — Item Sublists (Locations + Vendors) ─────────────────
cron.schedule("0 * * * *", async () => {
    console.log("[CRON] [ITEM-SUBLISTS] Fetching Location/Vendor sublists for inventory items...");
    try {
        const result = await runItemSublistsSync();
        console.log(`[CRON] [ITEM-SUBLISTS] Done. Updated: ${result.updated}/${result.total}`);
    } catch (err: any) {
        console.error("[CRON] [ITEM-SUBLISTS] Error:", err.message);
    }
});
