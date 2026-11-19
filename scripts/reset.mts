import { SIZE_LIMIT_BYTES, resetDemo, writeSeed } from "@/seed/apply";
import { cols } from "@/domain/collections";
import { FULL, PREVIEW, generateSeed } from "@/seed/generate";
import { withDb } from "./cli.mts";

// Nightly server-side reset (run by GitHub Actions). Exits non-zero if the reset needed repairing.
await withDb(async (db) => {
  // Never reseed a database that was not seeded before (wrong URI or db name).
  if (!(await cols(db).ops.findOne({ _id: "status" }))) throw new Error(`No ops/status document in ${db.databaseName}: run \`npm run seed\` first.`);
  try {
    const report = await resetDemo(db);
    console.log(JSON.stringify({ db: db.databaseName, ...report }, null, 2));
    if (report.invariants.ok) return;
  } catch (err) {
    console.error("Reset failed:", err);
  }
  // A timed-out date shift leaves the data half-shifted and the next night can't repair it, so rebuild from scratch.
  // The run still ends red so a recurring reset bug is seen.
  process.exitCode = 1;
  console.log(`Reseeding ${db.databaseName}`);
  const anchor = new Date();
  const profile = db.databaseName === "bb_preview" ? PREVIEW : FULL;
  const seeded = await writeSeed(db, generateSeed({ ...profile, anchor }), anchor);
  console.log(JSON.stringify({ db: db.databaseName, reseeded: seeded.counts, invariants: seeded.invariants }, null, 2));
  if (!seeded.invariants.ok || seeded.bytes > SIZE_LIMIT_BYTES) throw new Error("Reseed failed invariants or the size budget");
});
