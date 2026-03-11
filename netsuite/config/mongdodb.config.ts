import mongoose, { Connection } from "mongoose";

let baseConnection: Connection | null = null;

export async function connectMongoBase(): Promise<Connection> {
  if (baseConnection) return baseConnection;

  const user = encodeURIComponent(process.env.mUser || "");
  const pass = encodeURIComponent(process.env.pUser || "");
  const host = "64.225.124.70";
  const port = "27017";
  const uri = `mongodb://${user}:${pass}@${host}:${port}/?authSource=admin`;

  const m = await mongoose.connect(uri);
  baseConnection = m.connection;
  return baseConnection;
}

// ✅ No "mongodb" import here
export async function getDb(dbName: string) {
  const baseConn = await connectMongoBase();
  const conn = baseConn.useDb(dbName, { useCache: true });

  if (!conn.db) throw new Error("Mongo DB not ready");
  return conn.db; // inferred type from mongoose's mongodb
}