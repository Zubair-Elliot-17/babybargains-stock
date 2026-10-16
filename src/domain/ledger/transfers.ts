// Pure transfer-suggestion maths shared by the manager screen (read) and Accept (write), so the
// suggestion shown is exactly the one re-checked before posting.
//
//   velocity v = 7 · soldInWindow / daysInStock (units/week over the days the branch had stock); cover = onHand / v (∞ with no sales)
//   donor:     cover > W and surplus = onHand − max(ceil(W·v), rp+1) ≥ 1
//   recipient: onHand < rp, need = max(rp+1, ceil(W/2·v)) − onHand
//
// Integer forms (7·W·sold vs onHand·days, exact ceilDiv) avoid floating-point edges at the thresholds.

export const VELOCITY_WEEKS = 8;
export const VELOCITY_DAYS = VELOCITY_WEEKS * 7;
// Fewer in-stock days than this still count as this many, so one sale on a restock day can't spike velocity.
export const MIN_DAYS_IN_STOCK = 7;
// Where dispatched stock waits for the receiving branch to confirm it. A ledger location, not a branch.
export const IN_TRANSIT = { _id: "IN-TRANSIT", name: "In transit", code: "TRN" } as const;

export interface BranchStock {
  branchId: string;
  onHand: number; // ACTIVE batches only (UNBATCHED included); recalled stock never counts
  incoming?: number; // dispatched to this branch, not yet received: counts towards its need, never its surplus
  soldInWindow: number; // units SOLD in the VELOCITY_DAYS whole UTC days before today
  daysInStock?: number; // of those days, how many the branch had stock to sell (default all of them)
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
  daysInStock: number; // the days velocity was measured over
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

const ceilDiv = (a: number, b: number) => (a + b - 1 - ((a + b - 1) % b)) / b; // non-negative integers, exact
const cover = (p: BranchPosition) => p.coverWeeks ?? Number.POSITIVE_INFINITY;

export function assessBranch(b: BranchStock): BranchPosition | null {
  if (!b.policy || b.stocktakeOpen) return null;
  const { reorderPoint: rp, overstockWeeks: w } = b.policy;
  const days = Math.max(MIN_DAYS_IN_STOCK, Math.min(VELOCITY_DAYS, b.daysInStock ?? VELOCITY_DAYS));
  const sold7 = 7 * b.soldInWindow; // units·days/week
  const coverWeeks = b.soldInWindow > 0 ? (b.onHand * days) / sold7 : b.onHand > 0 ? null : 0;
  const overstocked = b.soldInWindow > 0 ? b.onHand * days > w * sold7 : b.onHand > 0;
  const keep = Math.max(ceilDiv(w * sold7, days), rp + 1);
  const target = Math.max(rp + 1, ceilDiv(w * sold7, 2 * days));
  const surplus = overstocked ? Math.max(0, b.onHand - keep) : 0;
  const have = b.onHand + (b.incoming ?? 0); // a shortfall already on its way isn't suggested again
  const need = have < rp ? target - have : 0;
  return {
    branchId: b.branchId,
    onHand: b.onHand,
    velocity: sold7 / days,
    daysInStock: days,
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
