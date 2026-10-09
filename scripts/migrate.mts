import { migrate } from "@/seed/apply";
import { arg, withDb } from "./cli.mts";

// Applies generated validators and indexes. Use --level moderate while existing docs catch up.
const level = (arg("level") ?? "strict") as "strict" | "moderate";
await withDb(async (db) => {
  await migrate(db, level);
  console.log(`Migrated ${db.databaseName} (validationLevel=${level}).`);
});
