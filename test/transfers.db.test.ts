import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cols } from "@/domain/collections";
import { listTransferSuggestions, loadTransferInputs } from "@/domain/ledger/read";
import { openStocktake, receiveStock, recordSale } from "@/domain/ledger/write";
import { migrate } from "@/seed/apply";
import { freshDb } from "./helpers";
import { COT, NEW, OLD, TOY, TOYB, buildWorld, runner } from "./world";

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
});
