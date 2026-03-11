import express, { Application, Request, Response } from "express";
import suite_list from "./route/index.route";

const app: Application = express();
app.use(express.json({ limit: "100mb" }));

// REQUIRED
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api/v4/", suite_list);

export default app;
