/**
 * NETSUITE RESTLET — Vendor Bill Sync
 *
 * Creates Vendor Bills from existing Purchase Orders via record.transform.
 * The bill is DIRECTLY LINKED to the PO (createdfrom field).
 *
 * HOW TO DEPLOY IN NETSUITE:
 * 1. Go to: Customization → Scripting → Scripts → New
 * 2. Script Type: RESTlet
 * 3. Name: EBP Vendor Bill Sync
 * 4. Script ID: customscript_ebp_bill_sync
 * 5. Upload this file
 * 6. Set POST Function to: post
 * 7. Save → Deploy
 * 8. Deployment ID: customdeploy_ebp_bill_sync
 * 9. Status: Released
 *
 * PAYLOAD EXPECTED:
 * {
 *   action:       "create" | "skip",
 *   po_number:    "10001",           ← PO otherrefnum to find the source PO
 *   invoice_number: "INV-001",       ← vendor invoice # → bill's tranid/otherrefnum
 *   invoice_date:   "2026-03-15",    ← optional bill date (defaults to today)
 *   memo:           "...",           ← optional memo
 *   line_items:     [                ← optional: override qty/rate per line
 *     { sku: "29S0100", qty: 2, rate: 68.81 }
 *   ]
 * }
 */

/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(["N/record", "N/search", "N/log"], function (record, search, log) {

    // ── Find ALL POs by otherrefnum (newest first) ─────────────────────────
    function findPurchaseOrders(otherrefnum) {
        var idCol = search.createColumn({ name: "internalid", sort: search.Sort.DESC });
        var tranCol = search.createColumn({ name: "tranid" });
        var statusCol = search.createColumn({ name: "status" });

        var results = search.create({
            type: search.Type.PURCHASE_ORDER,
            filters: [
                ["otherrefnum", "is", otherrefnum],
                "AND",
                ["mainline", "is", "T"]
            ],
            columns: [idCol, tranCol, statusCol]
        }).run().getRange({ start: 0, end: 10 });

        if (results.length === 0) return [];

        var matches = [];
        for (var mi = 0; mi < results.length; mi++) {
            matches.push({
                id: parseInt(results[mi].getValue(idCol), 10),
                poNumber: results[mi].getValue(tranCol),
                status: results[mi].getText(statusCol) || results[mi].getValue(statusCol)
            });
        }
        log.debug("PO_MATCHES", "Found " + matches.length + " POs for otherrefnum=" + otherrefnum + ": " + JSON.stringify(matches));
        return matches;
    }

    // ── Check if a bill already exists for this PO ───────────────────────────
    function findExistingBill(poId) {
        var idCol = search.createColumn({ name: "internalid", sort: search.Sort.DESC });
        var tranCol = search.createColumn({ name: "tranid" });

        var results = search.create({
            type: search.Type.VENDOR_BILL,
            filters: [
                ["createdfrom", "anyof", [poId]],
                "AND",
                ["mainline", "is", "T"]
            ],
            columns: [idCol, tranCol]
        }).run().getRange({ start: 0, end: 5 });

        if (results.length === 0) return null;

        return {
            id: parseInt(results[0].getValue(idCol), 10),
            billNumber: results[0].getValue(tranCol),
            count: results.length
        };
    }

    // ── Main POST handler ───────────────────────────────────────────────────
    function post(payload) {
        try {
            log.debug("BILL_PAYLOAD", JSON.stringify(payload));

            var action         = payload.action || "create";
            var po_number      = payload.po_number;
            var invoice_number = payload.invoice_number || "";
            var invoice_date   = payload.invoice_date;
            var memo           = payload.memo || "";
            var line_items     = payload.line_items;

            if (!po_number) {
                return { success: false, error: "Missing po_number — need it to find the source PO" };
            }

            // ── Step 1: Find all matching POs (newest first) ─────────────────
            var poMatches = findPurchaseOrders(String(po_number));
            if (poMatches.length === 0) {
                return {
                    success: false,
                    error: "PO not found for otherrefnum: " + po_number,
                    po_number: po_number
                };
            }

            // ── Step 2: Loop through POs — try each until one has billable lines ─
            var bill = null;
            var poInfo = null;
            var existingBill = null;
            var skippedPOs = [];

            for (var pi = 0; pi < poMatches.length; pi++) {
                var candidate = poMatches[pi];
                log.debug("TRYING_PO", "Trying PO " + candidate.poNumber + " (ID " + candidate.id + "), status: " + candidate.status);

                // Check if bill already exists for this PO
                var candidateBill = findExistingBill(candidate.id);
                if (candidateBill && action === "skip") {
                    log.debug("BILL_EXISTS_SKIP", "Bill " + candidateBill.billNumber + " already exists for PO " + candidate.id + " — trying next");
                    skippedPOs.push({ id: candidate.id, poNumber: candidate.poNumber, reason: "already_billed" });
                    continue;
                }

                // Try the transform
                try {
                    var candidateRecord = record.transform({
                        fromType: record.Type.PURCHASE_ORDER,
                        fromId: candidate.id,
                        toType: record.Type.VENDOR_BILL,
                        isDynamic: true
                    });

                    var lineCount = candidateRecord.getLineCount({ sublistId: "item" });
                    log.debug("TRANSFORM_LINES_COUNT", "PO " + candidate.id + " → " + lineCount + " billable lines");

                    if (lineCount <= 0) {
                        log.debug("PO_FULLY_BILLED", "PO " + candidate.id + " has 0 billable lines — trying next");
                        skippedPOs.push({ id: candidate.id, poNumber: candidate.poNumber, reason: "0_billable_lines" });
                        continue;
                    }

                    // Found a good PO with billable lines
                    bill = candidateRecord;
                    poInfo = candidate;
                    existingBill = candidateBill;
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
                    error: "No billable PO found — all " + poMatches.length + " POs are already fully billed",
                    po_number: po_number,
                    tried: skippedPOs
                };
            }

            log.debug("PO_SELECTED", "Using PO " + poInfo.poNumber + " (ID " + poInfo.id + ") — " + bill.getLineCount({ sublistId: "item" }) + " billable lines");

            if (existingBill) {
                log.audit("BILL_EXISTS_WARN", "Bill " + existingBill.billNumber + " already exists for PO " + poInfo.id + " — creating another (action=" + action + ")");
            }

            // ── Step 4: Set bill header fields ───────────────────────────────
            // Invoice number → otherrefnum (so we can search by it later)
            if (invoice_number) {
                bill.setValue({ fieldId: "tranid", value: String(invoice_number) });
                bill.setValue({ fieldId: "otherrefnum", value: String(invoice_number) });
            }

            // Bill date
            if (invoice_date) {
                bill.setValue({ fieldId: "trandate", value: new Date(invoice_date) });
            }

            // Memo
            if (memo) {
                bill.setValue({ fieldId: "memo", value: memo });
            }

            // ── Step 5: Optionally update line items ─────────────────────────
            // By default, the transform copies PO lines as-is. If line_items
            // are provided, match by SKU and update qty/rate (partial billing).
            var linesUpdated = 0;
            var lineCount = bill.getLineCount({ sublistId: "item" });

            // Log what the transform gave us
            var transformLines = [];
            for (var tli = 0; tli < lineCount; tli++) {
                transformLines.push({
                    line: tli,
                    item: bill.getSublistText({ sublistId: "item", fieldId: "item", line: tli }),
                    itemId: bill.getSublistValue({ sublistId: "item", fieldId: "item", line: tli }),
                    quantity: bill.getSublistValue({ sublistId: "item", fieldId: "quantity", line: tli }),
                    rate: bill.getSublistValue({ sublistId: "item", fieldId: "rate", line: tli }),
                    amount: bill.getSublistValue({ sublistId: "item", fieldId: "amount", line: tli })
                });
            }
            log.debug("TRANSFORM_LINES", JSON.stringify(transformLines));

            if (Array.isArray(line_items) && line_items.length > 0) {
                // Build SKU → item ID map for matching
                var skuMap = {};  // sku → { qty, rate }
                for (var si = 0; si < line_items.length; si++) {
                    var li = line_items[si];
                    if (!li.sku) continue;

                    // Look up item ID by SKU
                    var itemResults = search.create({
                        type: search.Type.ITEM,
                        filters: [["itemid", "is", li.sku]],
                        columns: [search.createColumn({ name: "internalid" })]
                    }).run().getRange({ start: 0, end: 1 });

                    if (itemResults.length > 0) {
                        var itemId = String(itemResults[0].getValue({ name: "internalid" }));
                        skuMap[itemId] = { qty: li.qty, rate: li.rate, sku: li.sku };
                    }
                }

                // Match and update transform lines
                for (var ui = 0; ui < lineCount; ui++) {
                    var billItemId = String(bill.getSublistValue({ sublistId: "item", fieldId: "item", line: ui }));
                    var match = skuMap[billItemId];

                    if (match) {
                        bill.selectLine({ sublistId: "item", line: ui });
                        if (match.qty !== undefined) {
                            bill.setCurrentSublistValue({
                                sublistId: "item", fieldId: "quantity",
                                value: parseInt(match.qty, 10), ignoreFieldChange: false
                            });
                        }
                        if (match.rate !== undefined) {
                            bill.setCurrentSublistValue({
                                sublistId: "item", fieldId: "rate",
                                value: parseFloat(match.rate), ignoreFieldChange: false
                            });
                        }
                        bill.commitLine({ sublistId: "item" });
                        linesUpdated++;
                        log.debug("LINE_UPDATED", "Line " + ui + " SKU " + match.sku + " → qty=" + match.qty + ", rate=" + match.rate);
                    }
                }
            }

            // ── Step 6: Save ─────────────────────────────────────────────────
            var billId = bill.save({ enableSourcing: true, ignoreMandatoryFields: true });
            log.debug("BILL_SAVED", "Vendor Bill ID " + billId + " created from PO " + poInfo.id);

            return {
                success: true,
                action: existingBill ? "created_additional" : "created",
                bill: {
                    internalId: billId,
                    invoiceNumber: invoice_number
                },
                po: {
                    internalId: poInfo.id,
                    poNumber: poInfo.poNumber,
                    status: poInfo.status
                },
                linesFromTransform: lineCount,
                linesUpdated: linesUpdated
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
