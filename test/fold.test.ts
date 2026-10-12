import { describe, expect, it } from "vitest";
import { foldMovements, type CompactMovement } from "@/domain/ledger/fold";

const m = (type: CompactMovement["type"], at: number, qty: number, branchId = "A"): CompactMovement => ({ type, at, branchId, sku: "S", qty });

describe("foldMovements", () => {
  // Received 3, sold 1, a count +1 before the recall, recall pulls 3, then a count finds 2 that are pulled again.
  const moves = [m("RECEIVED", 1, 3), m("SOLD", 2, -1), m("ADJUSTMENT", 3, 1), m("RECEIVED", 4, 1, "B"), m("RECALLED", 10, -3), m("ADJUSTMENT", 20, 2), m("RECALLED", 20, -2)];

  it("counts units found on the batch after its recall, per branch and in total", () => {
    const f = foldMovements(moves, Number.POSITIVE_INFINITY, 10);
    expect(f.totals).toMatchObject({ quarantined: 5, adjusted: 3, found: 2, onHand: 1 });
    expect(f.branches.find((b) => b.branchId === "A")).toMatchObject({ quarantined: 5, found: 2, onHand: 0 });
    expect(f.branches.find((b) => b.branchId === "B")).toMatchObject({ found: 0 });
  });

  it("finds nothing without a recall time, or before the find", () => {
    expect(foldMovements(moves).totals.found).toBe(0);
    expect(foldMovements(moves, 15, 10).totals.found).toBe(0);
  });
});
