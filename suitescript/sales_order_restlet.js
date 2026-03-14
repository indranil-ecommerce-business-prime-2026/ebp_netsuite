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
 * NOTE: This account uses SuiteTax (Advanced Tax). SuiteTax requires DYNAMIC
 * mode for transaction records because the tax engine relies on field change
 * events that only fire in dynamic mode (setCurrentSublistValue).
 * Standard mode (setSublistValue) does NOT trigger these events, causing
 * VALID_LINE_ITEM_REQD errors even when all visible fields are set.
 *
 * PAYLOAD EXPECTED:
 * {
 *   action:              "skip" | "update",
 *   otherrefnum:         "113-1234567-1234567",
 *   trandate:            "2026-01-15T00:00:00Z",
 *   store_type:          "amazon" | "walmart" | "newegg" | "ebay",
 *   order_status:        "Unshipped" | "Shipped" | ...,
 *   fulfillment_channel: "MFN" | "AFN",
 *   ship_date:           "2026-01-16T00:00:00Z" | null,
 *   items:               [{ item: "SKU001", quantity: 2, amount: 49.99 }],
 *   po:                  [{ po_number: 10001, po_vendor: 117, order_items: [...] }]
 * }
 */

/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(["N/record", "N/search", "N/log"], function (record, search, log) {

    // ── Lookup maps: store_type → names (dynamic ID resolution at runtime) ──
    var CUSTOMER_MAP = {
        "amazon":          "Amazon",
        "walmart":         "Walmart",
        "newegg":          "NewEgg",
        "newegg_business": "NewEgg Business",
        "ebay":            "eBay"
    };

    var CHANNEL_MAP = {
        "amazon":          "3rd Party Marketplace : Amazon",
        "walmart":         "3rd Party Marketplace : Walmart",
        "newegg":          "3rd Party Marketplace : NewEgg",
        "ebay":            "3rd Party Marketplace : eBay"
    };

    var FORM_NAME = "Ecomm BP - Sales Order";

    // ── Caches (per RESTlet invocation) ─────────────────────────────────────
    var _customerCache = {};
    var _channelCache = {};
    var _formCache = {};
    var _fallbackLocationCache = {};

    // ═══════════════════════════════════════════════════════════════════════════
    // MAIN
    // ═══════════════════════════════════════════════════════════════════════════
    function post(payload) {
        var so;
        try {
            log.debug("PAYLOAD", JSON.stringify(payload));

            // ── TEST MODE: minimal SO to isolate VALID_LINE_ITEM_REQD ──────
            if (payload.test_mode) {
                return testMinimalCreate(payload);
            }

            var action              = payload.action || "skip";
            var otherrefnum         = payload.otherrefnum;
            var trandate            = payload.trandate;
            var store_type          = (payload.store_type || "amazon").toLowerCase();
            var order_status        = payload.order_status || "";
            var fulfillment_channel = payload.fulfillment_channel || "";
            var ship_date           = payload.ship_date;
            var items               = payload.items;
            var po                  = payload.po;

            if (!otherrefnum) {
                return { success: false, error: "Missing otherrefnum" };
            }

            // ── Check if Sales Order already exists ─────────────────────────
            var existingMatch = findSalesOrder(otherrefnum);
            var existingId = existingMatch ? existingMatch.id : null;
            var existingSoNum = existingMatch ? existingMatch.soNumber : null;

            if (existingId && action === "skip") {
                log.debug("SKIP", "Order " + otherrefnum + " already exists as " + existingSoNum + ". Skipping.");
                return { success: true, action: "skipped", otherrefnum: otherrefnum, existingId: existingId, soNumber: existingSoNum };
            }

            // ── Resolve Customer (dynamic from store_type) ──────────────────
            var customerName = CUSTOMER_MAP[store_type];
            if (!customerName) {
                return { success: false, error: "Unknown store_type: " + store_type + ". Add to CUSTOMER_MAP." };
            }

            var customerInfo = findCustomer(customerName);
            if (!customerInfo) {
                return { success: false, error: "Customer '" + customerName + "' not found in NetSuite. Create it first." };
            }
            log.debug("CUSTOMER", JSON.stringify(customerInfo));

            // ── Resolve Form (dynamic by name) ──────────────────────────────
            var formId = findFormId(FORM_NAME);
            log.debug("FORM", "'" + FORM_NAME + "' → ID " + formId);

            // ── Build record (DYNAMIC mode — required for SuiteTax) ─────────
            // SuiteTax needs field change events to process tax on line items.
            // These events only fire in dynamic mode (setCurrentSublistValue).
            if (existingId && action === "update") {
                so = record.load({ type: record.Type.SALES_ORDER, id: existingId, isDynamic: true });
            } else {
                so = record.create({ type: record.Type.SALES_ORDER, isDynamic: true });
            }

            // ── Snapshot BEFORE any changes ──────────────────────────────
            var before = snapshotSO(so);
            log.debug("SNAPSHOT_BEFORE", JSON.stringify(before));

            // Set Form FIRST (controls which fields/sublists are available)
            if (formId) {
                so.setValue({ fieldId: "customform", value: parseInt(formId, 10) });
            }

            // Entity (Customer) — auto-sets subsidiary in dynamic mode
            so.setValue({ fieldId: "entity", value: customerInfo.id });

            var soSubsidiary = so.getValue({ fieldId: "subsidiary" });
            var soCurrency = "";
            try { soCurrency = so.getValue({ fieldId: "currency" }); } catch (e) {}
            var soOrderStatus = "";
            try { soOrderStatus = so.getValue({ fieldId: "orderstatus" }); } catch (e) {}
            log.debug("ENTITY_SET", JSON.stringify({
                entity: customerInfo.id,
                subsidiary: soSubsidiary,
                currency: soCurrency,
                orderstatus: soOrderStatus,
                form: so.getValue({ fieldId: "customform" }),
                isDynamic: true,
                recordMode: existingId ? "update" : "create"
            }));

            // ── Channels/Lead Source (Custom Segment: csegecomm_channel) ───
            var channelName = CHANNEL_MAP[store_type];
            var channelResult = channelName ? findLeadSource(so, channelName) : { id: null, fieldId: null };
            log.debug("CHANNEL", JSON.stringify({ name: channelName, id: channelResult.id, fieldId: channelResult.fieldId }));

            if (channelResult.id && channelResult.fieldId) {
                try {
                    so.setValue({ fieldId: channelResult.fieldId, value: parseInt(channelResult.id, 10) });
                    log.debug("CHANNEL_SET", "Set " + channelResult.fieldId + " = " + channelResult.id);
                } catch (e) {
                    log.error("CHANNEL_SET_ERR", e.message);
                }
            }

            // ── Standard fields ─────────────────────────────────────────────
            so.setValue({ fieldId: "otherrefnum", value: String(otherrefnum) });

            if (trandate) {
                var parsedDate = new Date(trandate);
                if (!isNaN(parsedDate.getTime())) {
                    so.setValue({ fieldId: "trandate", value: parsedDate });
                }
            }

            if (ship_date) {
                var parsedShipDate = new Date(ship_date);
                if (!isNaN(parsedShipDate.getTime())) {
                    so.setValue({ fieldId: "shipdate", value: parsedShipDate });
                }
            }

            // Custom fields
            try { so.setValue({ fieldId: "custbody1", value: String(order_status) }); } catch (e) {}
            try { so.setValue({ fieldId: "custbody3", value: String(fulfillment_channel) }); } catch (e) {}

            // Memo
            var memo = "";
            if (Array.isArray(po) && po.length > 0) {
                var poNums = po.map(function (p) { return p.po_number; }).filter(Boolean).join(", ");
                if (poNums) memo = "PO: " + poNums;
            }
            so.setValue({ fieldId: "memo", value: memo });

            // ── Track existing lines (will be removed AFTER new lines are added) ─
            // NetSuite requires at least one valid line on a loaded record at all
            // times. So we add new lines first, then remove the old ones.
            var oldLineCount = so.getLineCount({ sublistId: "item" });
            log.debug("PRE_LINES", "Existing lines to replace: " + oldLineCount);

            // ── Line items (DYNAMIC mode — required for SuiteTax) ───────────
            // selectNewLine → setCurrentSublistValue → commitLine
            // This triggers field change events so SuiteTax can process each line.
            var linesAdded = 0;
            var skippedSkus = [];
            var SKIP_ITEM_TYPES = ["Group", "Kit", "Kit/Package"];

            log.debug("ITEMS_INPUT", JSON.stringify({
                count: Array.isArray(items) ? items.length : 0,
                raw: Array.isArray(items) ? items.slice(0, 5) : items
            }));

            if (Array.isArray(items) && items.length > 0) {
                for (var i = 0; i < items.length; i++) {
                    var lineItem = items[i];
                    var sku = lineItem.item;
                    log.debug("ITEM_RAW_" + i, JSON.stringify(lineItem));
                    if (!sku) {
                        log.debug("ITEM_SKIP_EMPTY", "Line " + i + " has no SKU");
                        continue;
                    }

                    try {
                        var itemCol1 = search.createColumn({ name: "internalid" });
                        var itemCol2 = search.createColumn({ name: "type" });
                        var itemCol3 = search.createColumn({ name: "subsidiary" });

                        var itemResults = search.create({
                            type: search.Type.ITEM,
                            filters: [["itemid", "is", sku]],
                            columns: [itemCol1, itemCol2, itemCol3]
                        }).run().getRange({ start: 0, end: 5 });

                        if (!itemResults || itemResults.length === 0) {
                            log.debug("ITEM_NOT_FOUND", "SKU \"" + sku + "\" not in NetSuite");
                            skippedSkus.push(sku);
                            continue;
                        }

                        var itemInternalId = parseInt(itemResults[0].getValue(itemCol1), 10);
                        var itemType = itemResults[0].getText(itemCol2) || itemResults[0].getValue(itemCol2);
                        var itemSub = itemResults[0].getText(itemCol3) || itemResults[0].getValue(itemCol3);

                        log.debug("ITEM_FOUND", JSON.stringify({ sku: sku, id: itemInternalId, type: itemType, subsidiary: itemSub }));

                        if (SKIP_ITEM_TYPES.indexOf(itemType) >= 0) {
                            log.audit("ITEM_TYPE_SKIP", "SKU " + sku + " type=" + itemType);
                            skippedSkus.push(sku + " (type:" + itemType + ")");
                            continue;
                        }

                        var locationId = findLocationForItem(itemInternalId, soSubsidiary);
                        if (!locationId) {
                            log.error("NO_LOCATION", "No location for item " + itemInternalId);
                            skippedSkus.push(sku + " (no location)");
                            continue;
                        }

                        var qty = parseInt(lineItem.quantity, 10) || 1;
                        var amt = parseFloat(lineItem.amount) || 0;
                        var rate = qty > 0 ? (amt / qty) : amt;

                        log.debug("LINE_CALC_" + i, JSON.stringify({
                            sku: sku, itemId: itemInternalId, locationId: locationId,
                            rawQty: lineItem.quantity, rawAmt: lineItem.amount,
                            parsedQty: qty, parsedAmt: amt, calcRate: rate
                        }));

                        if (amt === 0) {
                            log.audit("ZERO_AMOUNT", "SKU " + sku + " has $0 amount — may cause save error");
                        }

                        // Dynamic mode: selectNewLine → set fields → commitLine
                        so.selectNewLine({ sublistId: "item" });

                        // Item FIRST — triggers sourcing (tax engine, defaults)
                        so.setCurrentSublistValue({ sublistId: "item", fieldId: "item", value: itemInternalId });

                        // Location BEFORE quantity
                        so.setCurrentSublistValue({ sublistId: "item", fieldId: "location", value: parseInt(locationId, 10) });

                        // Quantity
                        so.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: qty });

                        // Custom price level → rate → amount
                        so.setCurrentSublistValue({ sublistId: "item", fieldId: "price", value: -1 });
                        so.setCurrentSublistValue({ sublistId: "item", fieldId: "rate", value: rate });
                        so.setCurrentSublistValue({ sublistId: "item", fieldId: "amount", value: amt });

                        // Commit — finalizes the line and lets SuiteTax process it
                        so.commitLine({ sublistId: "item" });

                        // Verify committed line (new lines append after old ones)
                        var vIdx = oldLineCount + linesAdded;
                        var vItem = so.getSublistValue({ sublistId: "item", fieldId: "item", line: vIdx });
                        var vLoc = so.getSublistValue({ sublistId: "item", fieldId: "location", line: vIdx });
                        var vQty = so.getSublistValue({ sublistId: "item", fieldId: "quantity", line: vIdx });
                        var vAmt = so.getSublistValue({ sublistId: "item", fieldId: "amount", line: vIdx });
                        log.debug("LINE_COMMITTED", JSON.stringify({
                            line: vIdx, sku: sku, id: itemInternalId,
                            qty: qty, rate: rate, amt: amt, loc: locationId,
                            v_item: vItem, v_loc: vLoc, v_qty: vQty, v_amt: vAmt
                        }));

                        linesAdded++;
                    } catch (lineErr) {
                        log.error("ITEM_SKIP", "SKU \"" + sku + "\" — " + lineErr.name + ": " + lineErr.message);
                        skippedSkus.push(sku);
                    }
                }
            }

            if (linesAdded === 0) {
                var skuList = Array.isArray(items) ? items.map(function (x) { return x.item; }).join(", ") : "none";
                var noItemsAfter = snapshotSO(so);
                return {
                    success: true, action: "no_items", otherrefnum: otherrefnum,
                    skus: skuList, skipped: skippedSkus,
                    before: before, after: noItemsAfter, diff: diffSnapshots(before, noItemsAfter)
                };
            }

            log.debug("LINES_READY", linesAdded + " lines, " + skippedSkus.length + " skipped");

            // ── Remove old lines (add-first, remove-old-after strategy) ─────
            // New lines were appended after the old ones. Old lines are at
            // indices 0..(oldLineCount-1). Remove in reverse to keep indices stable.
            if (oldLineCount > 0) {
                log.debug("REMOVING_OLD", "Removing " + oldLineCount + " old lines (indices 0.." + (oldLineCount - 1) + ")");
                for (var r = oldLineCount - 1; r >= 0; r--) {
                    so.removeLine({ sublistId: "item", line: r });
                }
                log.debug("OLD_REMOVED", "Removed " + oldLineCount + " old lines. Remaining: " + so.getLineCount({ sublistId: "item" }));
            }

            // ── Snapshot AFTER all changes (before save) ─────────────────
            var after = snapshotSO(so);
            log.debug("SNAPSHOT_AFTER", JSON.stringify(after));

            // ── Diff: what actually changed ──────────────────────────────
            var diff = diffSnapshots(before, after);
            log.debug("SNAPSHOT_DIFF", JSON.stringify(diff));

            // ── Save ────────────────────────────────────────────────────────
            log.audit("SAVING", "Attempting save for " + otherrefnum + " with " + linesAdded + " lines...");
            try {
                var savedId = so.save({ enableSourcing: true, ignoreMandatoryFields: false });
            } catch (saveErr) {
                log.error("SAVE_FAILED", JSON.stringify({
                    name: saveErr.name,
                    message: saveErr.message,
                    otherrefnum: otherrefnum,
                    linesAdded: linesAdded,
                    skippedSkus: skippedSkus
                }));
                throw saveErr;
            }
            log.audit("SUCCESS", "Order " + otherrefnum + " saved → ID: " + savedId);

            return {
                success: true,
                action: existingId ? "updated" : "created",
                otherrefnum: otherrefnum,
                internalId: savedId,
                before: before,
                after: after,
                diff: diff
            };

        } catch (e) {
            try {
                if (so) {
                    var errLineCount = so.getLineCount({ sublistId: "item" });
                    for (var el = 0; el < errLineCount; el++) {
                        var errLine = {};
                        ["item", "quantity", "rate", "amount", "location", "price"].forEach(function (f) {
                            try { errLine[f] = so.getSublistValue({ sublistId: "item", fieldId: f, line: el }); } catch (x) {}
                        });
                        log.error("FAIL_LINE_" + el, JSON.stringify(errLine));
                    }
                }
            } catch (dumpErr) {}

            // Capture after-snapshot even on failure (shows what was attempted)
            var failAfter = null;
            var failDiff = null;
            try {
                if (so) {
                    failAfter = snapshotSO(so);
                    failDiff = diffSnapshots(before, failAfter);
                }
            } catch (snapErr) {}

            log.error("ERROR", JSON.stringify({ name: e.name, message: e.message, stack: e.stack }));
            return {
                success: false, error: e.message, otherrefnum: otherrefnum,
                existingId: existingId || null, soNumber: existingSoNum || null,
                before: before || null,
                after: failAfter,
                diff: failDiff
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST — Minimal SO creation to isolate VALID_LINE_ITEM_REQD
    // Send: { "test_mode": true, "entity_id": 112, "item_id": 2451 }
    // Or:   { "test_mode": true, "entity_id": 112, "item_id": 2451, "form_id": 212 }
    // ═══════════════════════════════════════════════════════════════════════════
    function testMinimalCreate(payload) {
        var entityId = payload.entity_id;
        var itemId = payload.item_id;
        var testFormId = payload.form_id;
        var testQty = payload.quantity || 1;
        var testRate = payload.rate || 100;
        var testAmt = payload.amount || (testQty * testRate);
        var results = {};

        // Test A: NEW SO — dynamic mode with item + qty + rate + amount
        // try {
        //     log.debug("TEST_A", "NEW SO dynamic mode, entity=" + entityId + " item=" + itemId);
        //     var soA = record.create({ type: record.Type.SALES_ORDER, isDynamic: true });
        //     if (testFormId) soA.setValue({ fieldId: "customform", value: testFormId });
        //     soA.setValue({ fieldId: "entity", value: entityId });

        //     log.debug("TEST_A_HEADER", JSON.stringify({
        //         entity: soA.getValue({ fieldId: "entity" }),
        //         subsidiary: soA.getValue({ fieldId: "subsidiary" }),
        //         form: soA.getValue({ fieldId: "customform" })
        //     }));

        //     soA.selectNewLine({ sublistId: "item" });
        //     log.debug("TEST_A_SET_ITEM", "Setting item=" + itemId);
        //     soA.setCurrentSublistValue({ sublistId: "item", fieldId: "item", value: itemId });

        //     // Log what auto-populated after setting item
        //     var autoRate = "", autoAmt = "", autoQty = "", autoLoc = "", autoPrice = "";
        //     try { autoRate = soA.getCurrentSublistValue({ sublistId: "item", fieldId: "rate" }); } catch(e){}
        //     try { autoAmt = soA.getCurrentSublistValue({ sublistId: "item", fieldId: "amount" }); } catch(e){}
        //     try { autoQty = soA.getCurrentSublistValue({ sublistId: "item", fieldId: "quantity" }); } catch(e){}
        //     try { autoLoc = soA.getCurrentSublistValue({ sublistId: "item", fieldId: "location" }); } catch(e){}
        //     try { autoPrice = soA.getCurrentSublistValue({ sublistId: "item", fieldId: "price" }); } catch(e){}
        //     log.debug("TEST_A_AUTO_POPULATED", JSON.stringify({
        //         autoRate: autoRate, autoAmt: autoAmt, autoQty: autoQty, autoLoc: autoLoc, autoPrice: autoPrice
        //     }));

        //     log.debug("TEST_A_SETTING_FIELDS", JSON.stringify({ qty: testQty, rate: testRate, amt: testAmt }));
        //     soA.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: testQty });
        //     soA.setCurrentSublistValue({ sublistId: "item", fieldId: "price", value: -1 });
        //     soA.setCurrentSublistValue({ sublistId: "item", fieldId: "rate", value: testRate });
        //     soA.setCurrentSublistValue({ sublistId: "item", fieldId: "amount", value: testAmt });
        //     soA.commitLine({ sublistId: "item" });

        //     log.debug("TEST_A_LINE", JSON.stringify({
        //         lineCount: soA.getLineCount({ sublistId: "item" }),
        //         item: soA.getSublistValue({ sublistId: "item", fieldId: "item", line: 0 }),
        //         qty: soA.getSublistValue({ sublistId: "item", fieldId: "quantity", line: 0 }),
        //         amt: soA.getSublistValue({ sublistId: "item", fieldId: "amount", line: 0 })
        //     }));

        //     var idA = soA.save({ enableSourcing: true, ignoreMandatoryFields: true });
        //     log.debug("TEST_A_SUCCESS", "Saved → ID " + idA);
        //     results.testA_new_dynamic = { success: true, id: idA };
        // } catch (eA) {
        //     log.error("TEST_A_FAIL", eA.name + ": " + eA.message);
        //     results.testA_new_dynamic = { success: false, error: eA.name + ": " + eA.message };
        // }

        // // Test B: NEW SO — standard mode with item + qty + rate + amount
        // try {
        //     log.debug("TEST_B", "NEW SO standard mode, entity=" + entityId + " item=" + itemId);
        //     var soB = record.create({ type: record.Type.SALES_ORDER });
        //     if (testFormId) soB.setValue({ fieldId: "customform", value: testFormId });
        //     soB.setValue({ fieldId: "entity", value: entityId });

        //     soB.insertLine({ sublistId: "item", line: 0 });
        //     soB.setSublistValue({ sublistId: "item", fieldId: "item", line: 0, value: itemId });
        //     soB.setSublistValue({ sublistId: "item", fieldId: "quantity", line: 0, value: testQty });
        //     soB.setSublistValue({ sublistId: "item", fieldId: "price", line: 0, value: -1 });
        //     soB.setSublistValue({ sublistId: "item", fieldId: "rate", line: 0, value: testRate });
        //     soB.setSublistValue({ sublistId: "item", fieldId: "amount", line: 0, value: testAmt });

        //     var idB = soB.save({ enableSourcing: true, ignoreMandatoryFields: true });
        //     log.debug("TEST_B_SUCCESS", "Saved → ID " + idB);
        //     results.testB_new_standard = { success: true, id: idB };
        // } catch (eB) {
        //     log.error("TEST_B_FAIL", eB.name + ": " + eB.message);
        //     results.testB_new_standard = { success: false, error: eB.name + ": " + eB.message };
        // }

        // Test C: LOAD existing SO and update lines (add-first, remove-old)
        // Pass test_so_id to target a specific SO, otherwise searches for any SO
        try {
            var existingId = payload.test_so_id || null;
            if (!existingId) {
                var searchResults = search.create({
                    type: search.Type.SALES_ORDER,
                    filters: [["entity", "anyof", entityId], "AND", ["mainline", "is", "T"]],
                    columns: ["internalid"]
                }).run().getRange({ start: 0, end: 1 });
                if (searchResults.length > 0) {
                    existingId = searchResults[0].getValue("internalid");
                }
            }

            if (existingId) {
                log.debug("TEST_C", "LOAD existing SO id=" + existingId + " dynamic mode — add-first strategy");
                var soC = record.load({ type: record.Type.SALES_ORDER, id: existingId, isDynamic: true });

                // Step 1: Record how many old lines exist
                var oldLines = soC.getLineCount({ sublistId: "item" });
                log.debug("TEST_C_OLD_LINES", "Old lines: " + oldLines);

                // Step 2: Add new line FIRST (so record always has ≥1 valid line)
                soC.selectNewLine({ sublistId: "item" });
                soC.setCurrentSublistValue({ sublistId: "item", fieldId: "item", value: itemId });
                soC.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: testQty });
                soC.setCurrentSublistValue({ sublistId: "item", fieldId: "price", value: -1 });
                soC.setCurrentSublistValue({ sublistId: "item", fieldId: "rate", value: testRate });
                soC.setCurrentSublistValue({ sublistId: "item", fieldId: "amount", value: testAmt });
                soC.commitLine({ sublistId: "item" });
                log.debug("TEST_C_NEW_ADDED", "New line added. Total lines: " + soC.getLineCount({ sublistId: "item" }));

                // Step 3: Remove old lines (indices 0..oldLines-1) in reverse
                for (var cr = oldLines - 1; cr >= 0; cr--) {
                    soC.removeLine({ sublistId: "item", line: cr });
                }
                log.debug("TEST_C_OLD_REMOVED", "Removed " + oldLines + " old lines. Remaining: " + soC.getLineCount({ sublistId: "item" }));

                var idC = soC.save({ enableSourcing: true, ignoreMandatoryFields: true });
                log.debug("TEST_C_SUCCESS", "Saved → ID " + idC);
                results.testC_update_dynamic = { success: true, id: idC };
            } else {
                results.testC_update_dynamic = { skipped: true, reason: "No existing SO found" };
            }
        } catch (eC) {
            log.error("TEST_C_FAIL", eC.name + ": " + eC.message);
            results.testC_update_dynamic = { success: false, error: eC.name + ": " + eC.message };
        }

        return results;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    function findCustomer(companyName) {
        if (_customerCache[companyName]) return _customerCache[companyName];

        var col1 = search.createColumn({ name: "internalid" });
        var col2 = search.createColumn({ name: "subsidiary" });
        var results = search.create({
            type: search.Type.CUSTOMER,
            filters: [["companyname", "is", companyName]],
            columns: [col1, col2]
        }).run().getRange({ start: 0, end: 1 });

        if (results.length === 0) return null;

        var info = {
            id: parseInt(results[0].getValue(col1), 10),
            subsidiary: results[0].getValue(col2),
            subsidiaryText: results[0].getText(col2) || ""
        };
        _customerCache[companyName] = info;
        return info;
    }

    // ── Channels/Lead Source — Custom Segment: csegecomm_channel ─────────────
    // Uses getSelectOptions (dynamic mode) first, falls back to record.load
    function findLeadSource(soRecord, name) {
        if (_channelCache[name]) return _channelCache[name];

        var FIELD_ID = "csegecomm_channel";
        var recordId = null;
        var childPart = name.split(" : ").pop();

        // Attempt 1: getSelectOptions on the dynamic SO record
        try {
            var field = soRecord.getField({ fieldId: FIELD_ID });
            if (field) {
                var options = field.getSelectOptions();
                log.debug("CHANNEL_OPTIONS", "Found " + options.length + " options");
                for (var oi = 0; oi < options.length; oi++) {
                    var optText = options[oi].text;
                    var optVal = options[oi].value;
                    if (optText === name || optText === childPart ||
                        (optText && optText.indexOf(childPart) >= 0)) {
                        recordId = String(optVal);
                        log.debug("CHANNEL_MATCH", "'" + optText + "' → ID " + recordId);
                        break;
                    }
                }
            }
        } catch (e) {
            log.debug("CHANNEL_GETOPTIONS_ERR", e.message);
        }

        // Attempt 2: record.load fallback
        if (!recordId) {
            for (var rid = 1; rid <= 20; rid++) {
                try {
                    var rec = record.load({ type: "customrecord_csegecomm_channel", id: rid });
                    var recName = rec.getValue({ fieldId: "name" });
                    log.debug("LEADSOURCE_REC_" + rid, "name=" + recName);
                    if (recName === name || recName === childPart ||
                        (recName && recName.indexOf(childPart) >= 0)) {
                        recordId = String(rid);
                        log.debug("LEADSOURCE_MATCH", "'" + recName + "' → ID " + recordId);
                        break;
                    }
                } catch (e) {
                    log.debug("LEADSOURCE_REC_SKIP_" + rid, e.message);
                }
            }
        }

        if (!recordId) {
            log.error("LEADSOURCE_NOT_FOUND", "'" + name + "' not resolved");
            return { id: null, fieldId: null };
        }

        var result = { id: recordId, fieldId: FIELD_ID };
        _channelCache[name] = result;
        log.debug("LEADSOURCE_RESOLVED", "field=" + FIELD_ID + " value=" + recordId);
        return result;
    }

    function findFormId(formName) {
        if (_formCache[formName]) return _formCache[formName];

        try {
            var formCol = search.createColumn({ name: "customform" });
            var soResults = search.create({
                type: search.Type.SALES_ORDER,
                filters: [["mainline", "is", "T"]],
                columns: [formCol]
            }).run().getRange({ start: 0, end: 50 });

            for (var i = 0; i < soResults.length; i++) {
                var fId = soResults[i].getValue(formCol);
                var fName = soResults[i].getText(formCol);
                if (fName && fName.indexOf(formName) >= 0) {
                    _formCache[formName] = fId;
                    return fId;
                }
            }
        } catch (e) {
            log.debug("FORM_SEARCH_ERR", e.message);
        }

        log.audit("FORM_NOT_FOUND", "Could not find form: " + formName);
        return null;
    }

    function findLocationForItem(itemInternalId, subsidiaryId) {
        log.debug("LOC_LOOKUP", "Finding location for item=" + itemInternalId + " subsidiary=" + subsidiaryId);
        try {
            var locCol = search.createColumn({ name: "inventorylocation" });
            var locResults = search.create({
                type: search.Type.ITEM,
                filters: [["internalid", "anyof", itemInternalId]],
                columns: [locCol]
            }).run().getRange({ start: 0, end: 1 });

            if (locResults.length > 0) {
                var locId = locResults[0].getValue(locCol);
                var locText = locResults[0].getText(locCol) || "";
                log.debug("LOC_FROM_ITEM", "Item " + itemInternalId + " → location " + locId + " (" + locText + ")");
                if (locId) {
                    return locId;
                }
            } else {
                log.debug("LOC_FROM_ITEM", "No inventorylocation found for item " + itemInternalId);
            }
        } catch (e) {
            log.debug("LOC_ITEM_ERR", e.message);
        }

        if (_fallbackLocationCache[subsidiaryId]) {
            return _fallbackLocationCache[subsidiaryId];
        }

        try {
            var idCol = search.createColumn({ name: "internalid" });
            var nameCol = search.createColumn({ name: "name" });
            var subLocResults = search.create({
                type: "location",
                filters: [
                    ["subsidiary", "anyof", subsidiaryId],
                    "AND",
                    ["isinactive", "is", "F"]
                ],
                columns: [idCol, nameCol]
            }).run().getRange({ start: 0, end: 1 });

            if (subLocResults.length > 0) {
                var fallbackId = subLocResults[0].getValue(idCol);
                log.audit("LOC_FALLBACK", "Using " + subLocResults[0].getValue(nameCol) + " (ID " + fallbackId + ")");
                _fallbackLocationCache[subsidiaryId] = fallbackId;
                return fallbackId;
            }
        } catch (e) {
            log.debug("LOC_SUB_ERR", e.message);
        }

        return null;
    }

    // ── Snapshot: capture full SO state (header + lines) ─────────────────
    function snapshotSO(soRecord) {
        var snap = { header: {}, lines: [] };
        var headerFields = [
            "customform", "entity", "subsidiary", "otherrefnum", "trandate",
            "shipdate", "orderstatus", "memo", "currency",
            "custbody1", "custbody3", "csegecomm_channel"
        ];
        for (var hi = 0; hi < headerFields.length; hi++) {
            try { snap.header[headerFields[hi]] = soRecord.getValue({ fieldId: headerFields[hi] }); } catch (e) {}
        }
        var lineCount = soRecord.getLineCount({ sublistId: "item" });
        snap.header.lineCount = lineCount;
        var lineFields = ["item", "quantity", "rate", "amount", "location", "price", "description"];
        for (var li = 0; li < lineCount; li++) {
            var line = { line: li };
            for (var lf = 0; lf < lineFields.length; lf++) {
                try { line[lineFields[lf]] = soRecord.getSublistValue({ sublistId: "item", fieldId: lineFields[lf], line: li }); } catch (e) {}
            }
            snap.lines.push(line);
        }
        return snap;
    }

    // ── Diff: compare before/after snapshots ──────────────────────────────
    function diffSnapshots(before, after) {
        if (!before || !after) return null;
        var diff = { header: {}, lines: {} };
        var allKeys = Object.keys(before.header).concat(Object.keys(after.header));
        var seen = {};
        for (var ki = 0; ki < allKeys.length; ki++) {
            var k = allKeys[ki];
            if (seen[k]) continue;
            seen[k] = true;
            var bVal = before.header[k];
            var aVal = after.header[k];
            if (String(bVal) !== String(aVal)) {
                diff.header[k] = { from: bVal, to: aVal };
            }
        }
        // Line diff: simple count + content comparison
        if (before.lines.length !== after.lines.length) {
            diff.lines.countChange = { from: before.lines.length, to: after.lines.length };
        }
        diff.lines.before = before.lines;
        diff.lines.after = after.lines;
        return diff;
    }

    function findSalesOrder(otherrefnum) {
        log.debug("SO_LOOKUP", "Searching for otherrefnum=" + otherrefnum);
        var idCol = search.createColumn({ name: "internalid", sort: search.Sort.DESC });
        var refCol = search.createColumn({ name: "otherrefnum" });
        var tranCol = search.createColumn({ name: "tranid" });
        var results = search.create({
            type: search.Type.SALES_ORDER,
            filters: [["poastext", "is", otherrefnum], "AND", ["mainline", "is", "T"]],
            columns: [idCol, refCol, tranCol]
        }).run().getRange({ start: 0, end: 10 });

        if (results.length === 0) {
            log.debug("SO_LOOKUP_RESULT", "otherrefnum=" + otherrefnum + " → NOT FOUND");
            return null;
        }

        // Log ALL matches
        for (var si = 0; si < results.length; si++) {
            log.debug("SO_MATCH_" + si, JSON.stringify({
                id: results[si].getValue(idCol),
                soNumber: results[si].getValue(tranCol),
                otherrefnum: results[si].getValue(refCol)
            }));
        }

        if (results.length > 1) {
            log.audit("SO_DUPLICATES", "Found " + results.length + " SOs for PO# " + otherrefnum + " — using newest (highest ID)");
        }

        // Results sorted by internalid DESC — first result is the newest
        var found = parseInt(results[0].getValue(idCol), 10);
        var soNum = results[0].getValue(tranCol);
        log.debug("SO_LOOKUP_RESULT", "otherrefnum=" + otherrefnum + " → newest ID " + found + " (" + soNum + ")");
        return { id: found, soNumber: soNum };
    }

    return { post: post };
});
