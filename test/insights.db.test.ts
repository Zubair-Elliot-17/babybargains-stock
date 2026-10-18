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
  it("lists low stock, dead stock and sales by week", async () => {
    const a = await analytics(t.db);
    expect(a.lowStock).toEqual([expect.objectContaining({ branchId: "BR-B", sku: TOY, onHand: 1, reorderPoint: 3 })]);
    // COT at A and TOY at B have stock but no sale in 90 days; TOY at A sold today.
    expect(a.deadStock.map((d) => [d.branchId, d.sku, d.valuePence])).toEqual([["BR-A", COT, 20000], ["BR-B", TOY, 500]]);
    expect(a.deadStockValuePence).toBe(20500);
    expect(a.salesByWeek).toHaveLength(52);
    expect(a.salesByWeek.at(-1)).toMatchObject({ units: 3, pence: 1500 });
    expect(a.topMovers).toEqual([{ sku: TOY, name: "Test Toy", units: 3 }]);
  });

  it("filters by branch and category", async () => {
    expect((await analytics(t.db, { branchId: "BR-B" })).deadStock.map((d) => d.sku)).toEqual([TOY]);
    const cots = await analytics(t.db, { category: "cot" });
    expect(cots.topMovers).toEqual([]);
    expect(cots.salesByWeek.at(-1)?.units).toBe(0);
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

// Fixed-clock metrics for the Analytics page (plan AC10/AC11). Windows are whole UTC days ending today.
describe("analytics metrics", () => {
  const NOW = new Date("2026-06-17T12:00:00Z"); // a Wednesday
  const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
  const sell = (branchId: string, sku: string, qty: number, daysAgo: number) =>
    run((c, s, k) => recordSale(c, s, k, { branchId, lines: [{ sku, qty }] }), { now: ago(daysAgo) });
  const at = (opts: Parameters<typeof analytics>[1] = {}) => analytics(t.db, { now: NOW, ...opts });

  beforeEach(async () => {
    await t.db.dropDatabase();
    await migrate(t.db);
    await buildWorld(t.db);
    run = runner(t.client, t.db);
    for (const branchId of ["BR-A", "BR-B"]) {
      await run((c, s, k) => receiveStock(c, s, k, { branchId, sku: TOY, batchId: TOYB, qty: 500 }), { now: ago(400) });
    }
  });

  it("sums the last 30 days of sales and compares them with the 30 days before", async () => {
    await sell("BR-A", TOY, 2, 0);
    await sell("BR-B", TOY, 3, 29);
    await sell("BR-A", TOY, 4, 30); // previous period
    await sell("BR-A", TOY, 6, 59);
    await sell("BR-A", TOY, 1, 60); // older than both
    const { kpi } = await at();
    expect(kpi).toMatchObject({ sales30: 2500, units30: 5, salesPrev30: 5000, unitsPrev30: 10, salesChange: -0.5, unitsChange: -0.5 });
    expect(kpi.daily30).toHaveLength(30);
    expect(kpi.daily30.at(-1)).toBe(1000);
    expect(kpi.daily30[0]).toBe(1500);
    expect((await at({ branchId: "BR-B" })).kpi).toMatchObject({ sales30: 1500, salesPrev30: 0, salesChange: null });
    expect((await at({ category: "cot" })).kpi).toMatchObject({ sales30: 0, units30: 0, salesChange: null, unitsChange: null });
  });

  it("buckets a year of sales into 52 weeks ending today", async () => {
    await sell("BR-A", TOY, 1, 0);
    await sell("BR-A", TOY, 2, 6); // same week as today
    await sell("BR-B", TOY, 3, 7); // the week before
    await sell("BR-A", TOY, 4, 363); // first day of the year window
    await sell("BR-A", TOY, 5, 364); // outside it
    const weeks = (await at()).salesByWeek;
    expect(weeks).toHaveLength(52);
    expect(weeks[51]).toEqual({ start: "2026-06-11", pence: 1500, units: 3 });
    expect(weeks[50]).toEqual({ start: "2026-06-04", pence: 1500, units: 3 });
    expect(weeks[0]).toMatchObject({ start: "2025-06-19", units: 4 });
    expect(weeks.reduce((n, w) => n + w.units, 0)).toBe(10);
  });

  it("ranks every branch by 30-day sales, whatever the branch filter, with 12 weekly buckets", async () => {
    await sell("BR-A", TOY, 2, 0);
    await sell("BR-A", TOY, 4, 30);
    await sell("BR-B", TOY, 3, 29);
    await sell("BR-B", TOY, 1, 80);
    const { league } = await at();
    expect(league.map((r) => [r.branchId, r.name, r.code, r.sales30, r.change])).toEqual([["BR-B", "Bravo", "BB", 1500, null], ["BR-A", "Alpha", "AA", 1000, -0.5]]);
    expect(league[0].weekly).toEqual([500, 0, 0, 0, 0, 0, 0, 1500, 0, 0, 0, 0]);
    expect(league[1].weekly).toEqual([0, 0, 0, 0, 0, 0, 0, 2000, 0, 0, 0, 1000]);
    expect((await at({ branchId: "BR-A" })).league.map((r) => r.branchId)).toEqual(["BR-B", "BR-A"]);
    expect((await at({ category: "cot" })).league.map((r) => r.sales30)).toEqual([0, 0]);
  });

  it("averages each branch's sales by weekday over 12 weeks, counting days with no sales as 0", async () => {
    await sell("BR-A", TOY, 2, 0); // Wednesday
    await sell("BR-A", TOY, 4, 7); // the Wednesday before
    await sell("BR-A", TOY, 8, 84); // a 13th Wednesday: outside the 12 weeks
    await sell("BR-B", TOY, 3, 1); // Tuesday
    const { weekday } = await at({ branchId: "BR-B" });
    expect(weekday).toEqual([
      { branchId: "BR-A", name: "Alpha", code: "AA", avg: [0, 0, 250, 0, 0, 0, 0] },
      { branchId: "BR-B", name: "Bravo", code: "BB", avg: [0, 125, 0, 0, 0, 0, 0] },
    ]);
  });

  it("splits the year's revenue by category, adding up to the weekly trend", async () => {
    await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-A", sku: COT, batchId: OLD, qty: 5 }), { now: ago(400) });
    await sell("BR-A", TOY, 2, 0);
    await sell("BR-B", TOY, 3, 100);
    await sell("BR-A", COT, 1, 10);
    await sell("BR-A", COT, 1, 364); // outside the year
    const a = await at();
    expect(a.categories).toEqual([
      { category: "cot", pence: 10000, share: 0.8 },
      { category: "toy", pence: 2500, share: 0.2 },
      { category: "clothing", pence: 0, share: 0 },
      { category: "monitor", pence: 0, share: 0 },
      { category: "pram", pence: 0, share: 0 },
    ]);
    expect(a.salesByWeek.reduce((n, w) => n + w.pence, 0)).toBe(12500);
    expect((await at({ branchId: "BR-B" })).categories[0]).toEqual({ category: "toy", pence: 1500, share: 1 });
    expect((await at({ category: "toy" })).categories).toEqual([{ category: "toy", pence: 2500, share: 1 }]);
  });

  it("classes products A, B or C by the revenue share ranked above them; unsold products are C", async () => {
    const prices = { P1: 8000, P2: 1000, P3: 500, P4: 500 };
    for (const [sku, price] of Object.entries(prices)) {
      await cols(t.db).products.insertOne({ _id: sku, parentSku: sku, name: sku, supplierId: "SUP-W", price, batchTracked: false, category: "toy", attributes: { ageMonthsMin: 0, material: "Wood" } });
      await cols(t.db).batches.insertOne({ _id: `SUP-W:B-${sku}:${sku}`, supplierId: "SUP-W", batchCode: `B-${sku}`, sku, parentSku: sku, receivedAt: ago(50), status: "ACTIVE" });
      await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-A", sku, batchId: `SUP-W:B-${sku}:${sku}`, qty: 1 }), { now: ago(50) });
      await sell("BR-A", sku, 1, 3);
    }
    const { abc } = await at();
    // P1 starts at 0% (A); P2 at exactly 80% (B); P3 at 90% (B); P4 at exactly 95% (C); COT and TOY sold nothing (C).
    expect(abc).toEqual([
      { class: "A", skus: 1, pence: 8000, skuShare: 1 / 6, revenueShare: 0.8 },
      { class: "B", skus: 2, pence: 1500, skuShare: 2 / 6, revenueShare: 0.15 },
      { class: "C", skus: 3, pence: 500, skuShare: 3 / 6, revenueShare: 0.05 },
    ]);
    expect((await at({ category: "cot" })).abc.map((r) => r.skus)).toEqual([0, 0, 1]);
  });

  it("gives weeks of cover by category from the last 8 weeks of sales, against a band from the stock policies", async () => {
    await cols(t.db).stockPolicies.insertMany([
      { _id: `BR-A:${TOY}`, branchId: "BR-A", sku: TOY, reorderPoint: 1, overstockWeeks: 6 },
      { _id: `BR-B:${TOY}`, branchId: "BR-B", sku: TOY, reorderPoint: 3, overstockWeeks: 8 },
    ]);
    await sell("BR-A", TOY, 8, 0);
    await sell("BR-B", TOY, 8, 55);
    await sell("BR-B", TOY, 4, 56); // before the 8 weeks
    const toy = async (o = {}) => (await at(o)).cover.find((r) => r.category === "toy");
    // 980 on hand ÷ (16 units ÷ 8 weeks); band = Σ reorder points ÷ weekly units .. mean overstock weeks.
    expect(await toy()).toEqual({ category: "toy", onHand: 980, weeklyUnits: 2, weeks: 490, band: [2, 7] });
    expect(await toy({ branchId: "BR-A" })).toEqual({ category: "toy", onHand: 492, weeklyUnits: 1, weeks: 492, band: [1, 6] });
    const cot = (await at()).cover.find((r) => r.category === "cot");
    expect(cot).toEqual({ category: "cot", onHand: 0, weeklyUnits: 0, weeks: null, band: null });
    expect((await at({ category: "toy" })).cover.map((r) => r.category)).toEqual(["toy"]);
    // Reorder cover (20 ÷ 1 a week) above the overstock policy: the band can't invert, it closes at the reorder cover.
    await cols(t.db).stockPolicies.updateOne({ _id: `BR-B:${TOY}` }, { $set: { reorderPoint: 20 } });
    expect((await toy({ branchId: "BR-B" }))?.band).toEqual([20, 20]);
  });

  it("values shelf stock at retail by batch age, leaving out recalled batches and goods in transit", async () => {
    const batch = async (age: number, qty: number, branchId = "BR-A") => {
      const _id = `SUP-W:AGE-${age}:${TOY}`;
      await cols(t.db).batches.insertOne({ _id, supplierId: "SUP-W", batchCode: `AGE-${age}`, sku: TOY, parentSku: TOY, receivedAt: ago(age), status: "ACTIVE" });
      await run((c, s, k) => receiveStock(c, s, k, { branchId, sku: TOY, batchId: _id, qty }), { now: ago(age) });
      return _id;
    };
    const fresh = await batch(30, 1);
    for (const age of [31, 90, 91, 180, 181]) await batch(age, 1);
    await cols(t.db).batches.updateOne({ _id: await batch(10, 3) }, { $set: { status: "RECALLED" } });
    await cols(t.db).inventory.insertOne({ branchId: "IN-TRANSIT", sku: TOY, batchId: fresh, onHand: 7, updatedAt: NOW });
    const a = await at();
    // The seeded toy batch (received 2026-01-15, 153 days before NOW) holds 500 at each branch.
    expect(a.stockAge).toEqual([
      { bucket: "0–30 days", pence: 500 },
      { bucket: "31–90 days", pence: 1000 },
      { bucket: "91–180 days", pence: 501000 },
      { bucket: "Over 180 days", pence: 500 },
    ]);
    expect(a.kpi.stockPence).toBe(503000);
    expect((await at({ branchId: "BR-B" })).stockAge.map((b) => b.pence)).toEqual([0, 0, 250000, 0]);
    expect((await at({ category: "cot" })).kpi.stockPence).toBe(0);
  });

  it("keeps the page's totals in agreement with each other (all branches, no filter)", async () => {
    await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-A", sku: COT, batchId: OLD, qty: 6 }), { now: ago(400) });
    await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-B", sku: COT, batchId: NEW, qty: 4 }), { now: ago(300) });
    for (const [branchId, sku, qty, daysAgo] of [["BR-A", TOY, 3, 0], ["BR-B", TOY, 5, 12], ["BR-A", COT, 1, 20], ["BR-B", COT, 2, 45], ["BR-A", TOY, 7, 200], ["BR-B", TOY, 2, 363], ["BR-A", TOY, 9, 364]] as const) {
      await sell(branchId, sku, qty, daysAgo);
    }
    const a = await at();
    const total = (xs: { pence: number }[]) => xs.reduce((n, x) => n + x.pence, 0);
    const year = total(a.salesByWeek);
    expect(year).toBe(3 * 500 + 5 * 500 + 10000 + 2 * 10000 + 7 * 500 + 2 * 500); // 38,500: the 364-day-old sale is out
    expect(total(a.categories)).toBe(year);
    expect(total(a.abc)).toBe(year);
    expect(a.league.reduce((n, r) => n + r.sales30, 0)).toBe(a.kpi.sales30);
    const stock = await stockView(t.db, {});
    const price = { [COT]: 10000, [TOY]: 500 } as Record<string, number>;
    expect(total(a.stockAge)).toBe(a.kpi.stockPence);
    expect(a.kpi.stockPence).toBe(stock.reduce((n, r) => n + r.onHand * price[r.sku], 0));
    expect(a.deadStockValuePence).toBeLessThanOrEqual(a.kpi.stockPence);
    expect(a.abc.reduce((n, r) => n + r.skuShare, 0)).toBeCloseTo(1, 3);
    expect(a.abc.reduce((n, r) => n + r.revenueShare, 0)).toBeCloseTo(1, 3);
  });

  it("shows the same league and heatmap with a branch filter, other branches included up to 83 days back", async () => {
    await sell("BR-A", TOY, 2, 0);
    await sell("BR-B", TOY, 3, 45); // the previous 30 days, for the change
    await sell("BR-B", TOY, 4, 83); // last day of the 12 weeks
    await sell("BR-B", TOY, 5, 84); // outside the 12 weeks
    const all = await at();
    const one = await at({ branchId: "BR-A" });
    expect(all.league.find((r) => r.branchId === "BR-B")?.weekly[0]).toBe(2000);
    expect(one.league).toEqual(all.league);
    expect(one.weekday).toEqual(all.weekday);
    const cots = await at({ branchId: "BR-A", category: "cot" });
    expect(cots.league.map((r) => r.sales30)).toEqual([0, 0]);
    expect(cots.weekday.flatMap((r) => r.avg).every((v) => v === 0)).toBe(true);
  });

  it("keeps the totals in agreement under a branch and category filter", async () => {
    await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-A", sku: COT, batchId: OLD, qty: 6 }), { now: ago(400) });
    await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-B", sku: COT, batchId: NEW, qty: 4 }), { now: ago(300) });
    for (const [branchId, sku, qty, daysAgo] of [["BR-A", TOY, 3, 0], ["BR-B", TOY, 5, 12], ["BR-A", COT, 1, 20], ["BR-B", COT, 2, 45], ["BR-A", TOY, 7, 200]] as const) {
      await sell(branchId, sku, qty, daysAgo);
    }
    const total = (xs: { pence: number }[]) => xs.reduce((n, x) => n + x.pence, 0);
    const price = { [COT]: 10000, [TOY]: 500 } as Record<string, number>;
    const expected = { "BR-A": { "": 15000, toy: 5000 }, "BR-B": { "": 22500, toy: 2500 } } as const; // a year's sales per scope
    for (const branchId of ["BR-A", "BR-B"] as const) {
      for (const category of ["", "toy"] as const) {
        const a = await at({ branchId, category: category || undefined });
        const year = total(a.salesByWeek);
        expect(year, `${branchId} ${category}`).toBe(expected[branchId][category]);
        expect(total(a.categories)).toBe(year);
        expect(total(a.abc)).toBe(year);
        const shelf = (await stockView(t.db, { branchId })).filter((r) => !category || r.sku === TOY);
        expect(total(a.stockAge)).toBe(a.kpi.stockPence);
        expect(a.kpi.stockPence).toBe(shelf.reduce((n, r) => n + r.onHand * price[r.sku], 0));
        expect(a.deadStockValuePence).toBeLessThanOrEqual(a.kpi.stockPence);
      }
    }
  });

  it("reads salesDays once and stockMovements only for dead stock and top movers", async () => {
    await sell("BR-A", TOY, 1, 0);
    await t.db.command({ profile: 2 });
    try {
      await at({ branchId: "BR-A", category: "toy" });
    } finally {
      await t.db.command({ profile: 0 });
    }
    const ops = (coll: string) => t.db.collection("system.profile").countDocuments({ ns: `${t.db.databaseName}.${coll}`, op: { $in: ["command", "query"] } });
    expect(await ops("salesDays")).toBe(1);
    expect(await ops("stockMovements")).toBe(2);
  });
});
