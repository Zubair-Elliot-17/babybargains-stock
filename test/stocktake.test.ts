import { describe, expect, it } from "vitest";
import type { Lot } from "@/domain/ledger/allocate";
import { foldCounts, planLine, sortForReview, type PlanInput } from "@/domain/ledger/stocktake";

const t = (min: number) => new Date(Date.UTC(2026, 9, 10, 9, min));
const lot = (batchId: string, day: number, onHand: number, status: Lot["status"] = "ACTIVE"): Lot => ({
  batchId, onHand, status, receivedAt: new Date(Date.UTC(2026, 8, day)),
});

describe("foldCounts", () => {
  it("adds across locations, replace resets, keys are per SKU and batch", () => {
    const m = foldCounts([
      { sku: "A", counted: 3, mode: "replace", countedAt: t(1) },
      { sku: "A", counted: 5, mode: "add", countedAt: t(2) },
      { sku: "C", batchId: "B1", counted: 2, mode: "replace", countedAt: t(3) },
      { sku: "C", batchId: "B2", counted: 1, mode: "replace", countedAt: t(4) },
      { sku: "C", batchId: "B1", counted: 4, mode: "replace", countedAt: t(5) },
    ]);
    expect(m.get("A|")).toMatchObject({ counted: 8, countedAt: t(2) });
    expect(m.get("C|B1")).toMatchObject({ counted: 4, countedAt: t(5) });
    expect(m.get("C|B2")).toMatchObject({ counted: 1 });
  });

  it("each phone keeps its own running count; the stocktake sums the phones", () => {
    const m = foldCounts([
      { sku: "A", counted: 3, mode: "replace", countedAt: t(1), deviceId: "lead" },
      { sku: "A", counted: 2, mode: "replace", countedAt: t(2), deviceId: "mate" }, // another aisle, not an overwrite
      { sku: "A", counted: 4, mode: "replace", countedAt: t(3), deviceId: "lead" }, // the lead recounts their aisle
      { sku: "A", counted: 1, mode: "add", countedAt: t(4), deviceId: "mate" },
    ]);
    expect(m.get("A|")).toMatchObject({ counted: 7, countedAt: t(4) });
  });

  it("an add with no earlier entry is just the count", () => {
    expect(foldCounts([{ sku: "A", counted: 2, mode: "add", countedAt: t(1) }]).get("A|")?.counted).toBe(2);
  });
});

const input = (over: Partial<PlanInput>): PlanInput => ({
  key: "S|", sku: "S", counted: 5, expected: 5, pricePence: 1000, lots: [], newestActiveBatchId: "NEW", batchRecalled: false, ...over,
});

describe("planLine", () => {
  it("posts nothing when the count matches", () => {
    expect(planLine(input({}), "U")).toMatchObject({ variance: 0, adjustments: [], flagged: false });
  });

  it("non-batch shortage comes out of the oldest batches first", () => {
    const p = planLine(input({ counted: 1, expected: 4, lots: [lot("NEWER", 9, 5), lot("OLDER", 1, 2)] }), "U");
    expect(p.variance).toBe(-3);
    expect(p.adjustments).toEqual([
      { batchId: "OLDER", qty: -2, attributed: true },
      { batchId: "NEWER", qty: -1, attributed: true },
    ]);
  });

  it("non-batch surplus goes to the newest active batch", () => {
    expect(planLine(input({ counted: 7, expected: 5 }), "U").adjustments).toEqual([{ batchId: "NEW", qty: 2, attributed: true }]);
  });

  it("surplus with no active batch goes to UNBATCHED", () => {
    const p = planLine(input({ counted: 3, expected: 0, newestActiveBatchId: null }), "SUP:UNBATCHED:S");
    expect(p).toMatchObject({ needsUnbatched: true, adjustments: [{ batchId: "SUP:UNBATCHED:S", qty: 3 }] });
  });

  it("batch-tracked lines adjust only the counted batch and are not attributed", () => {
    const p = planLine(input({ key: "S|B1", batchId: "B1", counted: 0, expected: 2, lots: [lot("B1", 1, 2)] }), "U");
    expect(p.adjustments).toEqual([{ batchId: "B1", qty: -2, attributed: false }]);
  });

  it("clamps a shortage larger than current stock (sold since the count) and reports it", () => {
    const p = planLine(input({ counted: 0, expected: 4, lots: [lot("A", 1, 1)] }), "U");
    expect(p.adjustments).toEqual([{ batchId: "A", qty: -1, attributed: true }]);
    expect(p.clampedBy).toBe(3);
  });

  it("a surplus found on a recalled batch is added and quarantined", () => {
    const p = planLine(input({ key: "S|R", batchId: "R", counted: 3, expected: 0, batchRecalled: true }), "U");
    expect(p).toMatchObject({ variance: 3, quarantined: 3, adjustments: [{ batchId: "R", qty: 3, attributed: false }] });
  });

  it("only a batch-line surplus on a recalled batch quarantines", () => {
    expect(planLine(input({ key: "S|R", batchId: "R", counted: 3, expected: 0 }), "U").quarantined).toBe(0);
    const short = planLine(input({ key: "S|R", batchId: "R", counted: 0, expected: 2, batchRecalled: true }), "U");
    expect(short).toMatchObject({ quarantined: 0, adjustments: [], clampedBy: 2 });
    expect(planLine(input({ key: "S|R", batchId: "R", counted: 2, expected: 2, batchRecalled: true }), "U").quarantined).toBe(0);
    expect(planLine(input({ counted: 7, expected: 5, batchRecalled: true }), "U").quarantined).toBe(0);
  });

  it("never takes from recalled lots", () => {
    const p = planLine(input({ counted: 0, expected: 2, lots: [lot("R", 1, 5, "RECALLED"), lot("A", 2, 2)] }), "U");
    expect(p.adjustments).toEqual([{ batchId: "A", qty: -2, attributed: true }]);
  });

  it.each([
    { name: "3 units", counted: 2, expected: 5, price: 100, flagged: true },
    { name: "2 units under £50", counted: 3, expected: 5, price: 2000, flagged: false },
    { name: "£50 or more", counted: 4, expected: 5, price: 5000, flagged: true },
  ])("flags $name", ({ counted, expected, price, flagged }) => {
    expect(planLine(input({ counted, expected, pricePence: price, lots: [lot("A", 1, 10)] }), "U").flagged).toBe(flagged);
  });

  it("review order puts the largest value at risk first", () => {
    const a = planLine(input({ key: "A|", sku: "A", counted: 4, expected: 5, pricePence: 100, lots: [lot("x", 1, 9)] }), "U");
    const b = planLine(input({ key: "B|", sku: "B", counted: 0, expected: 2, pricePence: 15000, lots: [lot("y", 1, 9)] }), "U");
    expect(sortForReview([a, b]).map((p) => p.sku)).toEqual(["B", "A"]);
  });
});
