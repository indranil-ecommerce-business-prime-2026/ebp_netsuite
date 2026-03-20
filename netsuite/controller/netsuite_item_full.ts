import { Request, Response } from "express";
import { getDb } from "../config/mongdodb.config";
import { callDiagnostic } from "../services/netsuite.client";
import log from "../config/logger.config";

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
        log.error("[ITEM-FULL] Error:", err);
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

    const PAGE_MAX_RETRIES = 3;

    // ── Resume + Incremental: check last sync metadata ──
    const metaCol = nsDb.collection("sync_metadata");
    const lastRun = await metaCol.findOne({ _id: "item_full_sync" } as any);

    // Resume from interrupted page if sync didn't complete
    let page = lastRun?.lastCompletedPage != null ? lastRun.lastCompletedPage + 1 : 0;

    // Incremental: only fetch items modified since last completed sync
    // First run (no completedAt) = full sync. Subsequent runs = incremental.
    let modifiedSince: string | undefined;
    if (page === 0 && lastRun?.completedAt && mode === "fast") {
        // Format: "YYYY-MM-DD HH:MM:SS" for SuiteQL
        const d = new Date(lastRun.completedAt);
        modifiedSince = d.toISOString().replace("T", " ").substring(0, 19);
        log.info(`[${label}] Incremental sync — only items modified since ${modifiedSince}`);
    }

    if (page > 0) {
        log.info(`[${label}] Resuming from page ${page} (last run stopped at page ${page - 1})`);
    }

    let totalInserted = 0;
    let totalUpdated = 0;
    let totalPulled = 0;
    let failedPages: number[] = [];
    let done = false;

    while (!done) {
        log.info(`[${label}] Fetching page ${page} (pageSize: ${pageSize})...`);

        let response: any;
        let pageSuccess = false;

        for (let attempt = 1; attempt <= PAGE_MAX_RETRIES; attempt++) {
            try {
                response = await callDiagnostic({
                    sections: [section],
                    page,
                    pageSize,
                    ...(modifiedSince ? { modifiedSince } : {}),
                });
                pageSuccess = true;
                break;
            } catch (err: any) {
                // If fast mode fails on page 0, fall back to search mode
                if (mode === "fast" && page === 0) {
                    log.warn(`[${label}] SuiteQL failed, falling back to N/search mode: ${err.message}`);
                    return runItemFullSync(Math.min(pageSize, 1000), "search");
                }
                log.error(`[${label}] Page ${page} attempt ${attempt}/${PAGE_MAX_RETRIES} failed: ${err.message}`);
                if (attempt < PAGE_MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, 2000 * attempt)); // 2s, 4s backoff
                }
            }
        }

        if (!pageSuccess) {
            log.error(`[${label}] Page ${page} failed after ${PAGE_MAX_RETRIES} retries — skipping`);
            failedPages.push(page);
            page++;
            // Can't determine done without a response — keep going until we get one
            continue;
        }

        const batch = response?.[section];

        if (!batch || batch.error) {
            // If fast mode fails on page 0 (RESTlet-level error), fall back
            if (mode === "fast" && page === 0) {
                log.warn(`[${label}] SuiteQL returned error, falling back to N/search: ${batch?.error}`);
                return runItemFullSync(Math.min(pageSize, 1000), "search");
            }
            log.error(`[${label}] Page ${page} returned error: ${batch?.error} — skipping`);
            failedPages.push(page);
            page++;
            continue;
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
            log.warn(`[${label}] Skipped fields: ${batch.skippedFields.join(", ")}`);
        }

        log.info(`[${label}] Page ${page}: ${items.length} items (total: ${totalPulled}/${batch.total})`);

        // Save progress after each successful page
        await metaCol.updateOne(
            { _id: "item_full_sync" } as any,
            { $set: { lastCompletedPage: page, lastPageAt: new Date(), total: batch.total, pageSize } },
            { upsert: true }
        );

        done = batch.done || items.length === 0;
        page++;
    }

    // Reset resume pointer on completion so next run starts fresh
    await metaCol.updateOne(
        { _id: "item_full_sync" } as any,
        { $set: { lastCompletedPage: null, completedAt: new Date(), totalPulled, failedPages } },
        { upsert: true }
    );

    log.info(`[${label}] Done. Pulled: ${totalPulled}, inserted: ${totalInserted}, updated: ${totalUpdated}, failed pages: ${failedPages.length > 0 ? failedPages.join(",") : "none"}`);

    return {
        success: true,
        mode,
        incremental: !!modifiedSince,
        modifiedSince: modifiedSince || null,
        totalPulled,
        inserted: totalInserted,
        updated: totalUpdated,
        pages: page,
        failedPages: failedPages.length > 0 ? failedPages : undefined,
    };
}

/**
 * Phase 2: Fetch Location + Vendor sublists for all inventory items
 * in netsuite_items_full that don't yet have _sublists_at (or are stale).
 *
 * Called by hourly cron. Uses record.load (5 governance units each when
 * item type is passed — avoids try/catch fallback waste).
 *
 * Batch size 500 = ~2,500 governance units/call (50% of 5,000 limit).
 * 3 parallel workers = ~3x throughput.
 */
const SUBLISTS_BATCH_SIZE = 500;
const PARALLEL_RESTLET_CALLS = 3;

async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
    const results: T[] = [];
    let index = 0;
    async function worker() {
        while (index < tasks.length) {
            const i = index++;
            results[i] = await tasks[i]();
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
    return results;
}

export async function runItemSublistsSync(batchSize = SUBLISTS_BATCH_SIZE) {
    const nsDb = await getDb("netsuite");
    const col = nsDb.collection("netsuite_items_full");

    // If collection is empty, run Phase 1 first to populate items
    const docCount = await col.countDocuments();
    if (docCount === 0) {
        log.info("[ITEM-SUBLISTS] Collection empty — running Phase 1 (item full sync) first...");
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
        { projection: { internalid: 1, type: 1 } }
    ).toArray();

    // Build ID list + type map for direct record.load (no try/catch waste)
    const allItems = itemsDocs
        .map((d: any) => ({ id: Number(d.internalid), type: d.type as string }))
        .filter((item) => item.id > 0);

    if (allItems.length === 0) {
        log.info("[ITEM-SUBLISTS] No items need sublist update.");
        return { success: true, updated: 0, total: 0 };
    }

    log.info(`[ITEM-SUBLISTS] Fetching sublists for ${allItems.length} inventory items (batch: ${batchSize}, parallel: ${PARALLEL_RESTLET_CALLS})...`);

    let sublistsUpdated = 0;
    let batchErrors = 0;

    // Build batch tasks
    const tasks: (() => Promise<void>)[] = [];
    for (let i = 0; i < allItems.length; i += batchSize) {
        const batchItems = allItems.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;

        const batchIds = batchItems.map((item) => item.id);
        const itemTypes: Record<string, string> = {};
        for (const item of batchItems) {
            itemTypes[String(item.id)] = item.type;
        }

        tasks.push(async () => {
            log.info(`[ITEM-SUBLISTS] Batch ${batchNum}: ${batchIds.length} items...`);
            try {
                const slResponse = await callDiagnostic({
                    sections: ["fetch_item_sublists"],
                    itemIds: batchIds,
                    itemTypes,
                });

                const slBatch = slResponse?.fetch_item_sublists;
                if (slBatch && slBatch.items) {
                    const ops = slBatch.items
                        .filter((slItem: any) => !slItem.error)
                        .map((slItem: any) => ({
                            updateOne: {
                                filter: { internalid: String(slItem.internalid) },
                                update: {
                                    $set: {
                                        _locations: slItem.locations,
                                        _vendors: slItem.vendors,
                                        _sublists_at: new Date(),
                                    },
                                },
                            },
                        }));

                    if (ops.length > 0) {
                        const bulkResult: any = await col.bulkWrite(ops, { ordered: false });
                        sublistsUpdated += bulkResult.modifiedCount + bulkResult.upsertedCount;
                    }
                }
            } catch (slErr: any) {
                log.error(`[ITEM-SUBLISTS] Batch ${batchNum} error:`, slErr.message);
                batchErrors++;
            }
        });
    }

    // Run batches with concurrency limit
    await runWithConcurrency(tasks, PARALLEL_RESTLET_CALLS);

    log.info(`[ITEM-SUBLISTS] Done. Updated: ${sublistsUpdated}/${allItems.length}, batch errors: ${batchErrors}`);

    return {
        success: true,
        updated: sublistsUpdated,
        total: allItems.length,
        batchErrors,
    };
}
