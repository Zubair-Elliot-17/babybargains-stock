import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assessBranch, suggestForSku, suggestTransfers, type BranchStock } from "@/domain/ledger/transfers";

const branchStock = (branchId: string) =>
  fc.record({
    branchId: fc.constant(branchId),
    onHand: fc.integer({ min: 0, max: 80 }),
    sold56: fc.integer({ min: 0, max: 60 }),
    policy: fc.option(fc.record({ reorderPoint: fc.integer({ min: 0, max: 12 }), overstockWeeks: fc.integer({ min: 1, max: 10 }) }), { freq: 8 }),
    stocktakeOpen: fc.oneof({ arbitrary: fc.constant(false), weight: 3 }, { arbitrary: fc.constant(true), weight: 1 }),
  }) satisfies fc.Arbitrary<BranchStock>;

const skuStock = fc
  .integer({ min: 1, max: 8 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => branchStock(`BR-${i}`))))
  .chain((branches) => fc.record({ sku: fc.constant("S"), pricePence: fc.integer({ min: 0, max: 50_000 }), branches: fc.constant(branches) }));

describe("transfer suggestion properties", () => {
  it("moves no more than each donor's surplus or recipient's need, and as much as both allow", () => {
    fc.assert(
      fc.property(skuStock, (s) => {
        const out = suggestForSku(s);
        const positions = s.branches.flatMap((b) => assessBranch(b) ?? []);
        const moved = new Map<string, number>();
        for (const x of out) {
          expect(x.qty).toBeGreaterThanOrEqual(1);
          expect(x.fromBranchId).not.toBe(x.toBranchId);
          moved.set(`out:${x.fromBranchId}`, (moved.get(`out:${x.fromBranchId}`) ?? 0) + x.qty);
          moved.set(`in:${x.toBranchId}`, (moved.get(`in:${x.toBranchId}`) ?? 0) + x.qty);
        }
        for (const p of positions) {
          const sent = moved.get(`out:${p.branchId}`) ?? 0;
          const got = moved.get(`in:${p.branchId}`) ?? 0;
          expect(sent).toBeLessThanOrEqual(p.surplus);
          expect(got).toBeLessThanOrEqual(p.need);
          if (sent) expect(p.onHand - sent).toBeGreaterThanOrEqual(p.keep); // no donor drops below keep
          if (got) expect(p.onHand + got).toBeLessThanOrEqual(p.target);
        }
        const totalSurplus = positions.reduce((n, p) => n + p.surplus, 0);
        const totalNeed = positions.reduce((n, p) => n + p.need, 0);
        expect(out.reduce((n, x) => n + x.qty, 0)).toBe(Math.min(totalSurplus, totalNeed));
        // Excluded branches never appear.
        const excluded = new Set(s.branches.filter((b) => !b.policy || b.stocktakeOpen).map((b) => b.branchId));
        expect(out.some((x) => excluded.has(x.fromBranchId) || excluded.has(x.toBranchId))).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it("a branch is never both a donor and a recipient", () => {
    fc.assert(
      fc.property(branchStock("X"), (b) => {
        const p = assessBranch(b);
        if (p) expect(p.surplus > 0 && p.need > 0).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it("ranking is a permutation ordered by units saved", () => {
    fc.assert(
      fc.property(fc.array(skuStock, { maxLength: 5 }), (skus) => {
        const flat = skus.flatMap((s, i) => suggestForSku({ ...s, sku: `S${i}` }));
        const ranked = suggestTransfers(skus.map((s, i) => ({ ...s, sku: `S${i}` })));
        expect(ranked.length).toBe(flat.length);
        for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1].qty).toBeGreaterThanOrEqual(ranked[i].qty);
      }),
      { numRuns: 200 },
    );
  });
});
