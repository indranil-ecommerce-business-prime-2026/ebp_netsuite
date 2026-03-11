import { getDb } from "../config/mongdodb.config";
import { Request, Response } from "express";

export async function getSuiteList(req: Request, res: Response) {
    try {
        const db = await getDb("netsuite");
        const suitelist = db.collection("suite_list");

        // ✅ Query Params
        const pageSize = Math.max(parseInt(String(req.query.pageSize)) || 20, 1);
        const pageNumber = Math.max(parseInt(String(req.query.pageNumber)) || 1, 1);
        const vendorName = String(req.query.vendorName || "").trim();

        const skip = (pageNumber - 1) * pageSize;

        // ✅ Build filter
        const filter: any = {};

        if (vendorName) {
            filter.vendorname = { $regex: vendorName }; // case-insensitive partial match
        }

        // ✅ Get total count with filter
        const total = await suitelist.countDocuments(filter);

        // ✅ Fetch paginated data
        const data = await suitelist
            .find(filter)
            .skip(skip)
            .limit(pageSize)
            .toArray();

        return res.json({
            success: true,
            pageNumber,
            pageSize,
            total,
            totalPages: Math.ceil(total / pageSize),
            data,
        });

    } catch (e: any) {
        console.error("getSuiteList error:", e);
        return res.status(500).json({
            success: false,
            message: "Internal Server Error",
            error: e.message,
        });
    }
}