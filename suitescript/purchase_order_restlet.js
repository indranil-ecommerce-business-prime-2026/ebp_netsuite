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
 * NOTE: This RESTlet shares the same URL pattern as the Sales Order RESTlet
 * but uses record_type = "purchaseorder" in the payload to differentiate.
 * You can deploy both as separate scripts, OR merge into one RESTlet that
 * routes by record_type.
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
define(["N/record", "N/search", "N/log"], (record, search, log) => {

    const post = (payload) => {
        try {
            const {
                action,
                po_number,
                otherrefnum,
                vendor_id,
                distributor,
                distributor_order_number,
                status,
                invoice,
                tracking,
                website_order_number,
                order_items
            } = payload;

            if (!po_number) {
                return { success: false, error: "Missing po_number" };
            }

            // ── Check if PO already exists in NetSuite ───────────────────────
            const existingId = findPurchaseOrder(otherrefnum, search);

            if (existingId && action === "skip") {
                log.debug("SKIP", `PO ${po_number} already exists. Skipping.`);
                return { success: true, action: "skipped", po_number };
            }

            // ── Build record ─────────────────────────────────────────────────
            let po;

            if (existingId && action === "update") {
                po = record.load({ type: record.Type.PURCHASE_ORDER, id: existingId, isDynamic: true });
            } else {
                po = record.create({ type: record.Type.PURCHASE_ORDER, isDynamic: true });
            }

            // ── Standard fields ──────────────────────────────────────────────
            po.setValue({ fieldId: "otherrefnum", value: String(po_number) });
            po.setValue({ fieldId: "trandate",    value: new Date() });
            po.setValue({ fieldId: "memo",        value: website_order_number || "" });

            // ── Vendor (required for Purchase Order) ─────────────────────────
            if (vendor_id) {
                po.setValue({ fieldId: "entity", value: vendor_id });
            }

            // ── Existing custom fields (from TransactionBodyFields export) ───
            po.setValue({ fieldId: "custbody2", value: String(distributor_order_number || po_number) }); // "Disti PO Number"
            po.setValue({ fieldId: "custbody1", value: status || "" });                                  // "Shipping Status"

            // ── Distributor name → custbody_otherrefnumber_custom ("PO#") ───
            if (distributor) {
                po.setValue({ fieldId: "custbody_otherrefnumber_custom", value: String(distributor) });
            }

            // ── Invoice reference (first invoice entry if array) ─────────────
            if (Array.isArray(invoice) && invoice.length > 0) {
                po.setValue({ fieldId: "memo", value: `${website_order_number || ""} | INV: ${invoice[0]}` });
            }

            // ── Tracking ─────────────────────────────────────────────────────
            // custbody_ebp_tracking — create this field in NetSuite if needed
            // Go to: Customization → Lists, Records & Fields → Transaction Body Fields → New
            //   Label: Tracking Number | ID: custbody_ebp_tracking | Type: Free-Form Text | Applies to: Purchase
            // Once created, uncomment:
            // if (tracking) po.setValue({ fieldId: "custbody_ebp_tracking", value: tracking });

            // ── Line items ───────────────────────────────────────────────────
            if (Array.isArray(order_items)) {
                order_items.forEach((item) => {
                    po.selectNewLine({ sublistId: "item" });
                    po.setCurrentSublistValue({ sublistId: "item", fieldId: "item",     value: item.sku });
                    po.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: Number(item.qty || 0) });
                    po.setCurrentSublistValue({ sublistId: "item", fieldId: "rate",     value: Number(item.cost || 0) });
                    po.commitLine({ sublistId: "item" });
                });
            }

            const savedId = po.save();

            log.debug("SUCCESS", `PO ${po_number} saved with internal ID: ${savedId}`);

            return {
                success: true,
                action: existingId ? "updated" : "created",
                po_number,
                internalId: savedId
            };

        } catch (e) {
            log.error("ERROR", e.message);
            return { success: false, error: e.message };
        }
    };

    // ── Helper: find existing PO by otherrefnum ──────────────────────────────
    const findPurchaseOrder = (otherrefnum, search) => {
        const results = search.create({
            type: search.Type.PURCHASE_ORDER,
            filters: [["otherrefnum", "is", otherrefnum]],
            columns: ["internalid"]
        }).run().getRange({ start: 0, end: 1 });

        return results.length > 0 ? results[0].getValue("internalid") : null;
    };

    return { post };
});
