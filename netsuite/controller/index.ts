// controllers/syncMasterListToSuiteList.controller.ts
import type { Request, Response } from "express";
import { getDb } from "../config/mongdodb.config";

const SUITE_COLS = [
  "class",
  "vendorname",
  "displayname",
  "upccode",
  "cost",
  "manufacturer",
  "custitem1",
  "custitem2",
  "custitem3",
  "custitem17",
  "custitem36",
  "custitem22",
  "custitem23",
  "custitem24",
  "custitem25",
  "custitem27",
  "custitem28",
  "custitem52",
  "custitem55",
  "custitem53",
  "custitem51",
  "custitem54",
  "custitem29",
  "custitem30",
  "custitem31",
  "custitem32",
  "custitem38",
  "custitem33",
  "custitem34",
  "custitem35",
  "custitem49",
  "custitem50",
  "custitem40",
  "custitem18",
  "custitem19",
  "custitem20",
  "custitem21",
  "custitem39",
  "custitem57",
  "custitem58",
  "custitem59",
  "vendor",
  "purchase_price",
] as const;

type SuiteCol = (typeof SUITE_COLS)[number];

/* ================= helpers ================ */
const S = (v: any) => (v === null || v === undefined ? "" : String(v));
const trim = (v: any) => S(v).trim();
const toNum = (v: any) => {
  const n = Number(trim(v));
  return Number.isFinite(n) ? n : 0;
};
const asArray = <T,>(v: T | T[] | undefined | null): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

// ✅ combined hierarchy: L1:L2:L3 (skip blanks)
const pickClassName = (row: any): string | null => {
  const l1 = trim(row?.category_class);
  const l2 = trim(row?.category_class_l2);
  const l3 = trim(row?.category_class_l3);
  const parts = [l1, l2, l3].filter(Boolean);
  return parts.length ? parts.join(":") : null;
};

const normDist = (v: any) =>
  trim(v).toLowerCase().replace(/\s+/g, " ").replace(/[–—]/g, "-");

/* ================= vendor mapping ================ */
const DIST_TO_VENDOR_ID: Record<string, number> = {
  "d&h": 118,
  dandh: 118,
  "d&h – dll": 118,
  "d&h - dll": 118,

  newage: 239,
  "newage – dll": 239,
  "newage - dll": 239,

  "td synnex": 117,
  synnex: 117,
  "td synnex – dll": 117,
  "td synnex - dll": 117,

  "supplies net": 131,
  suppliesnet: 131,
  "supplies network": 131,
  supplies: 131,

  ingram: 133,
  "ingram dll": 133,
  "ingram - dll": 133,
};

function resolveVendorIdFromMaster(row: any): number | null {
  const d = normDist(row?.distributor);
  if (d && DIST_TO_VENDOR_ID[d]) return DIST_TO_VENDOR_ID[d];

  if (toNum(row?.dandh_price) > 0) return 118;
  if (toNum(row?.synnex_price) > 0) return 117;
  if (toNum(row?.ingram_price) > 0) return 133;
  if (toNum(row?.supplies_price) > 0) return 131;

  return null;
}

function resolvePurchasePriceFromMaster(row: any): number | null {
  if (row?.dist_price != null && trim(row.dist_price) !== "") {
    const n = toNum(row.dist_price);
    return n >= 0 ? n : 0;
  }

  const d = normDist(row?.distributor);
  if (d.includes("d&h") || d.includes("dandh")) return toNum(row?.dandh_price) || 0;
  if (d.includes("synnex") || d.includes("td synnex")) return toNum(row?.synnex_price) || 0;
  if (d.includes("ingram")) return toNum(row?.ingram_price) || 0;
  if (d.includes("supplies")) return toNum(row?.supplies_price) || 0;

  const candidates = [
    row?.dandh_price,
    row?.synnex_price,
    row?.ingram_price,
    row?.supplies_price,
  ].map(toNum);

  return candidates.find((x) => x > 0) ?? 0;
}

/* =========================================================
   PARSERS (product_list already has objects/arrays)
========================================================= */

/**
 * SYNNEX: product_list.synnex_response is ARRAY
 * - custitem36 = synnexSKU (first found)
 * - custitem17 = count of warehouses with qty>0 (across ALL records)
 * - custitem22.. etc = qty per warehouse number (take MAX across records)
 */
const SYNNEX_WH_MAP: Record<string, SuiteCol> = {
  "6": "custitem22",
  "502": "custitem23",
  "7": "custitem24",
  "503": "custitem25",
  "505": "custitem27",
  "12": "custitem28",
  "52": "custitem52",
  "53": "custitem53",
  "51": "custitem51",
  "54": "custitem54",
  "506": "custitem55",
};

function parseSynnexFromObj(synnexResp: any): Record<string, any> {
  const arr = Array.isArray(synnexResp) ? synnexResp : [];
  if (!arr.length) return {};

  const out: Record<string, any> = {};

  for (const node of arr) {
    const sku = trim(node?.synnexSKU);
    if (sku) {
      out.custitem36 = sku;
      break;
    }
  }

  let whInStockCount = 0;
  const whMax: Record<string, number> = {};

  for (const node of arr) {
    const whs = asArray(node?.AvailabilityByWarehouse);
    for (const w of whs) {
      const num = trim(w?.warehouseInfo?.number);
      const qty = toNum(w?.qty);
      if (!num) continue;

      if (qty > 0) whInStockCount++;

      const prev = whMax[num] ?? 0;
      if (qty > prev) whMax[num] = qty;
    }
  }

  for (const [num, qty] of Object.entries(whMax)) {
    const key = SYNNEX_WH_MAP[num];
    if (key) out[key] = qty;
  }

  out.custitem17 = whInStockCount;
  return out;
}

/**
 * D&H: product_list.dandh_response is OBJECT:
 * { status:"ok", items:[{ partNum, branches:[{branch,qty}] }] }
 */
function parseDandHFromObj(dh: any): Record<string, any> {
  const out: Record<string, any> = {};
  const items = Array.isArray(dh?.items) ? dh.items : [];
  if (!items.length) return out;

  const first = items[0];
  const partNum = trim(first?.partNum);
  if (partNum) out.custitem38 = partNum;

  let h = 0,
    ca = 0,
    ch = 0,
    at = 0;

  for (const it of items) {
    const branches = Array.isArray(it?.branches) ? it.branches : [];
    for (const b of branches) {
      const loc = trim(b?.branch).toLowerCase();
      const qty = toNum(b?.qty);

      if (loc.includes("harrisburg")) h = Math.max(h, qty);
      else if (loc.includes("california")) ca = Math.max(ca, qty);
      else if (loc.includes("chicago")) ch = Math.max(ch, qty);
      else if (loc.includes("atlanta")) at = Math.max(at, qty);
    }
  }

  out.custitem29 = h;
  out.custitem30 = ca;
  out.custitem31 = ch;
  out.custitem32 = at;

  out.custitem58 = h + ca + ch + at;
  return out;
}

/**
 * INGRAM: product_list.ingram_response is OBJECT:
 * { ingramPartNumber, availability:{ availabilityByWarehouse:[{warehouseId,location,quantityAvailable}] } }
 */
function parseIngramFromObj(obj: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!obj || typeof obj !== "object") return out;

  const ipn = trim(obj?.ingramPartNumber);
  if (ipn) out.custitem40 = ipn;

  const whs = asArray(obj?.availability?.availabilityByWarehouse);

  let mira = 0,
    carol = 0,
    hazel = 0,
    ftw = 0,
    moore = 0;

  for (const w of whs) {
    const id = trim(w?.warehouseId);
    const loc = trim(w?.location).toLowerCase();
    const qty = toNum(w?.quantityAvailable);

    if (id === "10" || loc.includes("mira loma")) mira = Math.max(mira, qty);
    else if (id === "40" || loc.includes("carol stream")) carol = Math.max(carol, qty);
    else if (id === "89" || loc.includes("hazelton")) hazel = Math.max(hazel, qty);
    else if (loc.includes("fort worth")) ftw = Math.max(ftw, qty);
    else if (loc.includes("moore")) moore = Math.max(moore, qty);
  }

  out.custitem33 = mira;
  out.custitem34 = carol;
  out.custitem35 = hazel;
  out.custitem49 = ftw;
  out.custitem50 = moore;

  out.custitem57 = mira + carol + hazel + ftw + moore;
  return out;
}

/**
 * SUPPLIES: product_list.supplies_response is OBJECT: { qqh_stl, qqh_dal, qqh_car, qqh_frn }
 */
const SUPPLIES_MAP: Record<string, SuiteCol> = {
  qqh_frn: "custitem18",
  qqh_dal: "custitem19",
  qqh_car: "custitem20",
  qqh_stl: "custitem21",
};

function parseSuppliesFromObj(
  obj: any,
  vendornameSku: string | null | undefined
): Record<string, any> {
  const out: Record<string, any> = {};
  if (!obj || typeof obj !== "object") return out;

  for (const [alias, qty] of Object.entries(obj)) {
    const key = SUPPLIES_MAP[alias];
    if (key) out[key] = toNum(qty);
  }

  out.custitem39 = vendornameSku ? trim(vendornameSku) : null;
  out.custitem59 =
    toNum(out.custitem18) + toNum(out.custitem19) + toNum(out.custitem20) + toNum(out.custitem21);

  return out;
}

/* =========================================================
   mapMasterToSuite (async: class name -> suite_class internalId)
   ========================================================= */
async function mapMasterToSuite(row: any, classMap: Map<string, string>) {
  const base: Record<SuiteCol, any> =
    Object.fromEntries(SUITE_COLS.map((c) => [c, null])) as any;

  const vendorId = resolveVendorIdFromMaster(row);
  const purchasePrice = resolvePurchasePriceFromMaster(row);

  base.vendorname = trim(row?.sku) || null;
  base.displayname = trim(row?.name ?? row?.product_name ?? row?.displayname) || null;
  base.upccode = trim(row?.upc) || null;

  base.cost = null;
  base.manufacturer = trim(row?.manufacturer_map ?? row?.manufacturer) || null;

  base.custitem1 = row?.condition ?? null;
  base.custitem2 = trim(row?.manufacturer_map ?? row?.manufacturer) || null;
  base.custitem3 = 0;

  base.vendor = vendorId;
  base.purchase_price = purchasePrice;

  // -------------------------
  // ✅ Class lookup
  // -------------------------
  const mergedClass = pickClassName(row); // "L1:L2:L3"
  if (mergedClass) {
    const internalId = classMap.get(mergedClass) || null;
    base.class = internalId; // store internalId (string) or null
  } else {
    base.class = null;
  }

  // -------------------------
  // dist parsers
  // -------------------------
  try {
    if (Array.isArray(row?.synnex_response)) Object.assign(base, parseSynnexFromObj(row.synnex_response));
  } catch {}

  try {
    if (row?.dandh_response && typeof row.dandh_response === "object")
      Object.assign(base, parseDandHFromObj(row.dandh_response));
  } catch {}

  try {
    if (row?.ingram_response && typeof row.ingram_response === "object")
      Object.assign(base, parseIngramFromObj(row.ingram_response));
  } catch {}

  try {
    if (row?.supplies_response && typeof row.supplies_response === "object")
      Object.assign(base, parseSuppliesFromObj(row.supplies_response, base.vendorname));
  } catch {}

  return base;
}

/* =========================================================
   SYNC (Mongo source → Mongo target)
   Source: master_list.product_list
   Target: netsuite.suite_list
   ========================================================= */
export const syncMasterListToSuiteList = async (req: Request, res: Response) => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;

  try {
    // SOURCE
    const masterDb: any = await getDb("master_list");
    const productCol = masterDb.collection("product_list");

    const cursor = productCol.find({});
    if (limit && limit > 0) cursor.limit(limit);

    const items = await cursor.toArray();
    if (!items.length) return res.json({ success: true, pulled: 0, upserted: 0 });

    // TARGET
    const nsDb: any = await getDb("netsuite");
    const suiteListCol = nsDb.collection("suite_list");
    const suiteClassCol = nsDb.collection("suite_class");

    // Unique SKU key on target
    await suiteListCol.createIndex({ vendorname: 1 }, { unique: true });

    // -----------------------------------------
    // ✅ Build a fast in-memory map: name -> internalId
    // -----------------------------------------
    const classDocs = await suiteClassCol
      .find({}, { projection: { name: 1, internalId: 1 } })
      .toArray();

    const classMap = new Map<string, string>();
    for (const c of classDocs) {
      const name = trim((c as any)?.name);
      const internalId = (c as any)?.internalId;
      if (name && internalId != null) classMap.set(name, String(internalId));
    }

    // 1) map with ALL custom fields (async because of classMap use, but no DB calls now)
    const suiteRows: any[] = [];
    for (const item of items) {
      suiteRows.push(await mapMasterToSuite(item, classMap));
    }

    // 2) bulk upsert (keep ALL SUITE_COLS keys)
    const ops = suiteRows
      .filter((r: any) => trim(r.vendorname))
      .map((r: any) => ({
        updateOne: {
          filter: { vendorname: r.vendorname },
          update: {
            $set: {
              ...Object.fromEntries(SUITE_COLS.map((c) => [c, r[c] ?? null])),
              updated_at: new Date(),
            },
            $setOnInsert: { created_at: new Date() },
          },
          upsert: true,
        },
      }));

    if (!ops.length) return res.json({ success: true, pulled: items.length, upserted: 0 });

    // Chunk bulkWrite
    const CHUNK = 1000;
    let inserted = 0;
    let updated = 0;

    for (let i = 0; i < ops.length; i += CHUNK) {
      const chunk = ops.slice(i, i + CHUNK);
      const result: any = await suiteListCol.bulkWrite(chunk, { ordered: false });
      inserted += result.upsertedCount ?? 0;
      updated += result.modifiedCount ?? 0;
    }

    return res.json({
      success: true,
      pulled: items.length,
      inserted,
      updated,
      upserted: inserted + updated,
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ success: false, error: err?.message ?? String(err) });
  }
};