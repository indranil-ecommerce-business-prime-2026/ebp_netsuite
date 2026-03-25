import { Request, Response } from "express";
import { getDb } from "../config/mongdodb.config";
import { callDiagnostic } from "../services/netsuite.client";
import log from "../config/logger.config";

const BATCH_SIZE = 1000;
const POLL_INTERVAL = 10_000; // 10 seconds
const MAX_POLLS = 360;        // 1 hour max

// ─────────────────────────────────────────────────────────────────────────────
// Map Item Fields (displayname + purchasedescription) from master_list
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /map-item-fields           → apply updates
 * GET /map-item-fields?dry=1     → dry-run
 *
 * Matches netsuite_items_full by SKU to master_list/product_list.
 * Computes diffs for displayname and purchasedescription.
 * Writes changed items to netsuite_items_field_update collection.
 */
export async function mapItemFields(req: Request, res: Response) {
    try {
        const dryRun = req.query.dry === "1" || req.query.dry === "true";
        const result = await runFieldMapping(dryRun);
        return res.json(result);
    } catch (err: any) {
        log.error("[FIELD-MAP] Error:", err);
        return res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
}

async function runFieldMapping(dryRun = false) {
    const nsDb = await getDb("netsuite");
    const masterDb = await getDb("master_list");

    // ── Step 1: Load master_list.product_list → sku→{name} map ──
    const productCol = masterDb.collection("product_list");
    const products = await productCol.find(
        {},
        { projection: { sku: 1, name: 1, product_name: 1, displayname: 1 } }
    ).toArray();

    const skuMasterMap = new Map<string, { displayname: string; purchasedescription: string }>();
    for (const p of products) {
        const sku = (p.sku || "").toString().trim();
        if (!sku) continue;
        const name = trim(p.name ?? p.product_name ?? p.displayname) || "";
        if (!name) continue;
        skuMasterMap.set(sku, {
            displayname: name,
            purchasedescription: name,  // same source field
        });
    }

    log.info(`[FIELD-MAP] Master list loaded: ${skuMasterMap.size} SKUs with names`);

    // ── Step 2: Load netsuite_items_full ──
    const itemCol = nsDb.collection("netsuite_items_full");
    const items = await itemCol.find(
        { itemid: { $exists: true, $ne: null } },
        { projection: { itemid: 1, internalid: 1, displayname: 1, purchasedescription: 1, type: 1 } }
    ).toArray();

    log.info(`[FIELD-MAP] Processing ${items.length} items from netsuite_items_full...`);

    // ── Step 3: Compute diffs ──
    let matched = 0;
    let needsUpdate = 0;
    let alreadyCurrent = 0;
    let noMatch = 0;
    const ops: any[] = [];
    const sampleUpdates: any[] = [];

    for (const item of items) {
        const sku = (item.itemid || "").toString().trim();
        const master = skuMasterMap.get(sku);

        if (!master) {
            noMatch++;
            continue;
        }
        matched++;

        const changes: Record<string, any> = {};
        const previous: Record<string, any> = {};

        // displayname
        const curDisplay = trim(item.displayname) || "";
        if (master.displayname && master.displayname !== curDisplay) {
            changes.displayname = master.displayname;
            previous.previous_displayname = curDisplay;
        }

        // purchasedescription
        const curPurchDesc = trim(item.purchasedescription) || "";
        if (master.purchasedescription && master.purchasedescription !== curPurchDesc) {
            changes.purchasedescription = master.purchasedescription;
            previous.previous_purchasedescription = curPurchDesc;
        }

        if (Object.keys(changes).length === 0) {
            alreadyCurrent++;
            continue;
        }

        needsUpdate++;

        if (!dryRun) {
            ops.push({
                updateOne: {
                    filter: { internalid: item.internalid },
                    update: {
                        $set: {
                            internalid: item.internalid,
                            itemid: sku,
                            type: item.type || "InvtPart",
                            ...changes,
                            ...previous,
                            _field_mapped_at: new Date(),
                        },
                        $unset: { ns_field_pushed: "", ns_field_pushed_at: "" },
                    },
                    upsert: true,
                },
            });
        }

        if (sampleUpdates.length < 10) {
            sampleUpdates.push({ sku, internalid: item.internalid, changes, previous });
        }
    }

    // ── Step 4: Write to netsuite_items_field_update ──
    const updateCol = nsDb.collection("netsuite_items_field_update");
    await updateCol.createIndex({ internalid: 1 }, { unique: true });

    let writeResult = { modifiedCount: 0, upsertedCount: 0 };
    if (!dryRun && ops.length > 0) {
        let totalUpserted = 0;
        let totalModified = 0;

        for (let i = 0; i < ops.length; i += BATCH_SIZE) {
            const batch = ops.slice(i, i + BATCH_SIZE);
            const r: any = await updateCol.bulkWrite(batch, { ordered: false });
            totalUpserted += r.upsertedCount ?? 0;
            totalModified += r.modifiedCount ?? 0;
        }

        writeResult = { modifiedCount: totalModified, upsertedCount: totalUpserted };
        log.info(`[FIELD-MAP] Wrote ${totalModified + totalUpserted} items to netsuite_items_field_update`);
    }

    const summary = {
        success: true,
        dryRun,
        totalItems: items.length,
        matchedInMaster: matched,
        noMatchInMaster: noMatch,
        alreadyCurrent,
        needsUpdate,
        ...(dryRun ? {} : { written: writeResult.modifiedCount + writeResult.upsertedCount }),
        samples: sampleUpdates,
    };

    log.info(`[FIELD-MAP] Done — matched: ${matched}, needsUpdate: ${needsUpdate}, alreadyCurrent: ${alreadyCurrent}, noMatch: ${noMatch}`);
    return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Map isdropshipitem = false for ALL items
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /map-item-dropship-false           → apply
 * GET /map-item-dropship-false?dry=1     → dry-run
 *
 * Finds items in netsuite_items_full where isdropshipitem is truthy ('T', true, 'Yes').
 * Writes update records to netsuite_items_field_update.
 */
export async function mapDropshipFalse(req: Request, res: Response) {
    try {
        const dryRun = req.query.dry === "1" || req.query.dry === "true";
        const result = await runDropshipMapping(dryRun);
        return res.json(result);
    } catch (err: any) {
        log.error("[DROPSHIP-MAP] Error:", err);
        return res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
}

async function runDropshipMapping(dryRun = false) {
    const nsDb = await getDb("netsuite");
    const itemCol = nsDb.collection("netsuite_items_full");

    // SuiteQL stores checkboxes as 'T'/'F' strings
    const dropshipItems = await itemCol.find(
        { isdropshipitem: { $in: ["T", true, "Yes", "t"] } },
        { projection: { internalid: 1, itemid: 1, type: 1, isdropshipitem: 1 } }
    ).toArray();

    log.info(`[DROPSHIP-MAP] Found ${dropshipItems.length} items with isdropshipitem = true`);

    if (dryRun) {
        return {
            success: true,
            dryRun: true,
            count: dropshipItems.length,
            samples: dropshipItems.slice(0, 10).map((i) => ({
                internalid: i.internalid,
                itemid: i.itemid,
                current: i.isdropshipitem,
            })),
        };
    }

    const updateCol = nsDb.collection("netsuite_items_field_update");
    await updateCol.createIndex({ internalid: 1 }, { unique: true });

    const ops = dropshipItems.map((item) => ({
        updateOne: {
            filter: { internalid: item.internalid },
            update: {
                $set: {
                    internalid: item.internalid,
                    itemid: item.itemid || "",
                    type: item.type || "InvtPart",
                    isdropshipitem: false,
                    previous_isdropshipitem: item.isdropshipitem,
                    _dropship_mapped_at: new Date(),
                },
                $unset: { ns_field_pushed: "", ns_field_pushed_at: "" },
            },
            upsert: true,
        },
    }));

    let totalWritten = 0;
    for (let i = 0; i < ops.length; i += BATCH_SIZE) {
        const batch = ops.slice(i, i + BATCH_SIZE);
        const r: any = await updateCol.bulkWrite(batch, { ordered: false });
        totalWritten += (r.upsertedCount ?? 0) + (r.modifiedCount ?? 0);
    }

    log.info(`[DROPSHIP-MAP] Wrote ${totalWritten} items to netsuite_items_field_update`);

    return {
        success: true,
        dryRun: false,
        count: dropshipItems.length,
        written: totalWritten,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Push all pending field updates to NetSuite via MapReduce
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /push-item-fields           → push to NetSuite
 * GET /push-item-fields?dry=1     → dry-run
 *
 * Reads items from netsuite_items_field_update that haven't been pushed yet.
 * Builds a single values object per item with ALL pending field changes.
 * Triggers generalized MR script via trigger_fields_mr.
 */
export async function pushItemFields(req: Request, res: Response) {
    try {
        const dryRun = req.query.dry === "1" || req.query.dry === "true";
        const result = await runFieldPush(dryRun);
        return res.json(result);
    } catch (err: any) {
        log.error("[FIELD-PUSH] Error:", err);
        return res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
}

async function runFieldPush(dryRun = false) {
    const nsDb = await getDb("netsuite");
    const updateCol = nsDb.collection("netsuite_items_field_update");

    // Load items that need pushing
    const pendingItems = await updateCol.find({
        ns_field_pushed: { $ne: true },
    }).toArray();

    if (pendingItems.length === 0) {
        return { success: true, message: "No items to push.", total: 0 };
    }

    // Build MR payload — combine all field changes per item into one values object
    const FIELD_KEYS = ["displayname", "purchasedescription", "isdropshipitem", "class"] as const;

    const mrItems: { id: any; type: string; values: Record<string, any> }[] = [];

    for (const item of pendingItems) {
        const values: Record<string, any> = {};

        for (const key of FIELD_KEYS) {
            if (item[key] !== undefined && item[key] !== null) {
                // For class, extract leaf ID from the class array (same as class_mapping logic)
                if (key === "class" && Array.isArray(item[key])) {
                    const classArr = item[key] as any[];
                    const deepest = classArr[classArr.length - 1];
                    if (deepest?.id) {
                        values["class"] = Number(deepest.id);
                    }
                } else {
                    values[key] = item[key];
                }
            }
        }

        if (Object.keys(values).length === 0) continue;

        mrItems.push({
            id: item.internalid,
            type: item.type || "InvtPart",
            values,
        });
    }

    log.info(`[FIELD-PUSH] ${mrItems.length} items to push${dryRun ? " [DRY RUN]" : ""}`);

    // Summarize which fields are being updated
    const fieldCounts: Record<string, number> = {};
    for (const item of mrItems) {
        for (const key of Object.keys(item.values)) {
            fieldCounts[key] = (fieldCounts[key] || 0) + 1;
        }
    }

    if (dryRun) {
        return {
            success: true,
            dryRun: true,
            totalPending: pendingItems.length,
            pushable: mrItems.length,
            fieldCounts,
            samplePayload: mrItems.slice(0, 5),
        };
    }

    // Trigger MapReduce via diagnostic RESTlet
    const response = await callDiagnostic({
        sections: ["trigger_fields_mr"],
        items: mrItems,
    });

    const mrResult = response?.trigger_fields_mr;
    if (!mrResult?.success) {
        log.error(`[FIELD-PUSH] Failed to trigger MapReduce:`, mrResult?.error);
        return {
            success: false,
            error: mrResult?.error || "Failed to trigger MapReduce",
            totalPending: pendingItems.length,
            pushable: mrItems.length,
        };
    }

    log.info(`[FIELD-PUSH] MapReduce triggered — taskId: ${mrResult.taskId}, fileId: ${mrResult.fileId}, items: ${mrResult.itemCount}, fields: ${mrResult.fields}`);

    // Poll for completion
    let status = "PENDING";
    let percentComplete = 0;

    for (let poll = 0; poll < MAX_POLLS; poll++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

        try {
            const statusResponse = await callDiagnostic({
                sections: ["check_mr_status"],
                taskId: mrResult.taskId,
            });

            const check = statusResponse?.check_mr_status;
            status = check?.status || "UNKNOWN";
            percentComplete = check?.percentComplete || 0;

            log.info(`[FIELD-PUSH] MR status: ${status} (${percentComplete}%)`);

            if (status === "COMPLETE" || status === "FAILED") break;
        } catch (pollErr: any) {
            log.warn(`[FIELD-PUSH] Poll error: ${pollErr.message}`);
        }
    }

    // Mark all items as pushed in MongoDB
    if (status === "COMPLETE") {
        const allIds = mrItems.map((r) => r.id);
        await updateCol.updateMany(
            { internalid: { $in: allIds } },
            { $set: { ns_field_pushed: true, ns_field_pushed_at: new Date() } }
        );
        log.info(`[FIELD-PUSH] Marked ${allIds.length} items as ns_field_pushed in MongoDB`);
    }

    return {
        success: status === "COMPLETE",
        mode: "mapreduce",
        taskId: mrResult.taskId,
        fileId: mrResult.fileId,
        status,
        percentComplete,
        totalPending: pendingItems.length,
        pushable: mrItems.length,
        fieldCounts,
    };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function trim(v: any): string {
    if (v === null || v === undefined) return "";
    return String(v).trim();
}
