import { MongoClient, type Db } from "mongodb";
import { dbName, mongoUri } from "@/lib/db";

// Shared connection for one-shot scripts; closes the client afterwards.
export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await MongoClient.connect(mongoUri());
  try {
    return await fn(client.db(dbName()));
  } finally {
    await client.close();
  }
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
