import app from "./app";
import dotenv from "dotenv";
import cron from "node-cron";
import log from "./config/logger.config";
import { getDb } from "./config/mongdodb.config";
import { retryFailedSalesOrders, syncSalesOrdersToNetsuite } from "./services/sales_order.sync";
// Used by commented-out cron jobs — uncomment when ready for production
// import { stageSalesOrders } from "./services/sales_order.stage";
// import { syncSalesOrdersToNetsuite } from "./services/sales_order.sync";
// import { stagePurchaseOrders } from "./services/po.stage";
// import { syncPurchaseOrdersToNetsuite } from "./services/po.sync";
import { runItemFullSync, runItemSublistsSync } from "./controller/netsuite_item_full";

// Route modules
import soRoutes from "./route/so.route";
import poRoutes from "./route/po.route";
import diagnosticRoutes from "./route/diagnostic.route";
import itemRoutes from "./route/item.route";
import { stageSalesOrders } from "./services/sales_order.stage";

dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.use(soRoutes);
app.use(poRoutes);
app.use(diagnosticRoutes);
app.use(itemRoutes);

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
cron.schedule("*/30 * * * *", async () => {
    log.info("[CRON] [SO] Step 1 — Staging sales orders...");
    await stageSalesOrders();

    log.info("[CRON] [SO] Step 2 — Pushing to NetSuite ERP...");
    await syncSalesOrdersToNetsuite();
});

// ─── Every 30 mins — Purchase Orders (shipped or invoiced) ──────────────────
// cron.schedule("*/30 * * * *", async () => {
//     log.info("[CRON] [PO] Step 1 — Staging purchase orders...");
//     await stagePurchaseOrders();
//
//     log.info("[CRON] [PO] Step 2 — Pushing to NetSuite ERP...");
//     await syncPurchaseOrdersToNetsuite();
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

// ─── Every 30 mins — Item Sync (Phase 1 + Phase 2 chained) ──────────────────
// Phase 1: SuiteQL bulk fetch (5 parallel workers, 5000/page → ~12-16s for 96k)
// Phase 2: Sublists — only runs when Phase 1 pulled new/updated items
// Incremental runs are near-instant — safe to run every 30 min.
let itemSyncRunning = false;

cron.schedule("10,35 * * * *", async () => {
    if (itemSyncRunning) {
        log.warn("[CRON] [ITEM] Skipping — previous sync still running");
        return;
    }
    itemSyncRunning = true;
    try {
        log.info("[CRON] [ITEM] Phase 1 — Syncing items...");
        const result = await runItemFullSync();
        log.info(`[CRON] [ITEM] Phase 1 done. Pulled: ${result.totalPulled}, inserted: ${result.inserted}, updated: ${result.updated}, incremental: ${result.incremental}`);

        if (result.totalPulled > 0) {
            log.info("[CRON] [ITEM] Phase 2 — Fetching sublists for updated items...");
            const slResult = await runItemSublistsSync();
            log.info(`[CRON] [ITEM] Phase 2 done. Updated: ${slResult.updated}/${slResult.total}`);
        }
    } catch (err: any) {
        log.error("[CRON] [ITEM] Error", { error: err.message });
    } finally {
        itemSyncRunning = false;
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

// Kick off full item sync if DB is empty or stale (10s delay for DB connection)
setTimeout(async () => {
    try {
        const nsDb = await getDb("netsuite");
        const count = await nsDb.collection("netsuite_items_full").countDocuments();
        const meta = await nsDb.collection("sync_metadata").findOne({ _id: "item_full_sync" } as any);
        const lastTotal = (meta as any)?.total || 0;
        const needsSync = count === 0 || (lastTotal > 0 && count < lastTotal * 0.8) || !meta?.completedAt;

        if (needsSync) {
            log.info(`[STARTUP] [ITEM] Items in DB: ${count}, last total: ${lastTotal} — running full sync (5 workers, 5000/page)...`);
            const result = await runItemFullSync();
            log.info(`[STARTUP] [ITEM] Done. Pulled: ${result.totalPulled}, inserted: ${result.inserted}, updated: ${result.updated}`);
        } else {
            log.info(`[STARTUP] [ITEM] Items in DB: ${count}/${lastTotal} — skipping (next sync via cron)`);
        }
    } catch (err: any) {
        log.error("[STARTUP] [ITEM] Error", { error: err.message });
    }
}, 10_000);
