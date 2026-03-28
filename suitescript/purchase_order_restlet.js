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
define(["N/record", "N/search", "N/query", "N/log"], function (record, search, query, log) {

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
            "trandate", "currency", "custbody1", "custbody2",
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

    // ── Copy SO shipping address → PO (Dropship: ship to customer) ─────
    function copySOShippingToPO(soId, po) {
        try {
            var so = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: false });
            var soShip = so.getSubrecord({ fieldId: "shippingaddress" });

            var addrFields = {
                country:   soShip.getValue({ fieldId: "country" }) || "US",
                addressee: soShip.getValue({ fieldId: "addressee" }) || "",
                attention: soShip.getValue({ fieldId: "attention" }) || "",
                addr1:     soShip.getValue({ fieldId: "addr1" }) || "",
                addr2:     soShip.getValue({ fieldId: "addr2" }) || "",
                city:      soShip.getValue({ fieldId: "city" }) || "",
                state:     soShip.getValue({ fieldId: "state" }) || "",
                zip:       soShip.getValue({ fieldId: "zip" }) || "",
                addrphone: soShip.getValue({ fieldId: "addrphone" }) || ""
            };

            log.debug("SO_SHIP_ADDR", JSON.stringify(addrFields));

            // Clear predefined list → enables custom address entry
            po.setValue({ fieldId: "shipaddresslist", value: "" });

            var poShip = po.getSubrecord({ fieldId: "shippingaddress" });
            poShip.setValue({ fieldId: "country",   value: addrFields.country });
            poShip.setValue({ fieldId: "addressee", value: addrFields.addressee });
            if (addrFields.attention) poShip.setValue({ fieldId: "attention", value: addrFields.attention });
            poShip.setValue({ fieldId: "addr1", value: addrFields.addr1 });
            if (addrFields.addr2) poShip.setValue({ fieldId: "addr2", value: addrFields.addr2 });
            poShip.setValue({ fieldId: "city",  value: addrFields.city });
            poShip.setValue({ fieldId: "state", value: addrFields.state });
            poShip.setValue({ fieldId: "zip",   value: addrFields.zip });
            if (addrFields.addrphone) poShip.setValue({ fieldId: "addrphone", value: addrFields.addrphone });

            log.debug("PO_SHIP_ADDR_SET", "Copied SO " + soId + " shipping address to PO");
            return { success: true, address: addrFields };
        } catch (e) {
            log.error("COPY_SHIP_ADDR_ERR", "SO " + soId + ": " + e.message);
            return { success: false, error: e.message };
        }
    }

    // ── Set PO ship-to = warehouse location (Stocking) ──────────────────
    function setStockingShipAddress(po, locationId) {
        try {
            po.setValue({ fieldId: "shipaddresslist", value: parseInt(locationId, 10) });
            log.debug("STOCKING_SHIP_ADDR", "Set shipaddresslist to location " + locationId);
            return { success: true, locationId: locationId };
        } catch (e) {
            log.debug("STOCKING_SHIP_ADDR_ERR", e.message);
            return { success: false, error: e.message };
        }
    }

    // ── Update SO for Dropship — location + qty/amount sync ─────────────
    // Sets location=Dropship AND updates qty/amount on matching lines.
    // This MUST run BEFORE record.create with defaultValues.soid so the PO
    // auto-populates with the correct qty. Without this, po.save() tries to
    // back-sync a qty change to the SO and fails with DROP_SHIP_ERROR
    // ("Please enter a value for Amount").
    //
    // resolvedItems: [{ itemId, qty, cost, sku }] from SKU resolution
    function updateSOForDropship(soId, dropshipLocationId, resolvedItems) {
        if (!soId) return { success: false, reason: "no soId provided" };

        var so = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: true });
        var lineCount = so.getLineCount({ sublistId: "item" });
        var linesChanged = 0;

        var soStatus = so.getValue({ fieldId: "status" });
        log.debug("SO_STATUS", "SO " + soId + " status=" + soStatus);

        // Build itemId → desired qty map from resolvedItems
        var qtyMap = {};
        if (resolvedItems && resolvedItems.length > 0) {
            for (var qi = 0; qi < resolvedItems.length; qi++) {
                qtyMap[String(resolvedItems[qi].itemId)] = resolvedItems[qi].qty;
            }
        }

        for (var i = 0; i < lineCount; i++) {
            so.selectLine({ sublistId: "item", line: i });
            var changed = false;

            // Location → Dropship
            if (dropshipLocationId) {
                var currentLoc = so.getCurrentSublistValue({ sublistId: "item", fieldId: "location" });
                if (String(currentLoc) !== String(dropshipLocationId)) {
                    so.setCurrentSublistValue({
                        sublistId: "item", fieldId: "location",
                        value: dropshipLocationId, ignoreFieldChange: false
                    });
                    changed = true;
                }
            }

            // Qty → match PO order_items (so PO auto-populate gets correct qty)
            var lineItemId = String(so.getCurrentSublistValue({ sublistId: "item", fieldId: "item" }));
            if (qtyMap[lineItemId] !== undefined) {
                var currentQty = so.getCurrentSublistValue({ sublistId: "item", fieldId: "quantity" });
                var desiredQty = qtyMap[lineItemId];
                if (Number(currentQty) !== Number(desiredQty)) {
                    var currentRate = Number(so.getCurrentSublistValue({ sublistId: "item", fieldId: "rate" })) || 0;
                    so.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: desiredQty, ignoreFieldChange: false });
                    // Explicitly set amount = qty * SO rate (keep SO retail price, just update for new qty)
                    so.setCurrentSublistValue({ sublistId: "item", fieldId: "amount", value: desiredQty * currentRate, ignoreFieldChange: false });
                    log.debug("SO_QTY_UPDATE", "Line " + i + " item " + lineItemId + ": qty " + currentQty + " → " + desiredQty + ", amount → " + (desiredQty * currentRate));
                    changed = true;
                }
            }

            if (changed) linesChanged++;
            so.commitLine({ sublistId: "item" });
        }

        if (linesChanged === 0) {
            log.debug("SO_SETUP_SKIP", "All " + lineCount + " lines already correct — skipping save");
            return { success: true, soId: soId, linesChanged: 0, soStatus: soStatus };
        }

        var savedSoId = so.save({ enableSourcing: true, ignoreMandatoryFields: true });
        log.debug("SO_SETUP_SAVED", "SO " + savedSoId + " — " + linesChanged + "/" + lineCount + " lines updated");

        return { success: true, soId: savedSoId, linesChanged: linesChanged, soStatus: soStatus };
    }

    // ── Find PO linked to SO via createdfrom ─────────────────────────────
    function findLinkedPO(soId) {
        var idCol = search.createColumn({ name: "internalid", sort: search.Sort.DESC });
        var tranCol = search.createColumn({ name: "tranid" });

        var results = search.create({
            type: search.Type.PURCHASE_ORDER,
            filters: [
                ["createdfrom", "anyof", [soId]],
                "AND",
                ["mainline", "is", "T"]
            ],
            columns: [idCol, tranCol]
        }).run().getRange({ start: 0, end: 5 });

        if (results.length === 0) return null;

        if (results.length > 1) {
            log.audit("LINKED_PO_MULTIPLE", "Found " + results.length + " POs linked to SO " + soId + " — using newest");
        }

        return {
            id: parseInt(results[0].getValue(idCol), 10),
            poNumber: results[0].getValue(tranCol)
        };
    }

    // ── Set PO header fields ────────────────────────────────────────────
    function setPOHeaders(po, opts) {
        try { po.setValue({ fieldId: "tranid", value: "PO" + String(opts.po_number) }); } catch (e) {
            log.debug("TRANID_SKIP", "Could not set tranid: " + e.message);
        }
        po.setValue({ fieldId: "otherrefnum", value: String(opts.po_number) });
        po.setValue({ fieldId: "trandate",    value: new Date() });

        try { po.setValue({ fieldId: "custbody2", value: String(opts.distributor_order_number || opts.po_number) }); } catch (e) {
            log.debug("FIELD_SKIP", "custbody2: " + e.message);
        }
        try { po.setValue({ fieldId: "custbody1", value: opts.status }); } catch (e) {
            log.debug("FIELD_SKIP", "custbody1: " + e.message);
        }
        if (opts.distributor) {
            try { po.setValue({ fieldId: "custbody_otherrefnumber_custom", value: String(opts.distributor) }); } catch (e) {
                log.debug("FIELD_SKIP", "custbody_otherrefnumber_custom: " + e.message);
            }
        }
    }

    // ── Clear createpo + povendor on SO after auto-PO is confirmed ─────────
    // The PO link (createdfrom) is permanent once saved — clearing createpo
    // prevents duplicate auto-POs on future SO saves and hides the 'Drop Ship'
    // column from the SO UI. Uses ignoreFieldChange:true to prevent sourcing
    // from re-setting them during the clear.
    function clearSOCreatePO(soId) {
        var so = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: true });
        var lineCount = so.getLineCount({ sublistId: "item" });
        var cleared = 0;

        for (var ci = 0; ci < lineCount; ci++) {
            so.selectLine({ sublistId: "item", line: ci });
            try {
                so.setCurrentSublistValue({ sublistId: "item", fieldId: "createpo", value: " ", ignoreFieldChange: true });
                so.setCurrentSublistValue({ sublistId: "item", fieldId: "povendor", value: "",  ignoreFieldChange: true });
                so.commitLine({ sublistId: "item" });
                cleared++;
            } catch (lineErr) {
                log.debug("SO_CLEAR_LINE_ERR", "Line " + ci + ": " + lineErr.message);
                try { so.cancelLine({ sublistId: "item" }); } catch (e) {}
            }
        }

        var cleanedId = so.save({ enableSourcing: false, ignoreMandatoryFields: true });
        log.debug("SO_CREATEPO_CLEAN_SAVED", "SO " + cleanedId + " — cleared createpo/povendor on " + cleared + "/" + lineCount + " lines");
        return { soId: cleanedId, linesCleared: cleared, totalLines: lineCount };
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
            var linkedSoCustomerId = null;
            if (po_type === "Dropship" && website_order_number) {
                var soIdCol = search.createColumn({ name: "internalid" });
                var soTranCol = search.createColumn({ name: "tranid" });
                var soCustCol = search.createColumn({ name: "entity" });
                var soLookup = search.create({
                    type: search.Type.SALES_ORDER,
                    filters: [
                        ["poastext", "is", website_order_number],
                        "AND",
                        ["mainline", "is", "T"]
                    ],
                    columns: [soIdCol, soTranCol, soCustCol]
                }).run().getRange({ start: 0, end: 1 });

                if (soLookup.length > 0) {
                    linkedSoId = parseInt(soLookup[0].getValue(soIdCol), 10);
                    linkedSoNumber = soLookup[0].getValue(soTranCol);
                    linkedSoCustomerId = parseInt(soLookup[0].getValue(soCustCol), 10);
                    log.debug("LINKED_SO", "Found SO " + linkedSoNumber + " (ID " + linkedSoId + ", customer " + linkedSoCustomerId + ") for website_order_number: " + website_order_number);
                } else {
                    log.debug("LINKED_SO", "No SO found for website_order_number: " + website_order_number);
                }
            }

            // ── Resolve all PO item SKUs → internal IDs upfront ──────────────
            // Done FIRST so dropship path can use resolvedItems to update SO qty
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

            // ── Resolve location for line items ──────────────────────────────
            var locationId = resolveLocation(po_type, stocking_warehouse);
            log.debug("LOCATION_RESOLVED", JSON.stringify({
                po_type: po_type,
                stocking_warehouse: stocking_warehouse,
                locationId: locationId
            }));

            // ── Build record ─────────────────────────────────────────────────
            var po;
            var isUpdate = false;
            var isDropshipCreate = false;
            var soSetupResult = null;
            var autoPOInfo = null;

            var headerOpts = {
                po_number: po_number,
                website_order_number: website_order_number,
                distributor_order_number: distributor_order_number,
                status: status,
                distributor: distributor,
                invoice: invoice
            };

            if (po_type === "Dropship" && linkedSoId) {
                // ── DROPSHIP FLOW ────────────────────────────────────────────
                autoPOInfo = findLinkedPO(linkedSoId);

                if (autoPOInfo) {
                    // PO already linked — load for update
                    log.debug("LINKED_PO_FOUND", "PO " + autoPOInfo.poNumber + " (ID " + autoPOInfo.id + ") already linked to SO " + linkedSoNumber);
                    po = record.load({ type: record.Type.PURCHASE_ORDER, id: autoPOInfo.id, isDynamic: true });
                    isUpdate = true;

                    // Set headers + snapshot
                    setPOHeaders(po, headerOpts);

                } else {
                    // ── No auto-PO yet — update SO to trigger auto-PO via createpo='DropShip' ──
                    log.debug("NO_AUTO_PO", "No linked PO for SO " + linkedSoId + " — updating SO to trigger auto-PO");

                    try {
                        // Step 1: Load SO in static mode (defers validation to save)
                        var soRec = record.load({ type: record.Type.SALES_ORDER, id: linkedSoId, isDynamic: false });
                        var soLineCount = soRec.getLineCount({ sublistId: "item" });
                        var soLinesUpdated = 0;

                        for (var sli = 0; sli < soLineCount; sli++) {
                            var soLineItemId = soRec.getSublistValue({ sublistId: "item", fieldId: "item", line: sli });

                            // Look up item's preferred vendor (must be on vendor sublist)
                            var preferredVendor = null;
                            try {
                                var itemLookup = search.lookupFields({
                                    type: search.Type.ITEM,
                                    id: soLineItemId,
                                    columns: ["vendor"]
                                });
                                if (itemLookup.vendor && itemLookup.vendor.length > 0) {
                                    preferredVendor = parseInt(itemLookup.vendor[0].value, 10);
                                    log.debug("PREFERRED_VENDOR", "Item " + soLineItemId + " preferred vendor: " + preferredVendor);
                                }
                            } catch (vlErr) {
                                log.debug("VENDOR_LOOKUP_ERR", "Item " + soLineItemId + ": " + vlErr.message);
                            }

                            // Set createpo='DropShip' on this SO line
                            soRec.setSublistValue({ sublistId: "item", fieldId: "createpo", line: sli, value: "DropShip" });

                            // povendor: preferred vendor first, then fall back to payload vendor_id.
                            // createpo='DropShip' REQUIRES a povendor — without it NS rejects the SO save.
                            var resolvedVendor = preferredVendor || (vendor_id ? parseInt(vendor_id, 10) : null);
                            if (resolvedVendor) {
                                soRec.setSublistValue({ sublistId: "item", fieldId: "povendor", line: sli, value: resolvedVendor });
                                log.debug("SO_LINE_DROPSHIP", "Line " + sli + ": createpo=DropShip, povendor=" + resolvedVendor + (preferredVendor ? " (preferred)" : " (payload fallback)"));
                            } else {
                                log.debug("SO_LINE_DROPSHIP", "Line " + sli + ": createpo=DropShip, no vendor — skipping povendor");
                            }

                            soLinesUpdated++;
                        }

                        // Step 2: Save SO → should trigger NetSuite auto-PO creation
                        var savedSoId = soRec.save({ enableSourcing: true, ignoreMandatoryFields: true });
                        log.debug("SO_DROPSHIP_SAVED", "SO " + savedSoId + " updated — " + soLinesUpdated + " lines set to createpo=DropShip");
                        soSetupResult = { success: true, soId: savedSoId, linesUpdated: soLinesUpdated };

                        // Step 3: Find auto-created PO via createdfrom search
                        autoPOInfo = findLinkedPO(linkedSoId);

                        if (autoPOInfo) {
                            // Auto-PO found — load it and apply our form/vendor/headers
                            log.debug("AUTO_PO_FOUND", "Auto-PO " + autoPOInfo.poNumber + " (ID " + autoPOInfo.id + ") linked to SO " + linkedSoId);
                            po = record.load({ type: record.Type.PURCHASE_ORDER, id: autoPOInfo.id, isDynamic: true });
                            isUpdate = true;

                            var dsFormId = findFormId("Ecomm BP - Purchase Order");
                            if (dsFormId) po.setValue({ fieldId: "customform", value: parseInt(dsFormId, 10) });
                            if (vendor_id) po.setValue({ fieldId: "entity", value: parseInt(vendor_id, 10) });
                            setPOHeaders(po, headerOpts);

                            // ── Step 4: Clean up SO — clear createpo + povendor ──────────
                            // PO is now linked via createdfrom (permanent). Clearing createpo
                            // on the SO prevents NetSuite from showing 'Drop Ship' on the SO
                            // UI and avoids duplicate auto-PO attempts on future SO saves.
                            try {
                                var soCleanResult = clearSOCreatePO(savedSoId);
                                log.debug("SO_CREATEPO_CLEARED", JSON.stringify(soCleanResult));
                                if (soSetupResult) soSetupResult.createpoCleared = soCleanResult;
                            } catch (cleanErr) {
                                log.error("SO_CREATEPO_CLEAR_ERR", cleanErr.message);
                            }

                        } else {
                            // Auto-PO NOT created — use record.transform (SO → PO) to ensure createdfrom is set.
                            log.debug("AUTO_PO_MISSING", "No auto-PO found — creating PO via record.transform from SO " + linkedSoId);
                            try {
                                po = record.transform({
                                    fromType: record.Type.SALES_ORDER,
                                    fromId:   parseInt(linkedSoId, 10),
                                    toType:   record.Type.PURCHASE_ORDER,
                                    isDynamic: true,
                                    defaultValues: { entity: parseInt(vendor_id, 10) }
                                });
                                // Force explicit link just in case
                                try { po.setValue({ fieldId: "createdfrom", value: parseInt(linkedSoId, 10) }); } catch (e) {}
                            } catch (transformErr) {
                                // transform failed — last resort: create standalone PO
                                log.error("TRANSFORM_FAILED", transformErr.message);
                                po = record.create({ type: record.Type.PURCHASE_ORDER, isDynamic: true });
                                if (vendor_id) po.setValue({ fieldId: "entity", value: parseInt(vendor_id, 10) });
                                try { po.setValue({ fieldId: "createdfrom", value: parseInt(linkedSoId, 10) }); } catch (e) {}
                            }
                            isDropshipCreate = true;

                            var dsFormId2 = findFormId("Ecomm BP - Purchase Order");
                            if (dsFormId2) po.setValue({ fieldId: "customform", value: parseInt(dsFormId2, 10) });
                            if (vendor_id) po.setValue({ fieldId: "entity", value: parseInt(vendor_id, 10) });
                            setPOHeaders(po, headerOpts);

                            // Clean up SO — remove Drop Ship from lines (best-effort)
                            try {
                                var soCleanResult2 = clearSOCreatePO(savedSoId);
                                log.debug("SO_CREATEPO_CLEARED_FALLBACK", JSON.stringify(soCleanResult2));
                                if (soSetupResult) soSetupResult.createpoCleared = soCleanResult2;
                            } catch (cleanErr2) {
                                log.error("SO_CREATEPO_CLEAR_ERR_FALLBACK", cleanErr2.message);
                            }
                        }

                    } catch (soErr) {
                        // SO update failed — use record.transform (SO → PO) to create a properly linked PO.
                        log.error("SO_DROPSHIP_FAILED", JSON.stringify({ soId: linkedSoId, error: soErr.message }));
                        soSetupResult = { success: false, error: soErr.message };

                        // record.transform guarantees createdfrom is set correctly IF lines map over.
                        // If they don't, we still get a PO but we need to try forcing the link.
                        var transformErrObj = null;
                        try {
                            po = record.transform({
                                fromType: record.Type.SALES_ORDER,
                                fromId:   parseInt(linkedSoId, 10),
                                toType:   record.Type.PURCHASE_ORDER,
                                isDynamic: true,
                                defaultValues: { entity: parseInt(vendor_id, 10) }
                            });
                            // Force explicit link just in case
                            try { po.setValue({ fieldId: "createdfrom", value: parseInt(linkedSoId, 10) }); } catch (e) {}
                        } catch (transformErr2) {
                            transformErrObj = transformErr2.message;
                            log.error("TRANSFORM_FAILED_CATCH", transformErr2.message);
                            po = record.create({ type: record.Type.PURCHASE_ORDER, isDynamic: true });
                            if (vendor_id) po.setValue({ fieldId: "entity", value: parseInt(vendor_id, 10) });
                            try { po.setValue({ fieldId: "createdfrom", value: parseInt(linkedSoId, 10) }); } catch (e) {}
                        }
                        
                        isDropshipCreate = true;
                        if (transformErrObj) {
                            soSetupResult.transformError = transformErrObj;
                        }

                        var dsFormId3 = findFormId("Ecomm BP - Purchase Order");
                        if (dsFormId3) po.setValue({ fieldId: "customform", value: parseInt(dsFormId3, 10) });
                        if (vendor_id) po.setValue({ fieldId: "entity",    value: parseInt(vendor_id, 10) });
                        setPOHeaders(po, headerOpts);

                        // Clean up SO — remove Drop Ship from lines (best-effort)
                        try {
                            var soCleanResult3 = clearSOCreatePO(linkedSoId);
                            log.debug("SO_CREATEPO_CLEARED_CATCH", JSON.stringify(soCleanResult3));
                            soSetupResult.createpoCleared = soCleanResult3;
                        } catch (cleanErr3) {
                            log.error("SO_CREATEPO_CLEAR_ERR_CATCH", cleanErr3.message);
                        }
                    }
                }

            } else if (existing && action === "update") {
                po = record.load({ type: record.Type.PURCHASE_ORDER, id: existing.id, isDynamic: true });
                isUpdate = true;

                // Form + entity + headers
                var formId = findFormId("Ecomm BP - Purchase Order");
                if (formId) {
                    po.setValue({ fieldId: "customform", value: parseInt(formId, 10) });
                    log.debug("FORM_SET", "customform → " + formId);
                }
                if (vendor_id) {
                    po.setValue({ fieldId: "entity", value: parseInt(vendor_id, 10) });
                }
                setPOHeaders(po, headerOpts);

            } else {
                // New standard PO
                po = record.create({ type: record.Type.PURCHASE_ORDER, isDynamic: true });

                var formId2 = findFormId("Ecomm BP - Purchase Order");
                if (formId2) {
                    po.setValue({ fieldId: "customform", value: parseInt(formId2, 10) });
                    log.debug("FORM_SET", "customform → " + formId2);
                }
                if (vendor_id) {
                    po.setValue({ fieldId: "entity", value: parseInt(vendor_id, 10) });
                }
                setPOHeaders(po, headerOpts);
            }

            var poSubsidiary = "";
            try { poSubsidiary = po.getValue({ fieldId: "subsidiary" }); } catch (e) {}
            log.debug("ENTITY_SET", JSON.stringify({
                vendor: vendor_id,
                subsidiary: poSubsidiary,
                form: po.getValue({ fieldId: "customform" })
            }));

            // ── SNAPSHOT: BEFORE (after header set, before line changes) ────
            before = snapshotPO(po);

            // ── Line items ─────────────────────────────────────────────────────
            var oldLineCount = po.getLineCount({ sublistId: "item" });
            var linesAdded = 0;
            var linesUpdated = 0;

            // If it's a dropship create but the PO transformed with 0 lines (because 
            // the SO lines were invalid dropship items), fall through to the STANDARD
            // add-first strategy to manually insert the lines.
            if (isDropshipCreate && oldLineCount > 0) {
                // ── DROPSHIP: Lines auto-populated from SO ──
                // Qty already matches (SO was updated first). Only update rate + location.
                log.debug("DROPSHIP_LINES", "Auto-populated " + oldLineCount + " lines from SO — updating rate/location only");

                // Build map: itemId → [line indices] for matching
                var existingLineMap = {};
                for (var eli = 0; eli < oldLineCount; eli++) {
                    var existItemId = po.getSublistValue({ sublistId: "item", fieldId: "item", line: eli });
                    var mapKey = String(existItemId);
                    if (!existingLineMap[mapKey]) existingLineMap[mapKey] = [];
                    existingLineMap[mapKey].push(eli);
                }

                var matchedLines = {};
                var unmatchedItems = [];

                // Match resolved items to auto-populated lines by item ID
                for (var mi = 0; mi < resolvedItems.length; mi++) {
                    var poItem = resolvedItems[mi];
                    var itemKey = String(poItem.itemId);
                    var matchedLine = -1;

                    if (existingLineMap[itemKey]) {
                        for (var mli = 0; mli < existingLineMap[itemKey].length; mli++) {
                            var candidate = existingLineMap[itemKey][mli];
                            if (!matchedLines[candidate]) {
                                matchedLine = candidate;
                                matchedLines[candidate] = true;
                                break;
                            }
                        }
                    }

                    if (matchedLine >= 0) {
                        try {
                            po.selectLine({ sublistId: "item", line: matchedLine });
                            // Only update rate (cost) — qty already matches from SO update
                            po.setCurrentSublistValue({ sublistId: "item", fieldId: "rate", value: poItem.cost, ignoreFieldChange: false });
                            if (locationId) {
                                po.setCurrentSublistValue({ sublistId: "item", fieldId: "location", value: locationId, ignoreFieldChange: false });
                            }
                            po.commitLine({ sublistId: "item" });
                            linesUpdated++;
                            log.debug("LINE_UPDATED", "Line " + matchedLine + " — SKU \"" + poItem.sku + "\" rate=" + poItem.cost);
                        } catch (updErr) {
                            log.error("LINE_UPDATE_ERR", "Line " + matchedLine + " SKU \"" + poItem.sku + "\" — " + updErr.message);
                            unmatchedItems.push(poItem);
                        }
                    } else {
                        unmatchedItems.push(poItem);
                    }
                }

                // Add any unmatched items as new lines
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
                        po.setCurrentSublistValue({ sublistId: "item", fieldId: "amount", value: newItem.qty * newItem.cost, ignoreFieldChange: false });
                        try { po.setCurrentSublistValue({ sublistId: "item", fieldId: "class", value: "", ignoreFieldChange: true }); } catch (e) {}
                        po.commitLine({ sublistId: "item" });
                        linesAdded++;
                    } catch (addErr) {
                        log.error("LINE_ADD_ERR", "SKU \"" + newItem.sku + "\" — " + addErr.message);
                        skippedSkus.push(newItem.sku);
                    }
                }

                // Remove unmatched auto-populated lines (not in our order_items) in reverse
                var linesToRemove = [];
                for (var rli = 0; rli < oldLineCount; rli++) {
                    if (!matchedLines[rli]) linesToRemove.push(rli);
                }
                if (linesToRemove.length > 0) {
                    log.debug("REMOVE_UNMATCHED", "Removing " + linesToRemove.length + " auto-populated lines not in order_items");
                    for (var rmi = linesToRemove.length - 1; rmi >= 0; rmi--) {
                        po.removeLine({ sublistId: "item", line: linesToRemove[rmi] });
                    }
                }

                log.debug("DROPSHIP_LINE_RESULT", "Updated: " + linesUpdated + ", Added: " + linesAdded + ", Removed: " + linesToRemove.length);

            } else {
                // ── STANDARD: Add-first, remove-old strategy ───────────────────
                // If this is a fallback Dropship create, we'll try to find the matching SO line
                // so we can hard-link the PO line to the SO line (orderdoc / orderline).
                // This is what makes the PO number show up on the SO "Create PO" column.
                var soLineMap = {};
                if (linkedSoId) {
                    try {
                        var soLookup = record.load({ type: record.Type.SALES_ORDER, id: linkedSoId, isDynamic: false });
                        var scount = soLookup.getLineCount({ sublistId: "item" });
                        for (var si = 0; si < scount; si++) {
                            var sItemId = soLookup.getSublistValue({ sublistId: "item", fieldId: "item", line: si });
                            var sLineId = soLookup.getSublistValue({ sublistId: "item", fieldId: "line", line: si });
                            if (!soLineMap[sItemId]) soLineMap[sItemId] = sLineId; // grab first match
                        }
                    } catch (e) { log.debug("SO_LINE_LOOKUP_ERR", e.message); }
                }

                for (var i = 0; i < resolvedItems.length; i++) {
                    var stdItem = resolvedItems[i];
                    try {
                        po.selectNewLine({ sublistId: "item" });
                        po.setCurrentSublistValue({ sublistId: "item", fieldId: "item", value: stdItem.itemId, ignoreFieldChange: false });
                        
                        // 🔗 Hard-link to SO Line
                        if (linkedSoId && soLineMap[stdItem.itemId]) {
                            try { po.setCurrentSublistValue({ sublistId: "item", fieldId: "orderdoc", value: linkedSoId, ignoreFieldChange: false }); } catch(e){}
                            try { po.setCurrentSublistValue({ sublistId: "item", fieldId: "orderline", value: soLineMap[stdItem.itemId], ignoreFieldChange: false }); } catch(e){}
                        }

                        if (locationId) {
                            po.setCurrentSublistValue({ sublistId: "item", fieldId: "location", value: locationId, ignoreFieldChange: false });
                        }
                        po.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: stdItem.qty, ignoreFieldChange: false });
                        po.setCurrentSublistValue({ sublistId: "item", fieldId: "rate", value: stdItem.cost, ignoreFieldChange: false });
                        try { po.setCurrentSublistValue({ sublistId: "item", fieldId: "class", value: "", ignoreFieldChange: true }); } catch (e) {}
                        po.commitLine({ sublistId: "item" });
                        linesAdded++;
                        log.debug("ITEM_ADDED", "SKU \"" + stdItem.sku + "\" → lines now: " + po.getLineCount({ sublistId: "item" }));
                    } catch (lineErr) {
                        log.error("ITEM_SKIP", "SKU \"" + stdItem.sku + "\" — " + lineErr.message);
                        skippedSkus.push(stdItem.sku);
                    }
                }

                // Remove old lines in reverse order
                if (oldLineCount > 0) {
                    log.debug("REMOVE_OLD", "Removing " + oldLineCount + " old lines (new added: " + linesAdded + ")");
                    for (var r = oldLineCount - 1; r >= 0; r--) {
                        po.removeLine({ sublistId: "item", line: r });
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

            // ── Set shipping address ─────────────────────────────────────────
            var shipResult = null;
            if (po_type === "Dropship" && linkedSoId) {
                shipResult = copySOShippingToPO(linkedSoId, po);
            } else if (po_type === "Stocking" && locationId) {
                shipResult = setStockingShipAddress(po, locationId);
            }
            if (shipResult) log.debug("SHIP_ADDRESS", JSON.stringify(shipResult));

            // ── Clear auto-sourced class to avoid subsidiary mismatch ────────
            try { po.setValue({ fieldId: "class", value: "" }); } catch (e) {}

            // ── SNAPSHOT: AFTER (before save) ────────────────────────────────
            after = snapshotPO(po);
            diff = diffSnapshots(before, after);

            var savedId = po.save({ enableSourcing: false, ignoreMandatoryFields: true });
            log.debug("SUCCESS", "PO " + po_number + " saved → ID: " + savedId);

            // Verify createdfrom link via search (same pattern as support script)
            var createdfromResult = null;
            if (linkedSoId) {
                try {
                    var cfSearch = search.create({
                        type: search.Type.PURCHASE_ORDER,
                        filters: [
                            ["createdfrom", "anyof", linkedSoId],
                            "AND",
                            ["internalid", "anyof", savedId]
                        ],
                        columns: ["internalid"]
                    });
                    var cfResults = cfSearch.run().getRange({ start: 0, end: 1 });
                    createdfromResult = {
                        linked: cfResults.length > 0,
                        soId: linkedSoId,
                        poId: savedId
                    };
                    log.debug("CREATEDFROM_VERIFY", JSON.stringify(createdfromResult));
                } catch (vErr) {
                    createdfromResult = { error: vErr.message };
                }
            }

            return {
                success: true,
                action: isUpdate ? "updated" : (isDropshipCreate ? "created_dropship" : "created"),
                po_number: po_number,
                internalId: savedId,
                linesAdded: linesAdded,
                linesUpdated: linesUpdated,
                locationId: locationId,
                po_type: po_type,
                skippedSkus: skippedSkus.length > 0 ? skippedSkus : undefined,
                soSetup: soSetupResult,
                autoPO: autoPOInfo,
                createdfromResult: createdfromResult,
                linkedSo: linkedSoId ? { id: linkedSoId, soNumber: linkedSoNumber } : null,
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
        // SuiteQL for exact match — N/search on otherrefnum returns false positives (gotcha #12)
        var sql = "SELECT id, tranid FROM transaction WHERE type = 'PurchOrd' AND otherrefnum = ? ORDER BY id DESC";
        var resultSet = query.runSuiteQL({ query: sql, params: [String(otherrefnum)] });
        var rows = resultSet.asMappedResults();

        if (rows.length === 0) return null;

        if (rows.length > 1) {
            log.audit("PO_DUPLICATES", "Found " + rows.length +
                " POs for otherrefnum " + otherrefnum + " -- using newest (highest ID)");
        }

        return {
            id: parseInt(rows[0].id, 10),
            poNumber: rows[0].tranid
        };
    }

    return { post: post };
});
