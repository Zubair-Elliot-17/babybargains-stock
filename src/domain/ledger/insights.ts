import type { Db } from "mongodb";
import { IN_TRANSIT } from "./transfers";
import { cols } from "../collections";
import { ProductCategory, type Product } from "../schemas";
import { DAY } from "./fold";

// Read models for the manager Stock and Analytics screens (Milestone 4). On-hand is sellable stock:
// recalled batches are excluded, as in transfers.

export const DEAD_DAYS = 90;
export const OVERDUE_DAYS = 7;
export const MOVER_DAYS = 30;
export const COVER_WEEKS = 8; // sales window for weeks of cover
export const YEAR_DAYS = 364; // 52 whole weeks, so the weekly trend and the 12-month totals agree

interface Row {
  branchId: string;
  sku: string;
  onHand: number;
}

// Shelf stock: not goods on the road, not recalled batches.
async function shelf(db: Db, branchId?: string) {
  const recalled = await cols(db).batches.distinct("_id", { status: "RECALLED" });
  return { branchId: branchId ?? { $ne: IN_TRANSIT._id }, batchId: { $nin: recalled } };
}

async function sellable(db: Db, branchId?: string, match?: Awaited<ReturnType<typeof shelf>>): Promise<Row[]> {
  return cols(db).inventory
    .aggregate<Row>([
      { $match: match ?? (await shelf(db, branchId)) },
      { $group: { _id: { branchId: "$branchId", sku: "$sku" }, onHand: { $sum: "$onHand" } } },
      { $project: { _id: 0, branchId: "$_id.branchId", sku: "$_id.sku", onHand: 1 } },
    ])
    .toArray();
}

export const AGE_BUCKETS = [
  { bucket: "0–30 days", upTo: 30 },
  { bucket: "31–90 days", upTo: 90 },
  { bucket: "91–180 days", upTo: 180 },
  { bucket: "Over 180 days", upTo: Infinity },
] as const;

// Shelf stock by SKU and age bucket (R3): batches joined on _id, bucketed in the database.
async function shelfByAge(db: Db, match: Awaited<ReturnType<typeof shelf>>, now: Date) {
  const age = { $ifNull: [{ $floor: { $divide: [{ $subtract: [now, { $first: "$b.receivedAt" }] }, DAY] } }, Number.MAX_SAFE_INTEGER] }; // no batch record: oldest
  return cols(db).inventory
    .aggregate<{ _id: { sku: string; bucket: number }; onHand: number }>([
      { $match: match },
      { $group: { _id: "$batchId", sku: { $first: "$sku" }, onHand: { $sum: "$onHand" } } },
      { $lookup: { from: "batches", localField: "_id", foreignField: "_id", as: "b", pipeline: [{ $project: { _id: 0, receivedAt: 1 } }] } },
      { $set: { age } },
      {
        $group: {
          _id: { sku: "$sku", bucket: { $switch: { branches: AGE_BUCKETS.slice(0, -1).map((b, i) => ({ case: { $lte: ["$age", b.upTo] }, then: i })), default: AGE_BUCKETS.length - 1 } } },
          onHand: { $sum: "$onHand" },
        },
      },
    ])
    .toArray();
}

export interface StockRow {
  sku: string;
  name: string;
  category: Product["category"];
  onHand: number;
  reorderPoint: number; // summed across branches when viewing all
  low: boolean;
}

// One row per product for a branch (or all branches summed), low stock first.
export async function stockView(db: Db, opts: { branchId?: string; q?: string; lowOnly?: boolean } = {}): Promise<StockRow[]> {
  const c = cols(db);
  const [products, rows, policies] = await Promise.all([
    c.products.find({}, { projection: { name: 1, category: 1 } }).toArray(),
    sellable(db, opts.branchId),
    c.stockPolicies.find(opts.branchId ? { branchId: opts.branchId } : {}).toArray(),
  ]);
  const onHand = new Map<string, number>();
  for (const r of rows) onHand.set(r.sku, (onHand.get(r.sku) ?? 0) + r.onHand);
  const rp = new Map<string, number>();
  for (const p of policies) rp.set(p.sku, (rp.get(p.sku) ?? 0) + p.reorderPoint);
  // With all branches, "low" means at least one branch is below its own reorder point.
  const lowAnywhere = new Set<string>();
  if (!opts.branchId) {
    const at = new Map(rows.map((r) => [`${r.branchId}|${r.sku}`, r.onHand]));
    for (const p of policies) if ((at.get(`${p.branchId}|${p.sku}`) ?? 0) < p.reorderPoint) lowAnywhere.add(p.sku);
  }
  const q = opts.q?.trim().toLowerCase();
  return products
    .map((p) => {
      const have = onHand.get(p._id) ?? 0;
      const point = rp.get(p._id) ?? 0;
      return { sku: p._id, name: p.name, category: p.category, onHand: have, reorderPoint: point, low: opts.branchId ? have < point : lowAnywhere.has(p._id) };
    })
    .filter((r) => (!q || r.name.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q)) && (!opts.lowOnly || r.low))
    .sort((a, b) => Number(b.low) - Number(a.low) || a.onHand - a.reorderPoint - (b.onHand - b.reorderPoint) || a.name.localeCompare(b.name));
}

export interface Analytics {
  lowStock: { branchId: string; branchName: string; sku: string; name: string; onHand: number; reorderPoint: number }[];
  lowStockTotal: number;
  deadStock: { branchId: string; branchName: string; sku: string; name: string; onHand: number; valuePence: number }[];
  deadStockTotal: number;
  deadStockValuePence: number;
  overdueOrders: { _id: string; branchName: string; supplierName: string; sentAt: Date; outstanding: number }[];
  salesByWeek: { start: string; pence: number; units: number }[]; // 52 weeks, the last one ending today
  stockAge: { bucket: (typeof AGE_BUCKETS)[number]["bucket"]; pence: number }[]; // shelf stock at retail by batch age
  cover: { category: Product["category"]; onHand: number; weeklyUnits: number; weeks: number | null; band: [number, number] | null }[];
  abc: { class: "A" | "B" | "C"; skus: number; pence: number; skuShare: number; revenueShare: number }[];
  categories: { category: Product["category"]; pence: number; share: number }[]; // the year's revenue, largest first
  weekday: { branchId: string; name: string; code: string; avg: number[] }[]; // Mon..Sun average daily pence, last 12 weeks
  league: { branchId: string; name: string; code: string; sales30: number; change: number | null; weekly: number[] }[]; // every branch (Q3)
  kpi: {
    sales30: number;
    salesPrev30: number;
    salesChange: number | null; // null when the previous period sold nothing
    units30: number;
    unitsPrev30: number;
    unitsChange: number | null;
    daily30: number[]; // pence per day, oldest first, ending today
    stockPence: number; // shelf stock at retail
  };
  topMovers: { sku: string; name: string; units: number }[];
  orders: { open: number; avgLeadDays: number | null; fillRate: number | null };
}

// Exceptions first (design D7): what needs action, then how sales and orders are going.
export async function analytics(db: Db, opts: { branchId?: string; category?: Product["category"]; now?: Date } = {}): Promise<Analytics> {
  const c = cols(db);
  const now = opts.now ?? new Date();
  const byBranch = opts.branchId ? { branchId: opts.branchId } : {};
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const categorySkus = opts.category ? await c.products.distinct("_id", { category: opts.category }) : null;
  const lines = categorySkus ? { $filter: { input: "$lines", cond: { $in: ["$$this.sku", categorySkus] } } } : "$lines";
  const bySku = categorySkus ? { sku: { $in: categorySkus } } : {};
  const match = shelf(db, opts.branchId);
  const [products, branches, suppliers, rows, ageRows, policies, soldRecently, [sales], movers, orders] = await Promise.all([
    c.products.find({}, { projection: { name: 1, category: 1, price: 1 } }).toArray(),
    c.branches.find({}, { projection: { name: 1, code: 1 } }).toArray(),
    c.suppliers.find({}, { projection: { name: 1 } }).toArray(),
    match.then((m) => sellable(db, opts.branchId, m)),
    match.then((m) => shelfByAge(db, m, now)),
    c.stockPolicies.find(byBranch).toArray(),
    c.movements.aggregate<{ _id: { branchId: string; sku: string } }>([
      { $match: { type: "SOLD", at: { $gte: new Date(now.getTime() - DEAD_DAYS * DAY) }, ...byBranch } },
      { $group: { _id: { branchId: "$branchId", sku: "$sku" } } },
    ]).toArray(),
    // The page's only salesDays read (R1). A salesDays doc is one branch-day, so per-day totals need no $unwind;
    // they keep every branch for the league and heatmap. Only the by-SKU facet unwinds lines.
    c.salesDays.aggregate<SalesFacets>([
      { $match: { day: { $gte: new Date(today - (YEAR_DAYS - 1) * DAY), $lt: new Date(today + DAY) } } },
      // Other branches only feed the league and heatmap, which read the last 84 days.
      ...(opts.branchId ? [{ $match: { $or: [{ branchId: opts.branchId }, { day: { $gte: new Date(today - 83 * DAY) } }] } }] : []),
      {
        $facet: {
          days: [{ $project: { _id: 0, branchId: 1, day: 1, pence: { $sum: { $map: { input: lines, in: { $multiply: ["$$this.qty", "$$this.unitPrice"] } } } }, units: { $sum: { $map: { input: lines, in: "$$this.qty" } } } } }],
          skus: [
            ...(opts.branchId ? [{ $match: { branchId: opts.branchId } }] : []),
            { $unwind: "$lines" },
            ...(categorySkus ? [{ $match: { "lines.sku": { $in: categorySkus } } }] : []),
            {
              $group: {
                _id: "$lines.sku",
                pence: { $sum: { $multiply: ["$lines.qty", "$lines.unitPrice"] } },
                recent: { $sum: { $cond: [{ $gte: ["$day", new Date(today - (COVER_WEEKS * 7 - 1) * DAY)] }, "$lines.qty", 0] } },
              },
            },
          ],
        },
      },
    ]).toArray(),
    c.movements.aggregate<{ _id: string; units: number }>([
      { $match: { type: "SOLD", at: { $gte: new Date(now.getTime() - MOVER_DAYS * DAY) }, ...byBranch, ...bySku } },
      { $group: { _id: "$sku", units: { $sum: { $multiply: ["$qty", -1] } } } },
      { $sort: { units: -1, _id: 1 } },
      { $limit: 10 },
    ]).toArray(),
    c.purchaseOrders.find({ ...byBranch, sentAt: { $gte: new Date(now.getTime() - 365 * DAY) } }).toArray(), // a year of orders
  ]);
  const product = new Map(products.map((p) => [p._id, p]));
  const inCategory = (sku: string) => !opts.category || product.get(sku)?.category === opts.category;
  const branchName = new Map(branches.map((b) => [b._id, b.name]));
  const supplierName = new Map(suppliers.map((s) => [s._id, s.name]));
  const at = new Map(rows.map((r) => [`${r.branchId}|${r.sku}`, r.onHand]));

  const low = policies
    .filter((p) => p.reorderPoint > 0 && inCategory(p.sku) && (at.get(`${p.branchId}|${p.sku}`) ?? 0) < p.reorderPoint)
    .map((p) => ({ branchId: p.branchId, branchName: branchName.get(p.branchId) ?? p.branchId, sku: p.sku, name: product.get(p.sku)?.name ?? p.sku, onHand: at.get(`${p.branchId}|${p.sku}`) ?? 0, reorderPoint: p.reorderPoint }))
    .sort((a, b) => a.onHand - a.reorderPoint - (b.onHand - b.reorderPoint));

  const sold = new Set(soldRecently.map((r) => `${r._id.branchId}|${r._id.sku}`));
  const dead = rows
    .filter((r) => r.onHand > 0 && inCategory(r.sku) && !sold.has(`${r.branchId}|${r.sku}`))
    .map((r) => ({ branchId: r.branchId, branchName: branchName.get(r.branchId) ?? r.branchId, sku: r.sku, name: product.get(r.sku)?.name ?? r.sku, onHand: r.onHand, valuePence: r.onHand * (product.get(r.sku)?.price ?? 0) }))
    .sort((a, b) => b.valuePence - a.valuePence);

  const overdue = orders
    .filter((o) => (o.status === "SENT" || o.status === "PARTIAL") && now.getTime() - o.sentAt.getTime() > OVERDUE_DAYS * DAY)
    .map((o) => ({ _id: o._id, branchName: branchName.get(o.branchId) ?? o.branchId, supplierName: supplierName.get(o.supplierId) ?? o.supplierId, sentAt: o.sentAt, outstanding: o.lines.reduce((n, l) => n + l.ordered - l.received, 0) }))
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());

  // Per-day totals, for the chosen scope and per branch; `ago` counts whole UTC days back from today (0 = today).
  type Days = Map<number, { pence: number; units: number }>;
  const add = (m: Days, ago: number, r: { pence: number; units: number }) => {
    const d = m.get(ago) ?? { pence: 0, units: 0 };
    d.pence += r.pence;
    d.units += r.units;
    m.set(ago, d);
  };
  const daily: Days = new Map();
  const perBranch = new Map<string, Days>();
  for (const r of sales.days) {
    const ago = Math.round((today - r.day.getTime()) / DAY);
    if (!perBranch.has(r.branchId)) perBranch.set(r.branchId, new Map());
    add(perBranch.get(r.branchId)!, ago, r);
    if (!opts.branchId || r.branchId === opts.branchId) add(daily, ago, r);
  }
  const sumOf = (m: Days | undefined, from: number, to: number, key: "pence" | "units") => {
    let n = 0;
    for (let a = from; a <= to; a++) n += m?.get(a)?.[key] ?? 0;
    return n;
  };
  const sum = (from: number, to: number, key: "pence" | "units") => sumOf(daily, from, to, key);
  const league = branches
    .map((b) => {
      const m = perBranch.get(b._id);
      const sales30 = sumOf(m, 0, 29, "pence");
      return { branchId: b._id, name: b.name, code: b.code, sales30, change: change(sales30, sumOf(m, 30, 59, "pence")), weekly: Array.from({ length: 12 }, (_, w) => sumOf(m, (11 - w) * 7, (11 - w) * 7 + 6, "pence")) };
    })
    .sort((a, b) => b.sales30 - a.sales30 || a.name.localeCompare(b.name));
  const byCategory = new Map<string, number>();
  for (const r of sales.skus) {
    const cat = product.get(r._id)?.category;
    if (cat) byCategory.set(cat, (byCategory.get(cat) ?? 0) + r.pence);
  }
  const yearPence = sales.skus.reduce((n, r) => n + r.pence, 0);
  const categories = ProductCategory.options
    .filter((cat) => !opts.category || cat === opts.category)
    .map((category) => ({ category, pence: byCategory.get(category) ?? 0, share: yearPence ? (byCategory.get(category) ?? 0) / yearPence : 0 }))
    .sort((a, b) => b.pence - a.pence || a.category.localeCompare(b.category));
  const stockAge = AGE_BUCKETS.map((b) => ({ bucket: b.bucket, pence: 0 }));
  for (const r of ageRows) if (inCategory(r._id.sku)) stockAge[r._id.bucket].pence += r.onHand * (product.get(r._id.sku)?.price ?? 0);

  // Weeks of cover = on hand ÷ weekly units. Band (R4): Σ reorder points ÷ weekly units, up to mean overstock weeks,
  // never below the reorder cover (as assessBranch keeps max(overstock weeks, reorder point)).
  const cover = ProductCategory.options
    .filter((cat) => !opts.category || cat === opts.category)
    .map((category) => {
      const isCat = (sku: string) => product.get(sku)?.category === category;
      const onHand = rows.filter((r) => isCat(r.sku)).reduce((n, r) => n + r.onHand, 0);
      const weeklyUnits = sales.skus.filter((r) => isCat(r._id)).reduce((n, r) => n + r.recent, 0) / COVER_WEEKS;
      const pol = policies.filter((p) => isCat(p.sku));
      const low = pol.reduce((n, p) => n + p.reorderPoint, 0) / weeklyUnits;
      const band: [number, number] | null = weeklyUnits > 0 && pol.length
        ? [low, Math.max(low, pol.reduce((n, p) => n + p.overstockWeeks, 0) / pol.length)]
        : null;
      return { category, onHand, weeklyUnits, weeks: weeklyUnits > 0 ? onHand / weeklyUnits : null, band };
    });

  // ABC by the year's revenue: a product's class comes from the share ranked above it (<80% A, <95% B, else C).
  const revenue = new Map(sales.skus.map((r) => [r._id, r.pence]));
  const ranked = products.filter((p) => inCategory(p._id)).map((p) => ({ sku: p._id, pence: revenue.get(p._id) ?? 0 }));
  ranked.sort((a, b) => b.pence - a.pence || a.sku.localeCompare(b.sku));
  const scopePence = ranked.reduce((n, r) => n + r.pence, 0);
  const abc = (["A", "B", "C"] as const).map((cls) => ({ class: cls, skus: 0, pence: 0, skuShare: 0, revenueShare: 0 }));
  let above = 0;
  for (const r of ranked) {
    const row = abc[r.pence > 0 && above * 100 < 80 * scopePence ? 0 : r.pence > 0 && above * 100 < 95 * scopePence ? 1 : 2]; // integer maths: no float drift at the cut-offs
    row.skus++;
    row.pence += r.pence;
    above += r.pence;
  }
  for (const row of abc) {
    row.skuShare = ranked.length ? row.skus / ranked.length : 0;
    row.revenueShare = scopePence ? row.pence / scopePence : 0;
  }
  const todayDow = (new Date(today).getUTCDay() + 6) % 7; // Monday = 0
  const weekday = [...branches]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((b) => {
      const avg = [0, 0, 0, 0, 0, 0, 0];
      for (let ago = 0; ago < 84; ago++) avg[(todayDow - (ago % 7) + 7) % 7] += perBranch.get(b._id)?.get(ago)?.pence ?? 0;
      return { branchId: b._id, name: b.name, code: b.code, avg: avg.map((p) => p / 12) }; // each weekday occurs 12 times in 84 days
    });
  const kpi = {
    sales30: sum(0, 29, "pence"),
    salesPrev30: sum(30, 59, "pence"),
    units30: sum(0, 29, "units"),
    unitsPrev30: sum(30, 59, "units"),
    daily30: Array.from({ length: 30 }, (_, i) => daily.get(29 - i)?.pence ?? 0),
  };

  const received = orders.filter((o) => o.status === "RECEIVED" && o.receivedAt);
  const closed = orders.filter((o) => o.status === "RECEIVED" || o.status === "CANCELLED"); // finished orders only
  const ordered = closed.reduce((n, o) => n + o.lines.reduce((m, l) => m + l.ordered, 0), 0);
  return {
    lowStock: low.slice(0, 10),
    lowStockTotal: low.length,
    deadStock: dead.slice(0, 10),
    deadStockTotal: dead.length,
    deadStockValuePence: dead.reduce((n, d) => n + d.valuePence, 0),
    overdueOrders: overdue,
    salesByWeek: Array.from({ length: YEAR_DAYS / 7 }, (_, w) => {
      const last = (YEAR_DAYS / 7 - 1 - w) * 7; // days ago of the week's final day
      return { start: new Date(today - (last + 6) * DAY).toISOString().slice(0, 10), pence: sum(last, last + 6, "pence"), units: sum(last, last + 6, "units") };
    }),
    league,
    weekday,
    categories,
    abc,
    cover,
    stockAge,
    kpi: { ...kpi, stockPence: stockAge.reduce((n, b) => n + b.pence, 0), salesChange: change(kpi.sales30, kpi.salesPrev30), unitsChange: change(kpi.units30, kpi.unitsPrev30) },
    topMovers: movers.map((m) => ({ sku: m._id, name: product.get(m._id)?.name ?? m._id, units: m.units })),
    orders: {
      open: orders.filter((o) => o.status === "SENT" || o.status === "PARTIAL").length,
      avgLeadDays: received.length ? received.reduce((n, o) => n + (o.receivedAt!.getTime() - o.sentAt.getTime()), 0) / received.length / DAY : null,
      fillRate: ordered ? closed.reduce((n, o) => n + o.lines.reduce((m, l) => m + l.received, 0), 0) / ordered : null,
    },
  };
}

interface SalesFacets {
  days: { branchId: string; day: Date; pence: number; units: number }[];
  skus: { _id: string; pence: number; recent: number }[]; // year revenue and last COVER_WEEKS weeks' units, by sku
}

const change = (now: number, before: number) => (before > 0 ? (now - before) / before : null);
