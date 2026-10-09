import { describe, expect, it } from "vitest";
import { allocateFifo, type Lot } from "@/domain/ledger/allocate";

const d = (day: number) => new Date(Date.UTC(2026, 0, day));
const lot = (batchId: string, day: number, onHand: number, extra: Partial<Lot> = {}): Lot => ({
  batchId, receivedAt: d(day), onHand, status: "ACTIVE", ...extra,
});

describe("allocateFifo", () => {
  it.each([
    { name: "oldest batch first", lots: [lot("B", 5, 4), lot("A", 1, 4)], qty: 3, want: [{ batchId: "A", qty: 3 }], short: 0 },
    { name: "spills into the next batch", lots: [lot("A", 1, 2), lot("B", 5, 4)], qty: 5, want: [{ batchId: "A", qty: 2 }, { batchId: "B", qty: 3 }], short: 0 },
    { name: "skips recalled batches", lots: [lot("A", 1, 9, { status: "RECALLED" }), lot("B", 5, 4)], qty: 2, want: [{ batchId: "B", qty: 2 }], short: 0 },
    { name: "uses UNBATCHED last", lots: [lot("U", 0, 5, { unbatched: true }), lot("B", 5, 1)], qty: 3, want: [{ batchId: "B", qty: 1 }, { batchId: "U", qty: 2 }], short: 0 },
    { name: "reports shortfall", lots: [lot("A", 1, 2)], qty: 5, want: [{ batchId: "A", qty: 2 }], short: 3 },
    { name: "ignores empty lots", lots: [lot("A", 1, 0), lot("B", 2, 1)], qty: 1, want: [{ batchId: "B", qty: 1 }], short: 0 },
    { name: "same day ties break by batchId", lots: [lot("Z", 1, 1), lot("M", 1, 1)], qty: 1, want: [{ batchId: "M", qty: 1 }], short: 0 },
  ])("$name", ({ lots, qty, want, short }) => {
    const res = allocateFifo(lots, qty);
    expect(res.allocations).toEqual(want);
    expect(res.shortBy).toBe(short);
  });

  it.each([0, -1, 1.5])("rejects qty %s", (qty) => {
    expect(() => allocateFifo([lot("A", 1, 5)], qty)).toThrow(RangeError);
  });
});
