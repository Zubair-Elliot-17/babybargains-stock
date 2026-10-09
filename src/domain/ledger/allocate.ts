// Pure FIFO allocation shared by the seed generator, runtime commands and the client replay.

export interface Lot {
  batchId: string;
  receivedAt: Date;
  onHand: number;
  status: "ACTIVE" | "RECALLED";
  unbatched?: boolean;
}

export interface Allocation {
  batchId: string;
  qty: number;
}

export interface AllocationResult {
  allocations: Allocation[];
  shortBy: number; // > 0 when attributable stock is less than qty
}

export function orderLots(lots: Lot[]): Lot[] {
  return lots
    .filter((l) => l.status === "ACTIVE" && l.onHand > 0)
    .sort(
      (a, b) =>
        Number(!!a.unbatched) - Number(!!b.unbatched) ||
        a.receivedAt.getTime() - b.receivedAt.getTime() ||
        a.batchId.localeCompare(b.batchId),
    );
}

export function allocateFifo(lots: Lot[], qty: number): AllocationResult {
  if (!Number.isInteger(qty) || qty <= 0) throw new RangeError(`qty must be a positive integer, got ${qty}`);
  const allocations: Allocation[] = [];
  let remaining = qty;
  for (const lot of orderLots(lots)) {
    if (remaining === 0) break;
    const take = Math.min(lot.onHand, remaining);
    allocations.push({ batchId: lot.batchId, qty: take });
    remaining -= take;
  }
  return { allocations, shortBy: remaining };
}
