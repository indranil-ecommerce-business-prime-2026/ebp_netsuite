import { Request, Response } from "express";
import { stageSalesOrders } from "../services/sales_order.stage";

export const sales_order = async (req: Request, res: Response) => {
    try {
        const result = await stageSalesOrders();
        return res.json({ success: true, ...result });
    } catch (e: any) {
        console.error("Sales Order Error:", e);
        return res.status(500).json({ success: false, message: "Internal Server Error", error: e.message });
    }
};
