import app from "./app";
import dotenv from "dotenv";
import cron from "node-cron";
import { stageSalesOrders } from "./services/sales_order.stage";
import { syncSalesOrdersToNetsuite } from "./services/sales_order.sync";
import { stagePurchaseOrders } from "./services/po.stage";
import { syncPurchaseOrdersToNetsuite } from "./services/po.sync";

dotenv.config();

const PORT = 5002;
app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});

// ─── CRON: Every 30 mins — Sales Orders ──────────────────────────────────────
cron.schedule("*/2 * * * *", async () => {
    // console.log("[CRON] [SO] Step 1 — Staging sales orders...");
    await stageSalesOrders();

    console.log("[CRON] [SO] Step 2 — Pushing to NetSuite ERP...");
    await syncSalesOrdersToNetsuite();
});

// ─── CRON: Every 30 mins — Purchase Orders (shipped or has invoice) ───────────
// cron.schedule("*/2 * * * *", async () => {
//     console.log("[CRON] [PO] Step 1 — Staging purchase orders (shipped / invoiced)...");
//     await stagePurchaseOrders();

//     console.log("[CRON] [PO] Step 2 — Pushing to NetSuite ERP...");
//     await syncPurchaseOrdersToNetsuite();
// });
