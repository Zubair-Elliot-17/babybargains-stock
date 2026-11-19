import { resetDemo, writeSeed } from "@/seed/apply";
import { FULL, PREVIEW, generateSeed } from "@/seed/generate";
import { withDb } from "./cli.mts";

// Nightly server-side reset (run by GitHub Actions). Exits non-zero if invariants fail.
await withDb(async (db) => {
  try {
    const report = await resetDemo(db);
    console.log(JSON.stringify({ db: db.databaseName, ...report }, null, 2));
    if (report.invariants.ok) return;
  } catch (err) {
    console.error("Reset failed:", err);
  }
  // A timed-out date shift leaves the data half-shifted and the next night can't repair it, so rebuild from scratch.
  console.log(`Reseeding ${db.databaseName}`);
  const anchor = new Date();
  const profile = db.databaseName.endsWith("preview") ? PREVIEW : FULL;
  const seeded = await writeSeed(db, generateSeed({ ...profile, anchor }), anchor);
  console.log(JSON.stringify({ db: db.databaseName, reseeded: seeded.counts, invariants: seeded.invariants }, null, 2));
  if (!seeded.invariants.ok) process.exitCode = 1;
});
