// Pure transfer-suggestion maths shared by the manager screen (read) and Accept (write), so the
// suggestion shown is exactly the one re-checked before posting.
//
//   velocity v = soldInWindow / VELOCITY_WEEKS (units/week, whole UTC days before today); cover = onHand / v (∞ with no sales)
//   donor:     cover > W and surplus = onHand − max(ceil(W·v), rp+1) ≥ 1
//   recipient: onHand < rp, need = max(rp+1, ceil(W/2·v)) − onHand
//
// Integer forms (W·sold/VELOCITY_WEEKS, W·sold/(2·VELOCITY_WEEKS)) avoid floating-point edges at the thresholds.

export const VELOCITY_WEEKS = 8;
export const VELOCITY_DAYS = VELOCITY_WEEKS * 7;

export interface BranchStock {
  branchId: string;
  onHand: number; // ACTIVE batches only (UNBATCHED included); recalled stock never counts
  soldInWindow: number; // units SOLD in the VELOCITY_DAYS whole UTC days before today
  policy: { reorderPoint: number; overstockWeeks: number } | null;
  stocktakeOpen: boolean; // an active OPEN stocktake (see activeStocktakes) freezes the branch on both sides
}

export interface SkuStock {
  sku: string;
  pricePence: number;
  branches: BranchStock[];
}

export interface BranchPosition {
  branchId: string;
  onHand: number;
  velocity: number; // units/week
  coverWeeks: number | null; // null = stock with no recent sales (infinite cover)
  reorderPoint: number;
  overstockWeeks: number;
  role: "donor" | "recipient" | "neither";
  keep: number; // donors never go below this
  target: number; // recipients are refilled to this
  surplus: number;
  need: number;
}

export interface TransferSuggestion {
  sku: string;
  fromBranchId: string;
  toBranchId: string;
  qty: number;
  unitsSaved: number; // units not reordered from the supplier
  valuePence: number; // qty × retail price
  from: BranchPosition;
  to: BranchPosition;
}

const ceilDiv = (a: number, b: number) => Math.ceil(a / b); // b is a power of two, so a / b is exact
const cover = (p: BranchPosition) => p.coverWeeks ?? Number.POSITIVE_INFINITY;

export function assessBranch(b: BranchStock): BranchPosition | null {
  if (!b.policy || b.stocktakeOpen) return null;
  const { reorderPoint: rp, overstockWeeks: w } = b.policy;
  const coverWeeks = b.soldInWindow > 0 ? (b.onHand * VELOCITY_WEEKS) / b.soldInWindow : b.onHand > 0 ? null : 0;
  const overstocked = b.soldInWindow > 0 ? b.onHand * VELOCITY_WEEKS > w * b.soldInWindow : b.onHand > 0;
  const keep = Math.max(ceilDiv(w * b.soldInWindow, VELOCITY_WEEKS), rp + 1);
  const target = Math.max(rp + 1, ceilDiv(w * b.soldInWindow, 2 * VELOCITY_WEEKS));
  const surplus = overstocked ? Math.max(0, b.onHand - keep) : 0;
  const need = b.onHand < rp ? target - b.onHand : 0;
  return {
    branchId: b.branchId,
    onHand: b.onHand,
    velocity: b.soldInWindow / VELOCITY_WEEKS,
    coverWeeks,
    reorderPoint: rp,
    overstockWeeks: w,
    role: surplus > 0 ? "donor" : need > 0 ? "recipient" : "neither",
    keep,
    target,
    surplus,
    need,
  };
}

// Greedy: lowest-cover recipient first, each filled from the donor with the most surplus left.
export function suggestForSku(s: SkuStock): TransferSuggestion[] {
  const positions = s.branches.flatMap((b) => assessBranch(b) ?? []);
  const recipients = positions
    .filter((p) => p.role === "recipient")
    .sort((a, b) => cover(a) - cover(b) || a.branchId.localeCompare(b.branchId));
  const donors = positions.filter((p) => p.role === "donor").map((p) => ({ p, left: p.surplus }));
  const out: TransferSuggestion[] = [];
  for (const to of recipients) {
    let need = to.need;
    while (need > 0) {
      const donor = donors
        .filter((d) => d.left > 0)
        .sort((a, b) => b.left - a.left || cover(b.p) - cover(a.p) || a.p.branchId.localeCompare(b.p.branchId))[0];
      if (!donor) return out;
      const qty = Math.min(need, donor.left);
      donor.left -= qty;
      need -= qty;
      out.push({ sku: s.sku, fromBranchId: donor.p.branchId, toBranchId: to.branchId, qty, unitsSaved: qty, valuePence: qty * s.pricePence, from: donor.p, to });
    }
  }
  return out;
}

export function rankSuggestions(list: TransferSuggestion[]): TransferSuggestion[] {
  return [...list].sort(
    (a, b) =>
      b.qty - a.qty ||
      b.valuePence - a.valuePence ||
      cover(a.to) - cover(b.to) ||
      a.sku.localeCompare(b.sku) ||
      a.fromBranchId.localeCompare(b.fromBranchId) ||
      a.toBranchId.localeCompare(b.toBranchId),
  );
}

export function suggestTransfers(skus: SkuStock[]): TransferSuggestion[] {
  return rankSuggestions(skus.flatMap(suggestForSku));
}
