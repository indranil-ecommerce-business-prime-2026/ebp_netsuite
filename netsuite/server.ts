import app from "./app";
import dotenv from "dotenv";
import cron from "node-cron";
import { stageSalesOrders } from "./services/sales_order.stage";
import { syncSalesOrdersToNetsuite, retryFailedSalesOrders } from "./services/sales_order.sync";
import { migrateSalesOrderSchema } from "./services/sales_order.migrate";
import { stagePurchaseOrders } from "./services/po.stage";
import { syncPurchaseOrdersToNetsuite } from "./services/po.sync";
import { callDiagnostic, postToNetsuite } from "./services/netsuite.client";

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

const PORT = 5002;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Diagnostic:      http://localhost:${PORT}/diagnostic`);
    console.log(`Migrate SO:      http://localhost:${PORT}/migrate-so`);
    console.log(`Sync SO:         http://localhost:${PORT}/sync-so`);
    console.log(`Retry Failed SO: http://localhost:${PORT}/retry-failed-so`);
});

// ─── CRON: Every 30 mins — Sales Orders ──────────────────────────────────────
// cron.schedule("*/2 * * * *", async () => {
//     console.log("[CRON] [SO] Step 1 — Staging sales orders...");
//     // await stageSalesOrders();

//     console.log("[CRON] [SO] Step 2 — Pushing to NetSuite ERP...");
//     await syncSalesOrdersToNetsuite();
// });

// ─── CRON: Every 30 mins — Purchase Orders (shipped or has invoice) ───────────
// cron.schedule("*/2 * * * *", async () => {
//     console.log("[CRON] [PO] Step 1 — Staging purchase orders (shipped / invoiced)...");
//     await stagePurchaseOrders();
//
//     console.log("[CRON] [PO] Step 2 — Pushing to NetSuite ERP...");
//     await syncPurchaseOrdersToNetsuite();
// });
