/**
 * PO Audit Script
 *
 * Pulls all POs from suite_purchase_order and reports:
 *  - Total PO count
 *  - POs missing po_number
 *  - Duplicate po_numbers and how many times each repeats
 *
 * Usage: npx tsx scripts/po_audit.ts
 */

import dotenv from "dotenv";
dotenv.config();

import { MongoClient } from "mongodb";

async function run() {
    const user = encodeURIComponent(process.env.MONGO_USER || process.env.mUser || "");
    const pass = encodeURIComponent(process.env.MONGO_PASS || process.env.pUser || "");
    const host = process.env.MONGO_HOST || "64.225.124.70";
    const port = process.env.MONGO_PORT || "27017";
    const uri = process.env.MONGO_URI || `mongodb://${user}:${pass}@${host}:${port}/?authSource=admin`;

    const client = new MongoClient(uri);
    await client.connect();

    const db = client.db("netsuite");
    const collection = db.collection("suite_purchase_order");

    const allPOs = await collection.find({}).project({
        po_number: 1,
        po_type: 1,
        ns_synced: 1,
        ns_result: 1
    }).toArray();

    console.log(`\n=== PO Audit Report ===\n`);
    console.log(`Total POs: ${allPOs.length}`);

    // --- POs missing po_number ---
    const noPONumber = allPOs.filter((p: any) => !p.po_number && p.po_number !== 0);
    console.log(`POs without po_number: ${noPONumber.length}`);
    if (noPONumber.length > 0) {
        console.log(`  IDs:`, noPONumber.map((p: any) => p._id).slice(0, 20));
    }

    // --- Duplicate po_numbers ---
    const poCount: Record<string, number> = {};
    for (const po of allPOs) {
        if (po.po_number == null) continue;
        const key = String(po.po_number);
        poCount[key] = (poCount[key] || 0) + 1;
    }

    const duplicates = Object.entries(poCount)
        .filter(([_, count]) => count > 1)
        .sort((a, b) => b[1] - a[1]);

    console.log(`\nUnique po_numbers: ${Object.keys(poCount).length}`);
    console.log(`Duplicate po_numbers: ${duplicates.length}`);

    if (duplicates.length > 0) {
        console.log(`\n  PO Number     | Count`);
        console.log(`  ------------- | -----`);
        for (const [poNum, count] of duplicates) {
            console.log(`  ${poNum.padEnd(13)} | ${count}`);
        }
    }

    // --- Breakdown by type ---
    const byType: Record<string, number> = {};
    for (const po of allPOs) {
        const t = (po as any).po_type || "unknown";
        byType[t] = (byType[t] || 0) + 1;
    }
    console.log(`\nBy po_type:`);
    for (const [type, count] of Object.entries(byType)) {
        console.log(`  ${type}: ${count}`);
    }

    // --- Sync status ---
    const synced = allPOs.filter((p: any) => p.ns_synced === true).length;
    const failed = allPOs.filter((p: any) => p.ns_synced === false && p.ns_result).length;
    const pending = allPOs.length - synced - failed;
    console.log(`\nSync status:`);
    console.log(`  Synced:  ${synced}`);
    console.log(`  Failed:  ${failed}`);
    console.log(`  Pending: ${pending}`);

    console.log(`\n=== Done ===\n`);
    await client.close();
    process.exit(0);
}

run().catch(err => {
    console.error("Error:", err);
    process.exit(1);
});
