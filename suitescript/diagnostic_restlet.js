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
                 "custitem_item_360_itemclass", "baseprice", "cost"],
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

        log.audit("DIAGNOSTIC", "Sections: " + sections.join(", "));
        return result;
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function runSearch(type, columns, filters, limit) {
        try {
            var rows = [];
            search.create({ type: type, columns: columns, filters: filters })
                .run().each(function (r) {
                    var row = {};
                    columns.forEach(function (c) { row[c] = r.getValue(c); });
                    rows.push(row);
                    return rows.length < limit;
                });
            return rows;
        } catch (e) { return "Error: " + e.message; }
    }

    function runSearchWithText(type, columns, textColumns, filters, limit) {
        try {
            var rows = [];
            search.create({ type: type, columns: columns, filters: filters })
                .run().each(function (r) {
                    var row = {};
                    columns.forEach(function (c) {
                        row[c] = r.getValue(c);
                        if (textColumns.indexOf(c) >= 0) {
                            var txt = r.getText(c);
                            if (txt) row[c + "_text"] = txt;
                        }
                    });
                    rows.push(row);
                    return rows.length < limit;
                });
            return rows;
        } catch (e) { return "Error: " + e.message; }
    }

    return { post: post };
});
