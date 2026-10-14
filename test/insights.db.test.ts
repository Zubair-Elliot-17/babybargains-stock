import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cols } from "@/domain/collections";
import { analytics, stockView } from "@/domain/ledger/insights";
import { cancelPurchaseOrder, createPurchaseOrder, receivePurchaseOrder } from "@/domain/ledger/orders";
import { receiveStock, recordSale } from "@/domain/ledger/write";
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
  await cols(t.db).suppliers.insertOne({ _id: "SUP-OAK", name: "Little Oak Ltd", adapter: "x" });
  run = runner(t.client, t.db);
  const old = new Date(Date.now() - 200 * DAY);
  await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-A", sku: COT, batchId: OLD, qty: 2 }), { now: old });
  await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-A", sku: TOY, batchId: TOYB, qty: 10 }), { now: old });
  await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-B", sku: TOY, batchId: TOYB, qty: 1 }), { now: old });
  await run((c, s, k) => recordSale(c, s, k, { branchId: "BR-A", lines: [{ sku: TOY, qty: 3 }] })); // today
  await cols(t.db).stockPolicies.insertMany([
    { _id: `BR-A:${TOY}`, branchId: "BR-A", sku: TOY, reorderPoint: 2, overstockWeeks: 8 },
    { _id: `BR-B:${TOY}`, branchId: "BR-B", sku: TOY, reorderPoint: 3, overstockWeeks: 8 },
    { _id: `BR-A:${COT}`, branchId: "BR-A", sku: COT, reorderPoint: 1, overstockWeeks: 8 },
  ]);
});

describe("stock view", () => {
  it("shows a branch's sellable stock, low first, and excludes recalled batches", async () => {
    await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-A", sku: COT, batchId: NEW, qty: 5 }));
    await cols(t.db).batches.updateOne({ _id: NEW }, { $set: { status: "RECALLED" } });
    const rows = await stockView(t.db, { branchId: "BR-A" });
    expect(rows.map((r) => [r.sku, r.onHand, r.reorderPoint, r.low])).toEqual([[COT, 2, 1, false], [TOY, 7, 2, false]]);
  });

  it("across all branches sums stock and flags low when any branch is below its point", async () => {
    const rows = await stockView(t.db, {});
    expect(rows[0]).toMatchObject({ sku: TOY, onHand: 8, reorderPoint: 5, low: true }); // BR-B has 1 < 3
    expect(await stockView(t.db, { lowOnly: true })).toHaveLength(1);
    expect(await stockView(t.db, { q: "cot" })).toEqual([expect.objectContaining({ sku: COT })]);
  });
});

describe("analytics", () => {
  it("lists low stock, dead stock and sales by month", async () => {
    const a = await analytics(t.db);
    expect(a.lowStock).toEqual([expect.objectContaining({ branchId: "BR-B", sku: TOY, onHand: 1, reorderPoint: 3 })]);
    // COT at A and TOY at B have stock but no sale in 90 days; TOY at A sold today.
    expect(a.deadStock.map((d) => [d.branchId, d.sku, d.valuePence])).toEqual([["BR-A", COT, 20000], ["BR-B", TOY, 500]]);
    expect(a.deadStockValuePence).toBe(20500);
    expect(a.salesByMonth).toHaveLength(12);
    expect(a.salesByMonth.at(-1)).toMatchObject({ units: 3, pence: 1500 });
    expect(a.topMovers).toEqual([{ sku: TOY, name: "Test Toy", units: 3 }]);
  });

  it("filters by branch and category", async () => {
    expect((await analytics(t.db, { branchId: "BR-B" })).deadStock.map((d) => d.sku)).toEqual([TOY]);
    const cots = await analytics(t.db, { category: "cot" });
    expect(cots.topMovers).toEqual([]);
    expect(cots.salesByMonth.at(-1)?.units).toBe(0);
    expect(cots.deadStock.map((d) => d.sku)).toEqual([COT]);
  });

  it("reports overdue orders, lead time and fill rate from finished orders", async () => {
    const sent = new Date(Date.now() - 10 * DAY);
    const a = (await run((c, s, k) => createPurchaseOrder(c, s, k, { branchId: "BR-A", supplierId: "SUP-OAK", lines: [{ sku: COT, qty: 4 }] }), { now: sent })).result;
    const b = (await run((c, s, k) => createPurchaseOrder(c, s, k, { branchId: "BR-A", supplierId: "SUP-OAK", lines: [{ sku: COT, qty: 2 }] }), { now: sent })).result;
    const d = (await run((c, s, k) => createPurchaseOrder(c, s, k, { branchId: "BR-A", supplierId: "SUP-OAK", lines: [{ sku: COT, qty: 2 }] }))).result;
    await run((c, s, k) => receivePurchaseOrder(c, s, k, { orderId: a._id, lines: [{ sku: COT, qty: 4, batchCode: "B-1" }] }), { now: new Date(sent.getTime() + 2 * DAY) });
    await run((c, s, k) => cancelPurchaseOrder(c, s, k, { orderId: d._id }));
    const r = await analytics(t.db);
    expect(r.overdueOrders.map((o) => o._id)).toEqual([b._id]);
    expect(r.orders).toEqual({ open: 1, avgLeadDays: 2, fillRate: 4 / 6 });
  });
});
