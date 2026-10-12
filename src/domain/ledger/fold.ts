// Pure replay of ledger movements; runs on the server and in the browser (recall slider).

export interface CompactMovement {
  type: "RECEIVED" | "SOLD" | "TRANSFER_OUT" | "TRANSFER_IN" | "ADJUSTMENT" | "RECALLED";
  at: number; // epoch ms
  branchId: string;
  sku: string;
  qty: number;
}

export interface BranchState {
  branchId: string;
  received: number;
  transferredIn: number;
  transferredOut: number;
  sold: number;
  adjusted: number;
  quarantined: number;
  found: number; // units a stocktake found on the batch after its recall (quarantined again at once)
  onHand: number;
}

export interface FoldResult {
  totals: Omit<BranchState, "branchId">;
  branches: BranchState[];
}

const empty = () => ({ received: 0, transferredIn: 0, transferredOut: 0, sold: 0, adjusted: 0, quarantined: 0, found: 0, onHand: 0 });

// Movements must be sorted by `at`; asOf is inclusive.
export function foldMovements(movements: CompactMovement[], asOf = Number.POSITIVE_INFINITY, recalledAt = Number.POSITIVE_INFINITY): FoldResult {
  const byBranch = new Map<string, BranchState>();
  const totals = empty();
  for (const m of movements) {
    if (m.at > asOf) break;
    let b = byBranch.get(m.branchId);
    if (!b) byBranch.set(m.branchId, (b = { branchId: m.branchId, ...empty() }));
    for (const s of [b, totals]) {
      switch (m.type) {
        case "RECEIVED": s.received += m.qty; break;
        case "TRANSFER_IN": s.transferredIn += m.qty; break;
        case "TRANSFER_OUT": s.transferredOut -= m.qty; break;
        case "SOLD": s.sold -= m.qty; break;
        case "ADJUSTMENT":
          s.adjusted += m.qty;
          if (m.qty > 0 && m.at > recalledAt) s.found += m.qty;
          break;
        case "RECALLED": s.quarantined -= m.qty; break;
      }
      s.onHand += m.qty;
    }
  }
  const branches = [...byBranch.values()].sort((a, b) => b.onHand - a.onHand || a.branchId.localeCompare(b.branchId));
  return { totals, branches };
}

export type EventKind = "delivery" | "transfer" | "stocktake" | "recall";

export interface TimelineEvent {
  day: number; // epoch ms at UTC midnight
  kind: EventKind;
  label: string;
}

const DAY = 86_400_000;

// One tick per day and kind; sales are too frequent to tick.
export function timelineEvents(movements: CompactMovement[]): TimelineEvent[] {
  const seen = new Map<string, TimelineEvent & { units: number }>();
  for (const m of movements) {
    const kind: EventKind | null =
      m.type === "RECEIVED" ? "delivery"
      : m.type === "TRANSFER_IN" ? "transfer"
      : m.type === "ADJUSTMENT" ? "stocktake"
      : m.type === "RECALLED" ? "recall"
      : null;
    if (!kind) continue;
    const day = Math.floor(m.at / DAY) * DAY;
    const key = `${day}:${kind}`;
    const e = seen.get(key) ?? { day, kind, label: "", units: 0 };
    e.units += Math.abs(m.qty);
    seen.set(key, e);
  }
  const verb: Record<EventKind, string> = { delivery: "received", transfer: "transferred", stocktake: "adjusted", recall: "quarantined" };
  return [...seen.values()]
    .sort((a, b) => a.day - b.day)
    .map(({ day, kind, units }) => ({ day, kind, label: `${units} units ${verb[kind]}` }));
}

export function startOfDay(ms: number): number {
  return Math.floor(ms / DAY) * DAY;
}
export { DAY };
