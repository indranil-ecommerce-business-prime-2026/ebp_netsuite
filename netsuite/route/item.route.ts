import { Router } from "express";
import { syncNetsuiteItems } from "../controller/netsuite_item";
import { syncNetsuitePOs } from "../controller/netsuite_po";
import { syncNetsuiteItemsFull } from "../controller/netsuite_item_full";

const router = Router();

// ─── Fetch items from NetSuite → netsuite.netsuite_product_list ─────────────
router.get("/netsuite-items", syncNetsuiteItems);

// ─── Fetch POs from NetSuite → netsuite.netsuite_purchase_order ─────────────
router.get("/netsuite-po", syncNetsuitePOs);

// ─── Fetch items FULL (raw fields) → netsuite.netsuite_items_full ───────────
// ?mode=search  → N/search fallback
// ?pageSize=5000
// ?sublists=true → + Location/Vendor sublists
router.get("/netsuite-items-full", syncNetsuiteItemsFull);

export default router;
