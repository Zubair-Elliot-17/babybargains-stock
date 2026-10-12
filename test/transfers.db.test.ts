import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cols } from "@/domain/collections";
import { DomainError } from "@/domain/errors";
import { checkLedgerInvariants, listTransferSuggestions, loadTransferInputs, projectionDiff } from "@/domain/ledger/read";
import { acceptTransferSuggestion, openStocktake, receiveStock, recordSale, submitStocktake, transferStock } from "@/domain/ledger/write";
import { migrate } from "@/seed/apply";
import { freshDb } from "./helpers";
import { COT, NEW, OLD, TOY, TOYB, buildWorld, ctx, runner } from "./world";

let t: Awaited<ReturnType<typeof freshDb>>;
let run: ReturnType<typeof runner>;
const DAY = 86_400_000;

beforeAll(async () => (t = await freshDb()));
afterAll(() => t.close());
beforeEach(async () => {
  await t.db.dropDatabase();
  await migrate(t.db);
  await buildWorld(t.db);
  run = runner(t.client, t.db);
  const policy = (branchId: string, sku: string, reorderPoint: number) =>
    ({ _id: `${branchId}:${sku}`, branchId, sku, reorderPoint, overstockWeeks: 6 });
  await cols(t.db).stockPolicies.insertMany([policy("BR-A", TOY, 2), policy("BR-B", TOY, 2), policy("BR-A", COT, 1), policy("BR-B", COT, 2)]);

  // TOY: Alpha holds 20 with no sales; Bravo sold 2 nine weeks ago (outside the window) and 3 today.
  await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-A", sku: TOY, batchId: TOYB, qty: 20 }));
  await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-B", sku: TOY, batchId: TOYB, qty: 5 }), { now: new Date(Date.now() - 70 * DAY) });
  await run((c, s, k) => recordSale(c, s, k, { branchId: "BR-B", lines: [{ sku: TOY, qty: 2 }] }), { now: new Date(Date.now() - 60 * DAY) });
  await run((c, s, k) => recordSale(c, s, k, { branchId: "BR-B", lines: [{ sku: TOY, qty: 3 }] }));
  // COT: Alpha holds two batches, Bravo none.
  await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-A", sku: COT, batchId: OLD, qty: 6 }));
  await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-A", sku: COT, batchId: NEW, qty: 6 }));
});

describe("transfer suggestions from the ledger", () => {
  it("counts SOLD over the last 8 weeks only and current on-hand stock", async () => {
    const inputs = await loadTransferInputs(cols(t.db), new Date());
    const toy = inputs.find((s) => s.sku === TOY)!;
    expect(toy.pricePence).toBe(500);
    expect(toy.branches).toEqual(expect.arrayContaining([
      { branchId: "BR-A", onHand: 20, sold56: 0, policy: { reorderPoint: 2, overstockWeeks: 6 }, stocktakeOpen: false },
      { branchId: "BR-B", onHand: 0, sold56: 3, policy: { reorderPoint: 2, overstockWeeks: 6 }, stocktakeOpen: false },
    ]));
  });

  it("lists ranked suggestions with names and the FIFO batches that would move", async () => {
    const view = await listTransferSuggestions(t.db);
    expect(view.suggestions.map((s) => [s.sku, s.fromBranchId, s.toBranchId, s.qty, s.valuePence])).toEqual([
      [COT, "BR-A", "BR-B", 3, 30000], // need max(rp+1, 0) = 3; £100 each
      [TOY, "BR-A", "BR-B", 3, 1500], //  need max(3, ceil(6/2·3/8)) = 3
    ]);
    expect(view.suggestions[0]).toMatchObject({ productName: "Test Cot · Oak", fromName: "Alpha", toName: "Bravo", preview: [{ batchCode: "B-1", qty: 3 }] });
    expect(view.branches.map((b) => b.name)).toEqual(["Alpha", "Bravo"]);
    expect(view.blocked).toEqual([]);
  });

  it("filters by recipient branch", async () => {
    expect((await listTransferSuggestions(t.db, { to: "BR-A" })).suggestions).toEqual([]);
    expect((await listTransferSuggestions(t.db, { to: "BR-B" })).suggestions).toHaveLength(2);
  });

  it("leaves out a branch with an open stocktake and says so", async () => {
    await run((c, s, k) => openStocktake(c, s, k, { branchId: "BR-B", sid: "clerk", clerkLabel: "Clerk" }));
    const view = await listTransferSuggestions(t.db);
    expect(view.suggestions).toEqual([]);
    expect(view.blocked).toEqual([{ _id: "BR-B", name: "Bravo" }]);
  });

  it("ignores a stocktake left idle for over 2 hours, the same rule that lets another clerk take it over", async () => {
    await run((c, s, k) => openStocktake(c, s, k, { branchId: "BR-B", sid: "clerk", clerkLabel: "Clerk" }), { now: new Date(Date.now() - 2 * 3_600_000 - 60_000) });
    const view = await listTransferSuggestions(t.db);
    expect(view.suggestions).toHaveLength(2);
    expect(view.blocked).toEqual([]);
  });
});

describe("accepting a suggestion", () => {
  const accept = (qty: number, extra = {}, sku = COT) =>
    run((c, s, k) => acceptTransferSuggestion(c, s, k, { sku, fromBranchId: "BR-A", toBranchId: "BR-B", qty }), extra);
  const onHand = async (branchId: string, batchId: string) => (await cols(t.db).inventory.findOne({ branchId, batchId }))?.onHand ?? 0;

  it("posts an instant FIFO transfer pair and the suggestion is gone afterwards", async () => {
    const { result } = await accept(3);
    expect(result).toMatchObject({ moved: 3, allocations: [{ batchId: OLD, qty: 3 }] });
    expect([await onHand("BR-A", OLD), await onHand("BR-B", OLD)]).toEqual([3, 3]);
    const pair = await cols(t.db).movements.find({ refType: "transfer" }).toArray();
    expect(pair.map((m) => [m.type, m.branchId, m.qty])).toEqual([["TRANSFER_OUT", "BR-A", -3], ["TRANSFER_IN", "BR-B", 3]]);
    expect((await checkLedgerInvariants(t.db)).violations).toEqual([]);
    expect(await projectionDiff(t.db)).toEqual([]);
    expect((await listTransferSuggestions(t.db)).suggestions.map((s) => s.sku)).toEqual([TOY]);
  });

  it("is idempotent for a resent commandId", async () => {
    await accept(3, { commandId: "accept-1" });
    const again = await accept(3, { commandId: "accept-1" });
    expect(again.replayed).toBe(true);
    expect(await cols(t.db).movements.countDocuments({ refType: "transfer" })).toBe(2);
  });

  it("refuses more than the fresh suggestion, reporting what is suggested now", async () => {
    const err = await accept(4).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: "SUGGESTION_STALE", status: 409, details: { suggestedQty: 3 } });
    await accept(3);
    await expect(accept(3)).rejects.toMatchObject({ code: "SUGGESTION_STALE", details: { suggestedQty: 0 } });
  });

  // Generated by /ship coverage audit.
  // Value: protects=accepting a SKU with no stock policy is a clean 409 SUGGESTION_STALE, not a crash; fails_when=the missing-stock
  // guard is dropped and suggestForSku(undefined) throws (500); why_new=stale cases all use a SKU with policies; seam=none; no_claim=none beyond protects
  it("refuses a SKU that has no stock policy as no longer suggested", async () => {
    await cols(t.db).stockPolicies.deleteMany({ sku: COT });
    await expect(accept(1)).rejects.toMatchObject({ code: "SUGGESTION_STALE", status: 409, details: { suggestedQty: 0 } });
    expect(await cols(t.db).movements.countDocuments({ refType: "transfer" })).toBe(0);
  });

  it("refuses while either branch has an open stocktake", async () => {
    await run((c, s, k) => openStocktake(c, s, k, { branchId: "BR-A", sid: "clerk", clerkLabel: "Clerk" }));
    await expect(accept(3)).rejects.toMatchObject({ code: "STOCKTAKE_OPEN", status: 409 });
    expect(await cols(t.db).movements.countDocuments({ refType: "transfer" })).toBe(0);
  });

  it("goes through when the open stocktake has been idle for over 2 hours", async () => {
    await run((c, s, k) => openStocktake(c, s, k, { branchId: "BR-A", sid: "clerk", clerkLabel: "Clerk" }), { now: new Date(Date.now() - 2 * 3_600_000 - 60_000) });
    await expect(accept(3)).resolves.toMatchObject({ result: { moved: 3 } });
  });

  it("reads only through indexes", async () => {
    await t.db.command({ profile: 2 });
    try {
      await accept(3);
    } finally {
      await t.db.command({ profile: 0 });
    }
    const scans = await t.db.collection("system.profile")
      .find({ ns: { $not: /\.system\./ }, planSummary: /COLLSCAN/ })
      .project({ ns: 1, op: 1, command: 1 })
      .toArray();
    expect(scans).toEqual([]);
    // The 8-week SOLD read is led by the SKU: it touches none of TOY's sales when accepting COT.
    const sold = await t.db.collection("system.profile").findOne({ "command.aggregate": "stockMovements", "command.pipeline.0.$match.type": "SOLD" });
    expect(sold?.keysExamined).toBe(0);
  });

  it("refuses a transfer to the same branch as a domain error", async () => {
    await expect(run((c, s, k) => acceptTransferSuggestion(c, s, k, { sku: COT, fromBranchId: "BR-A", toBranchId: "BR-A", qty: 1 })))
      .rejects.toMatchObject({ code: "SAME_BRANCH", status: 400 });
    await expect(run((c, s, k) => transferStock(c, s, k, { sku: COT, fromBranchId: "BR-A", toBranchId: "BR-A", qty: 1 })))
      .rejects.toMatchObject({ code: "SAME_BRANCH", status: 400 });
  });
});

describe("accept vs stocktake race", () => {
  const lockRev = async (branchId: string) => (await cols(t.db).branchLocks.findOne({ _id: branchId }))?.rev ?? 0;

  it("accept, stocktake open and stocktake submit each bump the branch lock they depend on", async () => {
    await run((c, s, k) => acceptTransferSuggestion(c, s, k, { sku: COT, fromBranchId: "BR-A", toBranchId: "BR-B", qty: 1 }));
    expect([await lockRev("BR-A"), await lockRev("BR-B")]).toEqual([1, 1]);
    const { result: st } = await run((c, s, k) => openStocktake(c, s, k, { branchId: "BR-B", sid: "clerk", clerkLabel: "Clerk" }));
    expect([await lockRev("BR-A"), await lockRev("BR-B")]).toEqual([1, 2]);
    await run((c, s, k) => submitStocktake(c, s, k, { stocktakeId: st._id, sid: "clerk", uncounted: "leave" }));
    expect([await lockRev("BR-A"), await lockRev("BR-B")]).toEqual([1, 3]);
  });

  it("a stocktake opening while an accept is uncommitted conflicts instead of both committing", async () => {
    const a = t.client.startSession();
    const b = t.client.startSession();
    try {
      a.startTransaction();
      await acceptTransferSuggestion(cols(t.db), a, ctx(), { sku: COT, fromBranchId: "BR-A", toBranchId: "BR-B", qty: 1 });
      b.startTransaction();
      const err = await openStocktake(cols(t.db), b, ctx(), { branchId: "BR-B", sid: "clerk", clerkLabel: "Clerk" }).catch((e) => e);
      expect(err?.hasErrorLabel?.("TransientTransactionError")).toBe(true); // withTransaction retries, then sees the transfer
      await b.abortTransaction().catch(() => {});
      await a.commitTransaction();
    } finally {
      await a.endSession();
      await b.endSession();
    }
  });
});
