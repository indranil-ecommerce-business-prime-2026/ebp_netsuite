/**
 * NETSUITE RESTLET — Vendor Bill Sync
 *
 * Creates Vendor Bills from existing Purchase Orders via record.transform.
 * The bill is DIRECTLY LINKED to the PO (createdfrom field).
 *
 * MongoDB invoice items are SOURCE OF TRUTH for bill lines:
 *   - Transform lines matching invoice SKUs -> updated with invoice qty/rate
 *   - Transform lines NOT in invoice -> removed
 *   - Invoice items NOT on PO -> logged & skipped (cannot add without PO link)
 *
 * HOW TO DEPLOY IN NETSUITE:
 * 1. Go to: Customization > Scripting > Scripts > New
 * 2. Script Type: RESTlet
 * 3. Name: EBP Vendor Bill Sync
 * 4. Script ID: customscript_ebp_bill_sync
 * 5. Upload this file
 * 6. Set POST Function to: post
 * 7. Save > Deploy
 * 8. Deployment ID: customdeploy_ebp_bill_sync
 * 9. Status: Released
 *
 * PAYLOAD EXPECTED:
 * {
 *   action:             "skip" | "update",
 *   po_number:          "10001",                  <- PO otherrefnum to find the source PO
 *   invoice_number:     "INV-001",                <- vendor invoice #
 *   reference_number:   "PO10001-INV-001",        <- unique ref -> tranid/otherrefnum
 *   invoice_date:       "3/15/2026",              <- bill date (M/D/YYYY)
 *   due_date:           "4/15/2026",              <- bill due date (M/D/YYYY)
 *   line_items:         [{ sku, qty, price }],    <- SOURCE OF TRUTH for bill lines
 *   po_type:            "Dropship" | "Stocking",  <- for location resolution
 *   stocking_warehouse: "MW"                      <- warehouse code
 * }
 */

/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(["N/record", "N/search", "N/query", "N/log"], function (record, search, query, log) {

    // ── Warehouse map: stocking_warehouse code -> NetSuite location name ──
    var WAREHOUSE_MAP = {
        "MW":     "California - Chatsworth",
        "W2G-PA": "Ware2Go - PA (Fairless Hills)",
        "W2G-IL": "Ware2Go - IL (Aurora)",
        "W2G-KY": "Ware2Go - KY (Hebron)",
        "W2G-TX": "Ware2Go - TX (Dallas)"
    };

    var _locationCache = {};

    // ── Dynamic location lookup by exact name ───────────────────────────
    function findLocationByName(locationName) {
        if (_locationCache[locationName]) return _locationCache[locationName];

        var idCol = search.createColumn({ name: "internalid" });
        var results = search.create({
            type: "location",
            filters: [
                ["name", "is", locationName],
                "AND",
                ["isinactive", "is", "F"]
            ],
            columns: [idCol]
        }).run().getRange({ start: 0, end: 1 });

        if (results.length === 0) {
            log.debug("LOCATION_NOT_FOUND", "No active location named: " + locationName);
            return null;
        }

        var locId = parseInt(results[0].getValue(idCol), 10);
        _locationCache[locationName] = locId;
        log.debug("LOCATION_FOUND", locationName + " -> ID " + locId);
        return locId;
    }

    // ── Resolve location ID from po_type + stocking_warehouse ───────────
    function resolveLocation(poType, stockingWarehouse) {
        if (poType === "Dropship") {
            return findLocationByName("Dropship");
        }
        if (poType === "Stocking" && stockingWarehouse) {
            var locationName = WAREHOUSE_MAP[stockingWarehouse];
            if (!locationName) {
                log.debug("WAREHOUSE_UNKNOWN", "No mapping for stocking_warehouse: " + stockingWarehouse);
                return null;
            }
            return findLocationByName(locationName);
        }
        return null;
    }

    // ── Find ALL POs by otherrefnum using SuiteQL (exact match) ─────────
    function findPurchaseOrders(otherrefnum) {
        var sql = "SELECT id, tranid, status FROM transaction WHERE type = 'PurchOrd' AND otherrefnum = ? ORDER BY id DESC";
        var resultSet = query.runSuiteQL({ query: sql, params: [String(otherrefnum)] });
        var rows = resultSet.asMappedResults();

        if (rows.length === 0) return [];

        var matches = [];
        for (var i = 0; i < rows.length; i++) {
            matches.push({
                id: parseInt(rows[i].id, 10),
                poNumber: rows[i].tranid,
                status: rows[i].status
            });
        }
        log.audit("PO_MATCHES", "Found " + matches.length + " POs for otherrefnum=" + otherrefnum);
        return matches;
    }

    // ── Check if a bill already exists by reference_number (otherrefnum) ─
    function findExistingBill(referenceNumber) {
        var sql = "SELECT id, tranid FROM transaction WHERE type = 'VendBill' AND otherrefnum = ? ORDER BY id DESC";
        var resultSet = query.runSuiteQL({ query: sql, params: [String(referenceNumber)] });
        var rows = resultSet.asMappedResults();

        if (rows.length === 0) return null;

        return {
            id: parseInt(rows[0].id, 10),
            billNumber: rows[0].tranid,
            count: rows.length
        };
    }

    // ── Batch lookup: item internal IDs -> SKUs ─────────────────────────
    // One search for all transform line items, returns { internalId: sku }
    function lookupSkusByIds(itemIds) {
        if (itemIds.length === 0) return {};

        var idToSku = {};
        var filters = [["internalid", "anyof", itemIds]];
        var cols = [
            search.createColumn({ name: "internalid" }),
            search.createColumn({ name: "itemid" })
        ];

        var results = search.create({
            type: search.Type.ITEM,
            filters: filters,
            columns: cols
        }).run().getRange({ start: 0, end: 200 });

        for (var ri = 0; ri < results.length; ri++) {
            var iid = String(results[ri].getValue({ name: "internalid" }));
            var rawSku = String(results[ri].getValue({ name: "itemid" }) || "");
            // itemid can be "Parent : Child" for matrix items — take last part
            var parts = rawSku.split(" : ");
            var finalSku = parts[parts.length - 1].trim();
            idToSku[iid] = finalSku;
        }

        log.audit("SKU_LOOKUP", "Resolved " + results.length + " items from transform lines");
        return idToSku;
    }

    // ── Fix inventory detail after qty change on lot/serial items ──────
    // Keep the first assignment's lot number, update its qty, remove extras.
    // Old approach (clear all + add blank) failed because lot# is required.
    function fixInventoryDetail(billRecord, newQty) {
        try {
            var invDetail = billRecord.getCurrentSublistSubrecord({
                sublistId: "item",
                fieldId: "inventorydetail"
            });

            var assignCount = invDetail.getLineCount({ sublistId: "inventoryassignment" });
            if (assignCount === 0) return;

            // Remove extra assignments first (reverse, keep index 0)
            for (var ad = assignCount - 1; ad >= 1; ad--) {
                invDetail.removeLine({ sublistId: "inventoryassignment", line: ad });
            }

            // Update first assignment's quantity (preserves lot/serial number)
            invDetail.selectLine({ sublistId: "inventoryassignment", line: 0 });
            invDetail.setCurrentSublistValue({
                sublistId: "inventoryassignment",
                fieldId: "quantity",
                value: newQty
            });
            invDetail.commitLine({ sublistId: "inventoryassignment" });

        } catch (invErr) {
            // No inventory detail on this line — expected for non-lot items
        }
    }

    // ── Main POST handler ───────────────────────────────────────────────
    function post(payload) {
        try {
            log.audit("BILL_PAYLOAD", "po=" + payload.po_number + " ref=" + (payload.reference_number || "") + " action=" + (payload.action || "skip") + " items=" + (Array.isArray(payload.line_items) ? payload.line_items.length : 0));

            var action             = payload.action || "skip";
            var po_number          = payload.po_number;
            var invoice_number     = payload.invoice_number || "";
            var reference_number   = payload.reference_number || "";
            var invoice_date       = payload.invoice_date || "";
            var due_date           = payload.due_date || "";
            var memo               = payload.memo || "";
            var line_items         = payload.line_items;
            var po_type            = payload.po_type || "";
            var stocking_warehouse = payload.stocking_warehouse || "";

            if (!po_number) {
                return { success: false, error: "Missing po_number -- need it to find the source PO" };
            }

            var billRef = reference_number || invoice_number;

            // ── Step 1: Check for existing bill by reference_number ─────────
            var existingBill = null;
            if (billRef) {
                existingBill = findExistingBill(billRef);
            }

            if (existingBill && action === "skip") {
                log.audit("BILL_EXISTS_SKIP", "Bill " + existingBill.billNumber + " (ID " + existingBill.id + ") already exists for ref " + billRef + " -- skipping");
                return {
                    success: true,
                    action: "skipped",
                    bill: { internalId: existingBill.id, billNumber: existingBill.billNumber },
                    reference_number: billRef
                };
            }

            // ── Step 2: Find all matching POs (newest first) ────────────────
            var poMatches = findPurchaseOrders(String(po_number));
            if (poMatches.length === 0) {
                return { success: false, error: "PO not found for otherrefnum: " + po_number, po_number: po_number };
            }

            // ── Step 3: Transform — try each PO until one has billable lines ─
            var bill = null;
            var poInfo = null;
            var skippedPOs = [];

            for (var pi = 0; pi < poMatches.length; pi++) {
                var candidate = poMatches[pi];
                log.audit("TRYING_PO", candidate.poNumber + " (ID " + candidate.id + ") status=" + candidate.status);

                try {
                    var candidateRecord = record.transform({
                        fromType: record.Type.PURCHASE_ORDER,
                        fromId: candidate.id,
                        toType: record.Type.VENDOR_BILL,
                        isDynamic: true
                    });

                    var lineCount = candidateRecord.getLineCount({ sublistId: "item" });
                    log.audit("TRANSFORM_LINES", "PO " + candidate.id + " -> " + lineCount + " billable lines");

                    if (lineCount <= 0) {
                        skippedPOs.push({ id: candidate.id, poNumber: candidate.poNumber, reason: "0_billable_lines" });
                        continue;
                    }

                    bill = candidateRecord;
                    poInfo = candidate;
                    break;
                } catch (transformErr) {
                    log.error("TRANSFORM_ERR", "PO " + candidate.id + ": " + transformErr.message);
                    skippedPOs.push({ id: candidate.id, poNumber: candidate.poNumber, reason: transformErr.message });
                    continue;
                }
            }

            if (!bill || !poInfo) {
                return {
                    success: false,
                    error: "No billable PO found -- all " + poMatches.length + " POs fully billed or errored",
                    po_number: po_number,
                    tried: skippedPOs
                };
            }

            log.audit("PO_SELECTED", "PO " + poInfo.poNumber + " (ID " + poInfo.id + ") " + bill.getLineCount({ sublistId: "item" }) + " billable lines");

            if (existingBill) {
                log.audit("BILL_EXISTS_UPDATE", "Bill " + existingBill.billNumber + " already exists for ref " + billRef + " -- creating another (action=" + action + ")");
            }

            // ── Step 4: Set bill header fields AFTER transform ──────────────
            if (billRef) {
                bill.setValue({ fieldId: "tranid", value: String(billRef) });
                bill.setValue({ fieldId: "otherrefnum", value: String(billRef) });
            }

            if (invoice_date) {
                var billDate = new Date(invoice_date);
                if (!isNaN(billDate.getTime())) {
                    bill.setValue({ fieldId: "trandate", value: billDate });
                }
            }

            if (due_date) {
                var dueDateVal = new Date(due_date);
                if (!isNaN(dueDateVal.getTime())) {
                    bill.setValue({ fieldId: "duedate", value: dueDateVal });
                }
            }

            if (memo) {
                bill.setValue({ fieldId: "memo", value: memo });
            }

            // ── Step 5: Resolve location ────────────────────────────────────
            var locationId = resolveLocation(po_type, stocking_warehouse);
            log.audit("LOCATION", po_type + "/" + stocking_warehouse + " -> " + (locationId || "none"));

            // ── Step 6: Reconcile lines — update matching, remove rest ───────
            var origLineCount = bill.getLineCount({ sublistId: "item" });

            // 6a. Collect all item internal IDs from transform lines
            var transformItemIds = [];
            var transformLines = [];
            for (var tli = 0; tli < origLineCount; tli++) {
                var tItemId = String(bill.getSublistValue({ sublistId: "item", fieldId: "item", line: tli }));
                transformItemIds.push(tItemId);
                transformLines.push({
                    line: tli,
                    itemId: tItemId,
                    quantity: bill.getSublistValue({ sublistId: "item", fieldId: "quantity", line: tli }),
                    rate: bill.getSublistValue({ sublistId: "item", fieldId: "rate", line: tli })
                });
            }
            // 6b. Batch lookup: internal IDs -> SKUs (one search, not N)
            var idToSku = lookupSkusByIds(transformItemIds);

            // 6c. Build invoice SKU map from payload
            var invoiceSkuMap = {};  // sku -> { qty, rate }
            var invoiceSkuList = [];
            if (Array.isArray(line_items) && line_items.length > 0) {
                for (var si = 0; si < line_items.length; si++) {
                    var li = line_items[si];
                    if (!li.sku) continue;
                    var skuKey = String(li.sku).trim();
                    invoiceSkuMap[skuKey] = {
                        qty: parseInt(li.qty, 10) || 0,
                        rate: parseFloat(li.rate || li.price) || 0
                    };
                    invoiceSkuList.push(skuKey);
                }
            }
            // 6d. Walk transform lines: update if SKU matches invoice, else mark for removal
            var linesUpdated = 0;
            var linesToRemove = [];
            var matchedSkus = {};

            for (var ui = 0; ui < origLineCount; ui++) {
                var lineItemId = transformItemIds[ui];
                var lineSku = idToSku[lineItemId] || "";

                bill.selectLine({ sublistId: "item", line: ui });

                var invoiceMatch = invoiceSkuMap[lineSku];

                if (invoiceMatch) {
                    // SKU is in invoice — update qty and rate
                    bill.setCurrentSublistValue({
                        sublistId: "item", fieldId: "quantity",
                        value: invoiceMatch.qty, ignoreFieldChange: false
                    });
                    bill.setCurrentSublistValue({
                        sublistId: "item", fieldId: "rate",
                        value: invoiceMatch.rate, ignoreFieldChange: false
                    });

                    fixInventoryDetail(bill, invoiceMatch.qty);

                    if (locationId) {
                        try {
                            bill.setCurrentSublistValue({
                                sublistId: "item", fieldId: "location",
                                value: locationId, ignoreFieldChange: true
                            });
                        } catch (locErr) {
                            log.debug("LINE_LOCATION_ERR", "Line " + ui + ": " + locErr.message);
                        }
                    }

                    try {
                        bill.setCurrentSublistValue({
                            sublistId: "item", fieldId: "class",
                            value: "", ignoreFieldChange: true
                        });
                    } catch (classErr) {}

                    bill.commitLine({ sublistId: "item" });
                    matchedSkus[lineSku] = true;
                    linesUpdated++;

                } else {
                    // Not in invoice — mark for removal
                    linesToRemove.push(ui);
                    bill.commitLine({ sublistId: "item" });
                }
            }

            // 6e. Remove non-matching lines in reverse order
            var linesRemoved = 0;
            for (var ri = linesToRemove.length - 1; ri >= 0; ri--) {
                bill.removeLine({ sublistId: "item", line: linesToRemove[ri] });
                linesRemoved++;
            }
            // 6f. Log invoice SKUs that had no matching PO line (informational)
            var unmatchedSkus = [];
            for (var us = 0; us < invoiceSkuList.length; us++) {
                if (!matchedSkus[invoiceSkuList[us]]) {
                    unmatchedSkus.push(invoiceSkuList[us]);
                }
            }
            if (unmatchedSkus.length > 0) {
                log.audit("UNMATCHED_SKUS", "Invoice SKUs not on PO: " + unmatchedSkus.join(", "));
            }

            // ── Step 7: Clear header class ──────────────────────────────────
            try { bill.setValue({ fieldId: "class", value: "" }); } catch (e) {}

            // ── Step 8: Save ────────────────────────────────────────────────
            var finalLineCount = bill.getLineCount({ sublistId: "item" });

            log.audit("PRE_SAVE", "lines: " + linesUpdated + " kept, " + linesRemoved + " removed, " + finalLineCount + " final" + (unmatchedSkus.length > 0 ? " | unmatched: " + unmatchedSkus.join(", ") : ""));

            if (finalLineCount === 0) {
                return {
                    success: false,
                    error: "No matching lines — invoice SKUs [" + invoiceSkuList.join(", ") + "] not found on PO lines [" + JSON.stringify(Object.values(idToSku)) + "]",
                    po_number: po_number
                };
            }

            var billId = bill.save({ enableSourcing: false, ignoreMandatoryFields: true });
            log.audit("BILL_SAVED", "Bill ID " + billId + " from PO " + poInfo.poNumber + " (ref=" + billRef + ")");

            return {
                success: true,
                action: existingBill ? "created_additional" : "created",
                bill: { internalId: billId, referenceNumber: billRef },
                po: { internalId: poInfo.id, poNumber: poInfo.poNumber, status: poInfo.status },
                lines: {
                    fromTransform: origLineCount,
                    updated: linesUpdated,
                    removed: linesRemoved,
                    final: finalLineCount
                },
                unmatchedSkus: unmatchedSkus,
                locationId: locationId
            };

        } catch (e) {
            log.error("BILL_ERROR", JSON.stringify({ name: e.name, message: e.message, stack: e.stack }));
            return {
                success: false,
                error: e.message,
                po_number: payload ? payload.po_number : null
            };
        }
    }

    return { post: post };
});
