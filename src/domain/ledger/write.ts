import { createHash } from "node:crypto";
import { MongoServerError, type ClientSession, type Db, type MongoClient } from "mongodb";
import { cols, type Cols } from "../collections";
import { DomainError, InsufficientStock, NotFound, type ShortLine } from "../errors";
import type { Movement, Origin, Stocktake } from "../schemas";
import { allocateFifo, type Lot } from "./allocate";
import { computeStocktakePlan, loadTransferInputs } from "./read";
import { countKey, foldCounts, unbatchedBatchId } from "./stocktake";
import { suggestForSku } from "./transfers";

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

// Commands that read "is a stocktake open here?" and commands that open or close one touch no shared
// document otherwise, so two such transactions could both commit (write skew). Writing the branch
// docs makes them conflict; withTransaction retries the loser, which then sees the other's result.
async function lockBranches(c: Cols, s: ClientSession, branchIds: string[]) {
  await c.branches.updateMany({ _id: { $in: branchIds } }, { $inc: { lockRev: 1 } }, { session: s });
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
  if (input.fromBranchId === input.toBranchId) throw new DomainError("SAME_BRANCH", "Pick two different branches", 400);
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

// Accept re-derives the suggestion inside the transaction, so a stale screen can never move more
// than the ledger supports right now.
export async function acceptTransferSuggestion(c: Cols, s: ClientSession, ctx: CommandCtx, input: TransferInput) {
  if (input.fromBranchId === input.toBranchId) throw new DomainError("SAME_BRANCH", "Pick two different branches", 400);
  await lockBranches(c, s, [input.fromBranchId, input.toBranchId]);
  const open = await c.stocktakes.distinct("branchId", { branchId: { $in: [input.fromBranchId, input.toBranchId] }, status: "OPEN" }, { session: s });
  if (open.length) {
    throw new DomainError("STOCKTAKE_OPEN", "A stocktake is in progress at one of these branches. Try again once it is submitted", 409, { branchIds: open });
  }
  const [stock] = await loadTransferInputs(c, ctx.now ?? new Date(), { sku: input.sku, session: s });
  const fresh = stock ? suggestForSku(stock).find((x) => x.fromBranchId === input.fromBranchId && x.toBranchId === input.toBranchId) : undefined;
  const suggestedQty = fresh?.qty ?? 0;
  if (input.qty > suggestedQty) {
    throw new DomainError(
      "SUGGESTION_STALE",
      suggestedQty ? `Stock has changed. The suggestion is now ${suggestedQty}` : "Stock has changed. This transfer is no longer suggested",
      409,
      { suggestedQty },
    );
  }
  return transferStock(c, s, ctx, input);
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

// ── Stocktakes ───────────────────────────────────────────────────────────────

const STALE_MS = 2 * 3_600_000; // an idle OPEN stocktake can be taken over after 2 hours

export interface OpenInput {
  branchId: string;
  sid: string;
  clerkLabel: string;
}

// Resumes the clerk's OPEN stocktake for the branch, takes over an idle one, or opens a new one.
export async function openStocktake(c: Cols, s: ClientSession, ctx: CommandCtx, input: OpenInput): Promise<Stocktake> {
  const now = ctx.now ?? new Date();
  await lockBranches(c, s, [input.branchId]);
  const open = await c.stocktakes.findOne({ branchId: input.branchId, status: "OPEN" }, { session: s });
  if (open) {
    if (open.openedBy !== input.sid && now.getTime() - open.lastActivityAt.getTime() < STALE_MS) {
      throw new DomainError("STOCKTAKE_BUSY", "This branch's stocktake is in progress on another device", 409, {
        clerkLabel: open.clerkLabel,
        lastActivityAt: open.lastActivityAt,
      });
    }
    const update = { openedBy: input.sid, clerkLabel: input.clerkLabel, lastActivityAt: now };
    await c.stocktakes.updateOne({ _id: open._id }, { $set: update }, { session: s });
    return { ...open, ...update };
  }
  const branch = await c.branches.findOne({ _id: input.branchId }, { session: s });
  if (!branch) throw new NotFound(`Branch ${input.branchId} not found`);
  const doc: Stocktake = {
    _id: `ST-${branch.code}-${now.toISOString().slice(0, 10)}-${createHash("sha1").update(ctx.commandId).digest("hex").slice(0, 8)}`,
    branchId: input.branchId,
    status: "OPEN",
    openedAt: now,
    openedBy: input.sid,
    clerkLabel: input.clerkLabel,
    lastActivityAt: now,
    origin: ctx.origin,
  };
  await c.stocktakes.insertOne(doc, { session: s }); // partial unique index refuses a second OPEN per branch
  return doc;
}

async function ownedOpen(c: Cols, s: ClientSession, stocktakeId: string, sid: string): Promise<Stocktake> {
  const st = await c.stocktakes.findOne({ _id: stocktakeId }, { session: s });
  if (!st) throw new NotFound(`Stocktake ${stocktakeId} not found`);
  if (st.status !== "OPEN") throw new DomainError("STOCKTAKE_CLOSED", `Stocktake was ${st.status.toLowerCase()} at ${st.submittedAt?.toISOString() ?? ""}`, 409, { status: st.status, submittedAt: st.submittedAt });
  if (st.openedBy !== sid) throw new DomainError("STOCKTAKE_BUSY", "This stocktake is being counted on another device", 409);
  return st;
}

export interface CountLineInput {
  stocktakeId: string;
  lineId: string;
  sid: string;
  sku: string;
  batchId?: string;
  counted: number;
  mode: "add" | "replace";
}

export async function saveCountLine(c: Cols, s: ClientSession, ctx: CommandCtx, input: CountLineInput) {
  const now = ctx.now ?? new Date();
  await ownedOpen(c, s, input.stocktakeId, input.sid);
  const product = await c.products.findOne({ _id: input.sku }, { session: s });
  if (!product) throw new NotFound(`Product ${input.sku} not found`);
  if (product.batchTracked && !input.batchId) throw new DomainError("BATCH_REQUIRED", "Scan or pick the batch for this product", 400);
  if (!product.batchTracked && input.batchId) throw new DomainError("BATCH_NOT_TRACKED", "This product is counted without a batch", 400);
  if (input.batchId) {
    const batch = await c.batches.findOne({ _id: input.batchId }, { session: s });
    if (!batch || batch.sku !== input.sku) throw new DomainError("BATCH_MISMATCH", "That batch label belongs to a different product", 400);
  }
  await c.stocktakeLines.insertOne(
    {
      _id: input.lineId, stocktakeId: input.stocktakeId, sku: input.sku, counted: input.counted, mode: input.mode,
      countedAt: now, clerkId: input.sid, origin: ctx.origin,
      ...(input.batchId ? { batchId: input.batchId } : {}), // undefined would be stored as null and fail validation
    },
    { session: s },
  );
  await c.stocktakes.updateOne({ _id: input.stocktakeId }, { $set: { lastActivityAt: now } }, { session: s });
  const entries = await c.stocktakeLines
    .find({ stocktakeId: input.stocktakeId, sku: input.sku, batchId: input.batchId ?? { $exists: false } }, { session: s })
    .sort({ countedAt: 1, _id: 1 })
    .toArray();
  const effective = foldCounts(entries).get(countKey(input.sku, input.batchId));
  return { lineId: input.lineId, counted: effective?.counted ?? input.counted, countedAt: now };
}

export interface SubmitInput {
  stocktakeId: string;
  sid: string;
  uncounted: "zero" | "leave";
}

// "zero" records every uncounted product as 0 at submit time; "leave" posts nothing for them.
export async function submitStocktake(c: Cols, s: ClientSession, ctx: CommandCtx, input: SubmitInput) {
  const now = ctx.now ?? new Date();
  const st = await ownedOpen(c, s, input.stocktakeId, input.sid);
  await lockBranches(c, s, [st.branchId]);
  let zeroed = 0;
  if (input.uncounted === "zero") {
    const counted = new Set(await c.stocktakeLines.distinct("sku", { stocktakeId: st._id }, { session: s }));
    const products = await c.products.find({ _id: { $nin: [...counted] } }, { session: s, projection: { batchTracked: 1 } }).toArray();
    const rows = await c.inventory.find({ branchId: st.branchId, sku: { $in: products.map((p) => p._id) }, onHand: { $gt: 0 } }, { session: s }).toArray();
    const docs = products.flatMap((p, i) => {
      const base = { stocktakeId: st._id, counted: 0, mode: "replace" as const, countedAt: now, clerkId: input.sid, origin: ctx.origin };
      if (!p.batchTracked) return [{ ...base, _id: `${ctx.commandId}-z${i}`, sku: p._id }];
      return rows.filter((r) => r.sku === p._id).map((r, j) => ({ ...base, _id: `${ctx.commandId}-z${i}-${j}`, sku: p._id, batchId: r.batchId }));
    });
    if (docs.length) await c.stocktakeLines.insertMany(docs, { session: s });
    zeroed = products.length;
  }
  await c.stocktakes.updateOne(
    { _id: st._id },
    { $set: { status: "SUBMITTED", submittedAt: now, uncounted: input.uncounted, lastActivityAt: now } },
    { session: s },
  );
  const productsCounted = (await c.stocktakeLines.distinct("sku", { stocktakeId: st._id }, { session: s })).length;
  return { stocktakeId: st._id, submittedAt: now, productsCounted, zeroed, startedAt: st.openedAt };
}

export interface ApproveInput {
  stocktakeId: string;
  acceptedKeys: string[]; // every flagged line must be explicitly accepted
}

export async function approveStocktake(c: Cols, s: ClientSession, ctx: CommandCtx, input: ApproveInput) {
  const now = ctx.now ?? new Date();
  const plan = await computeStocktakePlan(c, input.stocktakeId, s);
  if (plan.stocktake.status !== "SUBMITTED") {
    throw new DomainError("NOT_SUBMITTED", `Stocktake is ${plan.stocktake.status.toLowerCase()}`, 409);
  }
  const accepted = new Set(input.acceptedKeys);
  const missing = plan.lines.filter((l) => l.flagged && !accepted.has(l.key)).map((l) => l.key);
  if (missing.length) throw new DomainError("REVIEW_REQUIRED", `Review ${missing.length} flagged line(s) before approving`, 400, { missing });

  for (const line of plan.lines.filter((l) => l.needsUnbatched)) {
    const id = unbatchedBatchId(line.supplierId, line.sku);
    const parent = await c.products.findOne({ _id: line.sku }, { session: s, projection: { parentSku: 1 } });
    await c.batches.updateOne(
      { _id: id },
      { $setOnInsert: { supplierId: line.supplierId, batchCode: "UNBATCHED", sku: line.sku, parentSku: parent?.parentSku ?? line.sku, receivedAt: now, status: "ACTIVE", createdOrigin: ctx.origin } },
      { session: s, upsert: true },
    );
  }
  const movements: NewMovement[] = plan.lines.flatMap((l) =>
    l.adjustments.map((a) => ({
      type: "ADJUSTMENT" as const,
      at: now,
      effectiveAt: l.countedAt,
      branchId: plan.stocktake.branchId,
      sku: l.sku,
      batchId: a.batchId,
      qty: a.qty,
      refType: "stocktake" as const,
      refId: plan.stocktake._id,
      attributed: a.attributed,
    })),
  );
  await postMovements(c, s, ctx, movements);
  await c.stocktakes.updateOne({ _id: plan.stocktake._id }, { $set: { status: "APPROVED", approvedAt: now, approvedOrigin: ctx.origin } }, { session: s });
  const up = movements.filter((m) => m.qty > 0).reduce((n, m) => n + m.qty, 0);
  const down = -movements.filter((m) => m.qty < 0).reduce((n, m) => n + m.qty, 0);
  return {
    stocktakeId: plan.stocktake._id,
    approvedAt: now,
    lines: plan.lines.length,
    adjustedLines: plan.lines.filter((l) => l.adjustments.length).length,
    unitsAdded: up,
    unitsRemoved: down,
    valuePence: plan.lines.reduce((n, l) => n + l.valuePence, 0),
  };
}
