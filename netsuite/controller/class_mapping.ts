import { Request, Response } from "express";
import { getDb } from "../config/mongdodb.config";
import log from "../config/logger.config";

const BATCH_SIZE = 1000;

/**
 * GET /map-item-classes
 *
 * Maps class hierarchy from master_list/product_list onto netsuite_items_full.
 *
 * Steps:
 * 1. Flatten netsuite_classifications tree → fullname→internalid map
 * 2. Load master_list.product_list → sku→{L1,L2,L3} map
 * 3. For each item in netsuite_items_full, check current class depth
 * 4. If missing levels, resolve IDs from classifications, update class array
 */
export async function mapItemClasses(req: Request, res: Response) {
    try {
        const dryRun = req.query.dry === "1" || req.query.dry === "true";
        const result = await runClassMapping(dryRun);
        return res.json(result);
    } catch (err: any) {
        log.error("[CLASS-MAP] Error:", err);
        return res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
}

export async function runClassMapping(dryRun = false) {
    const nsDb = await getDb("netsuite");
    const masterDb = await getDb("master_list");

    // ── Step 1: Build fullname → internalid map from classification tree ──
    const classCol = nsDb.collection("netsuite_classifications");
    const classRoots = await classCol.find({}).toArray();

    if (classRoots.length === 0) {
        return { success: false, error: "netsuite_classifications is empty — run /sync-class-tree first" };
    }

    const classMap = new Map<string, string>(); // fullname → internalid
    const nameAtLevelMap = new Map<string, string>(); // "L1" or "L1 : L2" → internalid

    function flattenTree(node: any) {
        if (node.fullname && node.internalid) {
            classMap.set(node.fullname.trim(), String(node.internalid));
        }
        if (node.name && node.internalid) {
            // Also store just the name for root-level (L1) lookups
            nameAtLevelMap.set(node.name.trim(), String(node.internalid));
        }
        if (Array.isArray(node.children)) {
            for (const child of node.children) {
                flattenTree(child);
            }
        }
    }

    for (const root of classRoots) {
        flattenTree(root);
    }

    log.info(`[CLASS-MAP] Classification map built: ${classMap.size} entries`);

    // ── Step 2: Build SKU → class levels map from master_list.product_list ──
    const productCol = masterDb.collection("product_list");
    const products = await productCol.find(
        {},
        { projection: { sku: 1, category_class: 1, category_class_l2: 1, category_class_l3: 1 } }
    ).toArray();

    const skuClassMap = new Map<string, { l1: string; l2: string; l3: string }>();
    for (const p of products) {
        const sku = (p.sku || "").toString().trim();
        if (!sku) continue;
        skuClassMap.set(sku, {
            l1: (p.category_class || "").toString().trim(),
            l2: (p.category_class_l2 || "").toString().trim(),
            l3: (p.category_class_l3 || "").toString().trim(),
        });
    }

    log.info(`[CLASS-MAP] Master list loaded: ${skuClassMap.size} SKUs with class data`);

    // ── Step 3: Process items in netsuite_items_full ──
    const itemCol = nsDb.collection("netsuite_items_full");
    const items = await itemCol.find(
        { itemid: { $exists: true, $ne: null } },
        { projection: { itemid: 1, class: 1, internalid: 1, type: 1 } }
    ).toArray();

    log.info(`[CLASS-MAP] Processing ${items.length} items from netsuite_items_full...`);

    let matched = 0;
    let updated = 0;
    let alreadyComplete = 0;
    let noClassInMaster = 0;
    let classNotFound = 0;
    const ops: any[] = [];
    const sampleUpdates: any[] = [];
    const missingClasses: Set<string> = new Set();

    for (const item of items) {
        const sku = (item.itemid || "").toString().trim();
        const masterClass = skuClassMap.get(sku);

        if (!masterClass || !masterClass.l1) {
            noClassInMaster++;
            continue;
        }

        matched++;

        // Build expected class hierarchy
        const expectedLevels: { level: number; name: string; id?: string }[] = [];
        const parts: string[] = [];

        // L1
        if (masterClass.l1) {
            parts.push(masterClass.l1);
            const fullname = parts.join(" : ");
            const id = classMap.get(fullname);
            expectedLevels.push({ level: 1, name: masterClass.l1, ...(id ? { id } : {}) });
            if (!id) missingClasses.add(fullname);
        }

        // L2
        if (masterClass.l2) {
            parts.push(masterClass.l2);
            const fullname = parts.join(" : ");
            const id = classMap.get(fullname);
            expectedLevels.push({ level: 2, name: masterClass.l2, ...(id ? { id } : {}) });
            if (!id) missingClasses.add(fullname);
        }

        // L3
        if (masterClass.l3) {
            parts.push(masterClass.l3);
            const fullname = parts.join(" : ");
            const id = classMap.get(fullname);
            expectedLevels.push({ level: 3, name: masterClass.l3, ...(id ? { id } : {}) });
            if (!id) missingClasses.add(fullname);
        }

        // Compare current vs expected
        const currentClass = Array.isArray(item.class) ? item.class : [];
        const currentDepth = currentClass.length;
        const expectedDepth = expectedLevels.length;

        // Check if current class already matches expected (same depth + all IDs present)
        let needsUpdate = false;

        if (currentDepth < expectedDepth) {
            needsUpdate = true;
        } else {
            // Same or greater depth — check if IDs are filled in
            for (let i = 0; i < expectedLevels.length; i++) {
                const cur = currentClass[i];
                const exp = expectedLevels[i];
                if (!cur || !cur.id || (exp.id && String(cur.id) !== String(exp.id))) {
                    needsUpdate = true;
                    break;
                }
            }
        }

        if (!needsUpdate) {
            alreadyComplete++;
            continue;
        }

        // Count missing IDs for reporting
        if (expectedLevels.some((l) => !l.id)) {
            classNotFound++;
        }

        if (!dryRun) {
            ops.push({
                updateOne: {
                    filter: { internalid: item.internalid },
                    update: {
                        $set: {
                            internalid: item.internalid,
                            itemid: sku,
                            type: item.type || "InvtPart",
                            class: expectedLevels,
                            previous_class: currentClass,
                            _class_mapped_at: new Date(),
                        },
                        $unset: { ns_field_pushed: "", ns_field_pushed_at: "" },
                    },
                    upsert: true,
                },
            });
        }

        updated++;

        // Keep samples for reporting
        if (sampleUpdates.length < 10) {
            sampleUpdates.push({
                sku,
                internalid: item.internalid,
                before: currentClass,
                after: expectedLevels,
            });
        }
    }

    // ── Step 4: Write to netsuite_items_field_update (merged collection) ──
    const updateCol = nsDb.collection("netsuite_items_field_update");
    await updateCol.createIndex({ internalid: 1 }, { unique: true });

    let writeResult = { modifiedCount: 0, matchedCount: 0 };
    if (!dryRun && ops.length > 0) {
        let totalUpserted = 0;
        let totalModified = 0;

        for (let i = 0; i < ops.length; i += BATCH_SIZE) {
            const batch = ops.slice(i, i + BATCH_SIZE);
            const r: any = await updateCol.bulkWrite(batch, { ordered: false });
            totalUpserted += r.upsertedCount ?? 0;
            totalModified += r.modifiedCount ?? 0;
        }

        writeResult = { modifiedCount: totalModified + totalUpserted, matchedCount: totalModified + totalUpserted };
        log.info(`[CLASS-MAP] Wrote ${totalModified + totalUpserted} items to netsuite_items_field_update`);
    }

    const summary = {
        success: true,
        dryRun,
        totalItems: items.length,
        matchedInMaster: matched,
        noClassInMaster,
        alreadyComplete,
        needsUpdate: updated,
        classNotFoundInTree: classNotFound,
        missingClassNames: Array.from(missingClasses).slice(0, 50),
        ...(dryRun ? {} : { modified: writeResult.modifiedCount }),
        samples: sampleUpdates,
    };

    log.info(`[CLASS-MAP] Done — matched: ${matched}, updated: ${updated}, complete: ${alreadyComplete}, no class: ${noClassInMaster}`);
    return summary;
}

