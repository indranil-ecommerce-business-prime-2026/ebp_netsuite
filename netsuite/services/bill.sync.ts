import { getDb } from "../config/mongdodb.config";
import { postToNetsuiteForBill } from "./netsuite.client";
import { SYNC_MODE_BILL as SYNC_MODE, TEST_MODE, STOP_ON_ERROR, MAX_RETRIES } from "../config/sync.config";
import { withConcurrency } from "../config/concurrency.config";
import log from "../config/logger.config";

const PARALLEL_WORKERS = 5;
const BILL_BATCH = 30;

// Errors that should never be retried -- mark as permanently failed immediately
const PERMANENT_ERRORS = [
    "PO not found for otherrefnum",
    "No matching lines",
    "No billable PO found",
    "Missing po_number"
];

function isPermanentError(error: string): boolean {
    return PERMANENT_ERRORS.some(pe => error.includes(pe));
}

export const syncBillsToNetsuite = async (): Promise<any[]> => {
    log.info(`[NS Bill Sync] Starting -- mode: ${SYNC_MODE}, workers: ${PARALLEL_WORKERS}, stopOnError: ${STOP_ON_ERROR}`);

    const ns_db = await getDb("netsuite");
    const billCollection = ns_db.collection("suite_vendor_bill");
    const poCollection = ns_db.collection("suite_purchase_order");

    // Base filter: not synced, not failed, not skipped
    const filter = {
        ns_synced: { $ne: true },
        ns_failed: { $ne: true },
        ns_skip:   { $ne: true }
    };

    const bills = await billCollection.find(filter).limit(BILL_BATCH).toArray();

    if (bills.length === 0) {
        log.info("[NS Bill Sync] No bills to process. Skipping.");
        return [];
    }

    // -- PO dependency check: only sync bills whose PO is confirmed created --
    const poNumbers = Array.from(new Set(bills.map((b: any) => b.po_number)));
    const syncedPOs = await poCollection
        .find({ po_number: { $in: poNumbers }, ns_synced: true, ns_result: "created" })
        .project({ po_number: 1 })
        .toArray();
    const syncedPOSet = new Set(syncedPOs.map((p: any) => p.po_number));

    const readyBills = bills.filter((b: any) => syncedPOSet.has(b.po_number));
    const waitingBills = bills.length - readyBills.length;

    if (waitingBills > 0) {
        log.info(`[NS Bill Sync] ${waitingBills} bills waiting -- PO not synced yet (will retry next cycle)`);
    }

    if (readyBills.length === 0) {
        log.info("[NS Bill Sync] No bills with synced POs. Skipping.");
        return [];
    }

    log.info(`[NS Bill Sync] ${readyBills.length} bills ready (${syncedPOs.length} POs synced)${TEST_MODE ? " (TEST MODE)" : ""}`);

    if (TEST_MODE || STOP_ON_ERROR) {
        return syncSerial(billCollection, readyBills);
    }

    // -- Parallel sync with worker pool --
    let sent = 0;
    let errors = 0;
    let skipped = 0;
    const results: any[] = [];
    let index = 0;

    async function worker() {
        while (index < readyBills.length) {
            const i = index++;
            const entry = await syncOneBill(billCollection, readyBills[i]);
            results[i] = entry;

            if (entry.action === "skipped") skipped++;
            else if (entry.success === false) errors++;
            else sent++;
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(PARALLEL_WORKERS, readyBills.length) }, () => worker())
    );

    log.info(`[NS Bill Sync] Done -- sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${readyBills.length}`);
    return results;
};

// -- Process a single bill: RESTlet call + MongoDB status update --
async function syncOneBill(collection: any, bill: any): Promise<any> {
    const t0 = Date.now();
    const ref = bill.reference_number || `PO${bill.po_number}-${bill.invoice_number}`;

    try {
        const result = await withConcurrency(() => postToNetsuiteForBill({
            action:             SYNC_MODE,
            po_number:          bill.po_number,
            invoice_number:     bill.invoice_number,
            reference_number:   ref,
            invoice_date:       bill.invoice_date,
            due_date:           bill.due_date,
            line_items:         bill.items,
            po_type:            bill.po_type || "",
            stocking_warehouse: bill.stocking_warehouse || ""
        }), `Bill ${ref}`);

        const ms = Date.now() - t0;

        if (result.success === false) {
            const errorStr = typeof result.error === "string" ? result.error : JSON.stringify(result.error);
            log.error(`[NS Bill Sync] Failed: ${ref} -> ${errorStr} (${ms}ms)`);

            // Permanent errors: skip immediately, don't waste retries
            if (isPermanentError(errorStr)) {
                await markPermanentSkip(collection, bill, errorStr);
                return { reference_number: ref, success: false, error: errorStr, ms, permanent: true };
            }

            await markFailed(collection, bill, result.error);
            return { reference_number: ref, success: false, error: errorStr, ms };
        }

        // Save rich result from RESTlet (bill ID, line breakdown, unmatched SKUs)
        const syncUpdate: any = {
            ns_synced: true,
            ns_synced_at: new Date(),
            ns_result: result.action
        };

        // Persist NetSuite bill internal ID for reference
        if (result.bill?.internalId) {
            syncUpdate.ns_bill_id = result.bill.internalId;
        }

        // Persist line breakdown for audit
        if (result.lines) {
            syncUpdate.ns_lines = result.lines;
        }

        // Persist unmatched SKUs so we can see what invoice items weren't on the PO
        if (result.unmatchedSkus && result.unmatchedSkus.length > 0) {
            syncUpdate.ns_unmatched_skus = result.unmatchedSkus;
        }

        await collection.updateOne(
            { _id: bill._id },
            {
                $set: syncUpdate,
                $unset: { ns_error: "", ns_retry_count: "", ns_failed: "" }
            }
        );

        const lineInfo = result.lines ? ` (lines: ${result.lines.updated} kept, ${result.lines.removed} removed, final ${result.lines.final})` : "";
        log.info(`[NS Bill Sync] Synced: ${ref} -> ${result.action}${lineInfo} (${ms}ms)`);
        return { reference_number: ref, ...result, ms };

    } catch (e: any) {
        const ms = Date.now() - t0;
        const rawErr = e?.response?.data || e.message;
        const errMsg = typeof rawErr === "string" ? rawErr : JSON.stringify(rawErr);
        log.error(`[NS Bill Sync] Error: ${ref}: ${errMsg} (${ms}ms)`);

        if (isPermanentError(errMsg)) {
            await markPermanentSkip(collection, bill, errMsg);
            return { reference_number: ref, success: false, error: errMsg, ms, permanent: true };
        }

        await markFailed(collection, bill, rawErr);
        return { reference_number: ref, success: false, error: errMsg, ms };
    }
}

// -- Serial fallback for TEST_MODE / STOP_ON_ERROR --
async function syncSerial(collection: any, bills: any[]): Promise<any[]> {
    let sent = 0, errors = 0, skipped = 0;
    const results: any[] = [];

    for (const bill of bills) {
        const entry = await syncOneBill(collection, bill);
        results.push(entry);

        if (entry.action === "skipped") { skipped++; continue; }
        if (entry.success === false) {
            errors++;
            if (STOP_ON_ERROR) { log.error("[NS Bill Sync] STOP_ON_ERROR -- halting."); break; }
            continue;
        }
        sent++;
        if (TEST_MODE) { log.info("[NS Bill Sync] TEST_MODE -- stopping after first."); break; }
    }

    log.info(`[NS Bill Sync] Done -- sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${bills.length}`);
    return results;
}

// --- Mark bill as failed with retry tracking ---
async function markFailed(collection: any, bill: any, error: any) {
    const retryCount = (bill.ns_retry_count || 0) + 1;
    const permanentlyFailed = retryCount >= MAX_RETRIES;

    const update: any = {
        $set: {
            ns_synced: false,
            ns_error: typeof error === "string" ? error : JSON.stringify(error),
            ns_error_at: new Date(),
            ns_retry_count: retryCount,
        }
    };

    if (permanentlyFailed) {
        update.$set.ns_failed = true;
        log.error(`[NS Bill Sync] Bill ${bill.reference_number} exceeded ${MAX_RETRIES} retries -- marked as permanently failed.`);
    }

    await collection.updateOne({ _id: bill._id }, update);
}

// --- Mark bill as permanently skipped (not retriable) ---
async function markPermanentSkip(collection: any, bill: any, error: string) {
    await collection.updateOne(
        { _id: bill._id },
        {
            $set: {
                ns_synced: false,
                ns_failed: true,
                ns_error: error,
                ns_error_at: new Date(),
                ns_skip_reason: "permanent_error"
            }
        }
    );
    log.warn(`[NS Bill Sync] Bill ${bill.reference_number} permanently failed: ${error}`);
}

// --- Retry failed bills ---
export const retryFailedBills = async (resetAll = false): Promise<any> => {
    const ns_db = await getDb("netsuite");
    const collection = ns_db.collection("suite_vendor_bill");

    const filter = resetAll
        ? { $or: [{ ns_synced: false, ns_error: { $exists: true } }, { ns_failed: true }] }
        : { ns_synced: false, ns_error: { $exists: true }, ns_failed: { $ne: true } };

    const failedBills = await collection.find(filter).toArray();

    if (failedBills.length === 0) {
        return { message: "No failed bills to retry.", count: 0 };
    }

    const result = await collection.updateMany(
        { _id: { $in: failedBills.map((b: any) => b._id) } },
        {
            $set: { ns_synced: false },
            $unset: { ns_error: "", ns_error_at: "", ns_retry_count: "", ns_failed: "", ns_skip_reason: "" }
        }
    );

    const billList = failedBills.map((b: any) => ({
        reference_number: b.reference_number,
        previousError: b.ns_error,
        retryCount: b.ns_retry_count || 0
    }));

    return {
        message: `Reset ${result.modifiedCount} failed bills for retry.`,
        count: result.modifiedCount,
        bills: billList
    };
};
