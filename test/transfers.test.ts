import { describe, expect, it } from "vitest";
import { assessBranch, suggestForSku, suggestTransfers, type BranchStock, type SkuStock } from "@/domain/ledger/transfers";

// Velocity is SOLD over the last 56 days / 8, in units per week.
const br = (branchId: string, onHand: number, soldInWindow: number, over: Partial<BranchStock> = {}): BranchStock => ({
  branchId, onHand, soldInWindow, policy: { reorderPoint: 4, overstockWeeks: 6 }, stocktakeOpen: false, ...over,
});
const sku = (id: string, branches: BranchStock[], pricePence = 1000): SkuStock => ({ sku: id, pricePence, branches });

describe("assessBranch", () => {
  it("a donor keeps max(ceil(W·v), rp+1) and offers the rest", () => {
    // v = 16/8 = 2/wk, cover 15 > 6; keep = max(12, 5) = 12
    expect(assessBranch(br("A", 30, 16))).toMatchObject({ role: "donor", velocity: 2, coverWeeks: 15, keep: 12, surplus: 18, need: 0 });
  });

  it("a slow seller keeps at least rp+1", () => {
    // v = 1/8, cover 80; keep = max(ceil(0.75), 5) = 5
    expect(assessBranch(br("A", 10, 1))).toMatchObject({ role: "donor", keep: 5, surplus: 5 });
  });

  it("stock with no sales is infinite cover", () => {
    expect(assessBranch(br("A", 7, 0))).toMatchObject({ role: "donor", velocity: 0, coverWeeks: null, keep: 5, surplus: 2 });
  });

  it("a recipient below its reorder point is refilled to max(rp+1, ceil(W/2·v))", () => {
    // v = 2, target = max(5, ceil(6)) = 6
    expect(assessBranch(br("B", 1, 16))).toMatchObject({ role: "recipient", target: 6, need: 5, surplus: 0 });
    // v = 0.5, target = max(5, ceil(1.5)) = 5
    expect(assessBranch(br("B", 0, 4))).toMatchObject({ role: "recipient", coverWeeks: 0, target: 5, need: 5 });
  });

  it("over W weeks of cover but no unit above keep is not a donor", () => {
    // v = 1/8 → cover 40 > 6, but keep = rp+1 = 5 = onHand
    expect(assessBranch(br("A", 5, 1))).toMatchObject({ role: "neither", surplus: 0 });
  });

  it("at the reorder point, or at exactly W weeks of cover, is neither", () => {
    expect(assessBranch(br("A", 4, 16))).toMatchObject({ role: "neither" });
    expect(assessBranch(br("A", 12, 16))).toMatchObject({ role: "neither", coverWeeks: 6 });
  });

  it("measures velocity over the days the branch had stock, so a sell-out isn't read as slow demand", () => {
    // 4 sold in the 14 days it had stock: v = 2/wk (not 0.5), target = max(5, ceil(6)) = 6
    expect(assessBranch(br("B", 0, 4, { daysInStock: 14 }))).toMatchObject({ role: "recipient", velocity: 2, daysInStock: 14, target: 6, need: 6 });
    // and a donor with a short in-stock history keeps more back: keep = max(ceil(6·2), 5) = 12
    expect(assessBranch(br("A", 30, 4, { daysInStock: 14 }))).toMatchObject({ role: "donor", keep: 12, surplus: 18 });
  });

  it("counts at least a week in stock, so one sale on a restock day can't spike velocity", () => {
    expect(assessBranch(br("B", 0, 1, { daysInStock: 1 }))).toMatchObject({ velocity: 1, daysInStock: 7 });
    expect(assessBranch(br("B", 0, 1))).toMatchObject({ velocity: 1 / 8, daysInStock: 56 });
  });

  it("excludes branches without a policy or with an open stocktake", () => {
    expect(assessBranch(br("A", 30, 0, { policy: null }))).toBeNull();
    expect(assessBranch(br("A", 30, 0, { stocktakeOpen: true }))).toBeNull();
  });
});

describe("suggestForSku", () => {
  it("moves min(surplus, need) from donor to recipient, valued at the retail price", () => {
    const [s, ...rest] = suggestForSku(sku("S", [br("A", 30, 16), br("B", 1, 16)]));
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ sku: "S", fromBranchId: "A", toBranchId: "B", qty: 5, unitsSaved: 5, valuePence: 5000 });
    expect(s.from).toMatchObject({ onHand: 30, surplus: 18 });
    expect(s.to).toMatchObject({ onHand: 1, need: 5 });
  });

  it("serves the lowest-cover recipient first from the donor with the most surplus left", () => {
    const out = suggestForSku(sku("S", [
      br("D1", 9, 0), //  surplus 4
      br("D2", 11, 0), // surplus 6
      br("R1", 2, 16), // cover 1, need 4
      br("R2", 0, 16), // cover 0, need 6
    ]));
    expect(out.map((s) => [s.fromBranchId, s.toBranchId, s.qty])).toEqual([
      ["D2", "R2", 6], // R2 first (cover 0); D2 has more surplus
      ["D1", "R1", 4],
    ]);
  });

  it("splits one recipient's need across donors when one is not enough", () => {
    const out = suggestForSku(sku("S", [br("D1", 7, 0), br("D2", 8, 0), br("R", 0, 16)]));
    expect(out.map((s) => [s.fromBranchId, s.qty])).toEqual([["D2", 3], ["D1", 2]]);
  });

  it("suggests nothing without both a donor and a recipient, or with an open stocktake on either side", () => {
    expect(suggestForSku(sku("S", [br("A", 30, 16)]))).toEqual([]);
    expect(suggestForSku(sku("S", [br("B", 1, 16)]))).toEqual([]);
    expect(suggestForSku(sku("S", [br("A", 30, 16, { stocktakeOpen: true }), br("B", 1, 16)]))).toEqual([]);
    expect(suggestForSku(sku("S", [br("A", 30, 16), br("B", 1, 16, { stocktakeOpen: true })]))).toEqual([]);
  });
});

describe("suggestTransfers", () => {
  it("ranks by units saved, then value, then recipient cover, then SKU and branches", () => {
    const out = suggestTransfers([
      sku("CHEAP", [br("A", 30, 16), br("B", 1, 16)], 100), //  5 units, £5
      sku("DEAR", [br("A", 30, 16), br("B", 1, 16)], 9000), // 5 units, £450
      sku("BIG", [br("A", 40, 0), br("B", 0, 80)]), //          rp+1 = 5 vs ceil(3·10) = 30 → 30 units
      sku("LOWER", [br("A", 30, 16), br("B", 0, 4)], 9000), // 5 units, £450, cover 0
    ]);
    expect(out.map((s) => s.sku)).toEqual(["BIG", "LOWER", "DEAR", "CHEAP"]);
  });
});
