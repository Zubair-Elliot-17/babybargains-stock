import { allocateFifo, type Lot } from "@/domain/ledger/allocate";
import { countKey, planLine } from "@/domain/ledger/stocktake";
import type { Batch, Branch, Movement, Product, SalesDay, StockPolicy, Stocktake, StocktakeLine, Supplier } from "@/domain/schemas";
import { BRANCHES, SUPPLIERS, buildCatalogue } from "./catalogue";

// Deterministic 12-month simulation. Uses the same FIFO allocator as runtime sales.

export interface SeedConfig {
  branches: number;
  skus: number;
  days: number;
  seed: number;
  anchor: Date; // last simulated day ends here
  transferScenario?: boolean; // default on; off only to compare against in tests
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
  stocktakes: Stocktake[];
  stocktakeLines: StocktakeLine[];
  transferScenario: string[]; // SKUs given the over/under-stock scenario
}

export const HERO_BATCH = "B-4471";
export const HERO_PARENT = "COT-DREAMTIMECOT120";
export const RECALLED_BATCH = "B-3920";

const DAY = 86_400_000;
const CYCLE_DAYS = 28;
// Transfer scenario: a few SKUs were over-ordered and sell slowly at one branch, while another
// branch had a demand spike and missed its last delivery.
const SCENARIO_DAYS = 70; // donor: one 4× order 10 weeks ago, then sales thinned to 40%
const SCENARIO_OVER_ORDER = 4;
const SCENARIO_KEEP_SALES = 0.4;
const SCENARIO_SPIKE_DAYS = 14; // recipient: extra demand at 3× its usual rate
const SCENARIO_SPIKE = 3;
const SCENARIO_SKIPPED_DELIVERY_DAYS = 14;

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

// What a seeded stocktake decided, keyed by stocktake id, plus how many main-stream draws it made.
type StocktakeTape = Map<string, { draws: number; skipped: Set<string>; counted: Map<string, number> }>;

export function generateSeed(cfg: SeedConfig): SeedData {
  if (cfg.branches < 2 || cfg.transferScenario === false) return simulate({ ...cfg, transferScenario: false }).data;
  // The stocktakes' main-stream draws depend on stock, which the scenario changes. Replaying the
  // plain run's stocktake decisions for every other SKU keeps the main stream, and so every
  // non-scenario SKU's history, identical to the dataset without the scenario.
  return simulate(cfg, simulate({ ...cfg, transferScenario: false }, undefined, true).tape).data;
}

// tapeOnly: the plain run only needs its stocktake tape, so its output rows are dropped as they're made.
function simulate(cfg: SeedConfig, baseline?: StocktakeTape, tapeOnly = false): { data: SeedData; tape: StocktakeTape } {
  const rows = <T>(): T[] => {
    const a: T[] = [];
    if (tapeOnly) a.push = () => 0;
    return a;
  };
  const mainRand = mulberry32(cfg.seed);
  let draws = 0;
  const rand = () => (draws++, mainRand());
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

  // Own RNG stream: the scenario's picks and draws don't consume the main simulation's stream. The
  // hero and recalled products are never picked, keeping the recall demo's figures stable.
  const scenarioRand = mulberry32(cfg.seed + 1);
  const scenario = new Map<string, { donor: string; recipient: string }>();
  if (branches.length > 1 && cfg.transferScenario !== false) {
    const pool = products.filter((p) => p.parentSku !== HERO_PARENT && p.parentSku !== recalledParent);
    const n = Math.min(pool.length, Math.max(18, Math.round(products.length * 0.05)));
    for (let i = 0; i < n; i++) {
      const [p] = pool.splice(Math.floor(scenarioRand() * pool.length), 1);
      const donor = Math.floor(scenarioRand() * branches.length);
      const recipient = (donor + 1 + Math.floor(scenarioRand() * (branches.length - 1))) % branches.length;
      scenario.set(p._id, { donor: branches[donor]._id, recipient: branches[recipient]._id });
    }
  }
  const inScenario = (d: number, days: number) => d >= cfg.days - days;

  const movements = rows<Movement>();
  const stocktakes: Stocktake[] = [];
  const stocktakeLines = rows<StocktakeLine>();
  const salesDays = rows<SalesDay>();
  const stockPolicies: StockPolicy[] = [];
  const lots = new Map<string, Lot[]>(); // `${branchId}|${sku}`
  const policy = new Map<string, { rp: number; order: number; lambda: number }>();
  const base = { attributed: false, actor: "seed", origin: "seed" as const };
  const tape: StocktakeTape = new Map();

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
        const overOrder = scenario.get(p._id)?.donor === b._id && d === cfg.days - SCENARIO_DAYS;
        if (onHand(key) > pol.rp && !overOrder) continue;
        if (scenario.get(p._id)?.recipient === b._id && inScenario(d, SCENARIO_SKIPPED_DELIVERY_DAYS)) continue;
        const batch = batchFor(p, d);
        const qty = d === 0 ? pol.order * 2 : overOrder ? pol.order * SCENARIO_OVER_ORDER : pol.order;
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
        if (scenario.has(p._id) && inScenario(d, SCENARIO_DAYS)) continue; // would rebalance the scenario away
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

    // 08:30 seeded stocktakes: approved at the first branch 20 days ago, awaiting review at the second yesterday.
    const stocktakeBranch = d === cfg.days - 20 ? branches[0] : d === cfg.days - 1 ? branches[1] : undefined;
    if (stocktakeBranch) {
      const approved = d === cfg.days - 20;
      const countedAt = at(d, 8.5);
      const id = `ST-${stocktakeBranch.code}-${countedAt.toISOString().slice(0, 10)}-seed`;
      stocktakes.push({
        _id: id, branchId: stocktakeBranch._id, status: approved ? "APPROVED" : "SUBMITTED", openedAt: at(d, 8), openedBy: "seed",
        clerkLabel: approved ? "Clerk Priya" : "Clerk Sam", lastActivityAt: countedAt, submittedAt: at(d, 8.6), uncounted: "leave",
        ...(approved ? { approvedAt: at(d, 8.7), approvedOrigin: "seed" as const } : {}), origin: "seed",
      });
      let lineNo = 0;
      const noisy = (r: () => number, n: number, i: number) => {
        if (!approved && i % 8 === 3 && n > 0) return Math.max(0, n - 3); // guaranteed lines to review
        const x = r();
        return x < 0.1 ? Math.max(0, n - 1) : x < 0.15 ? n + 1 : n;
      };
      const drawsBefore = draws;
      const rec = baseline?.get(id);
      const taped = { draws: 0, skipped: new Set<string>(), counted: new Map<string, number>() };
      const replay = (sku: string) => rec !== undefined && !scenario.has(sku);
      const stRand = rec ? scenarioRand : rand; // scenario SKUs' own decisions
      for (const p of products) {
        if (!approved && (replay(p._id) ? rec!.skipped.has(p._id) : stRand() > 0.4)) { // the submitted count covers ~40% of products
          taped.skipped.add(p._id);
          continue;
        }
        const key = `${stocktakeBranch._id}|${p._id}`;
        const list = lots.get(key) ?? [];
        const targets = p.batchTracked ? list.filter((l) => l.onHand > 0).map((l) => l.batchId) : [undefined];
        for (const batchId of targets) {
          const expected = batchId ? list.find((l) => l.batchId === batchId)!.onHand : onHand(key);
          const newest = [...batches.values()].filter((b) => b.sku === p._id && b.status === "ACTIVE").sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())[0];
          const lineKey = `${p._id}|${batchId ?? ""}`;
          let counted = replay(p._id) ? rec!.counted.get(lineKey) : noisy(stRand, expected, lineNo);
          if (counted === undefined) throw new Error(`seed: stocktake replay out of step at ${id} ${lineKey}`);
          if (!batchId && counted > expected && !newest) counted = expected;
          taped.counted.set(lineKey, counted);
          stocktakeLines.push({ _id: `${id}-L${lineNo++}`, stocktakeId: id, sku: p._id, ...(batchId ? { batchId } : {}), counted, mode: "replace", countedAt, clerkId: "seed", origin: "seed" });
          if (!approved) continue;
          const plan = planLine(
            { key: countKey(p._id, batchId), sku: p._id, batchId, counted, expected, pricePence: p.price, lots: batchId ? list.filter((l) => l.batchId === batchId) : list, newestActiveBatchId: newest?._id ?? null },
            `${p.supplierId}:UNBATCHED:${p._id}`,
          );
          for (const a of plan.adjustments) {
            const lot = list.find((l) => l.batchId === a.batchId);
            if (lot) lot.onHand += a.qty;
            else list.push({ batchId: a.batchId, receivedAt: batches.get(a.batchId)!.receivedAt, onHand: a.qty, status: "ACTIVE" });
            movements.push({ ...base, attributed: a.attributed, type: "ADJUSTMENT", at: at(d, 8.7), effectiveAt: countedAt, branchId: stocktakeBranch._id, sku: p._id, batchId: a.batchId, qty: a.qty, refType: "stocktake", refId: id });
          }
          lots.set(key, list.filter((l) => l.onHand > 0));
        }
      }
      if (rec) while (draws - drawsBefore < rec.draws) rand(); // advance the main stream as the plain run did
      taped.draws = draws - drawsBefore;
      tape.set(id, taped);
    }

    // 09:00–18:00 sales, FIFO-attributed, recorded on one daily sales document per branch.
    const s = season(new Date(dayStart(d)));
    for (const b of branches) {
      const lines: SalesDay["lines"] = [];
      const events: { minute: number; p: Product; units: number }[] = [];
      for (const p of products) {
        const units = poisson(rand, policy.get(`${b._id}|${p._id}`)!.lambda * s);
        if (units > 0) events.push({ minute: Math.floor(rand() * 540), p, units });
        if (scenario.get(p._id)?.recipient === b._id && inScenario(d, SCENARIO_SPIKE_DAYS)) {
          const extra = poisson(scenarioRand, policy.get(`${b._id}|${p._id}`)!.lambda * SCENARIO_SPIKE);
          if (extra > 0) events.push({ minute: Math.floor(scenarioRand() * 540), p, units: extra });
        }
      }
      events.sort((x, y) => x.minute - y.minute);
      for (const [i, e] of events.entries()) {
        const key = `${b._id}|${e.p._id}`;
        const available = onHand(key);
        const qty = Math.min(e.units, available);
        if (qty <= 0) continue; // lost sale: shelf empty
        if (scenario.get(e.p._id)?.donor === b._id && inScenario(d, SCENARIO_DAYS) && scenarioRand() >= SCENARIO_KEEP_SALES) continue;
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

  return { data: { branches, suppliers: SUPPLIERS, products, batches: [...batches.values()], movements, salesDays, stockPolicies, stocktakes, stocktakeLines, transferScenario: [...scenario.keys()] }, tape };
}
