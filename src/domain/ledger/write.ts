import { MongoServerError, type ClientSession, type Db, type MongoClient } from "mongodb";
import { cols, type Cols } from "../collections";
import { DomainError, InsufficientStock, NotFound, type ShortLine } from "../errors";
import type { Movement, Origin } from "../schemas";
import { allocateFifo, type Lot } from "./allocate";

// The only runtime write path for stock. Every command runs in one transaction:
//
//   command ─► commandLog insert (dup commandId → return first result)
//           ─► allocate (pure FIFO) ─► postMovements:
//                 negative qty: inventory.updateOne({.., onHand ≥ n}, {$inc: -n}); no match → abort
//                 positive qty: inventory upsert {$inc: +n}
//                 insert stockMovements
//           ─► command-specific refs (salesDays, batch status)

export interface CommandCtx {
  commandId: string;
  actor: string;
  origin: Origin;
  now?: Date;
}

export type NewMovement = Omit<Movement, "at" | "actor" | "origin"> & { at?: Date };

export async function postMovements(
  c: Cols,
  session: ClientSession,
  ctx: CommandCtx,
  movements: NewMovement[],
): Promise<void> {
  if (!movements.length) return;
  const now = ctx.now ?? new Date();
  const short: ShortLine[] = [];
  for (const m of movements) {
    const key = { branchId: m.branchId, sku: m.sku, batchId: m.batchId };
    if (m.qty < 0) {
      const res = await c.inventory.updateOne(
        { ...key, onHand: { $gte: -m.qty } },
        { $inc: { onHand: m.qty }, $set: { updatedAt: now } },
        { session },
      );
      if (res.matchedCount === 0) {
        const row = await c.inventory.findOne(key, { session });
        short.push({ branchId: m.branchId, sku: m.sku, requested: -m.qty, available: row?.onHand ?? 0 });
      }
    } else {
      await c.inventory.updateOne(
        key,
        { $inc: { onHand: m.qty }, $set: { updatedAt: now } },
        { session, upsert: true },
      );
    }
  }
  if (short.length) throw new InsufficientStock(short);
  await c.movements.insertMany(
    movements.map((m) => ({ ...m, at: m.at ?? now, actor: ctx.actor, origin: ctx.origin })),
    { session },
  );
}

// Runs fn inside a transaction, recording its result under commandId so retries are idempotent.
export async function runCommand<T>(
  client: MongoClient,
  db: Db,
  type: string,
  ctx: CommandCtx,
  fn: (c: Cols, session: ClientSession) => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const c = cols(db);
  const session = client.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      await c.commandLog.insertOne(
        { _id: ctx.commandId, type, result: null, at: ctx.now ?? new Date(), origin: ctx.origin },
        { session },
      );
      result = await fn(c, session);
      await c.commandLog.updateOne({ _id: ctx.commandId }, { $set: { result } }, { session });
    });
    return { result, replayed: false };
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000 && String(err.message).includes("commandLog")) {
      const prior = await c.commandLog.findOne({ _id: ctx.commandId });
      if (prior) return { result: prior.result as T, replayed: true };
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

async function lotsFor(c: Cols, session: ClientSession, branchId: string, sku: string): Promise<Lot[]> {
  const rows = await c.inventory.find({ branchId, sku, onHand: { $gt: 0 } }, { session }).toArray();
  if (!rows.length) return [];
  const batches = await c.batches
    .find({ _id: { $in: rows.map((r) => r.batchId) } }, { session })
    .toArray();
  const byId = new Map(batches.map((b) => [b._id, b]));
  return rows.flatMap((r) => {
    const b = byId.get(r.batchId);
    if (!b) return [];
    return [{ batchId: r.batchId, onHand: r.onHand, receivedAt: b.receivedAt, status: b.status, unbatched: b.batchCode === "UNBATCHED" }];
  });
}

function dayKey(d: Date): { id: string; day: Date } {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return { id: day.toISOString().slice(0, 10), day };
}

export interface ReceiveInput {
  branchId: string;
  sku: string;
  batchId: string;
  qty: number;
}

export async function receiveStock(c: Cols, s: ClientSession, ctx: CommandCtx, input: ReceiveInput) {
  const batch = await c.batches.findOne({ _id: input.batchId }, { session: s });
  if (!batch) throw new NotFound(`Batch ${input.batchId} not found`);
  if (batch.status === "RECALLED") {
    throw new DomainError("BATCH_RECALLED", `Batch ${batch.batchCode} is recalled; it cannot be received`, 409);
  }
  await postMovements(c, s, ctx, [
    { type: "RECEIVED", ...input, refType: "delivery", refId: ctx.commandId, attributed: false },
  ]);
  return { received: input.qty };
}

export interface SaleInput {
  branchId: string;
  lines: { sku: string; qty: number }[];
}

export async function recordSale(c: Cols, s: ClientSession, ctx: CommandCtx, input: SaleInput) {
  const now = ctx.now ?? new Date();
  const products = await c.products
    .find({ _id: { $in: input.lines.map((l) => l.sku) } }, { session: s })
    .toArray();
  const priceOf = new Map(products.map((p) => [p._id, p.price]));
  const short: ShortLine[] = [];
  const movements: NewMovement[] = [];
  const saleLines = [];
  for (const line of input.lines) {
    if (!priceOf.has(line.sku)) throw new NotFound(`Product ${line.sku} not found`);
    const { allocations, shortBy } = allocateFifo(await lotsFor(c, s, input.branchId, line.sku), line.qty);
    if (shortBy > 0) {
      short.push({ branchId: input.branchId, sku: line.sku, requested: line.qty, available: line.qty - shortBy });
      continue;
    }
    for (const a of allocations) {
      movements.push({
        type: "SOLD",
        branchId: input.branchId,
        sku: line.sku,
        batchId: a.batchId,
        qty: -a.qty,
        refType: "sale",
        refId: ctx.commandId,
        attributed: true,
      });
    }
    saleLines.push({ sku: line.sku, qty: line.qty, unitPrice: priceOf.get(line.sku)!, allocations, origin: ctx.origin });
  }
  if (short.length) throw new InsufficientStock(short);
  await postMovements(c, s, ctx, movements);
  const { id, day } = dayKey(now);
  await c.salesDays.updateOne(
    { _id: `${input.branchId}:${id}` },
    { $setOnInsert: { branchId: input.branchId, day }, $push: { lines: { $each: saleLines } } },
    { session: s, upsert: true },
  );
  const total = saleLines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
  return { lines: saleLines.length, total };
}

export interface TransferInput {
  fromBranchId: string;
  toBranchId: string;
  sku: string;
  qty: number;
}

export async function transferStock(c: Cols, s: ClientSession, ctx: CommandCtx, input: TransferInput) {
  if (input.fromBranchId === input.toBranchId) throw new RangeError("Cannot transfer to the same branch");
  const { allocations, shortBy } = allocateFifo(await lotsFor(c, s, input.fromBranchId, input.sku), input.qty);
  if (shortBy > 0) {
    throw new InsufficientStock([
      { branchId: input.fromBranchId, sku: input.sku, requested: input.qty, available: input.qty - shortBy },
    ]);
  }
  const base = { sku: input.sku, refType: "transfer" as const, refId: ctx.commandId, attributed: false };
  await postMovements(
    c,
    s,
    ctx,
    allocations.flatMap((a) => [
      { ...base, type: "TRANSFER_OUT" as const, branchId: input.fromBranchId, batchId: a.batchId, qty: -a.qty },
      { ...base, type: "TRANSFER_IN" as const, branchId: input.toBranchId, batchId: a.batchId, qty: a.qty },
    ]),
  );
  return { moved: input.qty, allocations };
}

export interface PullListRow {
  branchId: string;
  sku: string;
  batchId: string;
  units: number;
}

export interface QuarantineResult {
  batchCode: string;
  alreadyRecalled: boolean;
  recalledAt: Date;
  pullList: PullListRow[];
  units: number;
  branches: number;
}

// Marks every ACTIVE batch with this code RECALLED and pulls its current stock everywhere.
export async function quarantineBatch(
  c: Cols,
  s: ClientSession,
  ctx: CommandCtx,
  input: { batchCode: string },
): Promise<QuarantineResult> {
  const now = ctx.now ?? new Date();
  const all = await c.batches.find({ batchCode: input.batchCode }, { session: s }).toArray();
  if (!all.length) throw new NotFound(`No batch ${input.batchCode} found`);
  const active = all.filter((b) => b.status === "ACTIVE");
  if (!active.length) {
    const recalledAt = all.map((b) => b.recalledAt).filter(Boolean).sort().at(-1) ?? now;
    return { batchCode: input.batchCode, alreadyRecalled: true, recalledAt, pullList: [], units: 0, branches: 0 };
  }
  const rows = await c.inventory
    .find({ batchId: { $in: active.map((b) => b._id) }, onHand: { $gt: 0 } }, { session: s })
    .toArray();
  await postMovements(
    c,
    s,
    ctx,
    rows.map((r) => ({
      type: "RECALLED" as const,
      branchId: r.branchId,
      sku: r.sku,
      batchId: r.batchId,
      qty: -r.onHand,
      refType: "quarantine" as const,
      refId: ctx.commandId,
      attributed: false,
      at: now,
    })),
  );
  await c.batches.updateMany(
    { _id: { $in: active.map((b) => b._id) } },
    { $set: { status: "RECALLED", recalledAt: now, recallOrigin: ctx.origin } },
    { session: s },
  );
  const pullList = rows
    .map((r) => ({ branchId: r.branchId, sku: r.sku, batchId: r.batchId, units: r.onHand }))
    .sort((a, b) => a.branchId.localeCompare(b.branchId) || a.sku.localeCompare(b.sku));
  return {
    batchCode: input.batchCode,
    alreadyRecalled: false,
    recalledAt: now,
    pullList,
    units: pullList.reduce((n, r) => n + r.units, 0),
    branches: new Set(pullList.map((r) => r.branchId)).size,
  };
}
