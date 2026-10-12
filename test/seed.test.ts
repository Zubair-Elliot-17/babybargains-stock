import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cols } from "@/domain/collections";
import { computeStocktakePlan, findRecall, listTransferSuggestions, projectionDiff } from "@/domain/ledger/read";
import { approveStocktake, quarantineBatch, recordSale, runCommand } from "@/domain/ledger/write";
import { foldMovements } from "@/domain/ledger/fold";
import { resetDemo, writeSeed } from "@/seed/apply";
import { FULL, HERO_BATCH, PREVIEW, RECALLED_BATCH, generateSeed } from "@/seed/generate";
import { freshDb } from "./helpers";

let t: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => (t = await freshDb()));
afterAll(() => t.close());

const anchor = new Date("2026-06-30T23:00:00Z");
const DAY = 86_400_000;

describe("seed generator", () => {
  it("is deterministic for a given config", () => {
    const cfg = { branches: 2, skus: 30, days: 60, seed: 7, anchor };
    const a = generateSeed(cfg);
    const b = generateSeed(cfg);
    expect(a.movements.length).toBe(b.movements.length);
    expect(a.movements.slice(0, 50)).toEqual(b.movements.slice(0, 50));
  });

  it("writes a dataset whose ledger passes every invariant, with the hero and recalled batches", async () => {
    const data = generateSeed({ branches: 3, skus: 60, days: 240, seed: 42, anchor });
    const report = await writeSeed(t.db, data, anchor);
    expect(report.invariants.violations).toEqual([]);
    expect(report.bytes).toBeGreaterThan(0);
    expect(await projectionDiff(t.db)).toEqual([]);

    const hero = await findRecall(t.db, HERO_BATCH);
    expect(hero?.batches.length).toBeGreaterThanOrEqual(1);
    const now = foldMovements(hero!.movements);
    expect(now.totals.received).toBeGreaterThan(0);
    expect(now.totals.sold).toBeGreaterThan(0);

    const stocktakes = await cols(t.db).stocktakes.find().sort({ openedAt: 1 }).toArray();
    expect(stocktakes.map((st) => st.status)).toEqual(["APPROVED", "SUBMITTED"]);
    const plan = await computeStocktakePlan(cols(t.db), stocktakes[1]._id);
    expect(plan.lines.length).toBeGreaterThan(5);
    expect(plan.lines.some((l) => l.flagged)).toBe(true);

    const recalled = await findRecall(t.db, RECALLED_BATCH);
    expect(recalled?.batches.every((b) => b.status === "RECALLED")).toBe(true);
    expect(foldMovements(recalled!.movements).totals.onHand).toBe(0);
  });
});

describe("transfer scenario", () => {
  it("leaves every other SKU's history and the hero batch unchanged", () => {
    const cfg = { ...PREVIEW, anchor };
    const on = generateSeed(cfg);
    const off = generateSeed({ ...cfg, transferScenario: false });
    expect(on.transferScenario.length).toBeGreaterThanOrEqual(10);
    expect(off.transferScenario).toEqual([]);
    const touched = new Set(on.transferScenario);
    // refIds and the millisecond tie-break depend on how many sales share a day, so compare by minute.
    const history = (d: typeof on, keep: (m: (typeof on.movements)[number]) => boolean) =>
      d.movements.filter(keep).map((m) => [m.type, m.branchId, m.sku, m.batchId, m.qty, Math.floor(m.at.getTime() / 60_000)].join("|")).sort();
    const others = (m: (typeof on.movements)[number]) => !touched.has(m.sku);
    expect(history(on, others)).toEqual(history(off, others));
    const lines = (d: typeof on) => d.stocktakeLines.filter((l) => !touched.has(l.sku)).map((l) => [l.stocktakeId, l.sku, l.batchId, l.counted].join("|")).sort();
    expect(lines(on)).toEqual(lines(off));
    const heroIds = new Set(on.batches.filter((b) => b.batchCode === HERO_BATCH).map((b) => b._id));
    const hero = (m: (typeof on.movements)[number]) => heroIds.has(m.batchId);
    expect(history(on, hero).length).toBeGreaterThan(0);
    expect(history(on, hero)).toEqual(history(off, hero));
  });

  // Values from the pre-Milestone-3 generator (628fe5d): the scenario must not move the recall demo's figures.
  it.each([
    ["PREVIEW", "2026-06-30T23:00:00Z", 4, PREVIEW],
    ["PREVIEW", "2026-10-11T12:00:00Z", 6, PREVIEW],
    ["FULL", "2026-06-30T23:00:00Z", 11, FULL],
    ["FULL", "2026-10-11T12:00:00Z", 24, FULL],
  ] as const)("%s at %s keeps the hero batch's on-hand at %i", (_name, at, expected, cfg) => {
    const data = generateSeed({ ...cfg, anchor: new Date(at) });
    const heroIds = new Set(data.batches.filter((b) => b.batchCode === HERO_BATCH).map((b) => b._id));
    expect(data.movements.filter((m) => heroIds.has(m.batchId)).reduce((n, m) => n + m.qty, 0)).toBe(expected);
  }, 30_000);

  it.each([["PREVIEW", PREVIEW], ["FULL", FULL]] as const)("%s has at least 10 transfer suggestions, and each branch's view matches the full list", async (_name, cfg) => {
    const db = t.client.db(`${t.db.databaseName}_x`);
    try {
      await writeSeed(db, generateSeed({ ...cfg, anchor }), anchor);
      const view = await listTransferSuggestions(db, { now: anchor });
      expect(view.suggestions.length).toBeGreaterThanOrEqual(10);
      expect(new Set(view.suggestions.map((s) => s.toBranchId)).size).toBeGreaterThanOrEqual(2);
      expect(view.suggestions.every((s) => s.preview.reduce((n, p) => n + p.qty, 0) === s.qty)).toBe(true);
      // ?to= loads only the SKUs that branch is short of; it must not change what is suggested.
      for (const b of view.branches) {
        expect((await listTransferSuggestions(db, { now: anchor, to: b._id })).suggestions).toEqual(view.suggestions.filter((s) => s.toBranchId === b._id));
      }
    } finally {
      await db.dropDatabase();
    }
  });
});

describe("nightly reset", () => {
  it("removes visitor changes, restores visitor recalls and shifts dates to end today", async () => {
    const c = cols(t.db);
    const k = { commandId: "visitor-q", actor: "v", origin: "visitor" as const };
    await runCommand(t.client, t.db, "quarantine", k, (cl, s) => quarantineBatch(cl, s, k, { batchCode: HERO_BATCH }));
    const sk = { commandId: "visitor-s", actor: "v", origin: "visitor" as const };
    const anyStock = await c.inventory.findOne({ onHand: { $gt: 1 } });
    await runCommand(t.client, t.db, "sale", sk, (cl, s) => recordSale(cl, s, sk, { branchId: anyStock!.branchId, lines: [{ sku: anyStock!.sku, qty: 1 }] }));
    expect(await c.movements.countDocuments({ origin: "visitor" })).toBeGreaterThan(0);

    const submitted = (await c.stocktakes.findOne({ status: "SUBMITTED" }))!;
    const plan = await computeStocktakePlan(c, submitted._id);
    const ak = { commandId: "visitor-a", actor: "v", origin: "visitor" as const };
    await runCommand(t.client, t.db, "approve", ak, (cl, s) => approveStocktake(cl, s, ak, { stocktakeId: submitted._id, acceptedKeys: plan.lines.map((l) => l.key) }));
    expect((await c.stocktakes.findOne({ _id: submitted._id }))!.status).toBe("APPROVED");

    const firstMovementBefore = (await c.movements.find().sort({ at: 1 }).limit(1).next())!.at.getTime();
    const report = await resetDemo(t.db, new Date(anchor.getTime() + 3 * DAY));

    expect(report.shiftedDays).toBe(3);
    expect(report.restoredBatches).toBeGreaterThanOrEqual(1);
    expect(report.invariants.violations).toEqual([]);
    expect(await c.movements.countDocuments({ origin: "visitor" })).toBe(0);
    expect(await c.commandLog.countDocuments({ origin: "visitor" })).toBe(0);
    expect(await c.batches.countDocuments({ batchCode: HERO_BATCH, status: "ACTIVE" })).toBeGreaterThan(0);
    expect(await c.batches.countDocuments({ batchCode: RECALLED_BATCH, status: "RECALLED" })).toBeGreaterThan(0);
    const firstMovementAfter = (await c.movements.find().sort({ at: 1 }).limit(1).next())!.at.getTime();
    expect(firstMovementAfter - firstMovementBefore).toBe(3 * DAY);
    const sample = await c.salesDays.findOne({});
    expect(sample!._id).toBe(`${sample!.branchId}:${sample!.day.toISOString().slice(0, 10)}`);
    expect(await projectionDiff(t.db)).toEqual([]);
    expect((await c.stocktakes.findOne({ _id: submitted._id }))!.status).toBe("SUBMITTED");
    expect(await c.movements.countDocuments({ refId: submitted._id })).toBe(0);

    const again = await resetDemo(t.db, new Date(anchor.getTime() + 3 * DAY));
    expect(again.shiftedDays).toBe(0);
  });
});
