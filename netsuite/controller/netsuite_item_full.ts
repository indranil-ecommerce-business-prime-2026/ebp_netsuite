import { Request, Response } from "express";
import { getDb } from "../config/mongdodb.config";
import { callDiagnostic } from "../services/netsuite.client";

/**
 * GET /netsuite-items-full?pageSize=2000
 * GET /netsuite-items-full?pageSize=2000&mode=fast   → SuiteQL (default)
 * GET /netsuite-items-full?pageSize=500&mode=search  → N/search fallback
 *
 * Phase 1: Fetches ALL items from NetSuite → netsuite.netsuite_items_full.
 *          Builds _class object { id, text, l1, l2, l3 } from class hierarchy.
 *
 * Default mode=fast uses SuiteQL (up to 5000/page, faster pagination).
 * Falls back to N/search mode if SuiteQL fails on first page.
 */
export const syncNetsuiteItemsFull = async (req: Request, res: Response) => {
    const mode = (req.query.mode as string) || "fast";
    const maxPageSize = mode === "fast" ? 5000 : 1000;
    const defaultPageSize = mode === "fast" ? 2000 : 500;
    const pageSize = Math.min(Number(req.query.pageSize) || defaultPageSize, maxPageSize);

    try {
        const result = await runItemFullSync(pageSize, mode);
        return res.json(result);
    } catch (err: any) {
        console.error("[ITEM-FULL] Error:", err);
        return res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
};

/**
 * Phase 1 core — callable from both endpoint and cron.
 * mode = "fast"   → SuiteQL via fetch_items_fast (up to 5000/page, OFFSET pagination)
 * mode = "search" → N/search via fetch_all_items_full (up to 1000/page, runPaged)
 *
 * If "fast" fails on page 0, automatically retries with "search" mode.
 */
export async function runItemFullSync(pageSize = 2000, mode = "fast") {
    const nsDb = await getDb("netsuite");
    const col = nsDb.collection("netsuite_items_full");

    await col.createIndex({ itemid: 1 }, { unique: true });
    await col.createIndex({ internalid: 1 });

    const section = mode === "fast" ? "fetch_items_fast" : "fetch_all_items_full";
    const label = mode === "fast" ? "ITEM-FAST" : "ITEM-FULL";

    let page = 0;
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalPulled = 0;
    let done = false;

    while (!done) {
        console.log(`[${label}] Fetching page ${page} (pageSize: ${pageSize})...`);

        let response: any;
        try {
            response = await callDiagnostic({
                sections: [section],
                page,
                pageSize,
            });
        } catch (err: any) {
            // If fast mode fails on page 0, fall back to search mode
            if (mode === "fast" && page === 0) {
                console.warn(`[${label}] SuiteQL failed, falling back to N/search mode: ${err.message}`);
                return runItemFullSync(Math.min(pageSize, 1000), "search");
            }
            throw err;
        }

        const batch = response?.[section];

        if (!batch || batch.error) {
            // If fast mode fails on page 0 (RESTlet-level error), fall back
            if (mode === "fast" && page === 0) {
                console.warn(`[${label}] SuiteQL returned error, falling back to N/search: ${batch?.error}`);
                return runItemFullSync(Math.min(pageSize, 1000), "search");
            }
            throw new Error(batch?.error || "RESTlet returned failure at page " + page);
        }

        const items: any[] = batch.items || [];
        totalPulled += items.length;

        if (items.length > 0) {
            const ops = items
                .filter((item: any) => item.itemid)
                .map((item: any) => {
                    // Build class object with l1, l2, l3 from "L1 : L2 : L3" text
                    const classText = (item.class_text || "").trim();
                    const classParts = classText ? classText.split(":").map((s: string) => s.trim()) : [];
                    item._class = {
                        id: item.class || null,
                        text: classText || null,
                        l1: classParts[0] || null,
                        l2: classParts[1] || null,
                        l3: classParts[2] || null,
                    };

                    return {
                        updateOne: {
                            filter: { itemid: item.itemid },
                            update: {
                                $set: { ...item, updated_at: new Date() },
                                $setOnInsert: { created_at: new Date() },
                            },
                            upsert: true,
                        },
                    };
                });

            if (ops.length > 0) {
                const bulkResult: any = await col.bulkWrite(ops, { ordered: false });
                totalInserted += bulkResult.upsertedCount ?? 0;
                totalUpdated += bulkResult.modifiedCount ?? 0;
            }
        }

        if (batch.skippedFields && batch.skippedFields.length > 0 && page === 0) {
            console.warn(`[${label}] Skipped fields: ${batch.skippedFields.join(", ")}`);
        }

        console.log(`[${label}] Page ${page}: ${items.length} items (total: ${totalPulled}/${batch.total})`);

        done = batch.done || items.length === 0;
        page++;
    }

    console.log(`[${label}] Done. Pulled: ${totalPulled}, inserted: ${totalInserted}, updated: ${totalUpdated}`);

    return {
        success: true,
        mode,
        totalPulled,
        inserted: totalInserted,
        updated: totalUpdated,
        pages: page,
    };
}

/**
 * Phase 2: Fetch Location + Vendor sublists for all inventory items
 * in netsuite_items_full that don't yet have _sublists_at (or are stale).
 *
 * Called by hourly cron. Uses record.load (10 governance units each),
 * 50 items per RESTlet call.
 */
export async function runItemSublistsSync(batchSize = 50) {
    const nsDb = await getDb("netsuite");
    const col = nsDb.collection("netsuite_items_full");

    // If collection is empty, run Phase 1 first to populate items
    const docCount = await col.countDocuments();
    if (docCount === 0) {
        console.log("[ITEM-SUBLISTS] Collection empty — running Phase 1 (item full sync) first...");
        await runItemFullSync();
    }

    // Find inventory items that need sublists updated
    // Items without _sublists_at, or where _sublists_at is older than 1 hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const itemsDocs = await col.find(
        {
            type: { $in: ["InvtPart", "SerializedInventoryItem"] },
            internalid: { $ne: null },
            $or: [
                { _sublists_at: { $exists: false } },
                { _sublists_at: { $lt: oneHourAgo } },
            ],
        },
        { projection: { internalid: 1 } }
    ).toArray();

    const allIds = itemsDocs
        .map((d: any) => Number(d.internalid))
        .filter((id: number) => id > 0);

    if (allIds.length === 0) {
        console.log("[ITEM-SUBLISTS] No items need sublist update.");
        return { success: true, updated: 0, total: 0 };
    }

    console.log(`[ITEM-SUBLISTS] Fetching sublists for ${allIds.length} inventory items...`);

    let sublistsUpdated = 0;

    for (let i = 0; i < allIds.length; i += batchSize) {
        const batchIds = allIds.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;
        console.log(`[ITEM-SUBLISTS] Batch ${batchNum}: ${batchIds.length} items...`);

        try {
            const slResponse = await callDiagnostic({
                sections: ["fetch_item_sublists"],
                itemIds: batchIds,
            });

            const slBatch = slResponse?.fetch_item_sublists;
            if (slBatch && slBatch.items) {
                for (const slItem of slBatch.items) {
                    if (slItem.error) continue;

                    await col.updateOne(
                        { internalid: String(slItem.internalid) },
                        {
                            $set: {
                                _locations: slItem.locations,
                                _vendors: slItem.vendors,
                                _sublists_at: new Date(),
                            },
                        }
                    );
                    sublistsUpdated++;
                }
            }
        } catch (slErr: any) {
            console.error(`[ITEM-SUBLISTS] Batch ${batchNum} error:`, slErr.message);
        }
    }

    console.log(`[ITEM-SUBLISTS] Done. Updated: ${sublistsUpdated}/${allIds.length}`);

    return {
        success: true,
        updated: sublistsUpdated,
        total: allIds.length,
    };
}
