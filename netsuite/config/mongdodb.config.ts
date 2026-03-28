import mongoose, { Connection } from "mongoose";

let baseConnection: Connection | null = null;

export async function connectMongoBase(): Promise<Connection> {
  if (baseConnection) return baseConnection;

  const user = encodeURIComponent(process.env.MONGO_USER || process.env.mUser || "");
  const pass = encodeURIComponent(process.env.MONGO_PASS || process.env.pUser || "");
  const host = process.env.MONGO_HOST || "64.225.124.70";
  const port = process.env.MONGO_PORT || "27017";
  const uri = process.env.MONGO_URI || `mongodb://${user}:${pass}@${host}:${port}/?authSource=admin`;

  const m = await mongoose.connect(uri);
  baseConnection = m.connection;
  return baseConnection;
}

// ✅ No "mongodb" import here
export async function getDb(dbName: string) {
  const baseConn = await connectMongoBase();

  // Wait for the connection to be fully open before using .db
  if (baseConn.readyState !== 1) {
    await new Promise<void>((resolve) => baseConn.once("open", resolve));
  }

  const conn = baseConn.useDb(dbName, { useCache: true });

  if (!conn.db) throw new Error("Mongo DB not ready");
  return conn.db; // inferred type from mongoose's mongodb
}