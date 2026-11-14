import type { Db } from "mongodb";
import { cols } from "../collections";
import { ProductCategory, type Product } from "../schemas";
import { DAY } from "./fold";

// Read model for the manager Trends screen: units sold, indexed like Google Trends (the busiest point = 100).

export const CATEGORY_LABELS: Record<Product["category"], string> = { cot: "Cots", pram: "Prams", monitor: "Monitors", clothing: "Clothing", toy: "Toys" };
export const MAX_TERMS = 5;
export const RANGES = {
  "30d": { label: "Past 30 days", buckets: 30, size: 1 },
  "90d": { label: "Past 90 days", buckets: 13, size: 7 },
  "12m": { label: "Past 12 months", buckets: 52, size: 7 },
} as const;
export type Range = keyof typeof RANGES;
const RISING_MIN = 5; // units in the later half before a product can be "rising": keeps one-off sales out

export type Term = { kind: "cat"; id: Product["category"] } | { kind: "sku"; id: string };
export const termKey = (t: Term) => `${t.kind}:${t.id}`;

export interface Trends {
  terms: { key: string; name: string; values: number[]; units: number; avg: number }[]; // values: 0-100 per bucket
  buckets: string[]; // ISO date each bucket starts, oldest first; the last ends today
  branches: { branchId: string; name: string; code: string; units: number[]; index: number[] }[]; // per term; index 0-100 by share of the branch's sales
  top: { sku: string; name: string; units: number; index: number }[];
  rising: { sku: string; name: string; units: number; growth: number | null }[]; // null = no sales in the earlier half (breakout)
}

// Parses `t` params ("cat:pram", "sku:COT-1") against the catalogue: unknown, duplicate or extra terms are dropped.
export function parseTerms(raw: string[], products: { _id: string }[]): Term[] {
  const skus = new Set(products.map((p) => p._id));
  const out = new Map<string, Term>();
  for (const r of raw) {
    const [kind, id] = [r.slice(0, r.indexOf(":")), r.slice(r.indexOf(":") + 1)];
    const t: Term | null = kind === "cat" && ProductCategory.safeParse(id).success ? { kind, id: id as Product["category"] } : kind === "sku" && skus.has(id) ? { kind, id } : null;
    if (t && out.size < MAX_TERMS) out.set(termKey(t), t);
  }
  return [...out.values()];
}

export async function trends(db: Db, opts: { terms: Term[]; range: Range; branchId?: string; now?: Date }): Promise<Trends> {
  const c = cols(db);
  const now = opts.now ?? new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const { buckets, size } = RANGES[opts.range];
  const days = buckets * size;
  const [products, branches] = await Promise.all([
    c.products.find({}, { projection: { name: 1, category: 1 } }).toArray(),
    c.branches.find({}, { projection: { name: 1, code: 1 } }).sort({ name: 1 }).toArray(),
  ]);
  const product = new Map(products.map((p) => [p._id, p]));
  const skusOf = (t: Term) => (t.kind === "sku" ? [t.id] : products.filter((p) => p.category === t.id).map((p) => p._id));
  // Related products come from the categories the terms belong to.
  const scopeCats = new Set(opts.terms.map((t) => (t.kind === "cat" ? t.id : product.get(t.id)!.category)));
  const scope = products.filter((p) => scopeCats.has(p.category)).map((p) => p._id);

  const [facets] = await c.salesDays.aggregate<{
    byDay: { _id: { day: Date; sku: string }; units: number }[];
    byBranch: { _id: { branchId: string; sku: string }; units: number }[];
    branchTotals: { _id: string; units: number }[];
  }>([
    { $match: { day: { $gte: new Date(today - (days - 1) * DAY), $lt: new Date(today + DAY) } } },
    { $unwind: "$lines" },
    {
      $facet: {
        byDay: [
          { $match: { "lines.sku": { $in: scope }, ...(opts.branchId ? { branchId: opts.branchId } : {}) } },
          { $group: { _id: { day: "$day", sku: "$lines.sku" }, units: { $sum: "$lines.qty" } } },
        ],
        byBranch: [{ $match: { "lines.sku": { $in: scope } } }, { $group: { _id: { branchId: "$branchId", sku: "$lines.sku" }, units: { $sum: "$lines.qty" } } }],
        branchTotals: [{ $group: { _id: "$branchId", units: { $sum: "$lines.qty" } } }],
      },
    },
  ]).toArray();

  // Units per sku per day back from today (0 = today).
  const daily = new Map<string, number[]>();
  for (const r of facets.byDay) {
    const ago = Math.round((today - r._id.day.getTime()) / DAY);
    if (!daily.has(r._id.sku)) daily.set(r._id.sku, Array(days).fill(0));
    daily.get(r._id.sku)![days - 1 - ago] += r.units;
  }
  const raw = opts.terms.map((t) => {
    const series = Array(buckets).fill(0);
    for (const sku of skusOf(t)) daily.get(sku)?.forEach((u, d) => (series[Math.floor(d / size)] += u));
    return series as number[];
  });
  const peak = Math.max(0, ...raw.flat());
  const index = (v: number, top: number) => (top > 0 ? Math.round((v / top) * 100) : 0);
  const terms = opts.terms.map((t, i) => {
    const values = raw[i].map((v) => index(v, peak));
    return {
      key: termKey(t),
      name: t.kind === "cat" ? CATEGORY_LABELS[t.id] : product.get(t.id)!.name,
      values,
      units: raw[i].reduce((a, b) => a + b, 0),
      avg: Math.round(values.reduce((a, b) => a + b, 0) / buckets),
    };
  });

  // By branch: each term's share of all units the branch sold, indexed so the highest share = 100 (Google's regional interest).
  const branchUnits = new Map(facets.byBranch.map((r) => [`${r._id.branchId}|${r._id.sku}`, r.units]));
  const total = new Map(facets.branchTotals.map((r) => [r._id, r.units]));
  const rows = branches.map((b) => {
    const units = opts.terms.map((t) => skusOf(t).reduce((n, sku) => n + (branchUnits.get(`${b._id}|${sku}`) ?? 0), 0));
    return { branchId: b._id, name: b.name, code: b.code, units, share: units.map((u) => (total.get(b._id) ? u / total.get(b._id)! : 0)) };
  });
  const topShare = opts.terms.map((_, i) => Math.max(0, ...rows.map((r) => r.share[i])));
  const branchRows = rows.map(({ share, ...r }) => ({ ...r, index: share.map((s, i) => index(s, topShare[i])) }));

  // Top: most units in the range. Rising: daily rate in the later half against the earlier half.
  const half = Math.floor(days / 2);
  const related = scope.map((sku) => {
    const d = daily.get(sku) ?? [];
    const early = d.slice(0, half).reduce((a, b) => a + b, 0);
    const late = d.slice(half).reduce((a, b) => a + b, 0);
    return { sku, name: product.get(sku)!.name, units: early + late, late, growth: early > 0 ? (late / (days - half)) / (early / half) - 1 : null };
  });
  const topUnits = Math.max(0, ...related.map((r) => r.units));
  return {
    terms,
    buckets: Array.from({ length: buckets }, (_, b) => new Date(today - (days - 1 - b * size) * DAY).toISOString().slice(0, 10)),
    branches: branchRows,
    top: related
      .filter((r) => r.units > 0)
      .sort((a, b) => b.units - a.units || a.name.localeCompare(b.name))
      .slice(0, 10)
      .map((r) => ({ sku: r.sku, name: r.name, units: r.units, index: index(r.units, topUnits) })),
    rising: related
      .filter((r) => r.late >= RISING_MIN && (r.growth === null || r.growth > 0))
      .sort((a, b) => (b.growth ?? Infinity) - (a.growth ?? Infinity) || b.late - a.late || a.name.localeCompare(b.name))
      .slice(0, 10)
      .map((r) => ({ sku: r.sku, name: r.name, units: r.late, growth: r.growth })),
  };
}
