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
 *   po_audit          — PO number stats: total, missing, duplicates, recent 10
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(["N/search", "N/record", "N/runtime", "N/log", "N/query", "N/task", "N/file"], function (search, record, runtime, log, query, task, file) {

    function post(payload) {
        log.debug("DIAGNOSTIC_ENTRY", "Payload received: " + JSON.stringify(payload));
        var sections = (payload && payload.sections) || ["all"];
        var isAll = sections.indexOf("all") >= 0;
        log.debug("DIAGNOSTIC_SECTIONS", "Sections: " + JSON.stringify(sections) + ", isAll: " + isAll);
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

        // ── Delete Sales Orders (Pending Fulfillment only) ────────────────
        // POST: { "sections": ["delete_all_so"] }                              → dry-run (count only)
        // POST: { "sections": ["delete_all_so"], "confirm": true }             → delete batch of 200
        // POST: { "sections": ["delete_all_so"], "confirm": true, "batch_size": 500 }
        // Only deletes SOs with status = "Pending Fulfillment" (SalesOrd:B).
        // Governance: record.delete = 20 units. RESTlet cap = 10,000 units.
        // Max ~500 deletes per call. Call repeatedly until remaining = 0.
        if (sections.indexOf("delete_all_so") >= 0) {
            var delFilters = [
                ["mainline", "is", "T"],
                "AND",
                ["status", "anyof", "SalesOrd:B"]
            ];

            if (!payload.confirm) {
                // Dry-run: just count how many matching SOs exist
                try {
                    var countSearch = search.create({
                        type: search.Type.SALES_ORDER,
                        filters: delFilters,
                        columns: [search.createColumn({ name: "internalid" })]
                    });
                    var totalCount = 0;
                    countSearch.runPaged({ pageSize: 1000 }).pageRanges.forEach(function (pr) {
                        totalCount += countSearch.runPaged({ pageSize: 1000 }).fetch({ index: pr.index }).data.length;
                    });
                    result.delete_all_so = {
                        mode: "dry_run",
                        status_filter: "Pending Fulfillment",
                        total_sales_orders: totalCount,
                        message: "Pass { \"confirm\": true } to actually delete. Will delete in batches."
                    };
                } catch (e) { result.delete_all_so = { error: e.message }; }
            } else {
                // Actual delete
                var batchSize = parseInt(payload.batch_size, 10) || 200;
                if (batchSize > 500) batchSize = 500; // governance safety cap
                try {
                    var delIdCol = search.createColumn({ name: "internalid" });
                    var delTranCol = search.createColumn({ name: "tranid" });
                    var delPoCol = search.createColumn({ name: "otherrefnum" });
                    var delStatusCol = search.createColumn({ name: "status" });

                    var delResults = search.create({
                        type: search.Type.SALES_ORDER,
                        filters: delFilters,
                        columns: [delIdCol, delTranCol, delPoCol, delStatusCol]
                    }).run().getRange({ start: 0, end: batchSize });

                    var deleted = [];
                    var failed = [];

                    for (var di = 0; di < delResults.length; di++) {
                        var delId = delResults[di].getValue(delIdCol);
                        var delTran = delResults[di].getValue(delTranCol);
                        var delPo = delResults[di].getValue(delPoCol);
                        try {
                            record.delete({ type: record.Type.SALES_ORDER, id: parseInt(delId, 10) });
                            deleted.push({ id: delId, soNumber: delTran, po: delPo });
                            log.audit("SO_DELETED", "Deleted SO ID " + delId + " (" + delTran + ")");
                        } catch (delErr) {
                            failed.push({ id: delId, soNumber: delTran, po: delPo, error: delErr.message });
                            log.error("SO_DELETE_FAIL", "ID " + delId + " — " + delErr.message);
                        }
                    }

                    // Check how many matching SOs remain
                    var remaining = 0;
                    try {
                        remaining = search.create({
                            type: search.Type.SALES_ORDER,
                            filters: delFilters,
                            columns: [search.createColumn({ name: "internalid" })]
                        }).runPaged({ pageSize: 1000 }).count;
                    } catch (e) {}

                    result.delete_all_so = {
                        mode: "executed",
                        status_filter: "Pending Fulfillment",
                        batch_size: batchSize,
                        found_in_batch: delResults.length,
                        deleted_count: deleted.length,
                        failed_count: failed.length,
                        remaining: remaining,
                        deleted: deleted,
                        failed: failed.length > 0 ? failed : undefined,
                        done: remaining === 0,
                        message: remaining > 0 ? "Call again — " + remaining + " Pending Fulfillment SOs remaining." : "All Pending Fulfillment Sales Orders deleted."
                    };
                } catch (e) { result.delete_all_so = { error: e.message }; }
            }
        }

        // ── Fetch All Purchase Orders (paginated, with line items) ────────────
        // POST: { "sections": ["fetch_all_po"], "page": 0, "pageSize": 200 }
        // Returns PO headers + their line items per page.
        // Call repeatedly incrementing page until done === true.
        if (sections.indexOf("fetch_all_po") >= 0) {
            var fapPage = parseInt(payload.page, 10) || 0;
            var fapPageSize = parseInt(payload.pageSize, 10) || 200;
            if (fapPageSize > 1000) fapPageSize = 1000;

            try {
                // ── Step 1: PO headers (mainline=T) ──────────────────────────
                var fapHeaderNames = [
                    "internalid", "tranid", "otherrefnum", "entity",
                    "trandate", "status", "memo", "customform", "subsidiary"
                ];
                var fapCustomBodyNames = ["custbody1", "custbody2"];
                var fapTextCols = ["entity", "status", "customform", "subsidiary"];

                var fapAllHeaderNames = fapHeaderNames;
                var fapHasCustom = true;

                // Try adding custom body fields
                try {
                    var testCols = fapHeaderNames.concat(fapCustomBodyNames).map(function (n) {
                        return search.createColumn({ name: n });
                    });
                    search.create({
                        type: search.Type.PURCHASE_ORDER,
                        filters: [["mainline", "is", "T"]],
                        columns: testCols
                    }).run().getRange({ start: 0, end: 1 });
                    fapAllHeaderNames = fapHeaderNames.concat(fapCustomBodyNames);
                } catch (cbErr) {
                    log.audit("FAP_FALLBACK", "Custom body fields unavailable: " + cbErr.message);
                    fapHasCustom = false;
                }

                var fapHeaderCols = fapAllHeaderNames.map(function (n) {
                    return search.createColumn({ name: n });
                });

                var fapHeaderSearch = search.create({
                    type: search.Type.PURCHASE_ORDER,
                    filters: [["mainline", "is", "T"]],
                    columns: fapHeaderCols
                });

                var fapPaged = fapHeaderSearch.runPaged({ pageSize: fapPageSize });
                var fapTotal = fapPaged.count;
                var fapTotalPages = fapPaged.pageRanges.length;

                if (fapTotal === 0 || fapPage >= fapTotalPages) {
                    result.fetch_all_po = {
                        page: fapPage, pageSize: fapPageSize,
                        total: fapTotal, totalPages: fapTotalPages,
                        count: 0, purchase_orders: [], done: true,
                        hasCustomFields: fapHasCustom
                    };
                } else {
                    var fapHeaders = [];
                    var fapPoIds = [];
                    var fapPageData = fapPaged.fetch({ index: fapPage });

                    fapPageData.data.forEach(function (r) {
                        var po = {};
                        for (var fi = 0; fi < fapAllHeaderNames.length; fi++) {
                            try {
                                po[fapAllHeaderNames[fi]] = r.getValue(fapHeaderCols[fi]);
                                if (fapTextCols.indexOf(fapAllHeaderNames[fi]) >= 0) {
                                    var ftxt = r.getText(fapHeaderCols[fi]);
                                    if (ftxt) po[fapAllHeaderNames[fi] + "_text"] = ftxt;
                                }
                            } catch (fErr) {
                                po[fapAllHeaderNames[fi]] = null;
                            }
                        }
                        po.line_items = [];
                        fapHeaders.push(po);
                        fapPoIds.push(r.getValue("internalid"));
                    });

                    // ── Step 2: Line items for these POs (mainline=F) ────────
                    if (fapPoIds.length > 0) {
                        try {
                            var fapLineNames = ["internalid", "item", "quantity", "rate", "amount"];
                            var fapLineTextCols = ["item"];
                            var fapLineCols = fapLineNames.map(function (n) {
                                return search.createColumn({ name: n });
                            });

                            var fapLineSearch = search.create({
                                type: search.Type.PURCHASE_ORDER,
                                filters: [
                                    ["mainline", "is", "F"],
                                    "AND",
                                    ["internalid", "anyof", fapPoIds],
                                    "AND",
                                    ["item.type", "noneof", "@NONE@"]
                                ],
                                columns: fapLineCols
                            });

                            // Build a map: poId → [lines]
                            var fapLineMap = {};
                            var fapLinePagedData = fapLineSearch.runPaged({ pageSize: 1000 });
                            fapLinePagedData.pageRanges.forEach(function (pr) {
                                fapLinePagedData.fetch({ index: pr.index }).data.forEach(function (lr) {
                                    var poId = lr.getValue("internalid");
                                    var line = {};
                                    for (var li = 0; li < fapLineNames.length; li++) {
                                        try {
                                            line[fapLineNames[li]] = lr.getValue(fapLineCols[li]);
                                            if (fapLineTextCols.indexOf(fapLineNames[li]) >= 0) {
                                                var ltxt = lr.getText(fapLineCols[li]);
                                                if (ltxt) line[fapLineNames[li] + "_text"] = ltxt;
                                            }
                                        } catch (le) {
                                            line[fapLineNames[li]] = null;
                                        }
                                    }
                                    if (!fapLineMap[poId]) fapLineMap[poId] = [];
                                    fapLineMap[poId].push(line);
                                });
                            });

                            // Attach lines to their PO headers
                            for (var pi = 0; pi < fapHeaders.length; pi++) {
                                var hdrId = fapHeaders[pi].internalid;
                                fapHeaders[pi].line_items = fapLineMap[hdrId] || [];
                            }
                        } catch (lineErr) {
                            log.error("FAP_LINE_ERR", lineErr.message);
                            // Headers still returned, just without lines
                        }
                    }

                    result.fetch_all_po = {
                        page: fapPage, pageSize: fapPageSize,
                        total: fapTotal, totalPages: fapTotalPages,
                        count: fapHeaders.length,
                        purchase_orders: fapHeaders,
                        done: fapPage >= fapTotalPages - 1,
                        hasCustomFields: fapHasCustom
                    };
                }
            } catch (e) {
                result.fetch_all_po = { error: e.message };
            }
        }

        // ── Fetch All Items (paginated) ─────────────────────────────────────
        // POST: { "sections": ["fetch_all_items"], "page": 0, "pageSize": 500 }
        // Returns all active items with core + custom fields, paginated.
        // Call repeatedly incrementing page until done === true.
        if (sections.indexOf("fetch_all_items") >= 0) {
            var faiPage = parseInt(payload.page, 10) || 0;
            var faiPageSize = parseInt(payload.pageSize, 10) || 500;
            if (faiPageSize > 1000) faiPageSize = 1000;

            try {
                var faiCoreNames = [
                    "internalid", "itemid", "displayname", "upccode",
                    "type", "baseprice", "cost", "vendor", "class"
                ];
                var faiCustomNames = [
                    "custitem1", "custitem2", "custitem3", "custitem17",
                    "custitem36", "custitem38", "custitem39", "custitem40",
                    "custitem22", "custitem23", "custitem24", "custitem25",
                    "custitem27", "custitem28",
                    "custitem29", "custitem30", "custitem31", "custitem32",
                    "custitem33", "custitem34", "custitem35",
                    "custitem18", "custitem19", "custitem20", "custitem21"
                ];
                var faiTextCols = ["type", "vendor", "class"];

                // Try all columns; fall back to core-only if custom fields fail
                var faiColNames;
                var faiHasCustom = true;
                var faiColumns;

                try {
                    faiColNames = faiCoreNames.concat(faiCustomNames);
                    faiColumns = faiColNames.map(function (n) { return search.createColumn({ name: n }); });
                    // Test the search to confirm columns are valid
                    search.create({
                        type: search.Type.ITEM,
                        filters: [["isinactive", "is", "F"]],
                        columns: faiColumns
                    }).run().getRange({ start: 0, end: 1 });
                } catch (colErr) {
                    log.audit("FAI_FALLBACK", "Custom fields unavailable: " + colErr.message);
                    faiHasCustom = false;
                    faiColNames = faiCoreNames;
                    faiColumns = faiColNames.map(function (n) { return search.createColumn({ name: n }); });
                }

                var faiSearch = search.create({
                    type: search.Type.ITEM,
                    filters: [["isinactive", "is", "F"]],
                    columns: faiColumns
                });

                var faiPaged = faiSearch.runPaged({ pageSize: faiPageSize });
                var faiTotal = faiPaged.count;
                var faiTotalPages = faiPaged.pageRanges.length;

                if (faiTotal === 0 || faiPage >= faiTotalPages) {
                    result.fetch_all_items = {
                        page: faiPage, pageSize: faiPageSize,
                        total: faiTotal, totalPages: faiTotalPages,
                        count: 0, items: [], done: true,
                        hasCustomFields: faiHasCustom
                    };
                } else {
                    var faiItems = [];
                    var faiPageData = faiPaged.fetch({ index: faiPage });

                    faiPageData.data.forEach(function (r) {
                        var item = {};
                        for (var fi = 0; fi < faiColNames.length; fi++) {
                            try {
                                item[faiColNames[fi]] = r.getValue(faiColumns[fi]);
                                if (faiTextCols.indexOf(faiColNames[fi]) >= 0) {
                                    var ftxt = r.getText(faiColumns[fi]);
                                    if (ftxt) item[faiColNames[fi] + "_text"] = ftxt;
                                }
                            } catch (fErr) {
                                item[faiColNames[fi]] = null;
                            }
                        }
                        faiItems.push(item);
                    });

                    result.fetch_all_items = {
                        page: faiPage, pageSize: faiPageSize,
                        total: faiTotal, totalPages: faiTotalPages,
                        count: faiItems.length, items: faiItems,
                        done: faiPage >= faiTotalPages - 1,
                        hasCustomFields: faiHasCustom
                    };
                }
            } catch (e) {
                result.fetch_all_items = { error: e.message };
            }
        }

        // ── Fetch All Items FULL (raw NetSuite field names, expanded) ──────────
        // POST: { "sections": ["fetch_all_items_full"], "page": 0, "pageSize": 500 }
        // Returns ALL available fields with original NetSuite field IDs.
        // Includes: Primary Info, Item Detail, Item/Cost Detail, Manufacturing,
        //           TD Synnex, D&H, Ingram Micro, Distribution Mgmt, NewAge tabs
        if (sections.indexOf("fetch_all_items_full") >= 0) {
            var fifPage = parseInt(payload.page, 10) || 0;
            var fifPageSize = parseInt(payload.pageSize, 10) || 500;
            if (fifPageSize > 1000) fifPageSize = 1000;

            try {
                // ── Key format: "human_readable-internal_id" ──
                // Standard fields: key = internal ID (already readable)
                // Custom fields:   key = "description-custitemN" so you get both meaning + ID in one key
                var fifFieldMap = {
                    // Primary Information
                    "internalid": "internalid",
                    "externalid": "externalid",
                    "itemid": "itemid",
                    "displayname": "displayname",
                    "vendorname": "vendorname",
                    "parent": "parent",
                    "subsidiary": "subsidiary",
                    "class": "class",
                    "includechildren": "includechildren",
                    "department": "department",
                    "location": "location",

                    // Item Detail
                    "unitstype": "unitstype",
                    "baseunit": "baseunit",
                    "upccode": "upccode",
                    "stockunit": "stockunit",
                    "purchaseunit": "purchaseunit",
                    "saleunit": "saleunit",
                    "isserialitem": "isserialitem",
                    "islotitem": "islotitem",

                    // Item/Cost Detail
                    "baseprice": "baseprice",
                    "cost": "cost",
                    "averagecost": "averagecost",
                    "lastpurchaseprice": "lastpurchaseprice",
                    "purchasedescription": "purchasedescription",
                    "salesdescription": "salesdescription",
                    "costingmethod": "costingmethod",
                    "totalquantityonhand": "totalquantityonhand",
                    "totalvalue": "totalvalue",
                    "isdropshipitem": "isdropshipitem",
                    "isspecialorderitem": "isspecialorderitem",
                    "matchbilltoreceipt": "matchbilltoreceipt",
                    "stockdescription": "stockdescription",
                    "tracklandedcost": "tracklandedcost",
                    "costestimatetype": "costestimatetype",

                    // Accounts
                    "incomeaccount": "incomeaccount",
                    "cogsaccount": "cogsaccount",
                    "assetaccount": "assetaccount",
                    "taxschedule": "taxschedule",

                    // Manufacturing
                    "manufacturer": "manufacturer",
                    "mpn": "mpn",
                    "countryofmanufacture": "countryofmanufacture",

                    // Supply Planning
                    "preferredlocation": "preferredlocation",
                    "reorderpoint": "reorderpoint",
                    "safetystocklevel": "safetystocklevel",
                    "leadtime": "leadtime",
                    "seasonaldemand": "seasonaldemand",
                    "demandmodifier": "demandmodifier",

                    // Shipping
                    "weight": "weight",
                    "weightunit": "weightunit",
                    "shipindividually": "shipindividually",

                    // General
                    "type": "type",
                    "isinactive": "isinactive",
                    "created": "created",
                    "lastmodifieddate": "lastmodifieddate",

                    // Inventory
                    "quantityonhand": "quantityonhand",
                    "quantityavailable": "quantityavailable",
                    "quantityonorder": "quantityonorder",
                    "quantitycommitted": "quantitycommitted",
                    "inventorylocation": "inventorylocation",

                    // ── Item/Cost Detail — custom fields ──
                    "condition-custitem1":          "custitem1",
                    "brand-custitem2":              "custitem2",
                    "map_price-custitem3":          "custitem3",
                    "current_map_price-custitem4":  "custitem4",
                    "cmap_exp_date-custitem5":      "custitem5",
                    "minimum_price-custitem6":      "custitem6",
                    "maximum_price-custitem7":      "custitem7",
                    "vir_primary-custitem8":        "custitem8",
                    "vir_growth-custitem9":         "custitem9",
                    "vir_other-custitem10":         "custitem10",
                    "image_url_1-custitem11":       "custitem11",
                    "image_url_2-custitem12":       "custitem12",
                    "image_url_3-custitem13":       "custitem13",
                    "image_url_4-custitem14":       "custitem14",
                    "screen_size-custitem15":       "custitem15",
                    "item_type_custom-custitem16":  "custitem16",

                    // ── TD Synnex tab ──
                    "synnex_total_inventory-custitem17":  "custitem17",
                    "synnex_sku-custitem36":              "custitem36",
                    "synnex_romeoville_il-custitem22":    "custitem22",
                    "synnex_suwanee_ga-custitem23":       "custitem23",
                    "synnex_southaven_ms-custitem24":     "custitem24",
                    "synnex_swedesboro_nj-custitem25":    "custitem25",
                    "synnex_fort_worth_tx-custitem27":    "custitem27",
                    "synnex_chino_ca-custitem28":         "custitem28",

                    // ── D&H tab ──
                    "dh_sku-custitem38":           "custitem38",
                    "dh_harrisburg_pa-custitem29": "custitem29",
                    "dh_california-custitem30":    "custitem30",
                    "dh_chicago_il-custitem31":    "custitem31",
                    "dh_atlanta_ga-custitem32":    "custitem32",

                    // ── Ingram Micro tab ──
                    "ingram_sku-custitem40":             "custitem40",
                    "ingram_mira_loma_ca-custitem33":    "custitem33",
                    "ingram_carol_stream_il-custitem34": "custitem34",
                    "ingram_hazelton_pa-custitem35":     "custitem35",

                    // ── Distribution Management (Supplies) tab ──
                    "dm_sku-custitem39":  "custitem39",
                    "dm_ca-custitem18":   "custitem18",
                    "dm_tx-custitem19":   "custitem19",
                    "dm_pa-custitem20":   "custitem20",
                    "dm_mo-custitem21":   "custitem21",

                    // ── NewAge tab ──
                    "newage_sku-custitem37":           "custitem37",
                    "newage_miami_fl-custitem41":      "custitem41",
                    "newage_columbus_oh-custitem42":   "custitem42",
                    "newage_romeoville_il-custitem43": "custitem43",
                    "newage_suwanee_ga-custitem44":    "custitem44",
                    "newage_southaven_ms-custitem45":  "custitem45",
                    "newage_swedesboro_nj-custitem46": "custitem46",
                    "newage_fort_worth_tx-custitem47": "custitem47",
                    "newage_chino_ca-custitem48":      "custitem48",

                    // ── EBP / FarApp custom ──
                    "ebp_tag-custitem_ebp_tag":                          "custitem_ebp_tag",
                    "atlas_item_image-custitem_atlas_item_image":        "custitem_atlas_item_image",
                    "custom_uom-custitem_cust_uom":                      "custitem_cust_uom",
                    "amz_category-custitem_fa_amz_category":             "custitem_fa_amz_category",
                    "shopify_flag-custitem_fa_shopify_flag":              "custitem_fa_shopify_flag",
                    "amz_prod_type-custitem_fa_amz_prod_type":           "custitem_fa_amz_prod_type",
                    "amz_item_type-custitem_fa_amz_item_type":           "custitem_fa_amz_item_type",
                    "order_delay_count-custitem_order_delay_count":       "custitem_order_delay_count",
                    "supply_allocation_count-custitem_supply_allocation_count": "custitem_supply_allocation_count",
                    "supply_planning_count-custitem_supply_planning_count":     "custitem_supply_planning_count",
                    "last_posted_to_farapp-custitemlastpostedtofarapp":         "custitemlastpostedtofarapp"
                };

                // Derive parallel arrays: human-readable keys + internal NetSuite field IDs
                var fifKeyNames = Object.keys(fifFieldMap);           // ["internalid", ..., "synnex_sku", ...]
                var fifColNames = fifKeyNames.map(function (k) { return fifFieldMap[k]; }); // ["internalid", ..., "custitem36", ...]

                // Columns to also get getText() for (returns label instead of ID)
                // Uses INTERNAL field IDs (what NetSuite search expects)
                var fifTextCols = [
                    "type", "vendor", "class", "subsidiary", "parent",
                    "department", "location",
                    "unitstype", "baseunit", "stockunit", "purchaseunit", "saleunit",
                    "costingmethod", "costestimatetype",
                    "inventorylocation", "manufacturer",
                    "incomeaccount", "cogsaccount", "assetaccount", "taxschedule",
                    "preferredlocation", "weightunit",
                    "custitem1", "custitem2", "custitem_ebp_tag",
                    "custitem_fa_amz_category", "custitem_fa_amz_prod_type", "custitem_fa_amz_item_type"
                ];

                // Build columns — try full set first; if it fails, test each column
                // individually. search.createColumn() does NOT throw for invalid
                // fields — the error only surfaces at run() time.
                var fifColumns = [];
                var fifActiveKeys = [];   // human-readable keys for active columns
                var fifActiveCols = [];   // internal field IDs for active columns
                var fifFailed = [];

                // Attempt 1: try all columns at once (fast path)
                var fifAllCols = fifColNames.map(function (n) { return search.createColumn({ name: n }); });
                var fifNeedProbe = false;
                try {
                    search.create({
                        type: search.Type.ITEM,
                        filters: [["isinactive", "is", "F"]],
                        columns: fifAllCols
                    }).run().getRange({ start: 0, end: 1 });
                    // All columns valid
                    fifColumns = fifAllCols;
                    fifActiveKeys = fifKeyNames.slice();
                    fifActiveCols = fifColNames.slice();
                } catch (allErr) {
                    log.audit("FIF_PROBE", "Full set failed: " + allErr.message + ". Probing each column...");
                    fifNeedProbe = true;
                }

                // Attempt 2: probe each column individually (only if full set failed)
                if (fifNeedProbe) {
                    fifColumns = [];
                    fifActiveKeys = [];
                    fifActiveCols = [];
                    var baseCol = search.createColumn({ name: "internalid" });
                    for (var ci = 0; ci < fifColNames.length; ci++) {
                        if (fifColNames[ci] === "internalid") {
                            fifColumns.push(search.createColumn({ name: "internalid" }));
                            fifActiveKeys.push(fifKeyNames[ci]);
                            fifActiveCols.push(fifColNames[ci]);
                            continue;
                        }
                        try {
                            var probeCol = search.createColumn({ name: fifColNames[ci] });
                            search.create({
                                type: search.Type.ITEM,
                                filters: [["isinactive", "is", "F"]],
                                columns: [baseCol, probeCol]
                            }).run().getRange({ start: 0, end: 1 });
                            fifColumns.push(probeCol);
                            fifActiveKeys.push(fifKeyNames[ci]);
                            fifActiveCols.push(fifColNames[ci]);
                        } catch (probeErr) {
                            fifFailed.push(fifKeyNames[ci] + " (" + fifColNames[ci] + ")");
                            log.audit("FIF_SKIP", fifColNames[ci] + ": " + probeErr.message);
                        }
                    }
                }

                var fifSearch = search.create({
                    type: search.Type.ITEM,
                    filters: [["isinactive", "is", "F"]],
                    columns: fifColumns
                });

                var fifPaged = fifSearch.runPaged({ pageSize: fifPageSize });
                var fifTotal = fifPaged.count;
                var fifTotalPages = fifPaged.pageRanges.length;

                if (fifTotal === 0 || fifPage >= fifTotalPages) {
                    result.fetch_all_items_full = {
                        page: fifPage, pageSize: fifPageSize,
                        total: fifTotal, totalPages: fifTotalPages,
                        count: 0, items: [], done: true,
                        fields: fifActiveKeys,
                        skippedFields: fifFailed.length > 0 ? fifFailed : undefined
                    };
                } else {
                    var fifItems = [];
                    var fifPageData = fifPaged.fetch({ index: fifPage });

                    fifPageData.data.forEach(function (r) {
                        var item = {};
                        for (var fi = 0; fi < fifActiveKeys.length; fi++) {
                            try {
                                // Use human-readable key, read value from internal column
                                item[fifActiveKeys[fi]] = r.getValue(fifColumns[fi]);
                                // Add _text suffix for columns with text labels
                                if (fifTextCols.indexOf(fifActiveCols[fi]) >= 0) {
                                    var ftxt = r.getText(fifColumns[fi]);
                                    if (ftxt) item[fifActiveKeys[fi] + "_text"] = ftxt;
                                }
                            } catch (fErr) {
                                item[fifActiveKeys[fi]] = null;
                            }
                        }
                        fifItems.push(item);
                    });

                    result.fetch_all_items_full = {
                        page: fifPage, pageSize: fifPageSize,
                        total: fifTotal, totalPages: fifTotalPages,
                        count: fifItems.length, items: fifItems,
                        done: fifPage >= fifTotalPages - 1,
                        fields: fifActiveKeys,
                        skippedFields: fifFailed.length > 0 ? fifFailed : undefined
                    };
                }
            } catch (e) {
                result.fetch_all_items_full = { error: e.message };
            }
        }

        // ── Fetch Items FAST (SuiteQL — keyset pagination by i.id) ──────────
        // POST: { "sections": ["fetch_items_fast"], "lastId": 0, "pageSize": 4000 }
        // Uses N/query SuiteQL with keyset pagination: WHERE i.id > lastId.
        // No OFFSET — no OneWorld duplicate rows, no performance degradation.
        // BUILTIN.DF() gives text labels inline (no separate getText() calls).
        // Column resilience: if full query fails, drops bad columns and retries.
        // Same human-readable "description-internal_id" key format as fetch_all_items_full.
        if (sections.indexOf("fetch_items_fast") >= 0) {
            var fiqLastId = parseInt(payload.lastId, 10) || 0;
            var fiqPageSize = parseInt(payload.pageSize, 10) || 4000;
            if (fiqPageSize > 5000) fiqPageSize = 5000;

            try {
                // ── SuiteQL column map: alias → SQL expression ──
                // Standard fields use table column names.
                // Custom fields use custitem IDs directly.
                // BUILTIN.DF() wraps list/record fields to get text labels inline.
                var fiqColMap = {
                    // Primary Information
                    "internalid":       "i.id",
                    "externalid":       "i.externalid",
                    "itemid":           "i.itemid",
                    "displayname":      "i.displayname",
                    "vendorname":       "i.vendorname",
                    "parent":           "i.parent",
                    "parent_text":      "BUILTIN.DF(i.parent) AS parent_text",
                    "subsidiary":       "i.subsidiary",
                    "subsidiary_text":  "BUILTIN.DF(i.subsidiary) AS subsidiary_text",
                    "class":            "i.class",
                    "class_text":       "BUILTIN.DF(i.class) AS class_text",
                    "includechildren":  "i.includechildren",
                    "department":       "i.department",
                    "department_text":  "BUILTIN.DF(i.department) AS department_text",
                    "location":         "i.location",
                    "location_text":    "BUILTIN.DF(i.location) AS location_text",

                    // Item Detail
                    "unitstype":        "i.unitstype",
                    "unitstype_text":   "BUILTIN.DF(i.unitstype) AS unitstype_text",
                    "baseunit":         "i.baseunit",
                    "upccode":          "i.upccode",
                    "stockunit":        "i.stockunit",
                    "purchaseunit":     "i.purchaseunit",
                    "saleunit":         "i.saleunit",
                    "isserialitem":     "i.isserialitem",
                    "islotitem":        "i.islotitem",

                    // Item/Cost Detail
                    "baseprice":        "i.baseprice",
                    "cost":             "i.cost",
                    "averagecost":      "i.averagecost",
                    "lastpurchaseprice": "i.lastpurchaseprice",
                    "purchasedescription": "i.purchasedescription",
                    "salesdescription": "i.salesdescription",
                    "costingmethod":    "i.costingmethod",
                    "costingmethod_text": "BUILTIN.DF(i.costingmethod) AS costingmethod_text",
                    "totalquantityonhand": "i.totalquantityonhand",
                    "totalvalue":       "i.totalvalue",
                    "isdropshipitem":   "i.isdropshipitem",
                    "isspecialorderitem": "i.isspecialorderitem",
                    "matchbilltoreceipt": "i.matchbilltoreceipt",
                    "stockdescription": "i.stockdescription",
                    "tracklandedcost":  "i.tracklandedcost",
                    "costestimatetype": "i.costestimatetype",

                    // Accounts
                    "incomeaccount":    "i.incomeaccount",
                    "incomeaccount_text": "BUILTIN.DF(i.incomeaccount) AS incomeaccount_text",
                    "cogsaccount":      "i.cogsaccount",
                    "cogsaccount_text": "BUILTIN.DF(i.cogsaccount) AS cogsaccount_text",
                    "assetaccount":     "i.assetaccount",
                    "assetaccount_text": "BUILTIN.DF(i.assetaccount) AS assetaccount_text",
                    "taxschedule":      "i.taxschedule",
                    "taxschedule_text": "BUILTIN.DF(i.taxschedule) AS taxschedule_text",

                    // Manufacturing
                    "manufacturer":     "i.manufacturer",
                    "manufacturer_text": "BUILTIN.DF(i.manufacturer) AS manufacturer_text",
                    "mpn":              "i.mpn",
                    "countryofmanufacture": "i.countryofmanufacture",

                    // Supply Planning
                    "preferredlocation": "i.preferredlocation",
                    "preferredlocation_text": "BUILTIN.DF(i.preferredlocation) AS preferredlocation_text",
                    "reorderpoint":     "i.reorderpoint",
                    "safetystocklevel": "i.safetystocklevel",
                    "leadtime":         "i.leadtime",
                    "seasonaldemand":   "i.seasonaldemand",
                    "demandmodifier":   "i.demandmodifier",

                    // Shipping
                    "weight":           "i.weight",
                    "weightunit":       "i.weightunit",
                    "weightunit_text":  "BUILTIN.DF(i.weightunit) AS weightunit_text",
                    "shipindividually": "i.shipindividually",

                    // General
                    "type":             "i.itemtype",
                    "type_text":        "BUILTIN.DF(i.itemtype) AS type_text",
                    "isinactive":       "i.isinactive",
                    "created":          "i.createddate",
                    "lastmodifieddate": "i.lastmodifieddate",

                    // Inventory
                    "quantityonhand":     "i.quantityonhand",
                    "quantityavailable":  "i.quantityavailable",
                    "quantityonorder":    "i.quantityonorder",
                    "quantitycommitted":  "i.quantitycommitted",
                    "inventorylocation":  "i.inventorylocation",
                    "inventorylocation_text": "BUILTIN.DF(i.inventorylocation) AS inventorylocation_text",

                    // ── Custom fields (human_readable-internal_id format) ──
                    "condition-custitem1":          "i.custitem1",
                    "condition_text-custitem1":     "BUILTIN.DF(i.custitem1) AS condition_text",
                    "brand-custitem2":              "i.custitem2",
                    "brand_text-custitem2":         "BUILTIN.DF(i.custitem2) AS brand_text",
                    "map_price-custitem3":          "i.custitem3",
                    "current_map_price-custitem4":  "i.custitem4",
                    "cmap_exp_date-custitem5":      "i.custitem5",
                    "minimum_price-custitem6":      "i.custitem6",
                    "maximum_price-custitem7":      "i.custitem7",
                    "vir_primary-custitem8":        "i.custitem8",
                    "vir_growth-custitem9":         "i.custitem9",
                    "vir_other-custitem10":         "i.custitem10",
                    "image_url_1-custitem11":       "i.custitem11",
                    "image_url_2-custitem12":       "i.custitem12",
                    "image_url_3-custitem13":       "i.custitem13",
                    "image_url_4-custitem14":       "i.custitem14",
                    "screen_size-custitem15":       "i.custitem15",
                    "item_type_custom-custitem16":  "i.custitem16",

                    // TD Synnex
                    "synnex_total_inventory-custitem17": "i.custitem17",
                    "synnex_sku-custitem36":             "i.custitem36",
                    "synnex_romeoville_il-custitem22":   "i.custitem22",
                    "synnex_suwanee_ga-custitem23":      "i.custitem23",
                    "synnex_southaven_ms-custitem24":    "i.custitem24",
                    "synnex_swedesboro_nj-custitem25":   "i.custitem25",
                    "synnex_fort_worth_tx-custitem27":   "i.custitem27",
                    "synnex_chino_ca-custitem28":        "i.custitem28",

                    // D&H
                    "dh_sku-custitem38":           "i.custitem38",
                    "dh_harrisburg_pa-custitem29": "i.custitem29",
                    "dh_california-custitem30":    "i.custitem30",
                    "dh_chicago_il-custitem31":    "i.custitem31",
                    "dh_atlanta_ga-custitem32":    "i.custitem32",

                    // Ingram Micro
                    "ingram_sku-custitem40":             "i.custitem40",
                    "ingram_mira_loma_ca-custitem33":    "i.custitem33",
                    "ingram_carol_stream_il-custitem34": "i.custitem34",
                    "ingram_hazelton_pa-custitem35":     "i.custitem35",

                    // Distribution Management
                    "dm_sku-custitem39":  "i.custitem39",
                    "dm_ca-custitem18":   "i.custitem18",
                    "dm_tx-custitem19":   "i.custitem19",
                    "dm_pa-custitem20":   "i.custitem20",
                    "dm_mo-custitem21":   "i.custitem21",

                    // NewAge
                    "newage_sku-custitem37":           "i.custitem37",
                    "newage_miami_fl-custitem41":      "i.custitem41",
                    "newage_columbus_oh-custitem42":   "i.custitem42",
                    "newage_romeoville_il-custitem43": "i.custitem43",
                    "newage_suwanee_ga-custitem44":    "i.custitem44",
                    "newage_southaven_ms-custitem45":  "i.custitem45",
                    "newage_swedesboro_nj-custitem46": "i.custitem46",
                    "newage_fort_worth_tx-custitem47": "i.custitem47",
                    "newage_chino_ca-custitem48":      "i.custitem48",

                    // EBP / FarApp
                    "ebp_tag-custitem_ebp_tag":                          "i.custitem_ebp_tag",
                    "ebp_tag_text-custitem_ebp_tag":                     "BUILTIN.DF(i.custitem_ebp_tag) AS ebp_tag_text",
                    "atlas_item_image-custitem_atlas_item_image":        "i.custitem_atlas_item_image",
                    "custom_uom-custitem_cust_uom":                      "i.custitem_cust_uom",
                    "amz_category-custitem_fa_amz_category":             "i.custitem_fa_amz_category",
                    "amz_category_text-custitem_fa_amz_category":        "BUILTIN.DF(i.custitem_fa_amz_category) AS amz_category_text",
                    "shopify_flag-custitem_fa_shopify_flag":              "i.custitem_fa_shopify_flag",
                    "amz_prod_type-custitem_fa_amz_prod_type":           "i.custitem_fa_amz_prod_type",
                    "amz_prod_type_text-custitem_fa_amz_prod_type":      "BUILTIN.DF(i.custitem_fa_amz_prod_type) AS amz_prod_type_text",
                    "amz_item_type-custitem_fa_amz_item_type":           "i.custitem_fa_amz_item_type",
                    "amz_item_type_text-custitem_fa_amz_item_type":      "BUILTIN.DF(i.custitem_fa_amz_item_type) AS amz_item_type_text",
                    "order_delay_count-custitem_order_delay_count":       "i.custitem_order_delay_count",
                    "supply_allocation_count-custitem_supply_allocation_count": "i.custitem_supply_allocation_count",
                    "supply_planning_count-custitem_supply_planning_count":     "i.custitem_supply_planning_count",
                    "last_posted_to_farapp-custitemlastpostedtofarapp":         "i.custitemlastpostedtofarapp"
                };

                var fiqKeys = Object.keys(fiqColMap);
                var fiqExprs = fiqKeys.map(function (k) { return fiqColMap[k]; });

                // Build SELECT expressions — for BUILTIN.DF() columns, the expression IS the alias.
                // For plain columns, alias as the key name.
                var fiqSelectParts = [];
                for (var fqi = 0; fqi < fiqKeys.length; fqi++) {
                    var expr = fiqExprs[fqi];
                    if (expr.indexOf("BUILTIN.DF") >= 0) {
                        // Already has AS alias
                        fiqSelectParts.push(expr);
                    } else {
                        // Plain column — alias with the human-readable key
                        fiqSelectParts.push(expr + " AS " + sanitizeAlias(fiqKeys[fqi]));
                    }
                }

                // ── Incremental sync: optional modifiedSince filter ──
                // POST: { "sections": ["fetch_items_fast"], "modifiedSince": "2026-03-20 00:00:00" }
                var fiqModFilter = "";
                if (payload.modifiedSince) {
                    fiqModFilter = " AND i.lastmodifieddate >= '" + payload.modifiedSince + "'";
                }

                // ── Get total count on first call (lastId=0) for progress reporting ──
                var fiqTotal = 0;
                if (fiqLastId === 0) {
                    var fiqCountSql = "SELECT COUNT(*) AS cnt FROM item i WHERE i.isinactive = 'F'" + fiqModFilter;
                    var fiqCountResult = query.runSuiteQL({ query: fiqCountSql });
                    if (fiqCountResult && fiqCountResult.results && fiqCountResult.results.length > 0) {
                        fiqTotal = parseInt(fiqCountResult.results[0].values[0], 10) || 0;
                    }
                }

                {
                    // ── Try full query — if it fails, drop bad columns and retry ──
                    var fiqActiveKeys = fiqKeys.slice();
                    var fiqActiveSelects = fiqSelectParts.slice();
                    var fiqSkipped = [];
                    var fiqItems = [];

                    var fiqBaseSql = " FROM item i WHERE i.isinactive = 'F' AND i.id > " + fiqLastId + fiqModFilter + " ORDER BY i.id";
                    var fiqPageSql = " OFFSET 0 ROWS FETCH NEXT " + fiqPageSize + " ROWS ONLY";

                    // Attempt 1: full query
                    var fiqSuccess = false;
                    try {
                        var fiqFullSql = "SELECT " + fiqActiveSelects.join(", ") + fiqBaseSql + fiqPageSql;
                        var fiqResult = query.runSuiteQL({ query: fiqFullSql });
                        fiqItems = mapSuiteQLResults(fiqResult, fiqActiveKeys);
                        fiqSuccess = true;
                    } catch (fullErr) {
                        log.audit("FIQ_PROBE", "Full SuiteQL failed: " + fullErr.message + ". Probing columns...");
                    }

                    // Attempt 2: binary-split column probing (find bad columns fast)
                    if (!fiqSuccess) {
                        var fiqGoodKeys = [];
                        var fiqGoodSelects = [];

                        // Always keep id (internalid) as anchor
                        fiqGoodKeys.push(fiqKeys[0]);
                        fiqGoodSelects.push(fiqSelectParts[0]);

                        // Test remaining columns in chunks of 10
                        var chunkSize = 10;
                        for (var ci = 1; ci < fiqKeys.length; ci += chunkSize) {
                            var chunkKeys = fiqKeys.slice(ci, ci + chunkSize);
                            var chunkSelects = fiqSelectParts.slice(ci, ci + chunkSize);

                            // Try the whole chunk
                            var testSelects = [fiqSelectParts[0]].concat(chunkSelects);
                            var testSql = "SELECT " + testSelects.join(", ") + fiqBaseSql + " OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY";

                            try {
                                query.runSuiteQL({ query: testSql });
                                // Whole chunk is good
                                for (var cki = 0; cki < chunkKeys.length; cki++) {
                                    fiqGoodKeys.push(chunkKeys[cki]);
                                    fiqGoodSelects.push(chunkSelects[cki]);
                                }
                            } catch (chunkErr) {
                                // Some column in this chunk is bad — test individually
                                for (var sci = 0; sci < chunkKeys.length; sci++) {
                                    var singleTestSql = "SELECT " + fiqSelectParts[0] + ", " + chunkSelects[sci] + fiqBaseSql + " OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY";
                                    try {
                                        query.runSuiteQL({ query: singleTestSql });
                                        fiqGoodKeys.push(chunkKeys[sci]);
                                        fiqGoodSelects.push(chunkSelects[sci]);
                                    } catch (singleErr) {
                                        fiqSkipped.push(chunkKeys[sci]);
                                        log.audit("FIQ_SKIP", chunkKeys[sci] + ": " + singleErr.message);
                                    }
                                }
                            }
                        }

                        fiqActiveKeys = fiqGoodKeys;
                        fiqActiveSelects = fiqGoodSelects;

                        // Retry with validated columns
                        var fiqRetrySql = "SELECT " + fiqActiveSelects.join(", ") + fiqBaseSql + fiqPageSql;
                        var fiqRetryResult = query.runSuiteQL({ query: fiqRetrySql });
                        fiqItems = mapSuiteQLResults(fiqRetryResult, fiqActiveKeys);
                    }

                    // ── Enrich items with classification hierarchy ──
                    // Fetches all classifications once, resolves every level's ID
                    // via partial fullname lookup (e.g. "A : B : C" → "A", "A : B", "A : B : C")
                    try {
                        var classSql = "SELECT id, fullname FROM classification";
                        var classResult = query.runSuiteQL({ query: classSql });
                        var classNameToId = {};  // fullname → id
                        var classIdToName = {};  // id → fullname
                        if (classResult && classResult.results) {
                            for (var cr = 0; cr < classResult.results.length; cr++) {
                                var cv = classResult.results[cr].values;
                                classNameToId[cv[1]] = cv[0];
                                classIdToName[cv[0]] = cv[1];
                            }
                        }
                        for (var ci3 = 0; ci3 < fiqItems.length; ci3++) {
                            var itemClassId = fiqItems[ci3]["class"];
                            if (itemClassId && classIdToName[itemClassId]) {
                                var fn = classIdToName[itemClassId];
                                var parts = fn.split(" : ");
                                var levels = [];
                                for (var p = 0; p < parts.length; p++) {
                                    var partial = parts.slice(0, p + 1).join(" : ");
                                    levels.push({ level: p + 1, name: parts[p], id: classNameToId[partial] || null });
                                }
                                fiqItems[ci3]["class_levels"] = levels;
                            }
                        }
                    } catch (classErr) {
                        log.audit("FIQ_CLASS", "Classification lookup failed: " + classErr.message);
                    }

                    var fiqResponseLastId = fiqItems.length > 0 ? fiqItems[fiqItems.length - 1]["internalid"] : null;
                    result.fetch_items_fast = {
                        lastId: fiqResponseLastId,
                        pageSize: fiqPageSize,
                        total: fiqTotal || undefined,
                        count: fiqItems.length, items: fiqItems,
                        done: fiqItems.length < fiqPageSize,
                        fields: fiqActiveKeys,
                        skippedFields: fiqSkipped.length > 0 ? fiqSkipped : undefined
                    };
                }
            } catch (e) {
                result.fetch_items_fast = { error: e.message };
            }
        }

        // ── Fetch Classification Tree (all classes with parent/child) ──────
        // POST: { "sections": ["fetch_class_tree"] }
        // Returns flat list of all active classifications with id, name, fullname, parent.
        // Controller builds the nested tree on Node side.
        if (sections.indexOf("fetch_class_tree") >= 0) {
            try {
                var ctSql = "SELECT id, name, fullname, parent FROM classification WHERE isinactive = 'F' ORDER BY fullname";
                var ctResult = query.runSuiteQL({ query: ctSql });
                var ctItems = [];
                if (ctResult && ctResult.results) {
                    for (var cti = 0; cti < ctResult.results.length; cti++) {
                        var ctv = ctResult.results[cti].values;
                        ctItems.push({ id: ctv[0], name: ctv[1], fullname: ctv[2], parent: ctv[3] });
                    }
                }
                result.fetch_class_tree = { count: ctItems.length, classifications: ctItems };
            } catch (e) {
                result.fetch_class_tree = { error: e.message };
            }
        }

        // ── Custom Item Field Map (field ID → label) ──────────────────────
        // POST: { "sections": ["item_field_map"] }
        // POST: { "sections": ["item_field_map"], "itemId": 12692 }
        // Loads an item record and reads the label for every custitem* field.
        // Labels reveal which distributor tab each field belongs to.
        if (sections.indexOf("item_field_map") >= 0) {
            var fmItemId = parseInt(payload.itemId, 10) || 12692; // default: 29S0100
            try {
                var fmRec;
                try {
                    fmRec = record.load({ type: record.Type.SERIALIZED_INVENTORY_ITEM, id: fmItemId, isDynamic: false });
                } catch (e1) {
                    try {
                        fmRec = record.load({ type: record.Type.INVENTORY_ITEM, id: fmItemId, isDynamic: false });
                    } catch (e2) {
                        fmRec = record.load({ type: record.Type.NON_INVENTORY_ITEM, id: fmItemId, isDynamic: false });
                    }
                }

                var fmAllFields = fmRec.getFields();
                var fmCustomFields = fmAllFields.filter(function (f) {
                    return f.indexOf("custitem") === 0;
                });

                var fmResults = [];
                for (var fmi = 0; fmi < fmCustomFields.length; fmi++) {
                    var fmFieldId = fmCustomFields[fmi];
                    var fmInfo = { fieldId: fmFieldId };
                    try {
                        var fmField = fmRec.getField({ fieldId: fmFieldId });
                        if (fmField) {
                            fmInfo.label = fmField.label || null;
                            fmInfo.type = fmField.type || null;
                            fmInfo.isMandatory = fmField.isMandatory || false;
                        }
                    } catch (e) {}
                    try {
                        fmInfo.value = fmRec.getValue({ fieldId: fmFieldId });
                    } catch (e) {}
                    try {
                        fmInfo.text = fmRec.getText({ fieldId: fmFieldId });
                    } catch (e) {}
                    fmResults.push(fmInfo);
                }

                result.item_field_map = {
                    itemId: fmItemId,
                    totalCustomFields: fmResults.length,
                    fields: fmResults
                };
            } catch (e) {
                result.item_field_map = { error: e.message };
            }
        }

        // ── Fetch Item Sublists (Locations + Vendors via record.load) ─────────
        // POST: { "sections": ["fetch_item_sublists"], "itemIds": [123, 456, 789] }
        // POST: { "sections": ["fetch_item_sublists"], "itemIds": [123, 456], "itemTypes": {"123":"SerializedInventoryItem","456":"InvtPart"} }
        // When itemTypes map is provided, loads directly by type (5 units each).
        // Without itemTypes, falls back to try/catch (10 units worst case).
        // Max 800 items per call (governance: 800 × 5 = 4,000 units, leaving 1,000 buffer).
        if (sections.indexOf("fetch_item_sublists") >= 0) {
            var slItemIds = payload.itemIds || [];
            var slItemTypes = payload.itemTypes || {};  // { "123": "SerializedInventoryItem", "456": "InvtPart" }
            if (slItemIds.length > 800) slItemIds = slItemIds.slice(0, 800);

            var slResults = [];
            for (var sli = 0; sli < slItemIds.length; sli++) {
                var slId = slItemIds[sli];
                try {
                    var slRec;
                    var slType = slItemTypes[String(slId)];

                    if (slType === "SerializedInventoryItem") {
                        slRec = record.load({ type: record.Type.SERIALIZED_INVENTORY_ITEM, id: parseInt(slId, 10), isDynamic: false });
                    } else if (slType === "InvtPart") {
                        slRec = record.load({ type: record.Type.INVENTORY_ITEM, id: parseInt(slId, 10), isDynamic: false });
                    } else {
                        // Fallback: try serialized first, then inventory (wastes 5 units on miss)
                        try {
                            slRec = record.load({ type: record.Type.SERIALIZED_INVENTORY_ITEM, id: parseInt(slId, 10), isDynamic: false });
                        } catch (serErr) {
                            slRec = record.load({ type: record.Type.INVENTORY_ITEM, id: parseInt(slId, 10), isDynamic: false });
                        }
                    }

                    var slItem = { internalid: slId, locations: [], vendors: [] };

                    // ── Locations sublist ──
                    var slLocFields = [
                        "location", "quantityonhand", "quantityavailable",
                        "quantityonorder", "quantitycommitted",
                        "averagecostmli", "lastpurchasepricemli",
                        "reorderpoint", "preferredstocklevel",
                        "costaccountingstatus", "defaultreturncosmli"
                    ];
                    var slLocCount = 0;
                    try { slLocCount = slRec.getLineCount({ sublistId: "locations" }); } catch (e) {}

                    for (var lli = 0; lli < slLocCount; lli++) {
                        var locLine = {};
                        for (var lfi = 0; lfi < slLocFields.length; lfi++) {
                            try {
                                locLine[slLocFields[lfi]] = slRec.getSublistValue({
                                    sublistId: "locations", fieldId: slLocFields[lfi], line: lli
                                });
                            } catch (e) {}
                            try {
                                var ltxt = slRec.getSublistText({
                                    sublistId: "locations", fieldId: slLocFields[lfi], line: lli
                                });
                                if (ltxt) locLine[slLocFields[lfi] + "_text"] = ltxt;
                            } catch (e) {}
                        }
                        slItem.locations.push(locLine);
                    }

                    // ── Vendors sublist (itemvendor) ──
                    var slVendorFields = [
                        "vendor", "vendorname", "purchaseprice", "preferredvendor"
                    ];
                    var slVendCount = 0;
                    try { slVendCount = slRec.getLineCount({ sublistId: "itemvendor" }); } catch (e) {}

                    for (var vli = 0; vli < slVendCount; vli++) {
                        var vendLine = {};
                        for (var vfi = 0; vfi < slVendorFields.length; vfi++) {
                            try {
                                vendLine[slVendorFields[vfi]] = slRec.getSublistValue({
                                    sublistId: "itemvendor", fieldId: slVendorFields[vfi], line: vli
                                });
                            } catch (e) {}
                            try {
                                var vtxt = slRec.getSublistText({
                                    sublistId: "itemvendor", fieldId: slVendorFields[vfi], line: vli
                                });
                                if (vtxt) vendLine[slVendorFields[vfi] + "_text"] = vtxt;
                            } catch (e) {}
                        }
                        slItem.vendors.push(vendLine);
                    }

                    slResults.push(slItem);
                } catch (slErr) {
                    slResults.push({ internalid: slId, error: slErr.message });
                }
            }

            result.fetch_item_sublists = {
                requested: slItemIds.length,
                returned: slResults.length,
                items: slResults
            };
        }

        // ── Create Test SOs (hardcoded dummy data — no searches needed) ─────
        // POST: { "sections": ["create_test_so"], "count": 1 }
        if (sections.indexOf("create_test_so") >= 0) {
            var TEST_CUSTOMER_ID = 112;      // Amazon — confirmed
            var TEST_SKU         = payload.sku || "29S0100";
            var TEST_CHANNEL_ID  = 1;        // Amazon channel (csegecomm_channel)

            // Dynamic item lookup by SKU (same pattern as SO RESTlet lines 220-230)
            var TEST_ITEM_ID = null;
            try {
                var itemCol = search.createColumn({ name: "internalid" });
                var itemResults = search.create({
                    type: search.Type.ITEM,
                    filters: [["itemid", "is", TEST_SKU]],
                    columns: [itemCol]
                }).run().getRange({ start: 0, end: 1 });
                if (itemResults && itemResults.length > 0) {
                    TEST_ITEM_ID = parseInt(itemResults[0].getValue(itemCol), 10);
                }
                log.debug("TEST_SO_ITEM", "SKU=" + TEST_SKU + " → ID=" + TEST_ITEM_ID);
            } catch (itemErr) {
                log.audit("TEST_SO_ITEM", "Item lookup failed for SKU " + TEST_SKU + ": " + itemErr.message);
            }

            if (!TEST_ITEM_ID) {
                result.create_test_so = {
                    error: "Item not found for SKU: " + TEST_SKU + ". Pass a valid SKU via payload.sku"
                };
                return result;
            }

            // Dynamic form lookup — find "Ecomm BP - Sales Order" (same as SO RESTlet's findFormId)
            var TEST_FORM_ID = null;
            try {
                var fCol = search.createColumn({ name: "customform" });
                var fResults = search.create({
                    type: search.Type.SALES_ORDER,
                    filters: [["mainline", "is", "T"]],
                    columns: [fCol]
                }).run().getRange({ start: 0, end: 50 });
                for (var fi = 0; fi < fResults.length; fi++) {
                    var fName = fResults[fi].getText(fCol);
                    if (fName && fName.indexOf("Ecomm BP") >= 0) {
                        TEST_FORM_ID = parseInt(fResults[fi].getValue(fCol), 10);
                        break;
                    }
                }
            } catch (fErr) {
                log.audit("TEST_SO_FORM", "Could not find Ecomm BP form: " + fErr.message);
            }

            var testCount = parseInt(payload.count, 10) || 1;
            if (testCount > 10) testCount = 10;
            var testResults = [];

            try {
                for (var tsi = 0; tsi < testCount; tsi++) {
                    // Caller passes otherrefnum so PO can match it via website_order_number
                    var testRef = (payload.otherrefnum)
                        ? (testCount > 1 ? payload.otherrefnum + "-" + (tsi + 1) : payload.otherrefnum)
                        : "TEST-SO-" + (tsi + 1);
                    try {
                        var tso = record.create({ type: record.Type.SALES_ORDER, isDynamic: true });

                        if (TEST_FORM_ID) {
                            tso.setValue({ fieldId: "customform", value: TEST_FORM_ID });
                        }
                        tso.setValue({ fieldId: "entity", value: TEST_CUSTOMER_ID });
                        tso.setValue({ fieldId: "otherrefnum", value: testRef });
                        tso.setValue({ fieldId: "trandate", value: new Date() });
                        tso.setValue({ fieldId: "csegecomm_channel", value: TEST_CHANNEL_ID });

                        tso.selectNewLine({ sublistId: "item" });
                        tso.setCurrentSublistValue({ sublistId: "item", fieldId: "item", value: TEST_ITEM_ID });
                        tso.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: 1 });
                        tso.setCurrentSublistValue({ sublistId: "item", fieldId: "price", value: -1 });
                        tso.setCurrentSublistValue({ sublistId: "item", fieldId: "rate", value: 10.00 });
                        tso.setCurrentSublistValue({ sublistId: "item", fieldId: "amount", value: 10.00 });
                        tso.commitLine({ sublistId: "item" });

                        var savedId = tso.save({ enableSourcing: true, ignoreMandatoryFields: false });

                        var savedRec = record.load({ type: record.Type.SALES_ORDER, id: savedId, isDynamic: false });
                        var soNumber = savedRec.getValue({ fieldId: "tranid" });

                        testResults.push({
                            success: true,
                            internalId: savedId,
                            soNumber: soNumber,
                            otherrefnum: testRef,
                            item: TEST_SKU,
                            itemId: TEST_ITEM_ID
                        });

                        log.audit("TEST_SO_CREATED", "ID=" + savedId + " SO#=" + soNumber + " ref=" + testRef);
                    } catch (tsoErr) {
                        testResults.push({
                            success: false,
                            otherrefnum: testRef,
                            error: tsoErr.message
                        });
                        log.error("TEST_SO_FAIL", testRef + ": " + tsoErr.message);
                    }
                }

                result.create_test_so = {
                    requested: testCount,
                    created: testResults.filter(function (r) { return r.success; }).length,
                    config: {
                        customer: "Amazon (ID: " + TEST_CUSTOMER_ID + ")",
                        form: "Ecomm BP (ID: " + TEST_FORM_ID + ")",
                        channel: "Amazon (ID: " + TEST_CHANNEL_ID + ")",
                        item: TEST_SKU + " (ID: " + TEST_ITEM_ID + ")",
                        location: "NOT SET (intentional for testing)"
                    },
                    orders: testResults
                };
            } catch (e) {
                result.create_test_so = { error: e.message };
            }
        }

        // ── Inspect SO line item fields (find PO linking fields) ──────────────
        // POST: { "sections": ["so_line_inspect"], "soId": 250840 }
        if (sections.indexOf("so_line_inspect") >= 0) {
            var inspectSoId = parseInt(payload.soId, 10);
            if (!inspectSoId) {
                result.so_line_inspect = { error: "Missing soId" };
            } else {
                try {
                    var soRec = record.load({ type: record.Type.SALES_ORDER, id: inspectSoId, isDynamic: false });
                    var soLineCount = soRec.getLineCount({ sublistId: "item" });

                    // Get ALL available sublist fields
                    var sublistFields = [];
                    try { sublistFields = soRec.getSublistFields({ sublistId: "item" }); } catch (e) {}

                    var lines = [];
                    for (var sli = 0; sli < soLineCount; sli++) {
                        var lineData = { line: sli };
                        for (var sfi = 0; sfi < sublistFields.length; sfi++) {
                            var fid = sublistFields[sfi];
                            try {
                                var val = soRec.getSublistValue({ sublistId: "item", fieldId: fid, line: sli });
                                if (val !== null && val !== "" && val !== undefined) {
                                    lineData[fid] = val;
                                    // Also get text for select fields
                                    try {
                                        var txt = soRec.getSublistText({ sublistId: "item", fieldId: fid, line: sli });
                                        if (txt && txt !== String(val)) lineData[fid + "_text"] = txt;
                                    } catch (e) {}
                                }
                            } catch (e) {}
                        }
                        lines.push(lineData);
                    }

                    // Also get header createdfrom if exists
                    var headerInfo = {};
                    try { headerInfo.createdfrom = soRec.getValue({ fieldId: "createdfrom" }); } catch (e) {}
                    try { headerInfo.tranid = soRec.getValue({ fieldId: "tranid" }); } catch (e) {}
                    try { headerInfo.otherrefnum = soRec.getValue({ fieldId: "otherrefnum" }); } catch (e) {}
                    try { headerInfo.status = soRec.getValue({ fieldId: "status" }); } catch (e) {}

                    result.so_line_inspect = {
                        soId: inspectSoId,
                        header: headerInfo,
                        totalSublistFields: sublistFields.length,
                        sublistFields: sublistFields,
                        lineCount: soLineCount,
                        lines: lines
                    };
                } catch (e) {
                    result.so_line_inspect = { error: e.message };
                }
            }
        }

        // ── Delete Test SOs by internal IDs ──────────────────────────────────
        // POST: { "sections": ["delete_test_so"], "soIds": [248008, 248010] }
        if (sections.indexOf("delete_test_so") >= 0) {
            var delSoIds = payload.soIds || [];
            var delSoResults = [];
            for (var dsi = 0; dsi < delSoIds.length; dsi++) {
                try {
                    record.delete({ type: record.Type.SALES_ORDER, id: parseInt(delSoIds[dsi], 10) });
                    delSoResults.push({ id: delSoIds[dsi], deleted: true });
                } catch (delErr) {
                    delSoResults.push({ id: delSoIds[dsi], deleted: false, error: delErr.message });
                }
            }
            result.delete_test_so = { requested: delSoIds.length, results: delSoResults };
        }

        // ── Cleanup: delete test SOs where otherrefnum starts with "TEST" ──
        // POST: { "sections": ["cleanup_test_so"] }                    → dry-run (list only)
        // POST: { "sections": ["cleanup_test_so"], "confirm": true }   → actually delete
        if (sections.indexOf("cleanup_test_so") >= 0) {
            log.debug("CLEANUP_TEST_SO", "Starting cleanup_test_so, confirm=" + !!payload.confirm);
            try {
                var testSoSearchResults = [];
                search.create({
                    type: search.Type.SALES_ORDER,
                    filters: [
                        ["otherrefnum", "startswith", "TEST"],
                        "AND",
                        ["mainline", "is", "T"]
                    ],
                    columns: ["internalid", "tranid", "otherrefnum"]
                }).run().each(function (r) {
                    testSoSearchResults.push({
                        id: r.getValue("internalid"),
                        soNumber: r.getValue("tranid"),
                        otherrefnum: r.getValue("otherrefnum") || ""
                    });
                    return testSoSearchResults.length < 500;
                });

                log.debug("CLEANUP_TEST_SO", "Found " + testSoSearchResults.length + " test SOs");

                if (!payload.confirm) {
                    result.cleanup_test_so = {
                        mode: "dry_run",
                        found: testSoSearchResults.length,
                        orders: testSoSearchResults,
                        message: "Pass { \"confirm\": true } to delete these."
                    };
                } else {
                    var soDeleted = 0;
                    var soFailed = 0;
                    var soDelDetails = [];
                    for (var tsd = 0; tsd < testSoSearchResults.length; tsd++) {
                        var tsoId = parseInt(testSoSearchResults[tsd].id, 10);
                        try {
                            record.delete({ type: record.Type.SALES_ORDER, id: tsoId });
                            soDelDetails.push({ id: tsoId, deleted: true });
                            soDeleted++;
                        } catch (tsoErr) {
                            soDelDetails.push({ id: tsoId, deleted: false, error: tsoErr.message });
                            soFailed++;
                        }
                    }
                    result.cleanup_test_so = {
                        mode: "executed",
                        found: testSoSearchResults.length,
                        deleted: soDeleted,
                        failed: soFailed,
                        details: soDelDetails
                    };
                }
            } catch (e) {
                log.error("CLEANUP_TEST_SO_ERROR", e.name + ": " + e.message);
                result.cleanup_test_so = { error: e.message };
            }
        }

        // ── Cleanup: delete Purchase Orders (with optional exclude list) ──────
        // POST: { "sections": ["cleanup_all_po"] }                                          → dry-run (list only)
        // POST: { "sections": ["cleanup_all_po"], "confirm": true }                         → delete all
        // POST: { "sections": ["cleanup_all_po"], "confirm": true, "exclude": ["PO228047"] } → delete all except PO228047
        // "exclude" matches against tranid (e.g. "PO228047") — case-sensitive.
        if (sections.indexOf("cleanup_all_po") >= 0) {
            var poExcludeList = payload.exclude || [];
            var poExcludeSet = {};
            for (var ei = 0; ei < poExcludeList.length; ei++) {
                poExcludeSet[poExcludeList[ei]] = true;
            }

            try {
                // ── Fast path: countOnly uses SuiteQL (no search iteration) ──
                if (payload.countOnly && !payload.confirm) {
                    var totalSql = "SELECT COUNT(*) AS cnt FROM transaction WHERE type = 'PurchOrd'";
                    var totalRes = query.runSuiteQL({ query: totalSql }).asMappedResults();
                    var totalPOs = parseInt(totalRes[0].cnt, 10);

                    var excludedCount = 0;
                    if (poExcludeList.length > 0) {
                        var excludeQuoted = poExcludeList.map(function (e) { return "'" + e.replace(/'/g, "''") + "'"; }).join(", ");
                        var excludeSql = "SELECT COUNT(*) AS cnt FROM transaction WHERE type = 'PurchOrd' AND tranid IN (" + excludeQuoted + ")";
                        var excludeRes = query.runSuiteQL({ query: excludeSql }).asMappedResults();
                        excludedCount = parseInt(excludeRes[0].cnt, 10);
                    }

                    result.cleanup_all_po = {
                        mode: "dry_run",
                        found: totalPOs - excludedCount,
                        excluded: excludedCount,
                        message: "Pass { \"confirm\": true } to delete. Excluded POs will be kept."
                    };
                    // skip the rest of cleanup_all_po
                } else {

                var allPoSearchResults = [];
                var allPoExcluded = [];
                search.create({
                    type: search.Type.PURCHASE_ORDER,
                    filters: [["mainline", "is", "T"]],
                    columns: ["internalid", "tranid", "otherrefnum"]
                }).run().each(function (r) {
                    var entry = {
                        id: r.getValue("internalid"),
                        poNumber: r.getValue("tranid"),
                        otherrefnum: r.getValue("otherrefnum") || ""
                    };
                    if (poExcludeSet[entry.poNumber]) {
                        allPoExcluded.push(entry);
                    } else {
                        allPoSearchResults.push(entry);
                    }
                    return (allPoSearchResults.length + allPoExcluded.length) < 4000;
                });

                log.audit("CLEANUP_ALL_PO", "Found " + allPoSearchResults.length + " to delete, " + allPoExcluded.length + " excluded");

                if (!payload.confirm) {
                    result.cleanup_all_po = {
                        mode: "dry_run",
                        found: allPoSearchResults.length,
                        excluded: allPoExcluded.length,
                        excludedOrders: allPoExcluded,
                        orders: allPoSearchResults,
                        message: "Pass { \"confirm\": true } to delete. Excluded POs will be kept."
                    };
                } else {
                    var poDeleted = 0;
                    var poFailed = 0;
                    var poDelDetails = [];
                    for (var pd = 0; pd < allPoSearchResults.length; pd++) {
                        var delPoId = parseInt(allPoSearchResults[pd].id, 10);
                        try {
                            record.delete({ type: record.Type.PURCHASE_ORDER, id: delPoId });
                            poDelDetails.push({ id: delPoId, deleted: true });
                            poDeleted++;
                        } catch (poDelErr) {
                            poDelDetails.push({ id: delPoId, deleted: false, error: poDelErr.message });
                            poFailed++;
                        }
                    }
                    result.cleanup_all_po = {
                        mode: "executed",
                        found: allPoSearchResults.length,
                        deleted: poDeleted,
                        failed: poFailed,
                        excluded: allPoExcluded.length,
                        excludedOrders: allPoExcluded,
                        details: poDelDetails
                    };
                }
                } // end else (non-countOnly path)
            } catch (e) {
                log.error("CLEANUP_ALL_PO_ERROR", e.name + ": " + e.message);
                result.cleanup_all_po = { error: e.message };
            }
        }

        // ── Update Item Classes (submitFields — 10 units each) ────────────
        // POST: { "sections": ["update_item_classes"], "items": [{ "id": 123, "type": "InvtPart", "classId": 456 }, ...] }
        // type values: "InvtPart", "SerializedInventoryItem", "NonInvtPart", "Assembly", "Kit"
        // Max 400 items per call (400 × 10 = 4,000 governance units)
        if (sections.indexOf("update_item_classes") >= 0) {
            var ucItems = payload.items || [];
            log.debug("UC_START", "Received " + ucItems.length + " items for class update");
            if (ucItems.length > 400) ucItems = ucItems.slice(0, 400);

            // Log first 3 items for debugging
            for (var ucDbg = 0; ucDbg < Math.min(3, ucItems.length); ucDbg++) {
                log.debug("UC_SAMPLE_" + ucDbg, JSON.stringify(ucItems[ucDbg]));
            }

            var ucTypeMap = {
                "InvtPart":                    record.Type.INVENTORY_ITEM,
                "inventoryitem":               record.Type.INVENTORY_ITEM,
                "SerializedInventoryItem":     record.Type.SERIALIZED_INVENTORY_ITEM,
                "serializedinventoryitem":     record.Type.SERIALIZED_INVENTORY_ITEM,
                "NonInvtPart":                 record.Type.NON_INVENTORY_ITEM,
                "noninventoryitem":            record.Type.NON_INVENTORY_ITEM,
                "Assembly":                    record.Type.ASSEMBLY_ITEM,
                "assemblyitem":                record.Type.ASSEMBLY_ITEM,
                "Kit":                         record.Type.KIT_ITEM,
                "kititem":                     record.Type.KIT_ITEM
            };

            var ucScript = runtime.getCurrentScript();
            var ucStartUsage = ucScript.getRemainingUsage();
            log.debug("UC_GOVERNANCE", "Starting governance units: " + ucStartUsage);

            var ucUpdated = 0;
            var ucFailed = 0;
            var ucStopped = 0;
            var ucSkippedInvalid = 0;
            var ucSkippedNoType = 0;
            var ucFailedDetails = [];
            var ucTypeCounts = {};  // track which record types are being used

            for (var uci = 0; uci < ucItems.length; uci++) {
                // Governance guard: stop if < 100 units remaining
                var ucRemaining = ucScript.getRemainingUsage();
                if (ucRemaining < 100) {
                    ucStopped = ucItems.length - uci;
                    log.audit("UC_GOV_STOP", "Stopping at item " + uci + "/" + ucItems.length + " — only " + ucRemaining + " units left. Updated: " + ucUpdated + ", Failed: " + ucFailed);
                    break;
                }

                // Log progress every 50 items
                if (uci > 0 && uci % 50 === 0) {
                    log.debug("UC_PROGRESS", "Item " + uci + "/" + ucItems.length + " — updated: " + ucUpdated + ", failed: " + ucFailed + ", units left: " + ucRemaining);
                }

                var ucEntry = ucItems[uci];
                var ucId = Number(ucEntry.id);
                var ucClassId = Number(ucEntry.classId);
                var ucRecType = ucTypeMap[ucEntry.type];

                if (!ucId || isNaN(ucId) || !ucClassId || isNaN(ucClassId)) {
                    ucSkippedInvalid++;
                    ucFailed++;
                    ucFailedDetails.push({ id: ucEntry.id, classId: ucEntry.classId, error: "invalid id=" + ucEntry.id + " or classId=" + ucEntry.classId });
                    if (ucSkippedInvalid <= 5) {
                        log.debug("UC_INVALID", "Skipping invalid: id=" + ucEntry.id + " classId=" + ucEntry.classId + " type=" + ucEntry.type);
                    }
                    continue;
                }

                if (!ucRecType) {
                    ucSkippedNoType++;
                    ucRecType = record.Type.INVENTORY_ITEM;
                    if (ucSkippedNoType <= 5) {
                        log.debug("UC_NO_TYPE", "Unknown type '" + ucEntry.type + "' for id=" + ucId + " — defaulting to INVENTORY_ITEM");
                    }
                }

                // Track type distribution
                var ucTypeKey = ucEntry.type || "null";
                ucTypeCounts[ucTypeKey] = (ucTypeCounts[ucTypeKey] || 0) + 1;

                try {
                    record.submitFields({
                        type: ucRecType,
                        id: ucId,
                        values: { "class": ucClassId },
                        options: { enableSourcing: false, ignoreMandatoryFields: true }
                    });
                    ucUpdated++;
                } catch (ucErr) {
                    // Auto-retry with correct type if mismatch (e.g. InvtPart → SerializedInventoryItem)
                    var ucRetryType = null;
                    var errMsg = ucErr.message || "";
                    if (errMsg.indexOf("different type:") >= 0) {
                        // Extract actual type from: "different type: serializedinventoryitem from the type specified"
                        var typeMatch = errMsg.match(/different type:\s*(\w+)\s*from/);
                        if (typeMatch && typeMatch[1]) {
                            ucRetryType = ucTypeMap[typeMatch[1]] || null;
                        }
                    }

                    if (ucRetryType && ucRetryType !== ucRecType) {
                        try {
                            record.submitFields({
                                type: ucRetryType,
                                id: ucId,
                                values: { "class": ucClassId },
                                options: { enableSourcing: false, ignoreMandatoryFields: true }
                            });
                            ucUpdated++;
                            // Track retried type
                            var retryKey = ucEntry.type + "→" + typeMatch[1];
                            ucTypeCounts[retryKey] = (ucTypeCounts[retryKey] || 0) + 1;
                        } catch (ucRetryErr) {
                            ucFailed++;
                            ucFailedDetails.push({ id: ucId, classId: ucClassId, type: ucEntry.type, retried: typeMatch[1], error: ucRetryErr.message });
                            if (ucFailed <= 10) {
                                log.error("UC_FAIL", "id=" + ucId + " retry as " + typeMatch[1] + " classId=" + ucClassId + " — " + ucRetryErr.message);
                            }
                        }
                    } else {
                        ucFailed++;
                        ucFailedDetails.push({ id: ucId, classId: ucClassId, type: ucEntry.type, nsType: String(ucRecType), error: errMsg });
                        if (ucFailed <= 10) {
                            log.error("UC_FAIL", "id=" + ucId + " type=" + ucEntry.type + " nsType=" + ucRecType + " classId=" + ucClassId + " — " + errMsg);
                        }
                    }
                }
            }

            var ucEndUsage = ucScript.getRemainingUsage();
            log.audit("UC_DONE", "Updated: " + ucUpdated + ", Failed: " + ucFailed + ", Stopped: " + ucStopped + ", InvalidIds: " + ucSkippedInvalid + ", NoType: " + ucSkippedNoType + ", Governance used: " + (ucStartUsage - ucEndUsage) + ", Remaining: " + ucEndUsage);
            log.debug("UC_TYPES", "Type distribution: " + JSON.stringify(ucTypeCounts));

            result.update_item_classes = {
                requested: ucItems.length,
                updated: ucUpdated,
                failed: ucFailed,
                stopped: ucStopped,
                skippedInvalid: ucSkippedInvalid,
                skippedNoType: ucSkippedNoType,
                governanceUsed: ucStartUsage - ucEndUsage,
                governanceRemaining: ucEndUsage,
                typeCounts: ucTypeCounts,
                details: ucFailedDetails
            };
        }

        // ── Trigger Item Class Update MapReduce ─────────────────────────────
        // POST: { "sections": ["trigger_class_mr"], "items": [{ "id": 123, "type": "InvtPart", "classId": 456 }, ...] }
        // Writes items to File Cabinet as JSON, triggers MapReduceScript.
        // Returns taskId for status polling via check_mr_status.
        if (sections.indexOf("trigger_class_mr") >= 0) {
            var mrItems = payload.items || [];
            if (mrItems.length === 0) {
                result.trigger_class_mr = { error: "No items provided" };
            } else {
                try {
                    // Write JSON file to File Cabinet (SuiteScripts folder)
                    var mrFileName = "class_update_" + new Date().getTime() + ".json";
                    var mrFile = file.create({
                        name: mrFileName,
                        fileType: file.Type.JSON,
                        contents: JSON.stringify(mrItems),
                        folder: -15  // SuiteScripts folder
                    });
                    var mrFileId = mrFile.save();
                    log.audit("TRIGGER_CLASS_MR", "Wrote " + mrItems.length + " items to file " + mrFileId + " (" + mrFileName + ")");

                    // Trigger MapReduceScript
                    var mrTask = task.create({
                        taskType: task.TaskType.MAP_REDUCE,
                        scriptId: "customscript_update_item_classes_mr",
                        deploymentId: "customdeploy_update_item_classes_mr",
                        params: { "custscript_custscript_uc_file_id": mrFileId }
                    });
                    var mrTaskId = mrTask.submit();
                    log.audit("TRIGGER_CLASS_MR", "Submitted MR task " + mrTaskId);

                    result.trigger_class_mr = {
                        success: true,
                        taskId: mrTaskId,
                        fileId: mrFileId,
                        fileName: mrFileName,
                        itemCount: mrItems.length
                    };
                } catch (mrErr) {
                    log.error("TRIGGER_CLASS_MR", mrErr.message);
                    result.trigger_class_mr = { error: mrErr.message };
                }
            }
        }

        // ── Check MapReduce Task Status ──────────────────────────────────────
        // POST: { "sections": ["check_mr_status"], "taskId": "MAPREDUCETASK_xxx" }
        if (sections.indexOf("check_mr_status") >= 0) {
            var checkTaskId = payload.taskId || "";
            if (!checkTaskId) {
                result.check_mr_status = { error: "Missing taskId" };
            } else {
                try {
                    var mrStatus = task.checkStatus({ taskId: checkTaskId });
                    result.check_mr_status = {
                        taskId: checkTaskId,
                        status: mrStatus.status,
                        stage: mrStatus.stage || null,
                        percentComplete: mrStatus.getPercentageCompleted ? mrStatus.getPercentageCompleted() : null
                    };
                } catch (statusErr) {
                    result.check_mr_status = { taskId: checkTaskId, error: statusErr.message };
                }
            }
        }

        // ── Trigger Generalized Item Field Update MapReduce ──────────────────
        // POST: { "sections": ["trigger_fields_mr"], "items": [{ "id": 123, "type": "InvtPart", "values": { "displayname": "...", "class": 499, "isdropshipitem": false } }, ...] }
        // Writes items to File Cabinet as JSON, triggers the same MR script with generic values.
        // Returns taskId for status polling via check_mr_status.
        if (sections.indexOf("trigger_fields_mr") >= 0) {
            var ufItems = payload.items || [];
            if (ufItems.length === 0) {
                result.trigger_fields_mr = { error: "No items provided" };
            } else {
                try {
                    var ufFileName = "field_update_" + new Date().getTime() + ".json";
                    var ufFile = file.create({
                        name: ufFileName,
                        fileType: file.Type.JSON,
                        contents: JSON.stringify(ufItems),
                        folder: -15  // SuiteScripts folder
                    });
                    var ufFileId = ufFile.save();

                    // Log field summary
                    var ufSample = ufItems[0];
                    var ufFields = ufSample.values ? Object.keys(ufSample.values).join(", ") : "legacy";
                    log.audit("TRIGGER_FIELDS_MR", "Wrote " + ufItems.length + " items to file " + ufFileId + " (" + ufFileName + ") — fields: " + ufFields);

                    var ufTask = task.create({
                        taskType: task.TaskType.MAP_REDUCE,
                        scriptId: "customscript_update_item_classes_mr",
                        deploymentId: "customdeploy_update_item_classes_mr",
                        params: { "custscript_custscript_uc_file_id": ufFileId }
                    });
                    var ufTaskId = ufTask.submit();
                    log.audit("TRIGGER_FIELDS_MR", "Submitted MR task " + ufTaskId);

                    result.trigger_fields_mr = {
                        success: true,
                        taskId: ufTaskId,
                        fileId: ufFileId,
                        fileName: ufFileName,
                        itemCount: ufItems.length,
                        fields: ufFields
                    };
                } catch (ufErr) {
                    log.error("TRIGGER_FIELDS_MR", ufErr.message);
                    result.trigger_fields_mr = { error: ufErr.message };
                }
            }
        }

        // ── PO Audit — PO number stats from ERP ─────────────────────────
        if (sections.indexOf("po_audit") >= 0) {
            try {
                var poAudit = {};

                // Total PO count
                var totalSql = "SELECT COUNT(*) AS cnt FROM transaction WHERE type = 'PurchOrd'";
                var totalRes = query.runSuiteQL({ query: totalSql }).asMappedResults();
                poAudit.total = parseInt(totalRes[0].cnt, 10);

                // POs missing otherrefnum (our po_number)
                var noRefSql = "SELECT COUNT(*) AS cnt FROM transaction WHERE type = 'PurchOrd' AND (otherrefnum IS NULL OR otherrefnum = '')";
                var noRefRes = query.runSuiteQL({ query: noRefSql }).asMappedResults();
                poAudit.missing_po_number = parseInt(noRefRes[0].cnt, 10);

                // Duplicate otherrefnum values
                var dupSql = "SELECT otherrefnum, COUNT(*) AS cnt FROM transaction WHERE type = 'PurchOrd' AND otherrefnum IS NOT NULL AND otherrefnum != '' GROUP BY otherrefnum HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC";
                var dupRes = query.runSuiteQL({ query: dupSql }).asMappedResults();
                poAudit.duplicate_po_numbers = dupRes.length;
                poAudit.duplicates = dupRes.map(function (r) {
                    return { po_number: r.otherrefnum, count: parseInt(r.cnt, 10) };
                });

                // Recent POs (last 10) — for quick reference
                var recentSql = "SELECT id, tranid, otherrefnum, status, trandate, BUILTIN.DF(entity) AS vendor FROM transaction WHERE type = 'PurchOrd' ORDER BY id DESC FETCH FIRST 10 ROWS ONLY";
                var recentRes = query.runSuiteQL({ query: recentSql }).asMappedResults();
                poAudit.recent = recentRes;

                result.po_audit = poAudit;
            } catch (poAuditErr) {
                log.error("PO_AUDIT", poAuditErr.message);
                result.po_audit = { error: poAuditErr.message };
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

    /**
     * Sanitize a key name into a valid SQL alias (letters, digits, underscores only).
     * Replaces hyphens with underscores, strips anything else.
     */
    function sanitizeAlias(key) {
        return key.replace(/-/g, "_").replace(/[^a-zA-Z0-9_]/g, "");
    }

    /**
     * Map SuiteQL ResultSet → array of objects keyed by the human-readable key names.
     * SuiteQL results come back as positional arrays in result.values.
     */
    function mapSuiteQLResults(resultSet, keyNames) {
        var items = [];
        if (!resultSet || !resultSet.results) return items;
        for (var ri = 0; ri < resultSet.results.length; ri++) {
            var vals = resultSet.results[ri].values;
            var item = {};
            for (var ki = 0; ki < keyNames.length; ki++) {
                item[keyNames[ki]] = (ki < vals.length) ? vals[ki] : null;
            }
            items.push(item);
        }
        return items;
    }

    return { post: post };
});
