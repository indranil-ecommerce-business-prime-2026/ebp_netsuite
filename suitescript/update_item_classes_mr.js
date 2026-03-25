/**
 * UPDATE ITEM FIELDS — Generalized MapReduceScript
 *
 * Reads items from a JSON file in File Cabinet, updates each item's
 * fields via record.submitFields (10 governance units each).
 *
 * Governance resets per map() invocation — handles 70k+ items without limits.
 * Native NetSuite parallelism (up to 5 map workers).
 * Auto-retries type mismatches (InvtPart → SerializedInventoryItem).
 *
 * Supports ANY field updates — class, displayname, purchasedescription,
 * isdropshipitem, etc. — all in a single pass.
 *
 * Trigger from RESTlet:
 *   var task = require("N/task");
 *   var mrTask = task.create({
 *       taskType: task.TaskType.MAP_REDUCE,
 *       scriptId: "customscript_ebp_update_classes_mr",
 *       deploymentId: "customdeploy_ebp_update_classes_mr",
 *       params: { "custscript_uc_file_id": fileId }
 *   });
 *   var taskId = mrTask.submit();
 *
 * File format (JSON array):
 *   [{ "id": 5211, "type": "InvtPart", "values": { "class": 499, "displayname": "Xerox B225", "isdropshipitem": false } }, ...]
 *
 * Legacy format still supported (backward compatible):
 *   [{ "id": 5211, "type": "InvtPart", "classId": 499 }, ...]
 *
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(["N/file", "N/record", "N/log", "N/runtime"], function (file, record, log, runtime) {
    "use strict";

    // Script parameter — set when triggering via N/task
    var PARAM_FILE_ID = "custscript_custscript_uc_file_id";

    // String constants — record.Type.* is NOT available during define().
    // Resolved lazily via getTypeMap() inside entry-point functions.
    var _typeMap = null;
    function getTypeMap() {
        if (_typeMap) return _typeMap;
        _typeMap = {
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
        return _typeMap;
    }

    // ── getInputData ─────────────────────────────────────────────────────
    function getInputData() {
        var script = runtime.getCurrentScript();
        var fileId = script.getParameter({ name: PARAM_FILE_ID });

        // Debug: log script ID, deployment, and parameter value
        log.audit("UF_MR_DEBUG", "scriptId=" + script.id
            + " | deploymentId=" + script.deploymentId
            + " | paramName=" + PARAM_FILE_ID
            + " | fileId=" + JSON.stringify(fileId)
            + " | type=" + typeof fileId
        );

        if (!fileId) {
            log.error("UF_MR_INPUT", "No file ID — set " + PARAM_FILE_ID + " parameter. Check Parameters tab on script record.");
            return [];
        }

        var f = file.load({ id: Number(fileId) });
        var items = JSON.parse(f.getContents());
        log.audit("UF_MR_INPUT", "Loaded " + items.length + " items from file " + fileId);

        // Log field summary and type distribution for visibility
        if (items.length > 0) {
            var sample = items[0];
            var fields = sample.values ? Object.keys(sample.values) : (sample.classId ? ["class (legacy)"] : []);
            log.audit("UF_MR_FIELDS", "Fields to update: " + fields.join(", ") + " | Sample: " + JSON.stringify(sample));

            // Count items per type
            var typeCounts = {};
            for (var ti = 0; ti < items.length; ti++) {
                var t = items[ti].type || "unknown";
                typeCounts[t] = (typeCounts[t] || 0) + 1;
            }
            log.audit("UF_MR_TYPES", "Type distribution: " + JSON.stringify(typeCounts));

            // Count items per field (which fields are being set)
            var fieldCounts = {};
            for (var fi = 0; fi < items.length; fi++) {
                var vals = items[fi].values;
                if (vals) {
                    var keys = Object.keys(vals);
                    for (var ki = 0; ki < keys.length; ki++) {
                        fieldCounts[keys[ki]] = (fieldCounts[keys[ki]] || 0) + 1;
                    }
                } else if (items[fi].classId) {
                    fieldCounts["class (legacy)"] = (fieldCounts["class (legacy)"] || 0) + 1;
                }
            }
            log.audit("UF_MR_FIELD_COUNTS", "Field counts: " + JSON.stringify(fieldCounts));
        }

        return items;
    }

    // ── map ──────────────────────────────────────────────────────────────
    function map(context) {
        var entry = JSON.parse(context.value);
        var id = Number(entry.id);
        var typeMap = getTypeMap();
        var recType = typeMap[entry.type] || record.Type.INVENTORY_ITEM;

        // Build values object — support both new format { values: {...} }
        // and legacy format { classId: 499 }
        var values = entry.values;
        if (!values && entry.classId) {
            values = { "class": Number(entry.classId) };
        }

        if (!id || isNaN(id) || !values || Object.keys(values).length === 0) {
            log.debug("UF_MR_SKIP", "Invalid entry: id=" + entry.id + " type=" + entry.type + " values=" + JSON.stringify(values));
            context.write({ key: "invalid", value: "1" });
            return;
        }

        // Log first few items and every 500th for progress visibility
        var idx = Number(context.key) || 0;
        if (idx < 3 || idx % 500 === 0) {
            log.audit("UF_MR_MAP", "idx=" + idx + " id=" + id + " type=" + entry.type + " → " + recType + " fields=" + Object.keys(values).join(",") + " values=" + JSON.stringify(values));
        }

        try {
            record.submitFields({
                type: recType,
                id: id,
                values: values,
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });
            context.write({ key: "updated", value: String(id) });
        } catch (err) {
            var errMsg = err.message || "";

            // Auto-retry for type mismatch
            if (errMsg.indexOf("different type:") >= 0) {
                var typeMatch = errMsg.match(/different type:\s*(\w+)\s*from/);
                if (typeMatch && typeMatch[1]) {
                    var retryType = typeMap[typeMatch[1]];
                    if (retryType && retryType !== recType) {
                        log.audit("UF_MR_RETRY", "id=" + id + " type mismatch: " + entry.type + " → " + typeMatch[1] + " — retrying");
                        try {
                            record.submitFields({
                                type: retryType,
                                id: id,
                                values: values,
                                options: { enableSourcing: false, ignoreMandatoryFields: true }
                            });
                            context.write({ key: "retried", value: String(id) });
                            return;
                        } catch (retryErr) {
                            log.error("UF_MR_RETRY_FAIL", "id=" + id + " retried as " + typeMatch[1] + " — " + retryErr.message);
                        }
                    }
                }
            }

            log.error("UF_MR_FAIL", "id=" + id + " type=" + entry.type + " nsType=" + recType + " fields=" + Object.keys(values).join(",") + " — " + errMsg);
            context.write({ key: "failed", value: String(id) });
        }
    }

    // ── reduce ───────────────────────────────────────────────────────────
    function reduce(context) {
        // context.key = "updated" | "retried" | "failed" | "invalid"
        // context.values = array of item IDs (as strings)
        context.write({ key: context.key, value: String(context.values.length) });
    }

    // ── summarize ────────────────────────────────────────────────────────
    function summarize(summary) {
        var totals = { updated: 0, retried: 0, failed: 0, invalid: 0 };

        summary.output.iterator().each(function (key, value) {
            totals[key] = Number(value) || 0;
            return true;
        });

        var total = totals.updated + totals.retried + totals.failed + totals.invalid;
        var successRate = total > 0 ? Math.round((totals.updated + totals.retried) / total * 100) : 0;
        var elapsed = summary.seconds;

        log.audit("UF_MR_DONE", "──── SUMMARY ────"
            + "\n  Total processed: " + total
            + "\n  Updated:  " + totals.updated
            + "\n  Retried:  " + totals.retried + " (type mismatch auto-fix)"
            + "\n  Failed:   " + totals.failed
            + "\n  Invalid:  " + totals.invalid
            + "\n  Success:  " + successRate + "%"
            + "\n  Elapsed:  " + elapsed + "s"
            + "\n  Rate:     " + (total > 0 ? (total / elapsed).toFixed(1) : 0) + " items/sec"
        );

        // Log concurrency stats
        log.audit("UF_MR_CONCURRENCY", "Map concurrency used: " + (summary.mapSummary.concurrency || "N/A"));

        // Log input errors
        if (summary.inputSummary && summary.inputSummary.error) {
            log.error("UF_MR_INPUT_ERROR", summary.inputSummary.error);
        }

        // Log map errors (first 20)
        var mapErrCount = 0;
        summary.mapSummary.errors.iterator().each(function (k, err) {
            mapErrCount++;
            if (mapErrCount <= 20) {
                log.error("UF_MR_MAP_ERROR", "key=" + k + " — " + err);
            }
            return true;
        });
        if (mapErrCount > 0) {
            log.error("UF_MR_MAP_ERRORS_TOTAL", "Total map errors: " + mapErrCount);
        }

        // Log reduce errors
        var reduceErrCount = 0;
        summary.reduceSummary.errors.iterator().each(function (k, err) {
            reduceErrCount++;
            if (reduceErrCount <= 10) {
                log.error("UF_MR_REDUCE_ERROR", "key=" + k + " — " + err);
            }
            return true;
        });
        if (reduceErrCount > 0) {
            log.error("UF_MR_REDUCE_ERRORS_TOTAL", "Total reduce errors: " + reduceErrCount);
        }
    }

    return { getInputData: getInputData, map: map, reduce: reduce, summarize: summarize };
});
