import app from "./app";
import dotenv from "dotenv";
import cron from "node-cron";
import log from "./config/logger.config";
import { getDb } from "./config/mongdodb.config";
import { retryFailedSalesOrders, syncSalesOrdersToNetsuite } from "./services/sales_order.sync";
import { stagePurchaseOrders } from "./services/po.stage";
import { syncPurchaseOrdersToNetsuite } from "./services/po.sync";
import { runItemFullSync } from "./controller/netsuite_item_full";

// Route modules
import soRoutes from "./route/so.route";
import poRoutes from "./route/po.route";
import diagnosticRoutes from "./route/diagnostic.route";
import itemRoutes from "./route/item.route";
import indexRoutes from "./route/index.route";
import { stageSalesOrders } from "./services/sales_order.stage";

dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.use("/api/v4", soRoutes);
app.use("/api/v4", poRoutes);
app.use("/api/v4", diagnosticRoutes);
app.use("/api/v4", itemRoutes);
app.use("/api/v4", indexRoutes);

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER
// ═══════════════════════════════════════════════════════════════════════════════
const PORT = 5002;
app.listen(PORT, () => {
    log.info(`Server running at http://localhost:${PORT}`);
    log.info(`──── Sales Orders ────`);
    log.info(`  Stage SO:        GET  /stage-so`);
    log.info(`  Sync SO:         GET  /sync-so`);
    log.info(`  Retry Failed SO: GET  /retry-failed-so`);
    log.info(`  Reset SO Sync:   GET|POST /reset-so-sync`);
    log.info(`  Migrate SO:      GET  /migrate-so`);
    log.info(`  Migrate MV:      GET  /migrate-so-multivendor`);
    log.info(`  Test SO Flow:    GET  /test-so-flow`);
    log.info(`  Test Vendor SO:  GET  /test-so-vendor?store=amazon|walmart|newegg|ebay|shopify`);
    log.info(`  Direct SO Test:  POST /so-test`);
    log.info(`  Delete All SO:   GET|POST /delete-all-so`);
    log.info(`──── Purchase Orders ────`);
    log.info(`  Sync PO:         GET  /sync-po`);
    log.info(`  Retry Failed PO: GET  /retry-failed-po`);
    log.info(`  Test PO Flow:    POST /test-po-flow?type=dropship|stocking`);
    log.info(`  Direct PO Test:  POST /po-test`);
    log.info(`  Dropship Ready:  GET  /dropship-ready`);
    log.info(`  Delete All PO:   GET|POST /delete-all-po`);
    log.info(`──── Bills ────`);
    log.info(`  Test Bill Flow:  GET  /test-bill-flow?po=987612345`);
    log.info(`  Direct Bill:     POST /bill-test`);
    log.info(`──── Items & Diagnostics ────`);
    log.info(`  Items:           GET  /netsuite-items`);
    log.info(`  Items Full:      GET  /netsuite-items-full`);
    log.info(`  POs:             GET  /netsuite-po`);
    log.info(`  Diagnostic:      GET|POST /diagnostic`);
    log.info(`  Cleanup:         GET|POST /cleanup`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// CRON JOBS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Every 30 mins — Sales Orders (staging + sync) ──────────────────────────
let soSyncRunning = false;

// cron.schedule("*/15 * * * *", async () => {
//     if (soSyncRunning) {
//         log.warn("[CRON] [SO] Skipping — previous sync still running");
//         return;
//     }
//     soSyncRunning = true;
//     try {
//         log.info("[CRON] [SO] Step 1 — Staging sales orders...");
//         await stageSalesOrders();

//         log.info("[CRON] [SO] Step 2 — Pushing to NetSuite ERP...");
//         await syncSalesOrdersToNetsuite();
//     } catch (err: any) {
//         log.error("[CRON] [SO] Error", { error: err.message });
//     } finally {
//         soSyncRunning = false;
//     }
// });

// ─── PO sync offset from SO to avoid overlap ─────────────────────────────────
// SO runs at :00, :15, :30, :45  →  PO runs at :07, :22, :37, :52
// 7-min offset avoids :45 collision and gives SO a head start for dropship linking.
// Governance per PO: Stocking ~42 units, Dropship ~77 units (RESTlet limit 5,000)
// Batches: 50 stocking + 20 dropship per cron run, 5 parallel workers
let poSyncRunning = false;

cron.schedule("7,22,37,52 * * * *", async () => {
    if (poSyncRunning) {
        log.warn("[CRON] [PO] Skipping — previous sync still running");
        return;
    }
    poSyncRunning = true;
    try {
        log.info("[CRON] [PO] Step 1 — Staging purchase orders...");
        await stagePurchaseOrders();

        log.info("[CRON] [PO] Step 2 — Pushing to NetSuite ERP...");
        await syncPurchaseOrdersToNetsuite();
    } catch (err: any) {
        log.error("[CRON] [PO] Error", { error: err.message });
    } finally {
        poSyncRunning = false;
    }
});

// ─── Daily 3 AM — Auto-retry permanently failed SOs ─────────────────────────
cron.schedule("0 3 * * *", async () => {
    log.info("[CRON] [SO-RETRY] Resetting permanently failed SOs for retry...");
    try {
        const result = await retryFailedSalesOrders(true);
        log.info(`[CRON] [SO-RETRY] Reset ${result.count} failed orders for retry`);
    } catch (err: any) {
        log.error("[CRON] [SO-RETRY] Error", { error: err.message });
    }
});

// ─── Every 30 mins — Item Sync (Phase 1 + Phase 2 chained) ──────────────────
// Phase 1: SuiteQL bulk fetch (5 parallel workers, 5000/page → ~12-16s for 96k)
// Phase 2: Sublists — only runs when Phase 1 pulled new/updated items
// Incremental runs are near-instant — safe to run every 30 min.
let itemSyncRunning = false;

// cron.schedule("10,35 * * * *", async () => {
//     if (itemSyncRunning) {
//         log.warn("[CRON] [ITEM] Skipping — previous sync still running");
//         return;
//     }
//     itemSyncRunning = true;
//     try {
//         log.info("[CRON] [ITEM] Syncing items...");
//         const result = await runItemFullSync();
//         log.info(`[CRON] [ITEM] Done. Pulled: ${result.totalPulled}, inserted: ${result.inserted}, updated: ${result.updated}, incremental: ${result.incremental}`);
//     } catch (err: any) {
//         log.error("[CRON] [ITEM] Error", { error: err.message });
//     } finally {
//         itemSyncRunning = false;
//     }
// });

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

// Kick off full item sync if DB is empty or never completed (10s delay for DB connection)
// setTimeout(async () => {
//     try {
//         const nsDb = await getDb("netsuite");
//         const count = await nsDb.collection("netsuite_items_full").countDocuments();
//         const meta = await nsDb.collection("sync_metadata").findOne({ _id: "item_full_sync" } as any);

//         if (count === 0 || !meta?.completedAt) {
//             itemSyncRunning = true;
//             try {
//                 log.info(`[STARTUP] [ITEM] Items in DB: ${count} — running full sync...`);
//                 const result = await runItemFullSync();
//                 log.info(`[STARTUP] [ITEM] Done. Pulled: ${result.totalPulled}, inserted: ${result.inserted}, updated: ${result.updated}`);
//             } finally {
//                 itemSyncRunning = false;
//             }
//         } else {
//             log.info(`[STARTUP] [ITEM] Items in DB: ${count} — skipping (next sync via cron)`);
//         }
//     } catch (err: any) {
//         log.error("[STARTUP] [ITEM] Error", { error: err.message });
//         itemSyncRunning = false;
//     }
// }, 10_000);
