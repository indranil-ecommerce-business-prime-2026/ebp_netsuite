// controllers/suiteClass.controller.ts
import type { Request, Response } from "express";
import { getDb } from "../config/mongdodb.config";

export async function addSuiteClass(req: Request, res: Response) {
    try {
        const db = await getDb("netsuite");
        const collection = db.collection("suite_class");

        const payload = req.body;
   
        if (!payload) {
            return res.status(400).json({
                success: false,
                message: "Request body is required",
            });
        }

        // ✅ If array → insertMany
        if (Array.isArray(payload)) {
            if (payload.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "Array is empty",
                });
            }

            const result = await collection.insertMany(payload);

            return res.status(201).json({
                success: true,
                insertedCount: result.insertedCount,
                insertedIds: result.insertedIds,
            });
        }

        // ✅ If single object → insertOne
        const result = await collection.insertOne(payload);

        return res.status(201).json({
            success: true,
            insertedId: result.insertedId,
        });

    } catch (error: any) {
        console.error("❌ addSuiteClass error:", error);
        return res.status(500).json({
            success: false,
            message: "Internal Server Error",
            error: error.message,
        });
    }
}