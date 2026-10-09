import { resetDemo } from "@/seed/apply";
import { withDb } from "./cli.mts";

// Nightly server-side reset (run by GitHub Actions). Exits non-zero if invariants fail.
await withDb(async (db) => {
  const report = await resetDemo(db);
  console.log(JSON.stringify({ db: db.databaseName, ...report }, null, 2));
  if (!report.invariants.ok) process.exitCode = 1;
});
