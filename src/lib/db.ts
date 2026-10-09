import { MongoClient, type Db } from "mongodb";

// One cached client per server instance; small pool for serverless + Atlas M0 connection caps.
const g = globalThis as unknown as { __bbClient?: Promise<MongoClient> };

export function mongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set. Run `npm run db:local` or add it to .env.local.");
  return uri;
}

export function dbName(): string {
  return process.env.MONGODB_DB ?? "bb_demo";
}

export function getClient(): Promise<MongoClient> {
  g.__bbClient ??= new MongoClient(mongoUri(), { maxPoolSize: 5, maxIdleTimeMS: 60_000 }).connect();
  return g.__bbClient;
}

export async function getDb(): Promise<Db> {
  return (await getClient()).db(dbName());
}
