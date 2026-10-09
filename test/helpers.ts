import { MongoClient, type Db } from "mongodb";
import { inject } from "vitest";
import { migrate } from "@/seed/apply";

let n = 0;

// Fresh, migrated database per call on the shared replica set.
export async function freshDb(): Promise<{ client: MongoClient; db: Db; close: () => Promise<void> }> {
  const client = await MongoClient.connect(inject("mongoUri"));
  const db = client.db(`t_${process.pid}_${Date.now()}_${n++}`);
  await migrate(db);
  return {
    client,
    db,
    close: async () => {
      await db.dropDatabase();
      await client.close();
    },
  };
}
