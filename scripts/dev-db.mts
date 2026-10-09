import { MongoMemoryReplSet } from "mongodb-memory-server";
import { mkdirSync } from "node:fs";

// Local single-node replica set with on-disk data (transactions need a replica set).
const dbPath = ".data/mongo";
mkdirSync(dbPath, { recursive: true });
const rs = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
  instanceOpts: [{ port: 27027, dbPath }],
});
console.log(`Local MongoDB replica set ready.\nAdd to .env.local:\nMONGODB_URI=${rs.getUri()}`);
process.on("SIGINT", async () => {
  await rs.stop({ doCleanup: false });
  process.exit(0);
});
