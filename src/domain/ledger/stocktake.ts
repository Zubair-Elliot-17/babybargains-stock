import { allocateFifo, type Lot } from "./allocate";

// Pure stocktake maths shared by the manager review (read) and approval (write), so what is
// reviewed is exactly what is posted.

export const STALE_MS = 2 * 3_600_000; // an OPEN stocktake idle this long can be taken over, and stops blocking transfers

// OPEN stocktakes someone is still working on (Mongo filter).
export const activeStocktakes = (now: Date) => ({ status: "OPEN" as const, lastActivityAt: { $gt: new Date(now.getTime() - STALE_MS) } });

export const FLAG_UNITS = 3;
export const FLAG_PENCE = 5000; // £50

export interface CountEntry {
  sku: string;
  batchId?: string;
  counted: number;
  mode: "add" | "replace";
  countedAt: Date;
}

export interface EffectiveCount {
  key: string;
  sku: string;
  batchId?: string;
  counted: number;
  countedAt: Date; // time of the latest entry for this SKU/batch
}

export const countKey = (sku: string, batchId?: string) => `${sku}|${batchId ?? ""}`;

// Entries must be in countedAt order; replace resets the running count, add sums.
export function foldCounts(entries: CountEntry[]): Map<string, EffectiveCount> {
  const out = new Map<string, EffectiveCount>();
  for (const e of entries) {
    const key = countKey(e.sku, e.batchId);
    const prev = out.get(key);
    const counted = e.mode === "add" && prev ? prev.counted + e.counted : e.counted;
    out.set(key, { key, sku: e.sku, batchId: e.batchId, counted, countedAt: e.countedAt });
  }
  return out;
}

export interface PlanInput {
  key: string;
  sku: string;
  batchId?: string;
  counted: number;
  expected: number; // system stock at countedAt
  pricePence: number;
  lots: Lot[]; // current lots: the counted batch only for batch-tracked lines, all batches otherwise
  newestActiveBatchId: string | null; // target for positive variance on non-batch lines
  batchRecalled: boolean; // the counted batch is RECALLED (its lots are empty, so planLine can't tell)
}

export interface PlannedLine {
  key: string;
  sku: string;
  batchId?: string;
  counted: number;
  expected: number;
  variance: number;
  valuePence: number;
  flagged: boolean;
  adjustments: { batchId: string; qty: number; attributed: boolean }[];
  needsUnbatched: boolean; // positive variance with no ACTIVE batch → post to the SKU's UNBATCHED batch
  clampedBy: number; // negative variance larger than current stock (sold since the count)
  quarantined: number; // units found on a RECALLED batch: added, then pulled again with RECALLED -n
}

export function planLine(input: PlanInput, unbatchedId: string): PlannedLine {
  const variance = input.counted - input.expected;
  const valuePence = Math.abs(variance) * input.pricePence;
  const base = {
    key: input.key,
    sku: input.sku,
    batchId: input.batchId,
    counted: input.counted,
    expected: input.expected,
    variance,
    valuePence,
    flagged: Math.abs(variance) >= FLAG_UNITS || valuePence >= FLAG_PENCE,
    needsUnbatched: false,
    clampedBy: 0,
    quarantined: 0,
  };
  if (variance === 0) return { ...base, adjustments: [] };

  if (input.batchId) {
    if (variance > 0) {
      return { ...base, quarantined: input.batchRecalled ? variance : 0, adjustments: [{ batchId: input.batchId, qty: variance, attributed: false }] };
    }
    const onHand = input.lots.reduce((n, l) => n + l.onHand, 0);
    const take = Math.min(-variance, onHand);
    return { ...base, clampedBy: -variance - take, adjustments: take ? [{ batchId: input.batchId, qty: -take, attributed: false }] : [] };
  }

  if (variance > 0) {
    if (input.newestActiveBatchId) {
      return { ...base, adjustments: [{ batchId: input.newestActiveBatchId, qty: variance, attributed: true }] };
    }
    return { ...base, needsUnbatched: true, adjustments: [{ batchId: unbatchedId, qty: variance, attributed: true }] };
  }

  const available = input.lots.filter((l) => l.status === "ACTIVE").reduce((n, l) => n + l.onHand, 0);
  const take = Math.min(-variance, available);
  const allocations = take ? allocateFifo(input.lots, take).allocations : [];
  return {
    ...base,
    clampedBy: -variance - take,
    adjustments: allocations.map((a) => ({ batchId: a.batchId, qty: -a.qty, attributed: true })),
  };
}

// Manager review order: largest value at risk first.
export function sortForReview(lines: PlannedLine[]): PlannedLine[] {
  return [...lines].sort((a, b) => b.valuePence - a.valuePence || Math.abs(b.variance) - Math.abs(a.variance) || a.key.localeCompare(b.key));
}

export const unbatchedBatchId = (supplierId: string, sku: string) => `${supplierId}:UNBATCHED:${sku}`;
