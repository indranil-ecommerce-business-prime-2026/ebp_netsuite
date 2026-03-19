/**
 * NETSUITE RESTLET — Purchase Order Sync
 *
 * HOW TO DEPLOY IN NETSUITE:
 * 1. Go to: Customization → Scripting → Scripts → New
 * 2. Script Type: RESTlet
 * 3. Name: EBP Purchase Order Sync
 * 4. Script ID: customscript_ebp_po_sync
 * 5. Upload this file
 * 6. Set POST Function to: post
 * 7. Save → Deploy
 * 8. Deployment ID: customdeploy_ebp_po_sync
 * 9. Status: Released
 *
 * PAYLOAD EXPECTED:
 * {
 *   action:                   "skip" | "update",
 *   po_number:                10001,
 *   otherrefnum:              "10001",                  ← unique key
 *   vendor_id:                117,                      ← NetSuite vendor internalId
 *   distributor:              "D&H" | "Synnex" | ...,
 *   distributor_order_number: "DNH-98765",
 *   status:                   "shipped",
 *   invoice:                  ["INV-001", ...] | [],    ← array from po_management
 *   tracking:                 "1Z999AA10123456784" | null,
 *   website_order_number:     "113-1234567-1234567",
 *   po_type:                  "Dropship" | "Stocking",
 *   stocking_warehouse:       "MW" | "W2G-PA" | "W2G-IL" | "W2G-KY" | "W2G-TX" | "",
 *   order_items:              [{ sku: "SKU001", qty: 2, cost: 25.00 }]
 * }
 */

/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(["N/record", "N/search", "N/log"], function (record, search, log) {

    // ── Caches ─────────────────────────────────────────────────────────────
    var _formCache = {};
    var _locationCache = {};

    // ── Warehouse map: stocking_warehouse code → NetSuite location name ──
    var WAREHOUSE_MAP = {
        "MW":     "California - Chatsworth",
        "W2G-PA": "Ware2Go - PA (Fairless Hills)",
        "W2G-IL": "Ware2Go - IL (Aurora)",
        "W2G-KY": "Ware2Go - KY (Hebron)",
        "W2G-TX": "Ware2Go - TX (Dallas)"
    };

    // ── Snapshot helpers (mirror SO RESTlet pattern) ─────────────────────
    function snapshotPO(poRecord) {
        var snap = { header: {}, lines: [] };
        var headerFields = [
            "customform", "entity", "subsidiary", "otherrefnum",
            "trandate", "memo", "currency", "custbody1", "custbody2",
            "custbody_otherrefnumber_custom"
        ];
        for (var hi = 0; hi < headerFields.length; hi++) {
            try {
                snap.header[headerFields[hi]] = poRecord.getValue({ fieldId: headerFields[hi] });
            } catch (e) {}
        }
        var lineCount = poRecord.getLineCount({ sublistId: "item" });
        snap.header.lineCount = lineCount;

        var lineFields = ["item", "quantity", "rate", "amount", "location", "description"];
        for (var li = 0; li < lineCount; li++) {
            var line = { line: li };
            for (var lf = 0; lf < lineFields.length; lf++) {
                try {
                    line[lineFields[lf]] = poRecord.getSublistValue({
                        sublistId: "item", fieldId: lineFields[lf], line: li
                    });
                } catch (e) {}
            }
            snap.lines.push(line);
        }
        return snap;
    }

    function diffSnapshots(before, after) {
        var changes = { header: {}, lines: {} };
        for (var key in after.header) {
            if (String(before.header[key]) !== String(after.header[key])) {
                changes.header[key] = { from: before.header[key], to: after.header[key] };
            }
        }
        if (before.header.lineCount !== after.header.lineCount) {
            changes.lines.countChange = {
                from: before.header.lineCount,
                to: after.header.lineCount
            };
        }
        return changes;
    }

    // ── Dynamic form lookup — find "Ecomm BP - Purchase Order" form ID ──
    function findFormId(formName) {
        if (_formCache[formName]) return _formCache[formName];

        // Method 1: getSelectOptions — lists ALL available PO forms (works even if no POs use it yet)
        try {
            var tempPo = record.create({ type: record.Type.PURCHASE_ORDER, isDynamic: true });
            var formField = tempPo.getField({ fieldId: "customform" });
            if (formField) {
                var options = formField.getSelectOptions();
                for (var oi = 0; oi < options.length; oi++) {
                    if (options[oi].text && options[oi].text.indexOf(formName) >= 0) {
                        _formCache[formName] = options[oi].value;
                        log.debug("FORM_FOUND", formName + " → ID " + options[oi].value + " (from getSelectOptions)");
                        return options[oi].value;
                    }
                }
            }
        } catch (e) {
            log.debug("FORM_OPTIONS_ERROR", e.message);
        }

        // Method 2: fallback — search existing POs that already use the form
        var formCol = search.createColumn({ name: "customform" });
        var results = search.create({
            type: search.Type.PURCHASE_ORDER,
            filters: [["mainline", "is", "T"]],
            columns: [formCol]
        }).run().getRange({ start: 0, end: 200 });

        for (var i = 0; i < results.length; i++) {
            var text = results[i].getText(formCol);
            if (text && text.indexOf(formName) >= 0) {
                var id = results[i].getValue(formCol);
                _formCache[formName] = id;
                log.debug("FORM_FOUND", formName + " → ID " + id + " (from search)");
                return id;
            }
        }

        log.debug("FORM_NOT_FOUND", "Could not find form: " + formName);
        return null;
    }

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
        log.debug("LOCATION_FOUND", locationName + " → ID " + locId);
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

    // ── Update linked SO line item locations for Dropship POs ───────────
    function updateSOLocationForDropship(websiteOrderNumber, dropshipLocationId) {
        if (!websiteOrderNumber) return { found: false, reason: "no website_order_number" };

        var soIdCol = search.createColumn({ name: "internalid" });
        var soTranCol = search.createColumn({ name: "tranid" });
        var soResults = search.create({
            type: search.Type.SALES_ORDER,
            filters: [
                ["poastext", "is", websiteOrderNumber],
                "AND",
                ["mainline", "is", "T"]
            ],
            columns: [soIdCol, soTranCol]
        }).run().getRange({ start: 0, end: 1 });

        if (soResults.length === 0) {
            log.debug("SO_NOT_FOUND", "No SO with poastext: " + websiteOrderNumber);
            return { found: false, reason: "SO not found for poastext: " + websiteOrderNumber };
        }

        var soId = parseInt(soResults[0].getValue(soIdCol), 10);
        var soTranId = soResults[0].getValue(soTranCol);
        log.debug("SO_FOUND", "Loading SO ID " + soId + " (" + soTranId + ") to update line locations");

        var so = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: true });
        var lineCount = so.getLineCount({ sublistId: "item" });

        for (var i = 0; i < lineCount; i++) {
            so.selectLine({ sublistId: "item", line: i });
            so.setCurrentSublistValue({
                sublistId: "item", fieldId: "location",
                value: dropshipLocationId, ignoreFieldChange: false
            });
            so.commitLine({ sublistId: "item" });
        }

        var savedSoId = so.save({ enableSourcing: true, ignoreMandatoryFields: true });
        log.debug("SO_UPDATED", "SO ID " + savedSoId + " — " + lineCount + " lines updated to Dropship location");

        return { found: true, soId: savedSoId, soNumber: soTranId, linesUpdated: lineCount };
    }

    // ── Main POST handler ───────────────────────────────────────────────
    function post(payload) {
        var before = null;
        var after = null;
        var diff = null;

        try {
            log.debug("PAYLOAD", JSON.stringify(payload));

            var action                   = payload.action || "skip";
            var po_number                = payload.po_number;
            var otherrefnum              = payload.otherrefnum;
            var vendor_id                = payload.vendor_id;
            var distributor              = payload.distributor || "";
            var distributor_order_number = payload.distributor_order_number || "";
            var status                   = payload.status || "";
            var invoice                  = payload.invoice;
            var tracking                 = payload.tracking;
            var website_order_number     = payload.website_order_number || "";
            var order_items              = payload.order_items;
            var po_type                  = payload.po_type || "";
            var stocking_warehouse       = payload.stocking_warehouse || "";

            if (!po_number) {
                return { success: false, error: "Missing po_number" };
            }

            // ── Check if PO already exists in NetSuite ───────────────────────
            var existing = findPurchaseOrder(String(otherrefnum || po_number));

            if (existing && action === "skip") {
                log.debug("SKIP", "PO " + po_number + " already exists (ID " + existing.id + "). Skipping.");
                return { success: true, action: "skipped", po_number: po_number, internalId: existing.id, poNumber: existing.poNumber };
            }

            // ── For Dropship: find linked SO before creating PO ───────────────
            var linkedSoId = null;
            var linkedSoNumber = null;
            if (po_type === "Dropship" && website_order_number) {
                var soIdCol = search.createColumn({ name: "internalid" });
                var soTranCol = search.createColumn({ name: "tranid" });
                var soLookup = search.create({
                    type: search.Type.SALES_ORDER,
                    filters: [
                        ["poastext", "is", website_order_number],
                        "AND",
                        ["mainline", "is", "T"]
                    ],
                    columns: [soIdCol, soTranCol]
                }).run().getRange({ start: 0, end: 1 });

                if (soLookup.length > 0) {
                    linkedSoId = parseInt(soLookup[0].getValue(soIdCol), 10);
                    linkedSoNumber = soLookup[0].getValue(soTranCol);
                    log.debug("LINKED_SO", "Found SO " + linkedSoNumber + " (ID " + linkedSoId + ") for website_order_number: " + website_order_number);
                } else {
                    log.debug("LINKED_SO", "No SO found for website_order_number: " + website_order_number);
                }
            }

            // ── Build record ─────────────────────────────────────────────────
            var po;
            var isUpdate = false;
            var transformedFromSO = false;

            if (existing && action === "update") {
                po = record.load({ type: record.Type.PURCHASE_ORDER, id: existing.id, isDynamic: true });
                isUpdate = true;
            } else if (linkedSoId) {
                // Dropship: transform SO → PO (creates native createdfrom link)
                po = record.transform({
                    fromType: record.Type.SALES_ORDER,
                    fromId: linkedSoId,
                    toType: record.Type.PURCHASE_ORDER,
                    isDynamic: true
                });
                transformedFromSO = true;
                log.debug("TRANSFORM", "Created PO from SO " + linkedSoNumber + " (ID " + linkedSoId + ")");
            } else {
                po = record.create({ type: record.Type.PURCHASE_ORDER, isDynamic: true });
            }

            // ── Form — set FIRST before anything else ────────────────────────
            var formId = findFormId("Ecomm BP - Purchase Order");
            if (formId) {
                po.setValue({ fieldId: "customform", value: parseInt(formId, 10) });
                log.debug("FORM_SET", "customform → " + formId);
            }

            // ── Vendor (required for Purchase Order) — set after form ────────
            if (vendor_id) {
                po.setValue({ fieldId: "entity", value: parseInt(vendor_id, 10) });
            }

            var poSubsidiary = "";
            try { poSubsidiary = po.getValue({ fieldId: "subsidiary" }); } catch (e) {}
            log.debug("ENTITY_SET", JSON.stringify({
                vendor: vendor_id,
                subsidiary: poSubsidiary,
                form: po.getValue({ fieldId: "customform" })
            }));

            // ── Standard fields ──────────────────────────────────────────────
            po.setValue({ fieldId: "otherrefnum", value: String(po_number) });
            po.setValue({ fieldId: "trandate",    value: new Date() });
            po.setValue({ fieldId: "memo",        value: website_order_number });

            // ── Custom fields — wrapped in try/catch ─────────────────────────
            try { po.setValue({ fieldId: "custbody2", value: String(distributor_order_number || po_number) }); } catch (e) {
                log.debug("FIELD_SKIP", "custbody2: " + e.message);
            }
            try { po.setValue({ fieldId: "custbody1", value: status }); } catch (e) {
                log.debug("FIELD_SKIP", "custbody1: " + e.message);
            }

            // custbody_otherrefnumber_custom — only set if it exists on PO form
            if (distributor) {
                try { po.setValue({ fieldId: "custbody_otherrefnumber_custom", value: String(distributor) }); } catch (e) {
                    log.debug("FIELD_SKIP", "custbody_otherrefnumber_custom: " + e.message);
                }
            }

            // ── Invoice reference ────────────────────────────────────────────
            if (Array.isArray(invoice) && invoice.length > 0) {
                po.setValue({ fieldId: "memo", value: website_order_number + " | INV: " + invoice[0] });
            }

            // ── Resolve location for line items ──────────────────────────────
            var locationId = resolveLocation(po_type, stocking_warehouse);
            log.debug("LOCATION_RESOLVED", JSON.stringify({
                po_type: po_type,
                stocking_warehouse: stocking_warehouse,
                locationId: locationId
            }));

            // ── SNAPSHOT: BEFORE (after header set, before line changes) ────
            before = snapshotPO(po);

            // ── Resolve all PO item SKUs → internal IDs upfront ──────────────
            var skippedSkus = [];
            var resolvedItems = [];   // { sku, itemId, qty, cost }

            if (Array.isArray(order_items) && order_items.length > 0) {
                for (var ri = 0; ri < order_items.length; ri++) {
                    var rawItem = order_items[ri];
                    var rawSku = rawItem.sku;
                    if (!rawSku) continue;

                    try {
                        var riCol = search.createColumn({ name: "internalid" });
                        var rtCol = search.createColumn({ name: "type" });
                        var riResults = search.create({
                            type: search.Type.ITEM,
                            filters: [["itemid", "is", rawSku]],
                            columns: [riCol, rtCol]
                        }).run().getRange({ start: 0, end: 1 });

                        if (!riResults || riResults.length === 0) {
                            log.debug("ITEM_NOT_FOUND", "SKU \"" + rawSku + "\" not in NetSuite");
                            skippedSkus.push(rawSku);
                            continue;
                        }

                        var riId = parseInt(riResults[0].getValue(riCol), 10);
                        var riType = riResults[0].getText(rtCol) || riResults[0].getValue(rtCol);

                        if (riType === "Group" || riType === "Kit" || riType === "Kit/Package") {
                            log.debug("ITEM_SKIP_TYPE", "SKU \"" + rawSku + "\" is " + riType + " — skipping");
                            skippedSkus.push(rawSku + " (type:" + riType + ")");
                            continue;
                        }

                        log.debug("ITEM_FOUND", "SKU \"" + rawSku + "\" → ID " + riId + ", type: " + riType);
                        resolvedItems.push({
                            sku: rawSku,
                            itemId: riId,
                            qty: parseInt(rawItem.qty, 10) || 1,
                            cost: parseFloat(rawItem.cost) || 0
                        });
                    } catch (lookErr) {
                        log.error("ITEM_LOOKUP_ERR", "SKU \"" + rawSku + "\" — " + lookErr.message);
                        skippedSkus.push(rawSku);
                    }
                }
            }

            // ── Line items ─────────────────────────────────────────────────────
            var oldLineCount = po.getLineCount({ sublistId: "item" });
            var linesAdded = 0;
            var linesUpdated = 0;

            if (transformedFromSO && resolvedItems.length > 0) {
                // ── DROPSHIP TRANSFORM MODE ────────────────────────────────────
                // Transform copied SO lines → try to match by item ID and update
                // in place to preserve the native SO↔PO line-level link.

                // Build map of existing lines: itemId → line index
                var existingLineMap = {};   // itemId → [line indices]
                for (var eli = 0; eli < oldLineCount; eli++) {
                    var existItemId = po.getSublistValue({ sublistId: "item", fieldId: "item", line: eli });
                    var key = String(existItemId);
                    if (!existingLineMap[key]) existingLineMap[key] = [];
                    existingLineMap[key].push(eli);
                }
                log.debug("TRANSFORM_LINES", "Old lines: " + oldLineCount + ", map: " + JSON.stringify(existingLineMap));

                var matchedLineIndices = {};  // tracks which old lines were matched
                var unmatchedItems = [];      // PO items that didn't match any transform line

                // Step 1: Match and update existing lines in place
                for (var mi = 0; mi < resolvedItems.length; mi++) {
                    var poItem = resolvedItems[mi];
                    var matchKey = String(poItem.itemId);
                    var matchedLine = -1;

                    // Find an unmatched existing line with the same item ID
                    if (existingLineMap[matchKey]) {
                        for (var mli = 0; mli < existingLineMap[matchKey].length; mli++) {
                            var candidateLine = existingLineMap[matchKey][mli];
                            if (!matchedLineIndices[candidateLine]) {
                                matchedLine = candidateLine;
                                matchedLineIndices[candidateLine] = true;
                                break;
                            }
                        }
                    }

                    if (matchedLine >= 0) {
                        // UPDATE in place — preserves SO↔PO line link
                        try {
                            po.selectLine({ sublistId: "item", line: matchedLine });
                            po.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: poItem.qty, ignoreFieldChange: false });
                            po.setCurrentSublistValue({ sublistId: "item", fieldId: "rate", value: poItem.cost, ignoreFieldChange: false });
                            if (locationId) {
                                po.setCurrentSublistValue({ sublistId: "item", fieldId: "location", value: locationId, ignoreFieldChange: false });
                            }
                            po.commitLine({ sublistId: "item" });
                            linesUpdated++;
                            log.debug("LINE_UPDATED", "Line " + matchedLine + " — SKU \"" + poItem.sku + "\" qty=" + poItem.qty + " rate=" + poItem.cost);
                        } catch (updErr) {
                            log.error("LINE_UPDATE_ERR", "Line " + matchedLine + " SKU \"" + poItem.sku + "\" — " + updErr.message);
                            unmatchedItems.push(poItem);
                        }
                    } else {
                        // No matching transform line — add as new
                        unmatchedItems.push(poItem);
                    }
                }

                // Step 2: Add unmatched items as new lines
                for (var ui = 0; ui < unmatchedItems.length; ui++) {
                    var newItem = unmatchedItems[ui];
                    try {
                        po.selectNewLine({ sublistId: "item" });
                        po.setCurrentSublistValue({ sublistId: "item", fieldId: "item", value: newItem.itemId, ignoreFieldChange: false });
                        if (locationId) {
                            po.setCurrentSublistValue({ sublistId: "item", fieldId: "location", value: locationId, ignoreFieldChange: false });
                        }
                        po.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: newItem.qty, ignoreFieldChange: false });
                        po.setCurrentSublistValue({ sublistId: "item", fieldId: "rate", value: newItem.cost, ignoreFieldChange: false });
                        po.commitLine({ sublistId: "item" });
                        linesAdded++;
                        log.debug("LINE_ADDED_NEW", "SKU \"" + newItem.sku + "\" (no transform match) → lines now: " + po.getLineCount({ sublistId: "item" }));
                    } catch (addErr) {
                        log.error("LINE_ADD_ERR", "SKU \"" + newItem.sku + "\" — " + addErr.message);
                        skippedSkus.push(newItem.sku);
                    }
                }

                // Step 3: Remove unmatched OLD lines (transform lines that have no PO item)
                // Collect indices in reverse order to avoid index shift
                var linesToRemove = [];
                for (var rli = 0; rli < oldLineCount; rli++) {
                    if (!matchedLineIndices[rli]) {
                        linesToRemove.push(rli);
                    }
                }
                if (linesToRemove.length > 0) {
                    log.debug("REMOVE_UNMATCHED", "Removing " + linesToRemove.length + " unmatched transform lines: " + JSON.stringify(linesToRemove));
                    for (var rmi = linesToRemove.length - 1; rmi >= 0; rmi--) {
                        po.removeLine({ sublistId: "item", line: linesToRemove[rmi] });
                    }
                }

                log.debug("TRANSFORM_RESULT", "Updated: " + linesUpdated + ", Added: " + linesAdded + ", Removed: " + linesToRemove.length);

            } else {
                // ── STANDARD MODE (Stocking / create / update) ─────────────────
                // Add-first, remove-old strategy (no SO link to preserve)

                for (var i = 0; i < resolvedItems.length; i++) {
                    var stdItem = resolvedItems[i];
                    try {
                        po.selectNewLine({ sublistId: "item" });
                        po.setCurrentSublistValue({ sublistId: "item", fieldId: "item", value: stdItem.itemId, ignoreFieldChange: false });
                        if (locationId) {
                            po.setCurrentSublistValue({ sublistId: "item", fieldId: "location", value: locationId, ignoreFieldChange: false });
                        }
                        po.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: stdItem.qty, ignoreFieldChange: false });
                        po.setCurrentSublistValue({ sublistId: "item", fieldId: "rate", value: stdItem.cost, ignoreFieldChange: false });
                        po.commitLine({ sublistId: "item" });
                        linesAdded++;
                        log.debug("ITEM_ADDED", "SKU \"" + stdItem.sku + "\" → lines now: " + po.getLineCount({ sublistId: "item" }));
                    } catch (lineErr) {
                        log.error("ITEM_SKIP", "SKU \"" + stdItem.sku + "\" — " + lineErr.message);
                        skippedSkus.push(stdItem.sku);
                    }
                }

                // Remove old lines in reverse order
                if (oldLineCount > 0 && linesAdded > 0) {
                    log.debug("REMOVE_OLD", "Removing " + oldLineCount + " old lines (new added: " + linesAdded + ")");
                    for (var r = oldLineCount - 1; r >= 0; r--) {
                        po.removeLine({ sublistId: "item", line: r });
                    }
                } else if (oldLineCount > 0 && linesAdded === 0) {
                    for (var r2 = oldLineCount - 1; r2 >= 0; r2--) {
                        po.removeLine({ sublistId: "item", line: r2 });
                    }
                }
            }

            // ── No items to sync? ─────────────────────────────────────────────
            if (linesAdded === 0 && linesUpdated === 0) {
                after = snapshotPO(po);
                diff = diffSnapshots(before, after);
                var skuList = Array.isArray(order_items) ? order_items.map(function (x) { return x.sku; }).join(", ") : "none";
                return {
                    success: true,
                    action: "no_items",
                    po_number: po_number,
                    skus: skuList,
                    skipped: skippedSkus,
                    before: before, after: after, diff: diff
                };
            }

            // ── SNAPSHOT: AFTER (before save) ────────────────────────────────
            after = snapshotPO(po);
            diff = diffSnapshots(before, after);

            var savedId = po.save({ enableSourcing: true, ignoreMandatoryFields: true });
            log.debug("SUCCESS", "PO " + po_number + " saved → ID: " + savedId);

            // ── Dropship: update linked SO line item locations ───────────────
            var soUpdate = null;
            if (po_type === "Dropship" && website_order_number && locationId) {
                try {
                    soUpdate = updateSOLocationForDropship(website_order_number, locationId);
                    log.debug("SO_UPDATE_RESULT", JSON.stringify(soUpdate));
                } catch (soErr) {
                    log.error("SO_UPDATE_ERROR", soErr.message);
                    soUpdate = { error: soErr.message };
                }
            }

            return {
                success: true,
                action: isUpdate ? "updated" : "created",
                po_number: po_number,
                internalId: savedId,
                linesAdded: linesAdded,
                linesUpdated: linesUpdated,
                locationId: locationId,
                po_type: po_type,
                skippedSkus: skippedSkus.length > 0 ? skippedSkus : undefined,
                soUpdate: soUpdate,
                linkedSo: linkedSoId ? { id: linkedSoId, soNumber: linkedSoNumber, transformedFromSO: transformedFromSO } : null,
                before: before, after: after, diff: diff
            };

        } catch (e) {
            log.error("ERROR", JSON.stringify({ name: e.name, message: e.message, stack: e.stack }));
            return {
                success: false,
                error: e.message,
                po_number: payload ? payload.po_number : null,
                before: before, after: after, diff: diff
            };
        }
    }

    // ── Helper: find existing PO by otherrefnum ──────────────────────────────
    // Sorts by internalid DESC → picks newest if duplicates exist
    function findPurchaseOrder(otherrefnum) {
        var idCol = search.createColumn({ name: "internalid", sort: search.Sort.DESC });
        var tranCol = search.createColumn({ name: "tranid" });

        var results = search.create({
            type: search.Type.PURCHASE_ORDER,
            filters: [
                ["otherrefnum", "is", otherrefnum],
                "AND",
                ["mainline", "is", "T"]
            ],
            columns: [idCol, tranCol]
        }).run().getRange({ start: 0, end: 10 });

        if (results.length === 0) return null;

        if (results.length > 1) {
            log.audit("PO_DUPLICATES", "Found " + results.length +
                " POs for otherrefnum " + otherrefnum + " -- using newest (highest ID)");
        }

        return {
            id: parseInt(results[0].getValue(idCol), 10),
            poNumber: results[0].getValue(tranCol)
        };
    }

    return { post: post };
});
