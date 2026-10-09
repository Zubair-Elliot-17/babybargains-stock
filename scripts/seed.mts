import { FULL, PREVIEW, generateSeed } from "@/seed/generate";
import { SIZE_LIMIT_BYTES, writeSeed } from "@/seed/apply";
import { arg, withDb } from "./cli.mts";

// Drops and reseeds the target database. --profile full (default) | preview
const profile = arg("profile") === "preview" ? PREVIEW : FULL;
const anchor = new Date();
const started = Date.now();
const data = generateSeed({ ...profile, anchor });
console.log(`Generated ${data.movements.length} movements in ${Date.now() - started} ms`);

await withDb(async (db) => {
  const report = await writeSeed(db, data, anchor);
  const mb = (report.bytes / 1024 / 1024).toFixed(1);
  console.log(JSON.stringify({ db: db.databaseName, ...report.counts, sizeMb: Number(mb), invariants: report.invariants }, null, 2));
  if (!report.invariants.ok) throw new Error("Seed failed ledger invariants");
  if (report.bytes > SIZE_LIMIT_BYTES) throw new Error(`Seed is ${mb} MB, over the 350 MB budget`);
});
console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
