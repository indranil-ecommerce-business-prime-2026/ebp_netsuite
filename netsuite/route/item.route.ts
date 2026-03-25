import { Router } from "express";
import { syncNetsuiteItems } from "../controller/netsuite_item";
import { syncNetsuitePOs } from "../controller/netsuite_po";
import { syncNetsuiteItemsFull } from "../controller/netsuite_item_full";
import { mapItemClasses } from "../controller/class_mapping";
import { mapItemFields, mapDropshipFalse, pushItemFields } from "../controller/item_field_mapping";
import { getDb } from "../config/mongdodb.config";
import log from "../config/logger.config";

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

// ─── Map class hierarchy from master_list onto netsuite_items_full ───────────
// GET /map-item-classes          → apply updates
// GET /map-item-classes?dry=1    → dry-run (no writes, shows what would change)
router.get("/map-item-classes", mapItemClasses);

// ─── Map displayname + purchasedescription from master_list ──────────────────
// GET /map-item-fields           → apply updates to netsuite_items_field_update
// GET /map-item-fields?dry=1     → dry-run
router.get("/map-item-fields", mapItemFields);

// ─── Map isdropshipitem = false for all items ────────────────────────────────
// GET /map-item-dropship-false           → apply
// GET /map-item-dropship-false?dry=1     → dry-run
router.get("/map-item-dropship-false", mapDropshipFalse);

// ─── Push ALL pending field updates to NetSuite via MapReduce ────────────────
// GET /push-item-fields           → push to NetSuite
// GET /push-item-fields?dry=1     → dry-run
router.get("/push-item-fields", pushItemFields);

// ─── Reset all sync flags on netsuite_items_field_update ─────────────────────
// GET  /reset-item-field-sync     → dry-run (count only)
// POST /reset-item-field-sync     → actually reset
router.get("/reset-item-field-sync", async (_req, res) => {
    try {
        const nsDb = await getDb("netsuite");
        const col = nsDb.collection("netsuite_items_field_update");
        const total = await col.countDocuments({});
        const pushed = await col.countDocuments({ ns_field_pushed: true });
        res.json({ success: true, action: "dry_run", total, pushed });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post("/reset-item-field-sync", async (_req, res) => {
    try {
        const nsDb = await getDb("netsuite");
        const col = nsDb.collection("netsuite_items_field_update");
        const result = await col.updateMany(
            {},
            { $unset: { ns_field_pushed: "", ns_field_pushed_at: "" } }
        );
        log.info(`[RESET-ITEM-FIELD-SYNC] Reset ${result.modifiedCount} documents`);
        res.json({ success: true, action: "reset", matched: result.matchedCount, modified: result.modifiedCount });
    } catch (e: any) {
        log.error("[RESET-ITEM-FIELD-SYNC] Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Count how many products would populate suite_list ─────────────────────
// GET /sync-count  → read-only counts from master_list + netsuite
router.get("/sync-count", async (_req, res) => {
    try {
        const masterDb: any = await getDb("master_list");
        const nsDb: any = await getDb("netsuite");

        const productCol = masterDb.collection("product_list");
        const suiteClassCol = nsDb.collection("suite_class");

        const totalProducts = await productCol.countDocuments();
        const withSku = await productCol.countDocuments({ sku: { $exists: true, $nin: [null, ""] } });
        const withClass = await productCol.countDocuments({ category_class: { $exists: true, $nin: [null, ""] } });

        const withSynnex = await productCol.countDocuments({ synnex_response: { $exists: true, $not: { $size: 0 } } });
        const withDandh = await productCol.countDocuments({ dandh_response: { $exists: true, $ne: null } });
        const withIngram = await productCol.countDocuments({ ingram_response: { $exists: true, $ne: null } });
        const withSupplies = await productCol.countDocuments({ supplies_response: { $exists: true, $ne: null } });

        const withAnyDistributor = await productCol.countDocuments({
            $or: [
                { distributor: { $exists: true, $nin: [null, ""] } },
                { dandh_price: { $gt: 0 } },
                { synnex_price: { $gt: 0 } },
                { ingram_price: { $gt: 0 } },
                { supplies_price: { $gt: 0 } },
            ]
        });

        const suiteClassCount = await suiteClassCol.countDocuments().catch(() => 0);
        const suiteListCount = await nsDb.collection("suite_list").countDocuments().catch(() => 0);

        res.json({
            success: true,
            master_list: {
                total_products: totalProducts,
                with_sku: withSku,
                with_class: withClass,
                with_any_distributor: withAnyDistributor,
            },
            distributor_responses: {
                synnex: withSynnex,
                dandh: withDandh,
                ingram: withIngram,
                supplies: withSupplies,
            },
            netsuite: {
                suite_class_count: suiteClassCount,
                suite_list_count: suiteListCount,
            },
            note: "with_sku = items that would be upserted into suite_list by /sync"
        });
    } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
});

// ─── ERP item counts by creation date ──────────────────────────────────────
// GET /erp-item-stats              → overall counts
// GET /erp-item-stats?before=2026-03-12  → items created before a date
// "created" field is stored as string "MM/DD/YYYY" — uses $dateFromString to parse
router.get("/erp-item-stats", async (req, res) => {
    try {
        const nsDb = await getDb("netsuite");
        const col = nsDb.collection("netsuite_items_full");

        const total = await col.countDocuments();
        const beforeDate = req.query.before ? String(req.query.before) : null;

        const result: any = { success: true, total };

        if (beforeDate) {
            const dt = new Date(beforeDate);

            // "created" is stored as string "MM/DD/YYYY" — use aggregation to parse
            const [agg] = await col.aggregate([
                { $match: { created: { $exists: true, $ne: null } } },
                {
                    $addFields: {
                        _parsedCreated: {
                            $dateFromString: {
                                dateString: "$created",
                                format: "%m/%d/%Y",
                                onError: null
                            }
                        }
                    }
                },
                {
                    $group: {
                        _id: null,
                        beforeCount: {
                            $sum: {
                                $cond: [
                                    { $and: [{ $ne: ["$_parsedCreated", null] }, { $lt: ["$_parsedCreated", dt] }] },
                                    1, 0
                                ]
                            }
                        },
                        afterCount: {
                            $sum: {
                                $cond: [
                                    { $and: [{ $ne: ["$_parsedCreated", null] }, { $gte: ["$_parsedCreated", dt] }] },
                                    1, 0
                                ]
                            }
                        },
                        noDate: {
                            $sum: { $cond: [{ $eq: ["$_parsedCreated", null] }, 1, 0] }
                        }
                    }
                }
            ]).toArray();

            result.before = { date: beforeDate, count: agg?.beforeCount ?? 0 };
            result.after = { date: beforeDate, count: agg?.afterCount ?? 0 };
            result.no_created_date = agg?.noDate ?? 0;
        }

        // Sample a few docs to show date format
        const samples = await col.find(
            { created: { $exists: true, $ne: null } },
            { projection: { created: 1, lastmodifieddate: 1, itemid: 1, type: 1 } }
        ).limit(3).toArray();
        result.sample_date_fields = samples;

        res.json(result);
    } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
});

export default router;
