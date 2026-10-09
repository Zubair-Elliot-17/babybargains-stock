import type { Db } from "mongodb";
import { cols } from "../collections";
import type { Batch, Branch, Product } from "../schemas";
import type { CompactMovement } from "./fold";

export interface RecallView {
  batchCode: string;
  batches: Pick<Batch, "_id" | "sku" | "parentSku" | "supplierId" | "receivedAt" | "status" | "recalledAt">[];
  products: Pick<Product, "_id" | "name" | "parentSku" | "category" | "batchTracked">[];
  supplierName: string;
  branches: Pick<Branch, "_id" | "name" | "code">[];
  movements: CompactMovement[];
  lastCountedAt: Record<string, string>; // branchId → ISO date of the last approved batch-level count
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
    c.movements
      .aggregate<{ _id: string; at: Date }>([
        { $match: { batchId: { $in: batchIds }, refType: "stocktake" } },
        { $group: { _id: "$branchId", at: { $max: "$at" } } },
      ])
      .toArray(),
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
    lastCountedAt: Object.fromEntries(counts.map((x) => [x._id, x.at.toISOString()])),
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
