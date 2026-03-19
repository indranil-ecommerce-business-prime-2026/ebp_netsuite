/**
 * CLEANUP RESTLET — Delete POs and Test SOs from NetSuite
 *
 * Separate lightweight RESTlet to avoid issues with the large diagnostic file.
 *
 * POST body:
 *   { "action": "list_po" }                → dry-run: list all POs
 *   { "action": "delete_po" }              → delete ALL purchase orders
 *   { "action": "list_test_so" }           → dry-run: list test SOs (otherrefnum starts with "TEST")
 *   { "action": "delete_test_so" }         → delete test SOs
 *   { "action": "list_all" }               → dry-run: list both POs and test SOs
 *   { "action": "delete_all" }             → delete both POs and test SOs
 *
 * @NApiVersion 2.x
 * @NScriptType Restlet
 */
define(["N/record", "N/search", "N/log"], function (record, search, log) {

    function post(payload) {
        log.debug("CLEANUP_ENTRY", "action=" + (payload.action || "none"));

        var action = payload.action || "list_all";
        var result = {};

        // ── Purchase Orders ──────────────────────────────────────────────
        if (action === "list_po" || action === "delete_po" || action === "list_all" || action === "delete_all") {
            var doDeletePO = (action === "delete_po" || action === "delete_all");
            result.purchase_orders = handlePurchaseOrders(doDeletePO);
        }

        // ── Test Sales Orders ────────────────────────────────────────────
        if (action === "list_test_so" || action === "delete_test_so" || action === "list_all" || action === "delete_all") {
            var doDeleteSO = (action === "delete_test_so" || action === "delete_all");
            result.test_sales_orders = handleTestSalesOrders(doDeleteSO);
        }

        return result;
    }

    // Max deletions per call — record.delete costs 20 units, RESTlet limit is 5000
    // 200 × 20 = 4000 units, safely under limit
    var BATCH_LIMIT = 200;

    // ─── Find and optionally delete all Purchase Orders ──────────────────
    function handlePurchaseOrders(doDelete) {
        log.debug("CLEANUP_PO", "Starting PO search, doDelete=" + doDelete);

        var poList = [];
        var searchObj = search.create({
            type: search.Type.PURCHASE_ORDER,
            filters: [["mainline", "is", "T"]],
            columns: ["internalid", "tranid", "otherrefnum"]
        });

        searchObj.run().each(function (r) {
            poList.push({
                id: r.getValue("internalid"),
                poNumber: r.getValue("tranid"),
                otherrefnum: r.getValue("otherrefnum") || ""
            });
            return poList.length < 1000;  // gather up to 1000 to know total
        });

        log.debug("CLEANUP_PO", "Found " + poList.length + " POs");

        if (!doDelete) {
            return { mode: "dry_run", count: poList.length, orders: poList };
        }

        // Delete up to BATCH_LIMIT per call
        var batch = poList.slice(0, BATCH_LIMIT);
        var deleted = [];
        var errors = [];
        for (var i = 0; i < batch.length; i++) {
            try {
                record.delete({ type: record.Type.PURCHASE_ORDER, id: parseInt(batch[i].id, 10) });
                deleted.push(batch[i]);
            } catch (e) {
                errors.push({ id: batch[i].id, poNumber: batch[i].poNumber, error: e.message });
                log.error("CLEANUP_PO", "Failed to delete PO " + batch[i].id + ": " + e.message);
            }
        }

        var remaining = poList.length - deleted.length;
        log.debug("CLEANUP_PO", "Batch done. Deleted: " + deleted.length + ", errors: " + errors.length + ", remaining: ~" + remaining);

        return {
            mode: "executed",
            deleted: deleted.length,
            errors: errors.length,
            remaining: remaining,
            done: remaining <= 0,
            errorList: errors
        };
    }

    // ─── Find and optionally delete test Sales Orders ────────────────────
    function handleTestSalesOrders(doDelete) {
        log.debug("CLEANUP_SO", "Starting test SO search, doDelete=" + doDelete);

        var soList = [];
        var searchObj = search.create({
            type: search.Type.SALES_ORDER,
            filters: [
                ["mainline", "is", "T"],
                "AND",
                ["otherrefnum", "startswith", "TEST"]
            ],
            columns: ["internalid", "tranid", "otherrefnum"]
        });

        searchObj.run().each(function (r) {
            soList.push({
                id: r.getValue("internalid"),
                soNumber: r.getValue("tranid"),
                otherrefnum: r.getValue("otherrefnum") || ""
            });
            return soList.length < 1000;
        });

        log.debug("CLEANUP_SO", "Found " + soList.length + " test SOs");

        if (!doDelete) {
            return { mode: "dry_run", count: soList.length, orders: soList };
        }

        // Delete up to BATCH_LIMIT per call
        var batch = soList.slice(0, BATCH_LIMIT);
        var deleted = [];
        var errors = [];
        for (var i = 0; i < batch.length; i++) {
            try {
                record.delete({ type: record.Type.SALES_ORDER, id: parseInt(batch[i].id, 10) });
                deleted.push(batch[i]);
            } catch (e) {
                errors.push({ id: batch[i].id, soNumber: batch[i].soNumber, error: e.message });
                log.error("CLEANUP_SO", "Failed to delete SO " + batch[i].id + ": " + e.message);
            }
        }

        var remaining = soList.length - deleted.length;
        log.debug("CLEANUP_SO", "Batch done. Deleted: " + deleted.length + ", errors: " + errors.length + ", remaining: ~" + remaining);

        return {
            mode: "executed",
            deleted: deleted.length,
            errors: errors.length,
            remaining: remaining,
            done: remaining <= 0,
            errorList: errors
        };
    }

    return { post: post };
});
