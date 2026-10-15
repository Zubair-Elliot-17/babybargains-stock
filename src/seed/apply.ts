import type { Db } from "mongodb";
import { cols, ensureIndexes } from "@/domain/collections";
import { checkLedgerInvariants, rebuildProjection, type InvariantReport } from "@/domain/ledger/read";
import { toMongoJsonSchema } from "@/domain/mongoSchema";
import { validatedCollections } from "@/domain/schemas";
import type { SeedData } from "./generate";

export const SIZE_LIMIT_BYTES = 350 * 1024 * 1024;
const DAY = 86_400_000;

export function generatedValidators(): Record<string, { $jsonSchema: Record<string, unknown> }> {
  return Object.fromEntries(
    Object.entries(validatedCollections).map(([name, schema]) => [name, { $jsonSchema: toMongoJsonSchema(schema) }]),
  );
}

// Creates collections, applies generated validators (moderate during rollout) and indexes.
export async function migrate(db: Db, level: "strict" | "moderate" = "strict"): Promise<void> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const [name, validator] of Object.entries(generatedValidators())) {
    if (!existing.has(name)) await db.createCollection(name, { validator, validationLevel: level });
    else await db.command({ collMod: name, validator, validationLevel: level });
  }
  for (const name of ["inventory", "commandLog", "rateLimits", "ops", "branchLocks"]) {
    if (!existing.has(name)) await db.createCollection(name);
  }
  await ensureIndexes(db);
}

async function insertChunked<T extends object>(insert: (docs: T[]) => Promise<unknown>, docs: T[], size = 5000) {
  for (let i = 0; i < docs.length; i += size) await insert(docs.slice(i, i + size));
}

export interface SeedReport {
  counts: Record<string, number>;
  invariants: InvariantReport;
  bytes: number;
}

// Bulk-loads a generated dataset (documented exception to the runtime write path), then verifies it.
export async function writeSeed(db: Db, data: SeedData, anchor: Date): Promise<SeedReport> {
  await db.dropDatabase();
  await migrate(db);
  const c = cols(db);
  await c.branches.insertMany(data.branches);
  await c.suppliers.insertMany(data.suppliers);
  await insertChunked((d) => c.products.insertMany(d), data.products);
  await insertChunked((d) => c.batches.insertMany(d), data.batches);
  await insertChunked((d) => c.stockPolicies.insertMany(d), data.stockPolicies);
  await insertChunked((d) => c.salesDays.insertMany(d), data.salesDays, 1000);
  if (data.stocktakes.length) await c.stocktakes.insertMany(data.stocktakes);
  await insertChunked((d) => c.stocktakeLines.insertMany(d), data.stocktakeLines);
  await insertChunked((d) => c.movements.insertMany(d, { ordered: false }), data.movements);
  await rebuildProjection(db);
  const invariants = await checkLedgerInvariants(db);
  const stats = await db.stats();
  const bytes = Number(stats.dataSize) + Number(stats.indexSize);
  const counts = {
    products: data.products.length,
    batches: data.batches.length,
    movements: data.movements.length,
    salesDays: data.salesDays.length,
    stocktakes: data.stocktakes.length,
    stocktakeLines: data.stocktakeLines.length,
  };
  await c.ops.updateOne(
    { _id: "status" },
    { $set: { seededAt: new Date(), anchorAt: anchor, invariantsOk: invariants.ok, counts } },
    { upsert: true },
  );
  return { counts, invariants, bytes };
}

export interface ResetReport {
  shiftedDays: number;
  removed: Record<string, number>;
  restoredBatches: number;
  invariants: InvariantReport;
}

// Nightly server-side reset: removes visitor changes and shifts the dataset to end today.
export async function resetDemo(db: Db, now = new Date()): Promise<ResetReport> {
  const c = cols(db);
  const ops = await c.ops.findOne({ _id: "status" });
  if (!ops) throw new Error("No ops/status document: run `npm run seed` first.");

  const removed: Record<string, number> = {
    movements: (await c.movements.deleteMany({ origin: "visitor" })).deletedCount,
    commandLog: (await c.commandLog.deleteMany({ origin: "visitor" })).deletedCount,
    rateLimits: (await c.rateLimits.deleteMany({})).deletedCount,
  };
  removed.stocktakes = (await c.stocktakes.deleteMany({ origin: "visitor" })).deletedCount;
  removed.stocktakeLines = (await c.stocktakeLines.deleteMany({ origin: "visitor" })).deletedCount;
  removed.batches = (await c.batches.deleteMany({ createdOrigin: "visitor" })).deletedCount;
  removed.purchaseOrders = (await c.purchaseOrders.deleteMany({ origin: "visitor" })).deletedCount;
  // Visitor price lists: each changed product kept its seeded name and price (seedName/seedPrice). A list
  // applied during the reset sets them again and is undone the next night.
  removed.catalogueImports = (await c.catalogueImports.deleteMany({ origin: "visitor" })).deletedCount;
  await c.products.updateMany({ seedName: { $exists: true } }, [{ $set: { name: "$seedName", price: "$seedPrice" } }, { $unset: ["seedName", "seedPrice"] }]);
  // A visitor approving the seeded stocktake: its adjustments were visitor movements (already removed).
  await c.stocktakes.updateMany({ approvedOrigin: "visitor" }, { $set: { status: "SUBMITTED" }, $unset: { approvedAt: "", approvedOrigin: "" } });
  const restored = await c.batches.updateMany(
    { recallOrigin: "visitor" },
    { $set: { status: "ACTIVE" }, $unset: { recalledAt: "", recallOrigin: "" } },
  );
  // Visitor sales were appended to daily docs; seed lines are rebuilt from seed movements.
  await rebuildSeedSalesLines(db);

  const shiftedDays = Math.floor((now.getTime() - ops.anchorAt.getTime()) / DAY);
  if (shiftedDays > 0) {
    const ms = shiftedDays * DAY;
    const shift = (field: string) => [{ $set: { [field]: { $add: [`$${field}`, ms] } } }];
    await c.movements.updateMany({}, shift("at"));
    await c.movements.updateMany({ effectiveAt: { $exists: true } }, shift("effectiveAt"));
    await c.stocktakeLines.updateMany({}, shift("countedAt"));
    for (const field of ["openedAt", "lastActivityAt", "submittedAt", "approvedAt"]) {
      await c.stocktakes.updateMany({ [field]: { $exists: true } }, shift(field));
    }
    await c.batches.updateMany({}, shift("receivedAt"));
    await c.batches.updateMany({ recalledAt: { $exists: true } }, shift("recalledAt"));
    await shiftSalesDays(db, ms);
  }
  await rebuildProjection(db);
  const invariants = await checkLedgerInvariants(db);
  await c.ops.updateOne(
    { _id: "status" },
    {
      $set: {
        anchorAt: new Date(ops.anchorAt.getTime() + Math.max(0, shiftedDays) * DAY),
        lastResetAt: now,
        lastResetOk: invariants.ok,
        invariantsOk: invariants.ok,
      },
    },
  );
  return { shiftedDays, removed, restoredBatches: restored.modifiedCount, invariants };
}

// salesDays _id embeds the date, so shifted docs are rewritten via $out into a fresh collection.
async function shiftSalesDays(db: Db, ms: number) {
  await cols(db)
    .salesDays.aggregate([
      { $set: { day: { $add: ["$day", ms] } } },
      { $set: { _id: { $concat: ["$branchId", ":", { $dateToString: { date: "$day", format: "%Y-%m-%d" } }] } } },
      { $out: "salesDays" },
    ])
    .toArray();
}

// Drops sale lines whose allocations no longer match surviving SOLD movements (visitor sales).
async function rebuildSeedSalesLines(db: Db) {
  await cols(db)
    .salesDays.updateMany({}, [
      { $set: { lines: { $filter: { input: "$lines", as: "l", cond: { $ne: ["$$l.origin", "visitor"] } } } } },
    ]);
  await cols(db).salesDays.deleteMany({ lines: { $size: 0 } });
}
