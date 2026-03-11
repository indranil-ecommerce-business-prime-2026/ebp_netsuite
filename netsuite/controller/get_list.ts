import { Request, Response } from "express";
import { getDb } from "../config/mongdodb.config";

export const get_all_sales_orders = async (req: Request, res: Response) => {
    try {
 
        const db = await getDb("netsuite");
        const collection = db.collection("suite_sales_order");

        const data = await collection.find({}).toArray();

        return res.json({
            success: true,
            count: data.length,
            data
        });

    } catch (e: any) {
        console.error("Read Sales Orders Error:", e);

        return res.status(500).json({
            success: false,
            message: "Internal Server Error",
            error: e.message
        });
    }
};