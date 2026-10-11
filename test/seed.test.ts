import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cols } from "@/domain/collections";
import { computeStocktakePlan, findRecall, projectionDiff } from "@/domain/ledger/read";
import { approveStocktake, quarantineBatch, recordSale, runCommand } from "@/domain/ledger/write";
import { foldMovements } from "@/domain/ledger/fold";
import { resetDemo, writeSeed } from "@/seed/apply";
import { HERO_BATCH, RECALLED_BATCH, generateSeed } from "@/seed/generate";
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
