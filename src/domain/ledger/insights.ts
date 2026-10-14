import type { Db } from "mongodb";
import { cols } from "../collections";
import type { Product } from "../schemas";
import { DAY } from "./fold";

// Read models for the manager Stock and Analytics screens (Milestone 4). On-hand is sellable stock:
// recalled batches are excluded, as in transfers.

export const DEAD_DAYS = 90;
export const OVERDUE_DAYS = 7;
export const MOVER_DAYS = 30;

interface Row {
  branchId: string;
  sku: string;
  onHand: number;
}

async function sellable(db: Db, branchId?: string): Promise<Row[]> {
  const c = cols(db);
  const recalled = await c.batches.distinct("_id", { status: "RECALLED" });
  return c.inventory
    .aggregate<Row>([
      { $match: { ...(branchId ? { branchId } : {}), batchId: { $nin: recalled } } },
      { $group: { _id: { branchId: "$branchId", sku: "$sku" }, onHand: { $sum: "$onHand" } } },
      { $project: { _id: 0, branchId: "$_id.branchId", sku: "$_id.sku", onHand: 1 } },
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
  salesByMonth: { month: string; pence: number; units: number }[];
  topMovers: { sku: string; name: string; units: number }[];
  orders: { open: number; avgLeadDays: number | null; fillRate: number | null };
}

// Exceptions first (design D7): what needs action, then how sales and orders are going.
export async function analytics(db: Db, opts: { branchId?: string; category?: Product["category"]; now?: Date } = {}): Promise<Analytics> {
  const c = cols(db);
  const now = opts.now ?? new Date();
  const byBranch = opts.branchId ? { branchId: opts.branchId } : {};
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const categorySkus = opts.category ? await c.products.distinct("_id", { category: opts.category }) : null;
  const bySku = categorySkus ? { sku: { $in: categorySkus } } : {};
  const [products, branches, suppliers, rows, policies, soldRecently, months, movers, orders] = await Promise.all([
    c.products.find({}, { projection: { name: 1, category: 1, price: 1 } }).toArray(),
    c.branches.find({}, { projection: { name: 1 } }).toArray(),
    c.suppliers.find({}, { projection: { name: 1 } }).toArray(),
    sellable(db, opts.branchId),
    c.stockPolicies.find(byBranch).toArray(),
    c.movements.aggregate<{ _id: { branchId: string; sku: string } }>([
      { $match: { type: "SOLD", at: { $gte: new Date(now.getTime() - DEAD_DAYS * DAY) }, ...byBranch } },
      { $group: { _id: { branchId: "$branchId", sku: "$sku" } } },
    ]).toArray(),
    c.salesDays.aggregate<{ _id: { month: string; sku: string }; pence: number; units: number }>([
      { $match: { day: { $gte: monthStart }, ...byBranch } },
      { $unwind: "$lines" },
      {
        $group: {
          _id: { month: { $dateToString: { format: "%Y-%m", date: "$day" } }, sku: "$lines.sku" },
          pence: { $sum: { $multiply: ["$lines.qty", "$lines.unitPrice"] } },
          units: { $sum: "$lines.qty" },
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

  const monthTotals = new Map<string, { pence: number; units: number }>();
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + i, 1));
    monthTotals.set(d.toISOString().slice(0, 7), { pence: 0, units: 0 });
  }
  for (const m of months) {
    const t = monthTotals.get(m._id.month);
    if (t && inCategory(m._id.sku)) {
      t.pence += m.pence;
      t.units += m.units;
    }
  }

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
    salesByMonth: [...monthTotals].map(([month, t]) => ({ month, ...t })),
    topMovers: movers.map((m) => ({ sku: m._id, name: product.get(m._id)?.name ?? m._id, units: m.units })),
    orders: {
      open: orders.filter((o) => o.status === "SENT" || o.status === "PARTIAL").length,
      avgLeadDays: received.length ? received.reduce((n, o) => n + (o.receivedAt!.getTime() - o.sentAt.getTime()), 0) / received.length / DAY : null,
      fillRate: ordered ? closed.reduce((n, o) => n + o.lines.reduce((m, l) => m + l.received, 0), 0) / ordered : null,
    },
  };
}
