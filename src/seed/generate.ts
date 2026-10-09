import { allocateFifo, type Lot } from "@/domain/ledger/allocate";
import type { Batch, Branch, Movement, Product, SalesDay, StockPolicy, Supplier } from "@/domain/schemas";
import { BRANCHES, SUPPLIERS, buildCatalogue } from "./catalogue";

// Deterministic 12-month simulation. Uses the same FIFO allocator as runtime sales.

export interface SeedConfig {
  branches: number;
  skus: number;
  days: number;
  seed: number;
  anchor: Date; // last simulated day ends here
}

export const FULL: Omit<SeedConfig, "anchor"> = { branches: 15, skus: 300, days: 365, seed: 42 };
export const PREVIEW: Omit<SeedConfig, "anchor"> = { branches: 3, skus: 60, days: 365, seed: 42 };

export interface SeedData {
  branches: Branch[];
  suppliers: Supplier[];
  products: Product[];
  batches: Batch[];
  movements: Movement[];
  salesDays: SalesDay[];
  stockPolicies: StockPolicy[];
}

export const HERO_BATCH = "B-4471";
export const HERO_PARENT = "COT-DREAMTIMECOT120";
export const RECALLED_BATCH = "B-3920";

const DAY = 86_400_000;
const CYCLE_DAYS = 28;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(rand: () => number, lambda: number): number {
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > l);
  return k - 1;
}

const RATE: Record<Product["category"], number> = { cot: 0.08, pram: 0.04, monitor: 0.08, clothing: 0.12, toy: 0.1 };

function season(date: Date): number {
  const m = date.getUTCMonth();
  return m === 10 || m === 11 ? 1.6 : m === 0 ? 0.8 : m >= 5 && m <= 7 ? 1.1 : 1;
}

export function generateSeed(cfg: SeedConfig): SeedData {
  const rand = mulberry32(cfg.seed);
  const branches = BRANCHES.slice(0, cfg.branches);
  const products = buildCatalogue(cfg.skus);
  const anchorDay = Math.floor(cfg.anchor.getTime() / DAY) * DAY;
  const dayStart = (d: number) => anchorDay - (cfg.days - 1 - d) * DAY;
  const at = (d: number, hours: number, ms = 0) => new Date(dayStart(d) + hours * 3_600_000 + ms);

  const branchFactor = new Map(branches.map((b) => [b._id, 0.6 + rand() * 0.8]));
  const parents = [...new Set(products.map((p) => p.parentSku))];

  // One batch code per parent product per 28-day supplier cycle, shared by its variants.
  const heroCycle = Math.floor((cfg.days - 45) / CYCLE_DAYS); // recent enough that some units are still on shelves
  const recalledCycle = Math.floor((cfg.days - 90) / CYCLE_DAYS);
  const recalledParent = products.find((p) => p.category === "monitor")?.parentSku;
  let counter = 3000;
  const codeOf = new Map<string, string>();
  const cycles = Math.ceil(cfg.days / CYCLE_DAYS);
  for (let cycle = 0; cycle < cycles; cycle++) {
    for (const parent of parents) {
      let code: string;
      if (parent === HERO_PARENT && cycle === heroCycle) code = HERO_BATCH;
      else if (parent === recalledParent && cycle === recalledCycle) code = RECALLED_BATCH;
      else {
        do code = `B-${++counter}`;
        while (code === HERO_BATCH || code === RECALLED_BATCH);
      }
      codeOf.set(`${parent}|${cycle}`, code);
    }
  }

  const batches = new Map<string, Batch>();
  const batchFor = (p: Product, d: number): Batch => {
    const cycle = Math.floor(d / CYCLE_DAYS);
    const batchCode = codeOf.get(`${p.parentSku}|${cycle}`)!;
    const id = `${p.supplierId}:${batchCode}:${p._id}`;
    let b = batches.get(id);
    if (!b) {
      b = { _id: id, supplierId: p.supplierId, batchCode, sku: p._id, parentSku: p.parentSku, receivedAt: at(d, 7), status: "ACTIVE" };
      batches.set(id, b);
    }
    return b;
  };

  const movements: Movement[] = [];
  const salesDays: SalesDay[] = [];
  const stockPolicies: StockPolicy[] = [];
  const lots = new Map<string, Lot[]>(); // `${branchId}|${sku}`
  const policy = new Map<string, { rp: number; order: number; lambda: number }>();
  const base = { attributed: false, actor: "seed", origin: "seed" as const };

  for (const b of branches) {
    for (const p of products) {
      const lambda = RATE[p.category] * branchFactor.get(b._id)!;
      const rp = Math.max(1, Math.round(lambda * 14));
      const order = Math.max(2, Math.round(lambda * 28));
      policy.set(`${b._id}|${p._id}`, { rp, order, lambda });
      stockPolicies.push({ _id: `${b._id}:${p._id}`, branchId: b._id, sku: p._id, reorderPoint: rp, overstockWeeks: 6 });
    }
  }

  const onHand = (key: string) => (lots.get(key) ?? []).reduce((n, l) => n + l.onHand, 0);
  const take = (key: string, allocations: { batchId: string; qty: number }[]) => {
    const list = lots.get(key)!;
    for (const a of allocations) list.find((l) => l.batchId === a.batchId)!.onHand -= a.qty;
    lots.set(key, list.filter((l) => l.onHand > 0));
  };

  for (let d = 0; d < cfg.days; d++) {
    // 06:00 seeded recall of one monitor batch (gives the UI a recalled example).
    if (d === cfg.days - 60 && recalledParent) {
      for (const batch of batches.values()) {
        if (batch.batchCode !== RECALLED_BATCH) continue;
        batch.status = "RECALLED";
        batch.recalledAt = at(d, 6);
        batch.recallOrigin = "seed";
        for (const [key, list] of lots) {
          const lot = list.find((l) => l.batchId === batch._id);
          if (!lot) continue;
          lot.status = "RECALLED";
          const [branchId, sku] = key.split("|");
          movements.push({ ...base, type: "RECALLED", at: at(d, 6), branchId, sku, batchId: batch._id, qty: -lot.onHand, refType: "quarantine", refId: `seed-recall-${RECALLED_BATCH}` });
          take(key, [{ batchId: batch._id, qty: lot.onHand }]);
        }
      }
    }

    // 07:00 deliveries for anything at or below its reorder point.
    let seq = 0;
    for (const b of branches) {
      for (const p of products) {
        const key = `${b._id}|${p._id}`;
        const pol = policy.get(key)!;
        if (onHand(key) > pol.rp) continue;
        const batch = batchFor(p, d);
        const qty = d === 0 ? pol.order * 2 : pol.order;
        const list = lots.get(key) ?? [];
        const lot = list.find((l) => l.batchId === batch._id);
        if (lot) lot.onHand += qty;
        else list.push({ batchId: batch._id, receivedAt: batch.receivedAt, onHand: qty, status: "ACTIVE" });
        lots.set(key, list);
        movements.push({ ...base, type: "RECEIVED", at: at(d, 7, seq++), branchId: b._id, sku: p._id, batchId: batch._id, qty, refType: "seed", refId: `seed-delivery-${d}` });
      }
    }

    // 08:00 fortnightly rebalancing transfers between the fullest and emptiest branch.
    if (d % 14 === 7 && branches.length > 1) {
      for (let i = 0; i < Math.max(2, Math.round(products.length / 25)); i++) {
        const p = products[Math.floor(rand() * products.length)];
        const ranked = branches.map((b) => ({ b, n: onHand(`${b._id}|${p._id}`) })).sort((x, y) => y.n - x.n);
        const from = ranked[0];
        const to = ranked[ranked.length - 1];
        const qty = Math.floor((from.n - to.n) / 2);
        if (qty < 2) continue;
        const fromKey = `${from.b._id}|${p._id}`;
        const { allocations } = allocateFifo(lots.get(fromKey)!, qty);
        take(fromKey, allocations);
        const toKey = `${to.b._id}|${p._id}`;
        const toList = lots.get(toKey) ?? [];
        const refId = `seed-transfer-${d}-${i}`;
        for (const a of allocations) {
          const batch = batches.get(a.batchId)!;
          const lot = toList.find((l) => l.batchId === a.batchId);
          if (lot) lot.onHand += a.qty;
          else toList.push({ batchId: a.batchId, receivedAt: batch.receivedAt, onHand: a.qty, status: batch.status });
          movements.push({ ...base, type: "TRANSFER_OUT", at: at(d, 8, i), branchId: from.b._id, sku: p._id, batchId: a.batchId, qty: -a.qty, refType: "transfer", refId });
          movements.push({ ...base, type: "TRANSFER_IN", at: at(d, 8, i), branchId: to.b._id, sku: p._id, batchId: a.batchId, qty: a.qty, refType: "transfer", refId });
        }
        lots.set(toKey, toList);
      }
    }

    // 09:00–18:00 sales, FIFO-attributed, recorded on one daily sales document per branch.
    const s = season(new Date(dayStart(d)));
    for (const b of branches) {
      const lines: SalesDay["lines"] = [];
      const events: { minute: number; p: Product; units: number }[] = [];
      for (const p of products) {
        const units = poisson(rand, policy.get(`${b._id}|${p._id}`)!.lambda * s);
        if (units > 0) events.push({ minute: Math.floor(rand() * 540), p, units });
      }
      events.sort((x, y) => x.minute - y.minute);
      for (const [i, e] of events.entries()) {
        const key = `${b._id}|${e.p._id}`;
        const available = onHand(key);
        const qty = Math.min(e.units, available);
        if (qty <= 0) continue; // lost sale: shelf empty
        const { allocations } = allocateFifo(lots.get(key)!, qty);
        take(key, allocations);
        const when = new Date(dayStart(d) + 9 * 3_600_000 + e.minute * 60_000 + i);
        for (const a of allocations) {
          movements.push({ ...base, attributed: true, type: "SOLD", at: when, branchId: b._id, sku: e.p._id, batchId: a.batchId, qty: -a.qty, refType: "sale", refId: `seed-sale-${b.code}-${d}-${i}` });
        }
        lines.push({ sku: e.p._id, qty, unitPrice: e.p.price, allocations });
      }
      if (lines.length) {
        const day = new Date(dayStart(d));
        salesDays.push({ _id: `${b._id}:${day.toISOString().slice(0, 10)}`, branchId: b._id, day, lines });
      }
    }
  }

  return { branches, suppliers: SUPPLIERS, products, batches: [...batches.values()], movements, salesDays, stockPolicies };
}
