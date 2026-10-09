import { checkLedgerInvariants, findRecall, projectionDiff } from "@/domain/ledger/read";
import { foldMovements } from "@/domain/ledger/fold";
import { arg, withDb } from "./cli.mts";

// Checks ledger invariants and the projection; --batch prints that batch's current totals.
await withDb(async (db) => {
  const inv = await checkLedgerInvariants(db);
  const diff = await projectionDiff(db);
  console.log(JSON.stringify({ db: db.databaseName, invariantsOk: inv.ok, violations: inv.violations, projectionDiff: diff }, null, 2));
  const batch = arg("batch");
  if (batch) {
    const view = await findRecall(db, batch);
    if (view) {
      const f = foldMovements(view.movements);
      console.log(batch, f.totals, "branches with stock:", f.branches.filter((b) => b.onHand > 0).length);
    }
  }
  if (!inv.ok || diff.length) process.exitCode = 1;
});
