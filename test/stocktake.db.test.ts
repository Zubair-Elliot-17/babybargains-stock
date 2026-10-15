import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cols } from "@/domain/collections";
import { DomainError } from "@/domain/errors";
import { checkLedgerInvariants, computeStocktakePlan, findRecall, projectionDiff } from "@/domain/ledger/read";
import { approveStocktake, joinStocktake, openStocktake, quarantineBatch, receiveStock, recordSale, saveCountLine, stocktakeHeartbeat, submitStocktake, TEAM_MAX, TEAM_SILENT_MS } from "@/domain/ledger/write";
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

describe("team stocktakes", () => {
  const PHONE = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const join = (stocktakeId: string, sid: string, device: string, branchId = "BR-A") =>
    run((c, s, k) => joinStocktake(c, s, k, { stocktakeId, branchId, sid, clerkLabel: `Clerk ${sid}`, device }));
  const countOn = (stocktakeId: string, sid: string, deviceId: string, counted: number, mode: "add" | "replace" = "replace") =>
    run((c, s, k) => saveCountLine(c, s, k, { stocktakeId, lineId: lineId(), sid, sku: TOY, counted, mode, deviceId }));
  const beat = (stocktakeId: string, sid: string, device: string, pending: number, done = false, now?: Date) =>
    run((c, s, k) => stocktakeHeartbeat(c, s, k, { stocktakeId, sid, device, pending, done }), now ? { now } : {});
  const submit = (stocktakeId: string, sid = "clerk-1", withoutTeam = false, now?: Date) =>
    run((c, s, k) => submitStocktake(c, s, k, { stocktakeId, sid, uncounted: "leave", withoutTeam }), now ? { now } : {});

  it("a teammate joins from their phone; counts from each phone add up, a phone's replace resets only its own", async () => {
    const st = (await open()).result;
    expect((await join(st._id, "clerk-2", PHONE(2))).result).toEqual({ stocktakeId: st._id, lead: false });
    await countOn(st._id, "clerk-1", PHONE(1), 3);
    const { result } = await countOn(st._id, "clerk-2", PHONE(2), 2);
    expect(result.counted).toBe(2); // this phone's own running count
    await countOn(st._id, "clerk-1", PHONE(1), 1); // the lead recounts their aisle
    await expect(countOn(st._id, "clerk-3", PHONE(3), 9)).rejects.toMatchObject({ code: "STOCKTAKE_BUSY" }); // not on the team
    await expect(join(st._id, "clerk-4", PHONE(4), "BR-B")).rejects.toMatchObject({ status: 404 }); // another branch
    const plan = await computeStocktakePlan(cols(t.db), st._id);
    expect(plan.counts.get(`${TOY}|`)?.counted).toBe(3);
  });

  it("rejoining from the same phone takes the seat with the new session; a team holds 10 phones", async () => {
    const st = (await open()).result;
    await join(st._id, "clerk-2", PHONE(2));
    await join(st._id, "clerk-2b", PHONE(2)); // re-login on the same phone
    await expect(countOn(st._id, "clerk-2", PHONE(2), 1)).rejects.toMatchObject({ code: "STOCKTAKE_BUSY" });
    await countOn(st._id, "clerk-2b", PHONE(2), 1);
    expect((await cols(t.db).stocktakes.findOne({ _id: st._id }))?.participants).toHaveLength(1);
    for (let i = 3; i <= TEAM_MAX + 1; i++) await join(st._id, `clerk-${i}`, PHONE(i));
    await expect(join(st._id, "clerk-x", PHONE(99))).rejects.toMatchObject({ code: "TEAM_FULL" });
  });

  it("only the lead submits, and not while a teammate has counts waiting or has gone quiet, unless told to", async () => {
    const st = (await open()).result;
    await join(st._id, "clerk-2", PHONE(2));
    await expect(submit(st._id, "clerk-2")).rejects.toMatchObject({ code: "STOCKTAKE_BUSY" }); // teammates don't submit
    const lead = await beat(st._id, "clerk-1", PHONE(1), 0);
    expect(lead.result).toMatchObject({ lead: true, team: [{ clerkLabel: "Clerk clerk-2", pending: 0, done: false, waiting: false }] });

    await beat(st._id, "clerk-2", PHONE(2), 3);
    await expect(submit(st._id)).rejects.toMatchObject({ code: "TEAM_PENDING", details: { waiting: [{ clerkLabel: "Clerk clerk-2", pending: 3 }] } });
    await beat(st._id, "clerk-2", PHONE(2), 3, true); // "done" doesn't count while counts are still queued
    await expect(submit(st._id)).rejects.toMatchObject({ code: "TEAM_PENDING" });
    await beat(st._id, "clerk-2", PHONE(2), 0);
    // A teammate silent for 2 minutes may be in a dead spot with counts.
    await expect(submit(st._id, "clerk-1", false, new Date(Date.now() + TEAM_SILENT_MS + 1000))).rejects.toMatchObject({ code: "TEAM_PENDING" });
    await beat(st._id, "clerk-2", PHONE(2), 0, true); // done: never blocks, however quiet
    await expect(submit(st._id, "clerk-1", false, new Date(Date.now() + 10 * TEAM_SILENT_MS))).resolves.toBeDefined();
  });

  it("the lead can submit without a waiting teammate; the teammate's late count is refused", async () => {
    const st = (await open()).result;
    await join(st._id, "clerk-2", PHONE(2));
    await beat(st._id, "clerk-2", PHONE(2), 2);
    await submit(st._id, "clerk-1", true);
    await expect(countOn(st._id, "clerk-2", PHONE(2), 1)).rejects.toMatchObject({ code: "STOCKTAKE_CLOSED" });
    await expect(beat(st._id, "clerk-2", PHONE(2), 2)).rejects.toMatchObject({ code: "STOCKTAKE_CLOSED" });
  });
});

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
    const { countedAt } = (await cols(t.db).stocktakeLines.findOne({ stocktakeId: id }))!;
    const pair = await cols(t.db).movements.find({ refType: "stocktake" }, { projection: { _id: 0, actor: 0, origin: 0 } }).toArray();
    expect(pair).toEqual([
      { type: "ADJUSTMENT", at: result.approvedAt, effectiveAt: countedAt, branchId: "BR-A", sku: COT, batchId: OLD, qty: 3, refType: "stocktake", refId: id, attributed: false },
      { type: "RECALLED", at: result.approvedAt, effectiveAt: pair[0].effectiveAt, branchId: "BR-A", sku: COT, batchId: OLD, qty: -3, refType: "stocktake", refId: id, attributed: false },
    ]);
    expect(await onHand(OLD)).toBe(0);
    expect(await projectionDiff(t.db)).toEqual([]);
    expect((await checkLedgerInvariants(t.db)).violations).toEqual([]);
  });

  it("the approval's retail value leaves out quarantined units", async () => {
    await recallB1();
    const st = (await open()).result;
    await count(st._id, COT, 3, OLD); // +3 quarantined, £300 at retail
    await count(st._id, TOY, 6); // +2 at £5
    await run((c, s, k) => submitStocktake(c, s, k, { stocktakeId: st._id, sid: "clerk-1", uncounted: "leave" }));
    const { result } = await run((c, s, k) => approveStocktake(c, s, k, { stocktakeId: st._id, acceptedKeys: [`${COT}|${OLD}`] }));
    expect(result).toMatchObject({ unitsAdded: 5, unitsQuarantined: 3, valuePence: 1000 });
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

  it("a recall that snapshotted before an approval committed conflicts, and its retry pulls the found units", async () => {
    await run((c, s, k) => recordSale(c, s, k, { branchId: "BR-A", lines: [{ sku: COT, qty: 2 }] })); // OLD row at 0
    const id = await countFound(2);
    const a = t.client.startSession();
    const r = t.client.startSession();
    try {
      a.startTransaction();
      const approved = await approveStocktake(cols(t.db), a, ctx(), { stocktakeId: id, acceptedKeys: [`${COT}|${OLD}`] });
      expect(approved).toMatchObject({ unitsAdded: 2, unitsQuarantined: 0 }); // B-1 still ACTIVE: a bare +2
      r.startTransaction();
      await cols(t.db).batches.findOne({ _id: OLD }, { session: r }); // snapshot: OLD at 0 here
      await a.commitTransaction();
      const err = await quarantineBatch(cols(t.db), r, ctx(), { batchCode: "B-1" }).catch((e) => e);
      expect(err?.hasErrorLabel?.("TransientTransactionError")).toBe(true); // its branch-lock write conflicts
      await r.abortTransaction().catch(() => {});
    } finally {
      await a.endSession();
      await r.endSession();
    }
    const { result } = await recallB1();
    expect(result).toMatchObject({ units: 2, branches: 1 });
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

describe("counts queued offline", () => {
  const MIN = 60_000;
  const queued = (stocktakeId: string, sku: string, counted: number, capturedAt: Date, sentAt: Date, now: Date, mode: "add" | "replace" = "replace", batchId?: string) =>
    run((c, s, k) => saveCountLine(c, s, k, { stocktakeId, lineId: lineId(), sid: "clerk-1", sku, batchId, counted, mode, capturedAt, sentAt }), { now });
  const lines = async (id: string) => cols(t.db).stocktakeLines.find({ stocktakeId: id }).sort({ countedAt: 1 }).toArray();

  it("keeps the capture time, so a sale between capture and arrival is not a variance, and stores the arrival", async () => {
    // Receipts in beforeEach happened at real now, so this timeline runs after them.
    const base = Date.now();
    const at = (m: number) => new Date(base + m * MIN);
    const st = (await run((c, s, k) => openStocktake(c, s, k, { branchId: "BR-A", sid: "clerk-1", clerkLabel: "C" }), { now: at(1) })).result;
    const captured = at(2);
    await run((c, s, k) => recordSale(c, s, k, { branchId: "BR-A", lines: [{ sku: TOY, qty: 1 }] }), { now: at(3) });
    const now = at(4);
    await queued(st._id, TOY, 4, captured, now, now); // phone clock correct; counted before the sale
    const [line] = await lines(st._id);
    expect(line.countedAt).toEqual(captured);
    expect(line.receivedAt).toEqual(now);
    await run((c, s, k) => submitStocktake(c, s, k, { stocktakeId: st._id, sid: "clerk-1", uncounted: "leave" }), { now: at(5) });
    const plan = await computeStocktakePlan(cols(t.db), st._id);
    expect(plan.lines.map((l) => [l.expected, l.variance, l.lateMs, l.flagged])).toEqual([[4, 0, 2 * MIN, false]]);
  });

  it("flags a matching line that arrived over 15 minutes after its count, so approval needs an explicit accept", async () => {
    const base = Date.now();
    const at = (m: number) => new Date(base + m * MIN);
    const st = (await run((c, s, k) => openStocktake(c, s, k, { branchId: "BR-A", sid: "clerk-1", clerkLabel: "C" }), { now: at(1) })).result;
    await queued(st._id, TOY, 4, at(2), at(70), at(70));
    await run((c, s, k) => submitStocktake(c, s, k, { stocktakeId: st._id, sid: "clerk-1", uncounted: "leave" }), { now: at(71) });
    const [line] = (await computeStocktakePlan(cols(t.db), st._id)).lines;
    expect(line).toMatchObject({ variance: 0, lateMs: 68 * MIN, flagged: true });
    await expect(run((c, s, k) => approveStocktake(c, s, k, { stocktakeId: st._id, acceptedKeys: [] }))).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
  });

  it("corrects a wrong phone clock with the send-time header and clamps to [openedAt, now]", async () => {
    const opened = new Date(Date.now() - 60 * MIN);
    const st = (await run((c, s, k) => openStocktake(c, s, k, { branchId: "BR-A", sid: "clerk-1", clerkLabel: "C" }), { now: opened })).result;
    const now = new Date();
    const fast = 10 * MIN; // phone clock runs 10 minutes ahead
    await queued(st._id, TOY, 1, new Date(now.getTime() - 20 * MIN + fast), new Date(now.getTime() + fast), now);
    await queued(st._id, COT, 1, new Date(opened.getTime() - 99 * MIN), now, now, "replace", NEW); // before the open → openedAt
    await queued(st._id, TOY, 2, new Date(now.getTime() + 99 * MIN), now, now, "add"); // future → now
    const got = (await lines(st._id)).map((l) => [l.sku, l.countedAt.getTime()]);
    expect(got).toEqual([[COT, opened.getTime()], [TOY, now.getTime() - 20 * MIN], [TOY, now.getTime()]]);
  }, 15_000);

  it("never stamps a line before an earlier-sent line for the same item (uneven latency keeps capture order)", async () => {
    const st = (await open()).result;
    const now = Date.now();
    // Line A was captured first but sat 5 s in flight (skew +5 s); line B, captured 1 s later, went straight through.
    await queued(st._id, TOY, 5, new Date(now - 3000), new Date(now - 5000), new Date(now));
    const b = await queued(st._id, TOY, 2, new Date(now - 2000), new Date(now), new Date(now), "add");
    expect(b.result.counted).toBe(7); // A (replace 5) then B (add 2)
    const [a, bLine] = await lines(st._id);
    expect(bLine.countedAt.getTime()).toBeGreaterThan(a.countedAt.getTime());
  });

  it("stamps a line without capturedAt at arrival (older clients)", async () => {
    const st = (await open()).result;
    const now = new Date();
    await run((c, s, k) => saveCountLine(c, s, k, { stocktakeId: st._id, lineId: lineId(), sid: "clerk-1", sku: TOY, counted: 1, mode: "replace" }), { now });
    expect((await lines(st._id))[0]).toMatchObject({ countedAt: now, receivedAt: now });
  });
});

describe("resume key", () => {
  const openWith = (sid: string, ok: boolean, stocktakeId: string, branchId = "BR-A") =>
    run((c, s, k) => openStocktake(c, s, k, { branchId, sid, clerkLabel: `Clerk ${sid}`, resume: { stocktakeId, ok: () => ok } }));

  it("takes over at once with the key, refuses without it, and rotates the nonce on every open", async () => {
    const a = (await open()).result;
    await expect(openWith("clerk-2", false, a._id)).rejects.toMatchObject({ code: "STOCKTAKE_BUSY", details: { stocktakeId: a._id } });
    const b = (await openWith("clerk-2", true, a._id)).result;
    expect(b).toMatchObject({ _id: a._id, openedBy: "clerk-2", openedAt: a.openedAt });
    expect(b.resumeNonce).toBeTruthy();
    expect(b.resumeNonce).not.toBe(a.resumeNonce);
  });

  it("an old key is refused after a stale takeover by another phone", async () => {
    const a = (await open()).result;
    const oldNonce = a.resumeNonce;
    await cols(t.db).stocktakes.updateOne({ _id: a._id }, { $set: { lastActivityAt: new Date(Date.now() - 3 * 3_600_000) } });
    await open("phone-b"); // stale takeover rotates the nonce
    const err = await run((c, s, k) => openStocktake(c, s, k, { branchId: "BR-A", sid: "phone-a-again", clerkLabel: "A", resume: { stocktakeId: a._id, ok: (st) => st.resumeNonce === oldNonce } })).catch((e) => e);
    expect(err).toMatchObject({ code: "STOCKTAKE_BUSY" });
  });

  it("a resume from another branch's session is refused and opens nothing there", async () => {
    const a = (await open()).result;
    await expect(openWith("clerk-b", true, a._id, "BR-B")).rejects.toMatchObject({ code: "STOCKTAKE_BUSY" });
    expect(await cols(t.db).stocktakes.countDocuments({ branchId: "BR-B" })).toBe(0);
    expect((await cols(t.db).stocktakes.findOne({ _id: a._id }))?.openedBy).toBe("clerk-1");
  });

  it("the same session reopening keeps its key (overlapping opens can't store a stale one)", async () => {
    const a = (await open()).result;
    expect((await open()).result.resumeNonce).toBe(a.resumeNonce);
  });
});
