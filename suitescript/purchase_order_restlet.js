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
 *   order_items:              [{ sku: "SKU001", qty: 2, cost: 25.00 }]
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

            if (!po_number) {
                return { success: false, error: "Missing po_number" };
            }

            // ── Check if PO already exists in NetSuite ───────────────────────
            var existingId = findPurchaseOrder(String(otherrefnum || po_number));

            if (existingId && action === "skip") {
                log.debug("SKIP", "PO " + po_number + " already exists. Skipping.");
                return { success: true, action: "skipped", po_number: po_number };
            }

            // ── Build record ─────────────────────────────────────────────────
            var po;

            if (existingId && action === "update") {
                po = record.load({ type: record.Type.PURCHASE_ORDER, id: existingId, isDynamic: true });
            } else {
                po = record.create({ type: record.Type.PURCHASE_ORDER, isDynamic: true });
            }

            // ── Vendor (required for Purchase Order) — set FIRST for sourcing
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

            // ── Invoice reference ──────────────────────────────────────────────
            if (Array.isArray(invoice) && invoice.length > 0) {
                po.setValue({ fieldId: "memo", value: website_order_number + " | INV: " + invoice[0] });
            }

            // ── Remove any pre-populated/default line items ─────────────────
            var existingLines = po.getLineCount({ sublistId: "item" });
            for (var r = existingLines - 1; r >= 0; r--) {
                po.removeLine({ sublistId: "item", line: r });
            }

            // ── Line items ───────────────────────────────────────────────────
            var linesAdded = 0;
            var skippedSkus = [];

            if (Array.isArray(order_items) && order_items.length > 0) {
                for (var i = 0; i < order_items.length; i++) {
                    var lineItem = order_items[i];
                    var sku = lineItem.sku;
                    if (!sku) continue;

                    try {
                        // Look up item by SKU → get internal ID
                        var itemCol = search.createColumn({ name: "internalid" });
                        var typeCol = search.createColumn({ name: "type" });
                        var itemResults = search.create({
                            type: search.Type.ITEM,
                            filters: [["itemid", "is", sku]],
                            columns: [itemCol, typeCol]
                        }).run().getRange({ start: 0, end: 1 });

                        if (!itemResults || itemResults.length === 0) {
                            log.debug("ITEM_NOT_FOUND", "SKU \"" + sku + "\" not in NetSuite");
                            skippedSkus.push(sku);
                            continue;
                        }

                        var itemInternalId = parseInt(itemResults[0].getValue(itemCol), 10);
                        var itemType = itemResults[0].getText(typeCol) || itemResults[0].getValue(typeCol);
                        log.debug("ITEM_FOUND", "SKU \"" + sku + "\" → ID " + itemInternalId + ", type: " + itemType);

                        var qty = parseInt(lineItem.qty, 10) || 1;
                        var cost = parseFloat(lineItem.cost) || 0;

                        po.selectNewLine({ sublistId: "item" });
                        po.setCurrentSublistValue({
                            sublistId: "item", fieldId: "item",
                            value: itemInternalId, ignoreFieldChange: false
                        });
                        po.setCurrentSublistValue({
                            sublistId: "item", fieldId: "quantity",
                            value: qty, ignoreFieldChange: false
                        });
                        po.setCurrentSublistValue({
                            sublistId: "item", fieldId: "rate",
                            value: cost, ignoreFieldChange: false
                        });
                        po.commitLine({ sublistId: "item" });

                        linesAdded++;
                        log.debug("ITEM_ADDED", "SKU \"" + sku + "\" → lines now: " + po.getLineCount({ sublistId: "item" }));
                    } catch (lineErr) {
                        log.error("ITEM_SKIP", "SKU \"" + sku + "\" — " + lineErr.message);
                        skippedSkus.push(sku);
                    }
                }
            }

            if (linesAdded === 0) {
                var skuList = Array.isArray(order_items) ? order_items.map(function (x) { return x.sku; }).join(", ") : "none";
                return { success: false, action: "no_items", po_number: po_number, skus: skuList, skipped: skippedSkus };
            }

            var savedId = po.save({ enableSourcing: true, ignoreMandatoryFields: true });
            log.debug("SUCCESS", "PO " + po_number + " saved → ID: " + savedId);

            return {
                success: true,
                action: existingId ? "updated" : "created",
                po_number: po_number,
                internalId: savedId
            };

        } catch (e) {
            log.error("ERROR", JSON.stringify({ name: e.name, message: e.message, stack: e.stack }));
            return { success: false, error: e.message };
        }
    }

    // ── Helper: find existing PO by otherrefnum ──────────────────────────────
    function findPurchaseOrder(otherrefnum) {
        var results = search.create({
            type: search.Type.PURCHASE_ORDER,
            filters: [["otherrefnum", "is", otherrefnum]],
            columns: ["internalid"]
        }).run().getRange({ start: 0, end: 1 });

        return results.length > 0 ? parseInt(results[0].getValue("internalid"), 10) : null;
    }

    return { post: post };
});
