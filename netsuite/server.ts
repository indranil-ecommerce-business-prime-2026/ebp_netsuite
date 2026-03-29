import app from "./app";
import dotenv from "dotenv";
import cron from "node-cron";
import log from "./config/logger.config";
import { getDb } from "./config/mongdodb.config";
import { retryFailedSalesOrders, syncSalesOrdersToNetsuite } from "./services/sales_order.sync";
import { stagePurchaseOrders } from "./services/po.stage";
import { syncPurchaseOrdersToNetsuite } from "./services/po.sync";
import { stageBills } from "./services/bill.stage";
import { syncBillsToNetsuite, retryFailedBills } from "./services/bill.sync";
import { runItemFullSync } from "./controller/netsuite_item_full";

// Route modules
import soRoutes from "./route/so.route";
import poRoutes from "./route/po.route";
import diagnosticRoutes from "./route/diagnostic.route";
import billRoutes from "./route/bill.route";
import itemRoutes from "./route/item.route";
import indexRoutes from "./route/index.route";
import { stageSalesOrders } from "./services/sales_order.stage";

dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.use("/api/v4", soRoutes);
app.use("/api/v4", poRoutes);
app.use("/api/v4", billRoutes);
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
    log.info(`──── Vendor Bills ────`);
    log.info(`  Stage Bills:     GET  /stage-bill`);
    log.info(`  Sync Bills:      GET  /sync-bill`);
    log.info(`  Retry Failed:    GET  /retry-failed-bill`);
    log.info(`  Reset Sync:      GET|POST /reset-bill-sync`);
    log.info(`  Bill Ready:      GET  /bill-ready`);
    log.info(`  Direct Bill:     POST /bill-test`);
    log.info(`──── Cron Schedule ────`);
    log.info(`  SO:   every 90 min  (0:00, 1:30, 3:00, 4:30 ...)`);
    log.info(`  PO:   every 20 min  (:07, :27, :47)`);
    log.info(`  Bill: every 20 min  (:14, :34, :54)`);
    log.info(`  SO retry:   daily 3:00 AM`);
    log.info(`  Bill retry: daily 3:30 AM`);
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

// ─── Every 90 min — Sales Orders (staging + sync) ─────────────────────────
// 90 min = two cron entries sharing one guard.
// Runs at: 0:00, 1:30, 3:00, 4:30, 6:00, 7:30, 9:00, 10:30,
//          12:00, 13:30, 15:00, 16:30, 18:00, 19:30, 21:00, 22:30
let soSyncRunning = false;

async function runSOSync() {
    if (soSyncRunning) {
        log.warn("[CRON] [SO] Skipping — previous sync still running");
        return;
    }
    soSyncRunning = true;
    try {
        log.info("[CRON] [SO] Step 1 — Staging sales orders...");
        await stageSalesOrders();

        log.info("[CRON] [SO] Step 2 — Pushing to NetSuite ERP...");
        await syncSalesOrdersToNetsuite();
    } catch (err: any) {
        log.error("[CRON] [SO] Error", { error: err.message });
    } finally {
        soSyncRunning = false;
    }
}

cron.schedule("0 0,3,6,9,12,15,18,21 * * *", runSOSync);   // even hours :00
cron.schedule("30 1,4,7,10,13,16,19,22 * * *", runSOSync);  // odd hours :30

// ─── Every 20 min — Purchase Orders (staging + sync) ──────────────────────
// PO at :07, :27, :47 — 7-min offset from SO to avoid API overlap.
// Governance per PO: Stocking ~42 units, Dropship ~77 units (RESTlet limit 5,000)
// Batches: 50 stocking + 20 dropship per cron run, 5 parallel workers
let poSyncRunning = false;

cron.schedule("7,27,47 * * * *", async () => {
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

// ─── Every 20 min — Bill sync offset from PO ─────────────────────────────
// SO at :00/:30 → PO at :07/:27/:47 → Bill at :14/:34/:54
// 7-min gap between each job. Bills depend on PO being synced first.
let billSyncRunning = false;

// cron.schedule("14,34,54 * * * *", async () => {
//     if (billSyncRunning) {
//         log.warn("[CRON] [BILL] Skipping — previous sync still running");
//         return;
//     }
//     billSyncRunning = true;
//     try {
//         log.info("[CRON] [BILL] Step 1 — Staging bills...");
//         await stageBills();

//         log.info("[CRON] [BILL] Step 2 — Pushing to NetSuite...");
//         await syncBillsToNetsuite();
//     } catch (err: any) {
//         log.error("[CRON] [BILL] Error", { error: err.message });
//     } finally {
//         billSyncRunning = false;
//     }
// });

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

// ─── Daily 3:30 AM — Auto-retry permanently failed Bills ────────────────
cron.schedule("30 3 * * *", async () => {
    log.info("[CRON] [BILL-RETRY] Resetting permanently failed bills for retry...");
    try {
        const result = await retryFailedBills(true);
        log.info(`[CRON] [BILL-RETRY] Reset ${result.count} failed bills for retry`);
    } catch (err: any) {
        log.error("[CRON] [BILL-RETRY] Error", { error: err.message });
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
