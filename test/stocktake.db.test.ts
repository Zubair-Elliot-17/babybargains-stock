import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cols } from "@/domain/collections";
import { DomainError } from "@/domain/errors";
import { checkLedgerInvariants, computeStocktakePlan, findRecall, projectionDiff } from "@/domain/ledger/read";
import { approveStocktake, openStocktake, quarantineBatch, receiveStock, recordSale, saveCountLine, submitStocktake } from "@/domain/ledger/write";
import { migrate } from "@/seed/apply";
import { freshDb } from "./helpers";
import { COT, NEW, OLD, TOY, TOYB, buildWorld, ctx, runner } from "./world";

let t: Awaited<ReturnType<typeof freshDb>>;
let run: ReturnType<typeof runner>;
let seq = 0;
const lineId = () => `line-${process.pid}-${seq++}`;

beforeAll(async () => (t = await freshDb()));
afterAll(() => t.close());
beforeEach(async () => {
  await t.db.dropDatabase();
  await migrate(t.db);
  await buildWorld(t.db);
  run = runner(t.client, t.db);
  await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-A", sku: COT, batchId: OLD, qty: 2 }));
  await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-A", sku: COT, batchId: NEW, qty: 3 }));
  await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-A", sku: TOY, batchId: TOYB, qty: 4 }));
});

const open = (sid = "clerk-1") => run((c, s, k) => openStocktake(c, s, k, { branchId: "BR-A", sid, clerkLabel: `Clerk ${sid}` }));
const count = (stocktakeId: string, sku: string, counted: number, batchId?: string, mode: "add" | "replace" = "replace", sid = "clerk-1") =>
  run((c, s, k) => saveCountLine(c, s, k, { stocktakeId, lineId: lineId(), sid, sku, batchId, counted, mode }));
const onHand = async (batchId: string) => (await cols(t.db).inventory.findOne({ branchId: "BR-A", batchId }))?.onHand ?? 0;

describe("stocktake lifecycle", () => {
  it("resumes the clerk's open stocktake and refuses a second clerk while active", async () => {
    const a = (await open()).result;
    expect((await open()).result._id).toBe(a._id);
    const err = await open("clerk-2").catch((e) => e);
    expect(err).toMatchObject({ code: "STOCKTAKE_BUSY" });
  });

  it("lets another clerk take over a stocktake idle for 2 hours", async () => {
    const a = (await open()).result;
    await cols(t.db).stocktakes.updateOne({ _id: a._id }, { $set: { lastActivityAt: new Date(Date.now() - 3 * 3_600_000) } });
    const b = (await open("clerk-2")).result;
    expect(b).toMatchObject({ _id: a._id, openedBy: "clerk-2" });
  });

  it("enforces batch capture for batch-tracked products and ownership", async () => {
    const st = (await open()).result;
    await expect(count(st._id, COT, 1)).rejects.toMatchObject({ code: "BATCH_REQUIRED" });
    await expect(count(st._id, TOY, 1, TOYB)).rejects.toMatchObject({ code: "BATCH_NOT_TRACKED" });
    await expect(count(st._id, COT, 1, TOYB)).rejects.toMatchObject({ code: "BATCH_MISMATCH" });
    await expect(count(st._id, TOY, 1, undefined, "replace", "intruder")).rejects.toMatchObject({ code: "STOCKTAKE_BUSY" });
  });

  it("add sums across locations and the response reports the running count", async () => {
    const st = (await open()).result;
    await count(st._id, TOY, 1);
    const r = await count(st._id, TOY, 2, undefined, "add");
    expect(r.result.counted).toBe(3);
  });

  it("measures variance at count time, so sales during the count are not variances", async () => {
    const st = (await open()).result;
    await count(st._id, TOY, 4); // matches system stock when counted
    await run((c, s, k) => recordSale(c, s, k, { branchId: "BR-A", lines: [{ sku: TOY, qty: 1 }] })); // sold afterwards
    await run((c, s, k) => submitStocktake(c, s, k, { stocktakeId: st._id, sid: "clerk-1", uncounted: "leave" }));
    const plan = await computeStocktakePlan(cols(t.db), st._id);
    expect(plan.lines.map((l) => [l.sku, l.expected, l.variance])).toEqual([[TOY, 4, 0]]);
  });

  it("approval posts FIFO adjustments, requires flagged lines to be accepted, and keeps the ledger exact", async () => {
    const st = (await open()).result;
    await count(st._id, TOY, 1); // -3 → flagged
    await count(st._id, COT, 1, OLD); // batch line: -1, but £100 → flagged by value
    await count(st._id, COT, 3, NEW); // matches
    await run((c, s, k) => submitStocktake(c, s, k, { stocktakeId: st._id, sid: "clerk-1", uncounted: "leave" }));

    const plan = await computeStocktakePlan(cols(t.db), st._id);
    const flagged = plan.lines.filter((l) => l.flagged).map((l) => l.key).sort();
    expect(flagged).toEqual([`${COT}|${OLD}`, `${TOY}|`]);

    const err = await run((c, s, k) => approveStocktake(c, s, k, { stocktakeId: st._id, acceptedKeys: [`${TOY}|`] })).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: "REVIEW_REQUIRED", details: { missing: [`${COT}|${OLD}`] } });

    const { result } = await run((c, s, k) => approveStocktake(c, s, k, { stocktakeId: st._id, acceptedKeys: flagged }));
    expect(result).toMatchObject({ adjustedLines: 2, unitsRemoved: 4, unitsAdded: 0 });
    expect(await onHand(TOYB)).toBe(1);
    expect(await onHand(OLD)).toBe(1);
    const adj = await cols(t.db).movements.find({ type: "ADJUSTMENT" }).toArray();
    expect(adj.every((m) => m.effectiveAt && m.refType === "stocktake")).toBe(true);
    expect((await checkLedgerInvariants(t.db)).violations).toEqual([]);
    expect(await projectionDiff(t.db)).toEqual([]);

    // The recall view now shows the batch as counted at this branch.
    const view = await findRecall(t.db, "B-1");
    expect(Object.keys(view!.lastCountedAt)).toEqual(["BR-A"]);
  });

  it("'count as zero' records uncounted products, and surplus with no active batch goes to UNBATCHED", async () => {
    const st = (await open()).result;
    await run((c, s, k) => submitStocktake(c, s, k, { stocktakeId: st._id, sid: "clerk-1", uncounted: "zero" }));
    const plan = await computeStocktakePlan(cols(t.db), st._id);
    expect(plan.lines.map((l) => [l.key, l.counted, l.variance]).sort()).toEqual([
      [`${COT}|${OLD}`, 0, -2],
      [`${COT}|${NEW}`, 0, -3],
      [`${TOY}|`, 0, -4],
    ]);

    // Found stock for a SKU whose only batch is recalled.
    await cols(t.db).batches.updateOne({ _id: TOYB }, { $set: { status: "RECALLED", recalledAt: new Date() } });
    await cols(t.db).inventory.updateOne({ batchId: TOYB }, { $set: { onHand: 0 } });
    await cols(t.db).movements.insertOne({ type: "RECALLED", at: new Date(), branchId: "BR-A", sku: TOY, batchId: TOYB, qty: -4, refType: "quarantine", refId: "q", attributed: false, actor: "t", origin: "visitor" });
    const st2 = (await open("clerk-9")).result;
    expect(st2._id).not.toBe(st._id);
    await run((c, s, k) => saveCountLine(c, s, k, { stocktakeId: st2._id, lineId: lineId(), sid: "clerk-9", sku: TOY, counted: 2, mode: "replace" }));
    await run((c, s, k) => submitStocktake(c, s, k, { stocktakeId: st2._id, sid: "clerk-9", uncounted: "leave" }));
    await run((c, s, k) => approveStocktake(c, s, k, { stocktakeId: st2._id, acceptedKeys: [] }));
    const unbatched = await cols(t.db).batches.findOne({ batchCode: "UNBATCHED", sku: TOY });
    expect(unbatched).toMatchObject({ status: "ACTIVE", createdOrigin: "visitor" });
    expect(await onHand(unbatched!._id)).toBe(2);
  });

  it("is idempotent for a resent count line and rejects lines after submit", async () => {
    const st = (await open()).result;
    const id = lineId();
    const body = { stocktakeId: st._id, lineId: id, sid: "clerk-1", sku: TOY, counted: 2, mode: "replace" as const };
    await run((c, s, k) => saveCountLine(c, s, k, body), { commandId: id });
    const again = await run((c, s, k) => saveCountLine(c, s, k, body), { commandId: id });
    expect(again.replayed).toBe(true);
    expect(await cols(t.db).stocktakeLines.countDocuments({ stocktakeId: st._id })).toBe(1);
    await run((c, s, k) => submitStocktake(c, s, k, { stocktakeId: st._id, sid: "clerk-1", uncounted: "leave" }));
    await expect(count(st._id, TOY, 1)).rejects.toMatchObject({ code: "STOCKTAKE_CLOSED" });
  });
});

describe("found units on a recalled batch", () => {
  const recallB1 = () => run((c, s, k) => quarantineBatch(c, s, k, { batchCode: "B-1" }));
  const countFound = async (n: number) => {
    const st = (await open()).result;
    await count(st._id, COT, n, OLD);
    await run((c, s, k) => submitStocktake(c, s, k, { stocktakeId: st._id, sid: "clerk-1", uncounted: "leave" }));
    return st._id;
  };
  const approve = (stocktakeId: string, commandId?: string) =>
    run((c, s, k) => approveStocktake(c, s, k, { stocktakeId, acceptedKeys: [`${COT}|${OLD}`] }), commandId ? { commandId } : {});

  it("approval adds the found units and quarantines them again in the same breath", async () => {
    await recallB1(); // OLD: 2 → 0
    const id = await countFound(3);
    const { result } = await approve(id);
    expect(result).toMatchObject({ unitsAdded: 3, unitsRemoved: 0, unitsQuarantined: 3 });
    const pair = await cols(t.db).movements.find({ refType: "stocktake" }, { projection: { _id: 0, actor: 0, origin: 0 } }).toArray();
    expect(pair).toEqual([
      { type: "ADJUSTMENT", at: result.approvedAt, effectiveAt: expect.any(Date), branchId: "BR-A", sku: COT, batchId: OLD, qty: 3, refType: "stocktake", refId: id, attributed: false },
      { type: "RECALLED", at: result.approvedAt, effectiveAt: pair[0].effectiveAt, branchId: "BR-A", sku: COT, batchId: OLD, qty: -3, refType: "stocktake", refId: id, attributed: false },
    ]);
    expect(await onHand(OLD)).toBe(0);
    expect(await projectionDiff(t.db)).toEqual([]);
    expect((await checkLedgerInvariants(t.db)).violations).toEqual([]);
  });

  it("posts the pair once: a replayed approval returns the first result, a second one is refused", async () => {
    await recallB1();
    const id = await countFound(2);
    const first = await approve(id, "approve-once");
    const again = await approve(id, "approve-once");
    expect(again).toEqual({ result: first.result, replayed: true });
    await expect(approve(id)).rejects.toMatchObject({ code: "NOT_SUBMITTED", status: 409 });
    expect(await cols(t.db).movements.countDocuments({ refType: "stocktake", refId: id })).toBe(2);
  });

  it("a recall committing mid-approval conflicts, and the retry quarantines the found units", async () => {
    await run((c, s, k) => recordSale(c, s, k, { branchId: "BR-A", lines: [{ sku: COT, qty: 2 }] })); // OLD sold out: the recall pulls nothing here
    const id = await countFound(1);
    const a = t.client.startSession();
    try {
      a.startTransaction();
      await cols(t.db).stocktakes.findOne({ _id: id }, { session: a }); // snapshot: B-1 still ACTIVE
      await recallB1();
      const err = await approveStocktake(cols(t.db), a, ctx(), { stocktakeId: id, acceptedKeys: [`${COT}|${OLD}`] }).catch((e) => e);
      expect(err?.hasErrorLabel?.("TransientTransactionError")).toBe(true); // withTransaction retries with the recall visible
      await a.abortTransaction().catch(() => {});
    } finally {
      await a.endSession();
    }
    const { result } = await approve(id);
    expect(result).toMatchObject({ unitsAdded: 1, unitsQuarantined: 1 });
    expect(await onHand(OLD)).toBe(0);
    expect(await projectionDiff(t.db)).toEqual([]);
    expect((await checkLedgerInvariants(t.db)).violations).toEqual([]);
  });

  it.each([
    { name: "a bare stocktake ADJUSTMENT", moves: [{ type: "ADJUSTMENT", qty: 2 }], want: /stocktake st-x nets 2 on recalled .*B-1/ },
    { name: "an unpaired stocktake RECALLED", moves: [{ type: "ADJUSTMENT", qty: 2 }, { type: "RECALLED", qty: -1 }], want: /nets 1/ },
    { name: "a stocktake ADJUSTMENT taking units off", moves: [{ type: "ADJUSTMENT", qty: -1 }, { type: "RECALLED", qty: 1 }], want: /2 movement\(s\) after recall/ },
    { name: "a SOLD", moves: [{ type: "SOLD", qty: -1, refType: "sale" }], want: /1 movement\(s\) after recall/ },
    { name: "a TRANSFER", moves: [{ type: "TRANSFER_IN", qty: 1, refType: "transfer" }], want: /1 movement\(s\) after recall/ },
    { name: "a pair from a non-stocktake ref", moves: [{ type: "ADJUSTMENT", qty: 1, refType: "quarantine" }, { type: "RECALLED", qty: -1, refType: "quarantine" }], want: /2 movement\(s\) after recall/ },
  ])("invariant 3 reports $name after the recall", async ({ moves, want }) => {
    const { result } = await recallB1();
    const at = new Date(result.recalledAt.getTime() + 1000);
    await cols(t.db).movements.insertMany(moves.map((m) => ({
      branchId: "BR-A", sku: COT, batchId: OLD, refType: "stocktake", refId: "st-x", attributed: false, actor: "t", origin: "visitor", at, ...m,
    })) as never);
    const { violations } = await checkLedgerInvariants(t.db);
    expect(violations.some((v) => want.test(v))).toBe(true);
  });

  it("invariant 3 still reports stock left on a recalled batch", async () => {
    await recallB1();
    await cols(t.db).inventory.updateOne({ branchId: "BR-A", batchId: OLD }, { $set: { onHand: 1 } });
    expect((await checkLedgerInvariants(t.db)).violations).toContain(`recalled batch ${OLD} still has stock in 1 row(s)`);
  });
});
