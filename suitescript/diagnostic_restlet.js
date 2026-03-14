/**
 * DIAGNOSTIC RESTLET — Account Explorer
 *
 * Reusable tool to inspect any NetSuite account configuration.
 * Send a POST with { "sections": ["all"] } to get everything,
 * or pick specific sections:
 *
 * POST body examples:
 *   { "sections": ["all"] }                          — everything
 *   { "sections": ["account", "locations"] }         — just those
 *   { "sections": ["record_fields"], "recordType": "salesorder" }
 *   { "sections": ["item_lookup"], "sku": "29S0100" }
 *   { "sections": ["customer_lookup"], "name": "Amazon" }
 *   { "sections": ["record_sample"], "recordType": "salesorder", "limit": 5 }
 *   { "sections": ["record_sample"], "recordType": "purchaseorder", "limit": 3 }
 *   { "sections": ["item_line_test"], "sku": "29S0100" }  — dry-run: add item to SO in memory (no save)
 *
 * Available sections:
 *   account           — account ID, features (OneWorld, multi-location, etc.)
 *   subsidiaries      — all subsidiaries with IDs
 *   locations         — all locations with IDs + subsidiary
 *   departments       — all departments
 *   classes           — all classes (categories)
 *   currencies        — enabled currencies
 *   customers         — first 10 customers
 *   customer_lookup   — find customer by name (pass "name" param)
 *   vendors           — first 10 vendors
 *   items_sample      — first 10 items with key fields
 *   item_lookup       — find item by SKU (pass "sku" param)
 *   forms             — transaction forms (Sales Order, Purchase Order, etc.)
 *   record_fields     — all fields on a record type (pass "recordType" param)
 *   record_sample     — sample records of a type (pass "recordType", "limit")
 *   custom_fields     — all custbody/custcol fields on Sales Order
 *   roles             — roles in the account
 *   scripts           — deployed scripts
 *   item_line_test    — dry-run: creates SO in memory, adds one line, reports fields (no save)
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(["N/search", "N/record", "N/runtime", "N/log"], function (search, record, runtime, log) {

    function post(payload) {
        var sections = (payload && payload.sections) || ["all"];
        var isAll = sections.indexOf("all") >= 0;
        var result = { _timestamp: new Date().toISOString() };

        // ── Account Info ─────────────────────────────────────────────────
        if (isAll || sections.indexOf("account") >= 0) {
            try {
                result.account = {
                    accountId: runtime.accountId,
                    isOneWorld: runtime.isFeatureInEffect({ feature: "SUBSIDIARIES" }),
                    multiLocationInventory: runtime.isFeatureInEffect({ feature: "MULTILOCINVT" }),
                    advancedBilling: runtime.isFeatureInEffect({ feature: "BILLINGACCOUNTS" }),
                    dropShipments: runtime.isFeatureInEffect({ feature: "DROPSHIPMENTS" }),
                    multiCurrency: runtime.isFeatureInEffect({ feature: "MULTICURRENCY" }),
                    advancedRevenue: runtime.isFeatureInEffect({ feature: "ADVANCEDREVENUERECOGNITION" }),
                    serializedInventory: runtime.isFeatureInEffect({ feature: "SERIALIZEDINVENTORY" }),
                    lotNumbering: runtime.isFeatureInEffect({ feature: "LOTNUMBEREDINVENTORY" })
                };
            } catch (e) { result.account = { error: e.message }; }
        }

        // ── Subsidiaries ─────────────────────────────────────────────────
        if (isAll || sections.indexOf("subsidiaries") >= 0) {
            result.subsidiaries = runSearch("subsidiary", ["internalid", "name", "isinactive"], [], 50);
        }

        // ── Locations ────────────────────────────────────────────────────
        if (isAll || sections.indexOf("locations") >= 0) {
            result.locations = runSearchWithText("location",
                ["internalid", "name", "subsidiary", "isinactive"],
                ["subsidiary"], [], 50);
        }

        // ── Departments ──────────────────────────────────────────────────
        if (isAll || sections.indexOf("departments") >= 0) {
            result.departments = runSearch("department", ["internalid", "name", "isinactive"], [], 50);
        }

        // ── Classes ──────────────────────────────────────────────────────
        if (isAll || sections.indexOf("classes") >= 0) {
            result.classes = runSearch("classification", ["internalid", "name", "isinactive"], [], 50);
        }

        // ── Currencies ───────────────────────────────────────────────────
        if (isAll || sections.indexOf("currencies") >= 0) {
            result.currencies = runSearch("currency", ["internalid", "name", "symbol"], [], 20);
        }

        // ── Customers ────────────────────────────────────────────────────
        if (isAll || sections.indexOf("customers") >= 0) {
            result.customers = runSearchWithText(search.Type.CUSTOMER,
                ["internalid", "entityid", "companyname", "subsidiary", "email"],
                ["subsidiary"], [], 10);
        }

        // ── Customer Lookup ──────────────────────────────────────────────
        if (sections.indexOf("customer_lookup") >= 0) {
            var custName = payload.name || "Amazon";
            result.customer_lookup = runSearchWithText(search.Type.CUSTOMER,
                ["internalid", "entityid", "companyname", "subsidiary", "email", "isperson"],
                ["subsidiary"],
                [["entityid", "contains", custName]], 5);
        }

        // ── Vendors ──────────────────────────────────────────────────────
        if (isAll || sections.indexOf("vendors") >= 0) {
            result.vendors = runSearchWithText(search.Type.VENDOR,
                ["internalid", "entityid", "companyname", "subsidiary"],
                ["subsidiary"], [], 10);
        }

        // ── Items Sample ─────────────────────────────────────────────────
        if (isAll || sections.indexOf("items_sample") >= 0) {
            result.items_sample = runSearchWithText(search.Type.ITEM,
                ["internalid", "itemid", "displayname", "type", "subsidiary", "location"],
                ["subsidiary", "type", "location"], [], 10);
        }

        // ── Item Lookup ──────────────────────────────────────────────────
        if (sections.indexOf("item_lookup") >= 0) {
            var sku = payload.sku || "29S0100";
            result.item_lookup = runSearchWithText(search.Type.ITEM,
                ["internalid", "itemid", "displayname", "type", "subsidiary", "location",
                 "isserialitem", "islotitem", "baseprice", "cost"],
                ["subsidiary", "type", "location"],
                [["itemid", "is", sku]], 5);

            // Also get item's locations subrecord
            try {
                var itemLocSearch = search.create({
                    type: search.Type.ITEM,
                    filters: [["itemid", "is", sku]],
                    columns: [
                        search.createColumn({ name: "inventorylocation" }),
                        search.createColumn({ name: "locationquantityonhand" }),
                        search.createColumn({ name: "locationquantityavailable" })
                    ]
                }).run().getRange({ start: 0, end: 20 });
                result.item_locations = itemLocSearch.map(function (r) {
                    return {
                        location: r.getText("inventorylocation") || r.getValue("inventorylocation"),
                        locationId: r.getValue("inventorylocation"),
                        qtyOnHand: r.getValue("locationquantityonhand"),
                        qtyAvailable: r.getValue("locationquantityavailable")
                    };
                });
            } catch (e) { result.item_locations = "Error: " + e.message; }
        }

        // ── Transaction Forms ────────────────────────────────────────────
        if (isAll || sections.indexOf("forms") >= 0) {
            // Get forms from sample records of each type
            result.forms = {};

            // Sales Order forms
            try {
                var soForms = {};
                search.create({
                    type: search.Type.SALES_ORDER,
                    filters: [["mainline", "is", "T"]],
                    columns: ["customform"]
                }).run().each(function (r) {
                    var fId = r.getValue("customform");
                    var fName = r.getText("customform");
                    soForms[fId] = fName;
                    return Object.keys(soForms).length < 10;
                });
                result.forms.salesOrder = soForms;
            } catch (e) { result.forms.salesOrder = "Error: " + e.message; }

            // Purchase Order forms
            try {
                var poForms = {};
                search.create({
                    type: search.Type.PURCHASE_ORDER,
                    filters: [["mainline", "is", "T"]],
                    columns: ["customform"]
                }).run().each(function (r) {
                    var fId = r.getValue("customform");
                    var fName = r.getText("customform");
                    poForms[fId] = fName;
                    return Object.keys(poForms).length < 10;
                });
                result.forms.purchaseOrder = poForms;
            } catch (e) { result.forms.purchaseOrder = "Error: " + e.message; }
        }

        // ── Record Fields ────────────────────────────────────────────────
        if (sections.indexOf("record_fields") >= 0) {
            var recType = payload.recordType || "salesorder";
            try {
                var rec = record.create({ type: recType, isDynamic: false });
                var allFields = rec.getFields();
                result.record_fields = {
                    recordType: recType,
                    totalFields: allFields.length,
                    custbody: allFields.filter(function (f) { return f.indexOf("custbody") === 0; }),
                    custcol: allFields.filter(function (f) { return f.indexOf("custcol") === 0; }),
                    standard: allFields.filter(function (f) {
                        return f.indexOf("cust") !== 0 && f.indexOf("sys") !== 0;
                    })
                };
            } catch (e) { result.record_fields = { error: e.message }; }
        }

        // ── Record Sample ────────────────────────────────────────────────
        if (sections.indexOf("record_sample") >= 0) {
            var sampleType = payload.recordType || "salesorder";
            var sampleLimit = parseInt(payload.limit, 10) || 3;
            try {
                var cols = ["internalid", "tranid", "entity", "otherrefnum",
                            "customform", "subsidiary", "location", "trandate", "status"];
                var sampleResults = search.create({
                    type: sampleType,
                    filters: [["mainline", "is", "T"]],
                    columns: cols
                }).run().getRange({ start: 0, end: sampleLimit });

                result.record_sample = sampleResults.map(function (r) {
                    var row = {};
                    cols.forEach(function (c) {
                        row[c] = r.getValue(c);
                        var txt = r.getText(c);
                        if (txt && txt !== row[c]) row[c + "_text"] = txt;
                    });
                    return row;
                });
            } catch (e) { result.record_sample = { error: e.message }; }
        }

        // ── Custom Body/Column Fields ────────────────────────────────────
        if (isAll || sections.indexOf("custom_fields") >= 0) {
            try {
                var soRec = record.create({ type: record.Type.SALES_ORDER, isDynamic: false });
                var fields = soRec.getFields();
                result.custom_fields = {
                    salesOrder: {
                        custbody: fields.filter(function (f) { return f.indexOf("custbody") === 0; }),
                        custcol: fields.filter(function (f) { return f.indexOf("custcol") === 0; })
                    }
                };
            } catch (e) { result.custom_fields = { error: e.message }; }

            try {
                var poRec = record.create({ type: record.Type.PURCHASE_ORDER, isDynamic: false });
                var poFields = poRec.getFields();
                result.custom_fields.purchaseOrder = {
                    custbody: poFields.filter(function (f) { return f.indexOf("custbody") === 0; }),
                    custcol: poFields.filter(function (f) { return f.indexOf("custcol") === 0; })
                };
            } catch (e) { result.custom_fields = result.custom_fields || {}; result.custom_fields.purchaseOrder = { error: e.message }; }
        }

        // ── Scripts/Deployments ──────────────────────────────────────────
        if (isAll || sections.indexOf("scripts") >= 0) {
            try {
                var scripts = [];
                search.create({
                    type: "scriptdeployment",
                    columns: ["internalid", "script", "scriptid", "status", "title"],
                    filters: [["status", "is", "RELEASED"]]
                }).run().each(function (r) {
                    scripts.push({
                        id: r.getValue("internalid"),
                        script: r.getText("script"),
                        scriptid: r.getValue("scriptid"),
                        status: r.getValue("status"),
                        title: r.getValue("title")
                    });
                    return scripts.length < 30;
                });
                result.scripts = scripts;
            } catch (e) { result.scripts = "Error: " + e.message; }
        }

        // ── Item Line Test (dry-run — NO save) ────────────────────────────
        if (sections.indexOf("item_line_test") >= 0) {
            var testSku = payload.sku || "29S0100";
            result.item_line_test = {};
            try {
                // Find item by SKU
                var testItemCol = search.createColumn({ name: "internalid" });
                var testTypeCol = search.createColumn({ name: "type" });
                var testItemRes = search.create({
                    type: search.Type.ITEM,
                    filters: [["itemid", "is", testSku]],
                    columns: [testItemCol, testTypeCol]
                }).run().getRange({ start: 0, end: 1 });

                if (!testItemRes || testItemRes.length === 0) {
                    result.item_line_test = { error: "SKU not found: " + testSku };
                } else {
                    var testItemId = parseInt(testItemRes[0].getValue(testItemCol), 10);
                    var testItemType = testItemRes[0].getValue(testTypeCol);
                    result.item_line_test.item = { id: testItemId, type: testItemType };

                    // Find customer Amazon
                    var testCustCol = search.createColumn({ name: "internalid" });
                    var testCustRes = search.create({
                        type: search.Type.CUSTOMER,
                        filters: [["entityid", "is", "Amazon"]],
                        columns: [testCustCol]
                    }).run().getRange({ start: 0, end: 1 });

                    if (!testCustRes || testCustRes.length === 0) {
                        result.item_line_test.error = "Amazon customer not found";
                    } else {
                        var testCustId = parseInt(testCustRes[0].getValue(testCustCol), 10);
                        result.item_line_test.customer = { id: testCustId };

                        // Create SO in memory (NO SAVE)
                        var testSo = record.create({ type: record.Type.SALES_ORDER, isDynamic: true });
                        testSo.setValue({ fieldId: "entity", value: testCustId });

                        result.item_line_test.header = {
                            entity: testSo.getValue({ fieldId: "entity" }),
                            subsidiary: testSo.getValue({ fieldId: "subsidiary" }),
                            customform: testSo.getValue({ fieldId: "customform" })
                        };
                        try { result.item_line_test.header.currency = testSo.getValue({ fieldId: "currency" }); } catch (e) {}

                        // Clear any default lines
                        var testPreLines = testSo.getLineCount({ sublistId: "item" });
                        for (var tl = testPreLines - 1; tl >= 0; tl--) {
                            testSo.removeLine({ sublistId: "item", line: tl });
                        }
                        result.item_line_test.preLines = testPreLines;

                        // Add the test line item
                        testSo.selectNewLine({ sublistId: "item" });
                        testSo.setCurrentSublistValue({
                            sublistId: "item", fieldId: "item",
                            value: testItemId, ignoreFieldChange: false
                        });

                        // Read back ALL sourced fields after setting item
                        var sourcedFields = {};
                        var fieldsToCheck = ["item", "quantity", "rate", "amount", "price",
                            "location", "taxcode", "units", "description", "inventorydetail"];
                        for (var fi = 0; fi < fieldsToCheck.length; fi++) {
                            try {
                                sourcedFields[fieldsToCheck[fi]] = testSo.getCurrentSublistValue({
                                    sublistId: "item", fieldId: fieldsToCheck[fi]
                                });
                            } catch (e) {
                                sourcedFields[fieldsToCheck[fi]] = "ERR: " + e.message;
                            }
                        }
                        result.item_line_test.afterItemSet = sourcedFields;

                        // Now set location, qty, price, rate and try to commit
                        try {
                            // Find a location for this subsidiary
                            var testLocRes = search.create({
                                type: "location",
                                filters: [
                                    ["subsidiary", "anyof", testSo.getValue({ fieldId: "subsidiary" })],
                                    "AND",
                                    ["isinactive", "is", "F"]
                                ],
                                columns: [
                                    search.createColumn({ name: "internalid" }),
                                    search.createColumn({ name: "name" })
                                ]
                            }).run().getRange({ start: 0, end: 5 });

                            result.item_line_test.availableLocations = testLocRes.map(function (r) {
                                return { id: r.getValue("internalid"), name: r.getValue("name") };
                            });

                            if (testLocRes.length > 0) {
                                var testLocId = parseInt(testLocRes[0].getValue("internalid"), 10);
                                testSo.setCurrentSublistValue({
                                    sublistId: "item", fieldId: "location",
                                    value: testLocId, ignoreFieldChange: false
                                });
                            }
                        } catch (locE) {
                            result.item_line_test.locationError = locE.message;
                        }

                        testSo.setCurrentSublistValue({
                            sublistId: "item", fieldId: "quantity",
                            value: 1, ignoreFieldChange: false
                        });

                        try {
                            testSo.setCurrentSublistValue({
                                sublistId: "item", fieldId: "price",
                                value: -1, ignoreFieldChange: false
                            });
                        } catch (priceE) {
                            result.item_line_test.priceError = priceE.message;
                        }

                        testSo.setCurrentSublistValue({
                            sublistId: "item", fieldId: "rate",
                            value: 10.00, ignoreFieldChange: false
                        });

                        // Read back all fields before commit
                        var preCommitFields = {};
                        for (var pci = 0; pci < fieldsToCheck.length; pci++) {
                            try {
                                preCommitFields[fieldsToCheck[pci]] = testSo.getCurrentSublistValue({
                                    sublistId: "item", fieldId: fieldsToCheck[pci]
                                });
                            } catch (e) {
                                preCommitFields[fieldsToCheck[pci]] = "ERR: " + e.message;
                            }
                        }
                        result.item_line_test.preCommit = preCommitFields;

                        // Try commitLine
                        try {
                            testSo.commitLine({ sublistId: "item" });
                            result.item_line_test.commitResult = "SUCCESS";
                            result.item_line_test.lineCountAfterCommit = testSo.getLineCount({ sublistId: "item" });

                            // Read committed line
                            var committed = {};
                            for (var ci = 0; ci < fieldsToCheck.length; ci++) {
                                try {
                                    committed[fieldsToCheck[ci]] = testSo.getSublistValue({
                                        sublistId: "item", fieldId: fieldsToCheck[ci], line: 0
                                    });
                                } catch (e) {}
                            }
                            result.item_line_test.committedLine = committed;
                        } catch (commitE) {
                            result.item_line_test.commitResult = "FAILED: " + commitE.message;
                        }

                        // DO NOT SAVE — this is a dry-run
                        result.item_line_test.saved = false;
                    }
                }
            } catch (e) {
                result.item_line_test.error = e.name + ": " + e.message;
            }
        }

        // ── Roles ────────────────────────────────────────────────────────
        if (sections.indexOf("roles") >= 0) {
            try {
                result.roles = [];
                search.create({
                    type: "role",
                    columns: ["internalid", "name"]
                }).run().each(function (r) {
                    result.roles.push({ id: r.getValue("internalid"), name: r.getValue("name") });
                    return result.roles.length < 30;
                });
            } catch (e) { result.roles = "Error: " + e.message; }
        }

        // ── SO by PO# — find duplicate PO #s (count > 1) ─────────────────
        // POST: { "sections": ["so_by_po"] }
        // Uses poastext filter approach: fetches all SOs, groups by PO #, returns only duplicates
        if (sections.indexOf("so_by_po") >= 0) {
            try {
                var bpIdCol = search.createColumn({ name: "internalid" });
                var bpTranCol = search.createColumn({ name: "tranid" });
                var bpPoCol = search.createColumn({ name: "otherrefnum" });
                var bpDateCol = search.createColumn({ name: "trandate" });
                var bpStatusCol = search.createColumn({ name: "status" });

                var bpSearch = search.create({
                    type: search.Type.SALES_ORDER,
                    filters: [
                        ["mainline", "is", "T"],
                        "AND",
                        ["poastext", "isnotempty", ""]
                    ],
                    columns: [bpIdCol, bpTranCol, bpPoCol, bpDateCol, bpStatusCol]
                });

                var bpMap = {};
                var bpPagedData = bpSearch.runPaged({ pageSize: 1000 });
                bpPagedData.pageRanges.forEach(function (pageRange) {
                    bpPagedData.fetch({ index: pageRange.index }).data.forEach(function (r) {
                        var poVal = r.getValue(bpPoCol) || "(empty)";
                        var soEntry = {
                            id: r.getValue(bpIdCol),
                            soNumber: r.getValue(bpTranCol),
                            date: r.getValue(bpDateCol),
                            status: r.getText(bpStatusCol)
                        };
                        if (!bpMap[poVal]) bpMap[poVal] = [];
                        bpMap[poVal].push(soEntry);
                    });
                });

                result.so_by_po = Object.keys(bpMap).map(function (po) {
                    return { po: po, count: bpMap[po].length, sales_orders: bpMap[po] };
                }).filter(function (entry) { return entry.count > 1; });
            } catch (e) { result.so_by_po = "Error: " + e.message; }
        }

        // ── SO Lookup by PO # ───────────────────────────────────────────
        // POST: { "sections": ["so_lookup"], "po": "114-4569256-4348216" }
        if (sections.indexOf("so_lookup") >= 0) {
            var lookupPo = payload.po || "";
            if (!lookupPo) {
                result.so_lookup = { error: "Missing 'po' parameter" };
            } else {
                try {
                    var lkIdCol = search.createColumn({ name: "internalid" });
                    var lkTranCol = search.createColumn({ name: "tranid" });
                    var lkDateCol = search.createColumn({ name: "trandate" });
                    var lkStatusCol = search.createColumn({ name: "status" });
                    var lkFormCol = search.createColumn({ name: "customform" });
                    var lkEntityCol = search.createColumn({ name: "entity" });

                    var lkResults = search.create({
                        type: search.Type.SALES_ORDER,
                        filters: [
                            ["poastext", "is", lookupPo],
                            "AND",
                            ["mainline", "is", "T"]
                        ],
                        columns: [lkIdCol, lkTranCol, lkDateCol, lkStatusCol, lkFormCol, lkEntityCol]
                    }).run().getRange({ start: 0, end: 10 });

                    result.so_lookup = {
                        po: lookupPo,
                        count: lkResults.length,
                        sales_orders: lkResults.map(function (r) {
                            return {
                                id: r.getValue(lkIdCol),
                                soNumber: r.getValue(lkTranCol),
                                date: r.getValue(lkDateCol),
                                status: r.getText(lkStatusCol),
                                form: r.getText(lkFormCol),
                                customer: r.getText(lkEntityCol)
                            };
                        })
                    };
                } catch (e) { result.so_lookup = { error: e.message }; }
            }
        }

        log.audit("DIAGNOSTIC", "Sections: " + sections.join(", "));
        return result;
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function runSearch(type, colNames, filters, limit) {
        try {
            var rows = [];
            var colObjs = colNames.map(function (n) { return search.createColumn({ name: n }); });
            search.create({ type: type, columns: colObjs, filters: filters })
                .run().each(function (r) {
                    var row = {};
                    for (var i = 0; i < colObjs.length; i++) {
                        row[colNames[i]] = r.getValue(colObjs[i]);
                    }
                    rows.push(row);
                    return rows.length < limit;
                });
            return rows;
        } catch (e) { return "Error: " + e.message; }
    }

    function runSearchWithText(type, colNames, textColumns, filters, limit) {
        try {
            var rows = [];
            var colObjs = colNames.map(function (n) { return search.createColumn({ name: n }); });
            search.create({ type: type, columns: colObjs, filters: filters })
                .run().each(function (r) {
                    var row = {};
                    for (var i = 0; i < colObjs.length; i++) {
                        row[colNames[i]] = r.getValue(colObjs[i]);
                        if (textColumns.indexOf(colNames[i]) >= 0) {
                            var txt = r.getText(colObjs[i]);
                            if (txt) row[colNames[i] + "_text"] = txt;
                        }
                    }
                    rows.push(row);
                    return rows.length < limit;
                });
            return rows;
        } catch (e) { return "Error: " + e.message; }
    }

    return { post: post };
});
