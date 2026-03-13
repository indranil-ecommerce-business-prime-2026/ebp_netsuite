/**
 * NETSUITE RESTLET — Sales Order Sync
 *
 * HOW TO DEPLOY IN NETSUITE:
 * 1. Go to: Customization → Scripting → Scripts → New
 * 2. Script Type: RESTlet
 * 3. Name: EBP Sales Order Sync
 * 4. Script ID: customscript_ebp_sales_order_sync
 * 5. Upload this file
 * 6. Set POST Function to: post
 * 7. Save → Deploy
 * 8. Deployment ID: customdeploy_ebp_sales_order_sync
 * 9. Status: Released
 * 10. Update .env:
 *     RESTLET_SCRIPT_ID=customscript_ebp_sales_order_sync
 *     RESTLET_DEPLOY_ID=customdeploy_ebp_sales_order_sync
 *
 * PAYLOAD EXPECTED:
 * {
 *   action:              "skip" | "update",
 *   otherrefnum:         "113-1234567-1234567",   ← Amazon Order ID (unique key)
 *   trandate:            "2026-01-15T00:00:00Z",
 *   order_status:        "Unshipped" | "Shipped" | ...,
 *   fulfillment_channel: "MFN" | "AFN",
 *   ship_date:           "2026-01-16T00:00:00Z" | null,
 *   items_shipped:       0,
 *   items_unshipped:     2,
 *   location:            "123 MAIN ST, CITY, CA, 90001",   ← ship-to (from TPX)
 *   ship_from:           "456 WAREHOUSE RD, CITY, CA, 90002", ← ship-from (from Amazon)
 *   items:               [{ item: "SKU001", quantity: 2, amount: 49.99 }],
 *   po:                  [{ po_number: 10001, po_vendor: 117, order_items: [...] }]
 * }
 */

/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(["N/record", "N/search", "N/log"], function (record, search, log) {

    function post(payload) {
        try {
            log.debug("PAYLOAD", JSON.stringify(payload));

            var action          = payload.action || "skip";
            var otherrefnum     = payload.otherrefnum;
            var trandate        = payload.trandate;
            var order_status    = payload.order_status || "";
            var fulfillment_channel = payload.fulfillment_channel || "";
            var ship_date       = payload.ship_date;
            var location        = payload.location || "";
            var items           = payload.items;
            var po              = payload.po;

            if (!otherrefnum) {
                return { success: false, error: "Missing otherrefnum" };
            }

            // ── Check if Sales Order already exists in NetSuite ──────────────
            var existingId = findSalesOrder(otherrefnum);

            if (existingId && action === "skip") {
                log.debug("SKIP", "Order " + otherrefnum + " already exists. Skipping.");
                return { success: true, action: "skipped", otherrefnum: otherrefnum };
            }

            // ── Entity (customer) — REQUIRED by NetSuite ───────────────────
            var customerId = findOrCreateCustomer("Amazon");
            if (!customerId) {
                return { success: false, error: "Could not find or create Amazon customer" };
            }
            log.debug("CUSTOMER", "ID = " + customerId);

            // ── Build record ─────────────────────────────────────────────────
            var so;

            if (existingId && action === "update") {
                so = record.load({ type: record.Type.SALES_ORDER, id: existingId, isDynamic: true });
            } else {
                so = record.create({ type: record.Type.SALES_ORDER, isDynamic: true });
            }

            // Force standard Sales Order form (avoids custom form validation rules)
            try {
                so.setValue({ fieldId: "customform", value: 91 }); // 91 = Standard Sales Order. If this fails, try other IDs.
                log.debug("FORM", "Set to standard form 91");
            } catch (formErr) {
                log.debug("FORM_SKIP", "Could not set form: " + formErr.message);
            }

            // Entity MUST be set first — it triggers form/subsidiary sourcing
            so.setValue({ fieldId: "entity", value: parseInt(customerId, 10) });

            // ── Standard NetSuite fields ─────────────────────────────────────
            so.setValue({ fieldId: "otherrefnum", value: String(otherrefnum) });

            // trandate — handle null/undefined/invalid
            if (trandate) {
                var parsedDate = new Date(trandate);
                if (!isNaN(parsedDate.getTime())) {
                    so.setValue({ fieldId: "trandate", value: parsedDate });
                }
            }

            so.setValue({ fieldId: "memo", value: String(location || "") });

            // shipdate — handle null/undefined
            if (ship_date) {
                var parsedShipDate = new Date(ship_date);
                if (!isNaN(parsedShipDate.getTime())) {
                    so.setValue({ fieldId: "shipdate", value: parsedShipDate });
                }
            }

            // ── Custom fields — wrapped in try/catch so missing fields don't crash
            try { so.setValue({ fieldId: "custbody1", value: String(order_status) }); } catch (e) {
                log.debug("FIELD_SKIP", "custbody1: " + e.message);
            }
            try { so.setValue({ fieldId: "custbody3", value: String(fulfillment_channel) }); } catch (e) {
                log.debug("FIELD_SKIP", "custbody3: " + e.message);
            }

            // ── PO reference ─────────────────────────────────────────────────
            if (Array.isArray(po) && po.length > 0) {
                try {
                    so.setValue({ fieldId: "custbody_otherrefnumber_custom", value: String(po[0].po_number || "") });
                    var allPONumbers = po.map(function (p) { return p.po_number; }).filter(Boolean).join(", ");
                    so.setValue({ fieldId: "custbody2", value: String(allPONumbers) });
                } catch (e) {
                    log.debug("FIELD_SKIP", "PO fields: " + e.message);
                }
            }

            // ── Remove any pre-populated/default line items ─────────────────
            var existingLines = so.getLineCount({ sublistId: "item" });
            log.debug("PRE_LINES", "Lines before clear: " + existingLines);
            for (var r = existingLines - 1; r >= 0; r--) {
                so.removeLine({ sublistId: "item", line: r });
            }

            // ── Line items ───────────────────────────────────────────────────
            var linesAdded = 0;
            var skippedSkus = [];

            if (Array.isArray(items) && items.length > 0) {
                for (var i = 0; i < items.length; i++) {
                    var lineItem = items[i];
                    var sku = lineItem.item;
                    if (!sku) continue;

                    try {
                        // Search for item by SKU
                        var itemResults = search.create({
                            type: search.Type.ITEM,
                            filters: [["itemid", "is", sku]],
                            columns: ["internalid", "itemid", "type"]
                        }).run().getRange({ start: 0, end: 1 });

                        if (!itemResults || itemResults.length === 0) {
                            log.debug("ITEM_NOT_FOUND", "SKU \"" + sku + "\" not in NetSuite");
                            skippedSkus.push(sku);
                            continue;
                        }

                        var itemInternalId = parseInt(itemResults[0].getValue("internalid"), 10);
                        var itemType = itemResults[0].getValue("type");
                        log.debug("ITEM_FOUND", "SKU \"" + sku + "\" → ID " + itemInternalId + ", type: " + itemType);

                        var qty = parseInt(lineItem.quantity, 10) || 1;
                        var amt = parseFloat(lineItem.amount) || 0;
                        var rate = qty > 0 ? (amt / qty) : amt;

                        so.selectNewLine({ sublistId: "item" });
                        so.setCurrentSublistValue({ sublistId: "item", fieldId: "item", value: itemInternalId });

                        // For inventory items, location is often required — try to set it
                        // Get the first available location from the item's locations
                        try {
                            var locResults = search.create({
                                type: search.Type.ITEM,
                                filters: [["internalid", "anyof", itemInternalId]],
                                columns: [search.createColumn({ name: "inventorylocation" })]
                            }).run().getRange({ start: 0, end: 1 });
                            if (locResults.length > 0) {
                                var locId = locResults[0].getValue("inventorylocation");
                                if (locId) {
                                    so.setCurrentSublistValue({ sublistId: "item", fieldId: "location", value: parseInt(locId, 10) });
                                    log.debug("LOCATION_SET", "item " + itemInternalId + " → location " + locId);
                                }
                            }
                        } catch (locErr) {
                            log.debug("LOCATION_SKIP", "Could not set location: " + locErr.message);
                        }

                        so.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: qty });
                        so.setCurrentSublistValue({ sublistId: "item", fieldId: "price", value: -1 });
                        so.setCurrentSublistValue({ sublistId: "item", fieldId: "rate", value: rate });
                        so.commitLine({ sublistId: "item" });

                        var lineCount = so.getLineCount({ sublistId: "item" });
                        log.debug("ITEM_ADDED", "SKU \"" + sku + "\" (ID " + itemInternalId + ") → lines now: " + lineCount);
                        linesAdded++;
                    } catch (lineErr) {
                        log.debug("ITEM_SKIP", "SKU \"" + sku + "\" — " + lineErr.message);
                        skippedSkus.push(sku);
                    }
                }
            }

            // NetSuite requires at least 1 line item
            if (linesAdded === 0) {
                var skuList = Array.isArray(items) ? items.map(function (x) { return x.item; }).join(", ") : "none";
                log.debug("NO_ITEMS", "Order " + otherrefnum + " — 0 lines. SKUs: " + skuList + ". Skipped: " + skippedSkus.join(", "));
                return { success: false, action: "no_items", otherrefnum: otherrefnum, skus: skuList, skipped: skippedSkus };
            }

            log.debug("LINES_READY", linesAdded + " lines added, " + skippedSkus.length + " skipped");

            // ── Debug dump before save ───────────────────────────────────────
            var finalLineCount = so.getLineCount({ sublistId: "item" });
            log.debug("PRE_SAVE", JSON.stringify({
                entity: so.getValue({ fieldId: "entity" }),
                otherrefnum: so.getValue({ fieldId: "otherrefnum" }),
                lineCount: finalLineCount
            }));

            for (var d = 0; d < finalLineCount; d++) {
                var lineLocVal = "";
                try { lineLocVal = so.getSublistValue({ sublistId: "item", fieldId: "location", line: d }); } catch (e) {}
                log.debug("LINE_DUMP", "Line " + d + ": item=" +
                    so.getSublistValue({ sublistId: "item", fieldId: "item", line: d }) +
                    ", qty=" + so.getSublistValue({ sublistId: "item", fieldId: "quantity", line: d }) +
                    ", rate=" + so.getSublistValue({ sublistId: "item", fieldId: "rate", line: d }) +
                    ", amt=" + so.getSublistValue({ sublistId: "item", fieldId: "amount", line: d }) +
                    ", loc=" + lineLocVal);
            }

            // ── Save ─────────────────────────────────────────────────────────
            var savedId = so.save({ enableSourcing: false, ignoreMandatoryFields: true });
            log.debug("SUCCESS", "Order " + otherrefnum + " saved → ID: " + savedId);

            return {
                success: true,
                action: existingId ? "updated" : "created",
                otherrefnum: otherrefnum,
                internalId: savedId
            };

        } catch (e) {
            log.error("ERROR", JSON.stringify({ name: e.name, message: e.message, stack: e.stack }));
            return { success: false, error: e.message };
        }
    }

    // ── Helper: find or create a customer by name ──────────────────────────
    function findOrCreateCustomer(name) {
        var results = search.create({
            type: search.Type.CUSTOMER,
            filters: [["entityid", "is", name]],
            columns: ["internalid"]
        }).run().getRange({ start: 0, end: 1 });

        if (results.length > 0) {
            return parseInt(results[0].getValue("internalid"), 10);
        }

        // Not found — create it
        var cust = record.create({ type: record.Type.CUSTOMER });
        cust.setValue({ fieldId: "entityid", value: name });
        cust.setValue({ fieldId: "companyname", value: name });
        cust.setValue({ fieldId: "isperson", value: "F" });
        return cust.save();
    }

    // ── Helper: find existing Sales Order by otherrefnum ────────────────────
    function findSalesOrder(otherrefnum) {
        var results = search.create({
            type: search.Type.SALES_ORDER,
            filters: [["otherrefnum", "is", otherrefnum]],
            columns: ["internalid"]
        }).run().getRange({ start: 0, end: 1 });

        return results.length > 0 ? parseInt(results[0].getValue("internalid"), 10) : null;
    }

    return { post: post };
});
