import type { ClientSession, Db } from "mongodb";
import { cols, type Cols } from "../collections";
import { NotFound } from "../errors";
import type { Batch, Branch, Product, Stocktake } from "../schemas";
import { allocateFifo, type Lot } from "./allocate";
import { DAY, type CompactMovement } from "./fold";
import { activeStocktakes, foldCounts, planLine, unbatchedBatchId, type EffectiveCount, type PlannedLine } from "./stocktake";
import { VELOCITY_DAYS, suggestTransfers, type BranchStock, type SkuStock, type TransferSuggestion } from "./transfers";

export interface RecallView {
  batchCode: string;
  batches: Pick<Batch, "_id" | "sku" | "parentSku" | "supplierId" | "receivedAt" | "status" | "recalledAt">[];
  products: Pick<Product, "_id" | "name" | "parentSku" | "category" | "batchTracked">[];
  supplierName: string;
  branches: Pick<Branch, "_id" | "name" | "code">[];
  movements: CompactMovement[];
  lastCountedAt: Record<string, string>; // branchId → ISO date of the last approved batch-level count
}

// Latest approved batch-level count per branch for these batches (a match posts no adjustment,
// so this comes from the count lines, not the ledger).
async function lastBatchCounts(c: Cols, batchIds: string[]): Promise<Record<string, string>> {
  const lines = await c.stocktakeLines
    .find({ batchId: { $in: batchIds } }, { projection: { stocktakeId: 1, countedAt: 1 } })
    .toArray();
  if (!lines.length) return {};
  const approved = await c.stocktakes
    .find({ _id: { $in: [...new Set(lines.map((l) => l.stocktakeId))] }, status: "APPROVED" }, { projection: { branchId: 1 } })
    .toArray();
  const branchOf = new Map(approved.map((st) => [st._id, st.branchId]));
  const out: Record<string, string> = {};
  for (const l of lines) {
    const branchId = branchOf.get(l.stocktakeId);
    if (!branchId) continue;
    const iso = l.countedAt.toISOString();
    if (!out[branchId] || out[branchId] < iso) out[branchId] = iso;
  }
  return out;
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normaliseBatchCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export async function findRecall(db: Db, rawCode: string): Promise<RecallView | null> {
  const c = cols(db);
  const batchCode = normaliseBatchCode(rawCode);
  const batches = await c.batches.find({ batchCode }).toArray();
  if (!batches.length) return null;
  const batchIds = batches.map((b) => b._id);
  const [products, branches, supplier, movements, counts] = await Promise.all([
    c.products
      .find({ _id: { $in: [...new Set(batches.map((b) => b.sku))] } })
      .project<RecallView["products"][number]>({ name: 1, parentSku: 1, category: 1, batchTracked: 1 })
      .toArray(),
    c.branches.find({}, { projection: { name: 1, code: 1 } }).sort({ name: 1 }).toArray(),
    c.suppliers.findOne({ _id: batches[0].supplierId }),
    c.movements
      .find({ batchId: { $in: batchIds } })
      .sort({ at: 1, _id: 1 })
      .project<{ type: CompactMovement["type"]; at: Date; branchId: string; sku: string; qty: number }>({
        _id: 0, type: 1, at: 1, branchId: 1, sku: 1, qty: 1,
      })
      .toArray(),
    lastBatchCounts(c, batchIds),
  ]);
  return {
    batchCode,
    batches: batches.map(({ _id, sku, parentSku, supplierId, receivedAt, status, recalledAt }) => ({
      _id, sku, parentSku, supplierId, receivedAt, status, recalledAt,
    })),
    products,
    supplierName: supplier?.name ?? batches[0].supplierId,
    branches,
    movements: movements.map((m) => ({ ...m, at: m.at.getTime() })),
    lastCountedAt: counts,
  };
}

// "Did you mean" candidates: same prefix, then shared leading characters.
export async function suggestBatchCodes(db: Db, rawCode: string, limit = 5): Promise<string[]> {
  const code = normaliseBatchCode(rawCode);
  for (let n = code.length; n >= 2; n--) {
    const found = await cols(db).batches.distinct("batchCode", { batchCode: { $regex: `^${escapeRegex(code.slice(0, n))}` } });
    if (found.length) return found.sort().slice(0, limit);
  }
  return [];
}

export async function recentRecalls(db: Db, limit = 5): Promise<{ batchCode: string; recalledAt: Date }[]> {
  return cols(db)
    .batches.aggregate<{ batchCode: string; recalledAt: Date }>([
      { $match: { status: "RECALLED" } },
      { $group: { _id: "$batchCode", recalledAt: { $max: "$recalledAt" } } },
      { $sort: { recalledAt: -1 } },
      { $limit: limit },
      { $project: { _id: 0, batchCode: "$_id", recalledAt: 1 } },
    ])
    .toArray();
}

export interface InvariantReport {
  ok: boolean;
  violations: string[];
  checked: number;
}

// Ledger invariants, checked after the seed, the nightly reset and in tests.
export async function checkLedgerInvariants(db: Db, maxViolations = 20): Promise<InvariantReport> {
  const c = cols(db);
  const violations: string[] = [];
  const push = (v: string) => violations.length < maxViolations && violations.push(v);

  // 1. Running balance per branch/sku/batch never negative.
  const running = new Map<string, number>();
  let checked = 0;
  const cursor = c.movements
    .find({}, { projection: { branchId: 1, sku: 1, batchId: 1, qty: 1, at: 1 } })
    .sort({ sku: 1, batchId: 1, at: 1 }); // served by the {sku, batchId, at} index, no in-memory sort
  for await (const m of cursor) {
    checked++;
    const key = `${m.branchId}|${m.sku}|${m.batchId}`;
    const next = (running.get(key) ?? 0) + m.qty;
    running.set(key, next);
    if (next < 0) push(`negative balance ${next} for ${key} at ${m.at.toISOString()}`);
  }

  // 2. Transfer pairs net to zero.
  const unbalanced = await c.movements
    .aggregate<{ _id: string; net: number }>([
      { $match: { refType: "transfer" } },
      { $group: { _id: "$refId", net: { $sum: "$qty" } } },
      { $match: { net: { $ne: 0 } } },
      { $limit: maxViolations },
    ])
    .toArray();
  unbalanced.forEach((t) => push(`transfer ${t._id} nets ${t.net}`));

  // 3. Nothing but the RECALLED movement touches a batch after its recall.
  const recalled = await c.batches.find({ status: "RECALLED" }, { projection: { recalledAt: 1 } }).toArray();
  for (const b of recalled) {
    const late = await c.movements.countDocuments({ batchId: b._id, at: { $gt: b.recalledAt! }, type: { $ne: "RECALLED" } });
    if (late) push(`${late} movement(s) after recall on ${b._id}`);
    const left = await c.inventory.countDocuments({ batchId: b._id, onHand: { $gt: 0 } });
    if (left) push(`recalled batch ${b._id} still has stock in ${left} row(s)`);
  }

  // 4. Sale-line allocations match SOLD movements per branch/sku.
  const [allocated, sold] = await Promise.all([
    c.salesDays
      .aggregate<{ _id: string; qty: number }>([
        { $unwind: "$lines" },
        { $unwind: "$lines.allocations" },
        { $group: { _id: { $concat: ["$branchId", "|", "$lines.sku"] }, qty: { $sum: "$lines.allocations.qty" } } },
      ])
      .toArray(),
    c.movements
      .aggregate<{ _id: string; qty: number }>([
        { $match: { type: "SOLD" } },
        { $group: { _id: { $concat: ["$branchId", "|", "$sku"] }, qty: { $sum: { $multiply: ["$qty", -1] } } } },
      ])
      .toArray(),
  ]);
  const soldBy = new Map(sold.map((s) => [s._id, s.qty]));
  for (const a of allocated) {
    if (soldBy.get(a._id) !== a.qty) push(`sale allocations ${a.qty} ≠ SOLD ${soldBy.get(a._id) ?? 0} for ${a._id}`);
    soldBy.delete(a._id);
  }
  for (const [k, q] of soldBy) push(`SOLD ${q} without sale lines for ${k}`);

  return { ok: violations.length === 0, violations, checked };
}

const projectionPipeline = [
  { $group: { _id: { branchId: "$branchId", sku: "$sku", batchId: "$batchId" }, onHand: { $sum: "$qty" }, updatedAt: { $max: "$at" } } },
  { $project: { _id: 0, branchId: "$_id.branchId", sku: "$_id.sku", batchId: "$_id.batchId", onHand: 1, updatedAt: 1 } },
];

// Differences between the live inventory projection and a fresh fold of the ledger.
export async function projectionDiff(db: Db, limit = 20): Promise<string[]> {
  const c = cols(db);
  const expected = new Map<string, number>();
  for await (const r of c.movements.aggregate<{ branchId: string; sku: string; batchId: string; onHand: number }>(projectionPipeline)) {
    expected.set(`${r.branchId}|${r.sku}|${r.batchId}`, r.onHand);
  }
  const diffs: string[] = [];
  for await (const r of c.inventory.find({})) {
    const key = `${r.branchId}|${r.sku}|${r.batchId}`;
    const want = expected.get(key) ?? 0;
    if (want !== r.onHand && diffs.length < limit) diffs.push(`${key}: inventory ${r.onHand}, ledger ${want}`);
    expected.delete(key);
  }
  for (const [key, want] of expected) if (want !== 0 && diffs.length < limit) diffs.push(`${key}: missing row, ledger ${want}`);
  return diffs;
}

// Recomputes the projection server-side ($out keeps the collection's indexes).
export async function rebuildProjection(db: Db): Promise<void> {
  await cols(db).movements.aggregate([...projectionPipeline, { $out: "inventory" }]).toArray();
}

// ── Stocktakes ───────────────────────────────────────────────────────────────

export interface StocktakePlan {
  stocktake: Stocktake;
  lines: (PlannedLine & { countedAt: Date; productName: string; batchCode?: string; supplierId: string })[];
  counts: Map<string, EffectiveCount>;
}

// Expected stock is evaluated at each line's countedAt: current onHand minus movements since.
export async function computeStocktakePlan(c: Cols, stocktakeId: string, session?: ClientSession): Promise<StocktakePlan> {
  const stocktake = await c.stocktakes.findOne({ _id: stocktakeId }, { session });
  if (!stocktake) throw new NotFound(`Stocktake ${stocktakeId} not found`);
  const entries = await c.stocktakeLines.find({ stocktakeId }, { session }).sort({ countedAt: 1, _id: 1 }).toArray();
  const counts = foldCounts(entries);
  const skus = [...new Set([...counts.values()].map((x) => x.sku))];
  if (!skus.length) return { stocktake, lines: [], counts };

  const branchId = stocktake.branchId;
  const minCountedAt = new Date(Math.min(...[...counts.values()].map((x) => x.countedAt.getTime())));
  const [products, rows, later, activeBatches] = await Promise.all([
    c.products.find({ _id: { $in: skus } }, { session, projection: { name: 1, price: 1, supplierId: 1 } }).toArray(),
    c.inventory.find({ branchId, sku: { $in: skus } }, { session }).toArray(),
    c.movements
      .find({ branchId, sku: { $in: skus }, at: { $gt: minCountedAt } }, { session, projection: { sku: 1, batchId: 1, qty: 1, at: 1 } })
      .toArray(),
    c.batches
      .find({ sku: { $in: skus }, status: "ACTIVE", batchCode: { $ne: "UNBATCHED" } }, { session, projection: { sku: 1, receivedAt: 1 } })
      .toArray(),
  ]);
  const batchIds = [...new Set([...rows.map((r) => r.batchId), ...[...counts.values()].flatMap((x) => (x.batchId ? [x.batchId] : []))])];
  const batches = await c.batches.find({ _id: { $in: batchIds } }, { session }).toArray();
  const batchById = new Map(batches.map((b) => [b._id, b]));
  const productById = new Map(products.map((p) => [p._id, p]));
  const newest = new Map<string, { id: string; at: number }>();
  for (const b of activeBatches) {
    const cur = newest.get(b.sku);
    if (!cur || b.receivedAt.getTime() > cur.at) newest.set(b.sku, { id: b._id, at: b.receivedAt.getTime() });
  }

  const lines = [...counts.values()].map((x) => {
    const product = productById.get(x.sku);
    if (!product) throw new NotFound(`Product ${x.sku} not found`);
    const relevant = rows.filter((r) => r.sku === x.sku && (!x.batchId || r.batchId === x.batchId));
    const since = later
      .filter((m) => m.sku === x.sku && (!x.batchId || m.batchId === x.batchId) && m.at > x.countedAt)
      .reduce((n, m) => n + m.qty, 0);
    const expected = relevant.reduce((n, r) => n + r.onHand, 0) - since;
    const lots: Lot[] = relevant
      .filter((r) => r.onHand > 0 && batchById.has(r.batchId))
      .map((r) => {
        const b = batchById.get(r.batchId)!;
        return { batchId: r.batchId, onHand: r.onHand, receivedAt: b.receivedAt, status: b.status, unbatched: b.batchCode === "UNBATCHED" };
      });
    const planned = planLine(
      { key: x.key, sku: x.sku, batchId: x.batchId, counted: x.counted, expected, pricePence: product.price, lots, newestActiveBatchId: newest.get(x.sku)?.id ?? null, batchRecalled: !!x.batchId && batchById.get(x.batchId)?.status === "RECALLED" },
      unbatchedBatchId(product.supplierId, x.sku),
    );
    return { ...planned, countedAt: x.countedAt, productName: product.name, batchCode: x.batchId ? batchById.get(x.batchId)?.batchCode : undefined, supplierId: product.supplierId };
  });
  return { stocktake, lines, counts };
}

export interface StocktakeSummary {
  _id: string;
  branchId: string;
  branchName: string;
  status: Stocktake["status"];
  clerkLabel: string;
  openedAt: Date;
  submittedAt?: Date;
  approvedAt?: Date;
  productsCounted: number;
}

export async function listStocktakes(db: Db, limit = 50): Promise<StocktakeSummary[]> {
  const c = cols(db);
  const [stocktakes, branches] = await Promise.all([
    c.stocktakes.find({}).sort({ openedAt: -1 }).limit(limit).toArray(),
    c.branches.find({}, { projection: { name: 1 } }).toArray(),
  ]);
  const names = new Map(branches.map((b) => [b._id, b.name]));
  const counted = await c.stocktakeLines
    .aggregate<{ _id: string; skus: string[] }>([
      { $match: { stocktakeId: { $in: stocktakes.map((s) => s._id) } } },
      { $group: { _id: "$stocktakeId", skus: { $addToSet: "$sku" } } },
    ])
    .toArray();
  const countedBy = new Map(counted.map((x) => [x._id, x.skus.length]));
  return stocktakes.map((s) => ({
    _id: s._id, branchId: s.branchId, branchName: names.get(s.branchId) ?? s.branchId, status: s.status, clerkLabel: s.clerkLabel,
    openedAt: s.openedAt, submittedAt: s.submittedAt, approvedAt: s.approvedAt, productsCounted: countedBy.get(s._id) ?? 0,
  }));
}

export async function awaitingReviewCount(db: Db): Promise<number> {
  return cols(db).stocktakes.countDocuments({ status: "SUBMITTED" });
}

export interface ClerkProduct {
  sku: string;
  name: string;
  category: Product["category"];
  batchTracked: boolean;
}

export interface CountView {
  stocktake: Stocktake;
  branchName: string;
  products: ClerkProduct[];
  entries: { _id: string; sku: string; batchId?: string; batchCode?: string; counted: number; mode: "add" | "replace"; countedAt: string }[];
}

// Clerk count screen data. Never includes system quantities (blind count).
export async function countView(db: Db, stocktakeId: string): Promise<CountView | null> {
  const c = cols(db);
  const stocktake = await c.stocktakes.findOne({ _id: stocktakeId });
  if (!stocktake) return null;
  const [branch, products, entries] = await Promise.all([
    c.branches.findOne({ _id: stocktake.branchId }),
    c.products.find({}, { projection: { name: 1, category: 1, batchTracked: 1 } }).sort({ category: 1, name: 1 }).toArray(),
    c.stocktakeLines.find({ stocktakeId }).sort({ countedAt: 1, _id: 1 }).toArray(),
  ]);
  const batchIds = [...new Set(entries.flatMap((e) => (e.batchId ? [e.batchId] : [])))];
  const codes = new Map((await c.batches.find({ _id: { $in: batchIds } }, { projection: { batchCode: 1 } }).toArray()).map((b) => [b._id, b.batchCode]));
  return {
    stocktake,
    branchName: branch?.name ?? stocktake.branchId,
    products: products.map((p) => ({ sku: p._id, name: p.name, category: p.category, batchTracked: p.batchTracked })),
    entries: entries.map((e) => ({
      _id: e._id, sku: e.sku, batchId: e.batchId, batchCode: e.batchId ? codes.get(e.batchId) : undefined,
      counted: e.counted, mode: e.mode, countedAt: e.countedAt.toISOString(),
    })),
  };
}

// Batch codes a clerk can pick for a batch-tracked SKU at their branch (codes only, no quantities).
export async function batchChoices(db: Db, branchId: string, sku: string): Promise<{ batchId: string; batchCode: string }[]> {
  const c = cols(db);
  const rows = await c.inventory.find({ branchId, sku }, { projection: { batchId: 1 } }).toArray();
  const batches = await c.batches
    .find({ _id: { $in: rows.map((r) => r.batchId) }, status: "ACTIVE" }, { projection: { batchCode: 1, receivedAt: 1 } })
    .sort({ receivedAt: -1 })
    .toArray();
  return batches.map((b) => ({ batchId: b._id, batchCode: b.batchCode }));
}

export async function latestStocktakeForBranch(db: Db, branchId: string): Promise<Stocktake | null> {
  return cols(db).stocktakes.find({ branchId }).sort({ openedAt: -1 }).limit(1).next();
}

// ── Transfers ────────────────────────────────────────────────────────────────

// Current stock, 8-week sales, policy and stocktake state per SKU and branch. On-hand is ACTIVE stock
// only: quarantine zeroes a recalled batch, but a later stocktake can put found units back on it.
export async function loadTransferInputs(
  c: Cols,
  now: Date,
  opts: { skus?: string[]; session?: ClientSession; openBranchIds?: string[] } = {}, // openBranchIds: already read by the caller
): Promise<SkuStock[]> {
  const { session } = opts;
  const bySku = opts.skus ? { sku: { $in: opts.skus } } : {};
  // Whole UTC days ending tonight, so the page and a later Accept the same day see the same sales.
  const until = new Date(Math.floor(now.getTime() / DAY) * DAY + DAY);
  const since = new Date(until.getTime() - VELOCITY_DAYS * DAY);
  const recalled = await c.batches.distinct("_id", { ...bySku, status: "RECALLED" }, { session });
  const [policies, products, stock, sold, open] = await Promise.all([
    c.stockPolicies.find(bySku, { session }).toArray(),
    c.products.find(opts.skus ? { _id: { $in: opts.skus } } : {}, { session, projection: { price: 1 } }).toArray(),
    c.inventory
      .aggregate<{ _id: { branchId: string; sku: string }; onHand: number }>(
        [{ $match: { ...bySku, onHand: { $gt: 0 }, batchId: { $nin: recalled } } }, { $group: { _id: { branchId: "$branchId", sku: "$sku" }, onHand: { $sum: "$onHand" } } }],
        { session },
      )
      .toArray(),
    c.movements
      .aggregate<{ _id: { branchId: string; sku: string }; units: number }>(
        [
          { $match: { type: "SOLD", at: { $gte: since, $lt: until }, ...bySku } },
          { $group: { _id: { branchId: "$branchId", sku: "$sku" }, units: { $sum: { $multiply: ["$qty", -1] } } } },
        ],
        { session },
      )
      .toArray(),
    opts.openBranchIds ?? c.stocktakes.distinct("branchId", activeStocktakes(now), { session }),
  ]);
  const key = (x: { branchId: string; sku: string }) => `${x.branchId}|${x.sku}`;
  const onHand = new Map(stock.map((r) => [key(r._id), r.onHand]));
  const sold56 = new Map(sold.map((r) => [key(r._id), r.units]));
  const openBranches = new Set(open);
  const out = new Map(products.map((p) => [p._id, { sku: p._id, pricePence: p.price, branches: [] as BranchStock[] }]));
  for (const p of policies) {
    out.get(p.sku)?.branches.push({
      branchId: p.branchId,
      onHand: onHand.get(key(p)) ?? 0,
      sold56: sold56.get(key(p)) ?? 0,
      policy: { reorderPoint: p.reorderPoint, overstockWeeks: p.overstockWeeks },
      stocktakeOpen: openBranches.has(p.branchId),
    });
  }
  return [...out.values()].filter((s) => s.branches.length);
}

export interface TransferRow extends TransferSuggestion {
  productName: string;
  fromName: string;
  toName: string;
  preview: { batchCode: string; qty: number }[]; // FIFO batches that would move
}

export interface TransfersView {
  suggestions: TransferRow[];
  branches: Pick<Branch, "_id" | "name">[];
  blocked: Pick<Branch, "_id" | "name">[]; // branches left out because a stocktake is open
}

// SKUs below their reorder point at one branch, counting ACTIVE stock as loadTransferInputs does.
async function shortSkus(c: Cols, branchId: string): Promise<string[]> {
  const recalled = await c.batches.distinct("_id", { status: "RECALLED" });
  const [policies, stock] = await Promise.all([
    c.stockPolicies.find({ branchId }, { projection: { sku: 1, reorderPoint: 1 } }).toArray(),
    c.inventory
      .aggregate<{ _id: string; onHand: number }>([
        { $match: { branchId, onHand: { $gt: 0 }, batchId: { $nin: recalled } } },
        { $group: { _id: "$sku", onHand: { $sum: "$onHand" } } },
      ])
      .toArray(),
  ]);
  const onHand = new Map(stock.map((r) => [r._id, r.onHand]));
  return policies.filter((p) => (onHand.get(p.sku) ?? 0) < p.reorderPoint).map((p) => p.sku);
}

export async function listTransferSuggestions(db: Db, opts: { now?: Date; to?: string } = {}): Promise<TransfersView> {
  const c = cols(db);
  const now = opts.now ?? new Date();
  const [open, branches] = await Promise.all([
    c.stocktakes.distinct("branchId", activeStocktakes(now)),
    c.branches.find({}, { projection: { name: 1 } }).sort({ name: 1 }).toArray(),
  ]);
  // A receiving-branch view only needs the SKUs that branch is short of (whole SKUs, so matching is unchanged).
  const inputs = await loadTransferInputs(c, now, { skus: opts.to ? await shortSkus(c, opts.to) : undefined, openBranchIds: open });
  const ranked = suggestTransfers(inputs).filter((s) => !opts.to || s.toBranchId === opts.to);
  const skus = [...new Set(ranked.map((s) => s.sku))];
  const [products, rows] = await Promise.all([
    c.products.find({ _id: { $in: skus } }, { projection: { name: 1 } }).toArray(),
    c.inventory.find({ sku: { $in: skus }, branchId: { $in: [...new Set(ranked.map((s) => s.fromBranchId))] }, onHand: { $gt: 0 } }).toArray(),
  ]);
  const batches = await c.batches.find({ _id: { $in: [...new Set(rows.map((r) => r.batchId))] } }, { projection: { batchCode: 1, receivedAt: 1, status: 1 } }).toArray();
  const batchById = new Map(batches.map((b) => [b._id, b]));
  const names = new Map(branches.map((b) => [b._id, b.name]));
  const productName = new Map(products.map((p) => [p._id, p.name]));
  const rowsByLot = Map.groupBy(rows, (r) => `${r.branchId}|${r.sku}`);
  const suggestions = ranked.map((s) => {
    const lots: Lot[] = (rowsByLot.get(`${s.fromBranchId}|${s.sku}`) ?? [])
      .filter((r) => batchById.has(r.batchId))
      .map((r) => {
        const b = batchById.get(r.batchId)!;
        return { batchId: r.batchId, onHand: r.onHand, receivedAt: b.receivedAt, status: b.status, unbatched: b.batchCode === "UNBATCHED" };
      });
    const preview = allocateFifo(lots, s.qty).allocations.map((a) => ({ batchCode: batchById.get(a.batchId)!.batchCode, qty: a.qty }));
    return {
      ...s,
      productName: productName.get(s.sku) ?? s.sku,
      fromName: names.get(s.fromBranchId) ?? s.fromBranchId,
      toName: names.get(s.toBranchId) ?? s.toBranchId,
      preview,
    };
  });
  return { suggestions, branches, blocked: branches.filter((b) => open.includes(b._id)) };
}
