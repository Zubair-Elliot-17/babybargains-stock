import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { writeSeed } from "@/seed/apply";
import { PREVIEW, generateSeed } from "@/seed/generate";

// Self-contained E2E backend: in-memory replica set + preview seed + Next server.
const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
const uri = rs.getUri();
const URI_FILE = ".data/e2e-mongo-uri"; // read by specs that check the ledger after their writes
mkdirSync(".data", { recursive: true });
writeFileSync(URI_FILE, uri);
const client = await MongoClient.connect(uri);
const anchor = new Date();
const report = await writeSeed(client.db("bb_e2e"), generateSeed({ ...PREVIEW, anchor }), anchor);
await client.close();
if (!report.invariants.ok) throw new Error("E2E seed failed invariants");

const prod = process.env.E2E_PROD === "1";
const next = spawn("npx", ["next", prod ? "start" : "dev", "-p", "3200"], {
  stdio: "inherit",
  env: { ...process.env, MONGODB_URI: uri, MONGODB_DB: "bb_e2e", SESSION_SECRET: "e2e-secret-that-is-at-least-32-characters" },
});
const stop = async () => {
  next.kill("SIGTERM");
  await rs.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
