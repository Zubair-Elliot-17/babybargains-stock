import { createHash } from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import { cols, type Cols } from "../collections";
import { DomainError, NotFound } from "../errors";
import type { PurchaseOrder } from "../schemas";
import { BATCH_CODE, incomingUnits, normaliseBatchCode } from "./read";
import { UNBATCHED } from "./stocktake";
import { lockBranches, postMovements, type CommandCtx, type NewMovement } from "./write";

// Purchase orders (Milestone 4, docs/designs/milestone-4.md): create as SENT, receive in one or more
// deliveries (each posts RECEIVED movements into named batches), cancel while nothing has arrived.

export interface CreateOrderInput {
  branchId: string;
  supplierId: string;
  lines: { sku: string; qty: number }[];
}

export async function createPurchaseOrder(c: Cols, s: ClientSession, ctx: CommandCtx, input: CreateOrderInput): Promise<PurchaseOrder> {
  const now = ctx.now ?? new Date();
  const skus = input.lines.map((l) => l.sku);
  if (new Set(skus).size !== skus.length) throw new DomainError("DUPLICATE_LINE", "Each product can appear once per order", 400);
  const [branch, supplier, products] = await Promise.all([
    c.branches.findOne({ _id: input.branchId }, { session: s }),
    c.suppliers.findOne({ _id: input.supplierId }, { session: s }),
    c.products.find({ _id: { $in: skus } }, { session: s, projection: { supplierId: 1 } }).toArray(),
  ]);
  if (!branch) throw new NotFound(`Branch ${input.branchId} not found`);
  if (!supplier) throw new NotFound(`Supplier ${input.supplierId} not found`);
  const supplierOf = new Map(products.map((p) => [p._id, p.supplierId]));
  for (const sku of skus) {
    if (!supplierOf.has(sku)) throw new NotFound(`Product ${sku} not found`);
    if (supplierOf.get(sku) !== input.supplierId) throw new DomainError("WRONG_SUPPLIER", `${sku} is not supplied by ${supplier.name}`, 400);
  }
  const order: PurchaseOrder = {
    _id: `PO-${branch.code}-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${createHash("sha1").update(ctx.commandId).digest("hex").slice(0, 12)}`,
    supplierId: input.supplierId,
    branchId: input.branchId,
    status: "SENT",
    lines: input.lines.map((l) => ({ sku: l.sku, ordered: l.qty, received: 0 })),
    sentAt: now,
    origin: ctx.origin,
  };
  await c.purchaseOrders.insertOne(order, { session: s });
  return order;
}

const MAX_NOTES = 200; // schemas.ts PurchaseOrder.importedNotes

export interface ReceiveOrderInput {
  orderId: string;
  lines: { sku: string; qty: number; batchCode: string }[];
  noteId?: string; // set when the lines came from a supplier delivery note
}

export async function receivePurchaseOrder(c: Cols, s: ClientSession, ctx: CommandCtx, input: ReceiveOrderInput) {
  const now = ctx.now ?? new Date();
  const order = await c.purchaseOrders.findOne({ _id: input.orderId }, { session: s });
  if (!order) throw new NotFound(`Order ${input.orderId} not found`);
  if (order.status !== "SENT" && order.status !== "PARTIAL") throw new DomainError("ORDER_CLOSED", `Order is ${order.status.toLowerCase()}`, 409);
  if (input.noteId && order.importedNotes?.includes(input.noteId)) {
    throw new DomainError("NOTE_ALREADY_RECEIVED", `Delivery note ${input.noteId} is already recorded on this order`, 409);
  }
  if (input.noteId && (order.importedNotes?.length ?? 0) >= MAX_NOTES) {
    throw new DomainError("TOO_MANY_NOTES", `This order already has ${MAX_NOTES} delivery notes; enter this delivery by hand`, 409);
  }
  await lockBranches(c, s, [order.branchId]); // conflicts with a recall committing at the same time (it locks all branches)
  const arriving = input.lines.filter((l) => l.qty > 0);
  if (!arriving.length) throw new DomainError("NOTHING_RECEIVED", "Enter a quantity for at least one line", 400);
  if (new Set(arriving.map((l) => l.sku)).size !== arriving.length) throw new DomainError("DUPLICATE_LINE", "Each product can appear once per delivery", 400);

  const products = await c.products.find({ _id: { $in: arriving.map((l) => l.sku) } }, { session: s, projection: { parentSku: 1 } }).toArray();
  const parentOf = new Map(products.map((p) => [p._id, p.parentSku]));
  const movements: NewMovement[] = [];
  const lines = order.lines.map((l) => ({ ...l }));
  for (const a of arriving) {
    const line = lines.find((l) => l.sku === a.sku);
    if (!line) throw new DomainError("NOT_ON_ORDER", `${a.sku} is not on this order`, 400);
    if (a.qty > line.ordered - line.received) {
      throw new DomainError("OVER_RECEIVED", `${a.sku}: only ${line.ordered - line.received} still to arrive`, 400);
    }
    const batchCode = normaliseBatchCode(a.batchCode);
    if (!batchCode || batchCode === UNBATCHED) throw new DomainError("BATCH_CODE_REQUIRED", `Enter the batch code on the label for ${a.sku}`, 400);
    if (!BATCH_CODE.test(batchCode)) throw new DomainError("BATCH_CODE_INVALID", `Batch codes use letters, digits, spaces and . _ / - only (${a.sku})`, 400);
    // A recall covers the code across every SKU (sizes, colours), so any recalled batch with it refuses.
    if (await c.batches.findOne({ batchCode, status: "RECALLED" }, { session: s, projection: { _id: 1 } })) {
      throw new DomainError("BATCH_RECALLED", `Batch ${batchCode} is recalled; it cannot be received`, 409);
    }
    const batchId = `${order.supplierId}:${batchCode}:${a.sku}`;
    await c.batches.updateOne(
      { _id: batchId },
      { $setOnInsert: { supplierId: order.supplierId, batchCode, sku: a.sku, parentSku: parentOf.get(a.sku) ?? a.sku, receivedAt: now, status: "ACTIVE", createdOrigin: ctx.origin } },
      { session: s, upsert: true },
    );
    line.received += a.qty;
    movements.push({ type: "RECEIVED", branchId: order.branchId, sku: a.sku, batchId, qty: a.qty, refType: "delivery", refId: order._id, attributed: false });
  }
  await postMovements(c, s, ctx, movements);
  const done = lines.every((l) => l.received >= l.ordered);
  const update = {
    lines,
    status: done ? ("RECEIVED" as const) : ("PARTIAL" as const),
    ...(done ? { receivedAt: now } : {}),
    ...(input.noteId ? { importedNotes: [...(order.importedNotes ?? []), input.noteId] } : {}),
  };
  await c.purchaseOrders.updateOne({ _id: order._id }, { $set: update }, { session: s });
  return { orderId: order._id, status: update.status, units: arriving.reduce((n, l) => n + l.qty, 0) };
}

export async function cancelPurchaseOrder(c: Cols, s: ClientSession, ctx: CommandCtx, input: { orderId: string }) {
  const now = ctx.now ?? new Date();
  const order = await c.purchaseOrders.findOne({ _id: input.orderId }, { session: s });
  if (!order) throw new NotFound(`Order ${input.orderId} not found`);
  if (order.status !== "SENT") throw new DomainError("ORDER_CLOSED", order.status === "PARTIAL" ? "Part of this order has arrived; it can't be cancelled" : `Order is ${order.status.toLowerCase()}`, 409);
  await c.purchaseOrders.updateOne({ _id: order._id }, { $set: { status: "CANCELLED", cancelledAt: now } }, { session: s });
  return { orderId: order._id, status: "CANCELLED" as const };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface OrderSuggestion {
  sku: string;
  name: string;
  onHand: number;
  reorderPoint: number;
  qty: number; // tops the branch back up to twice its reorder point
}

// This supplier's products below reorder point at the branch.
export async function suggestOrderLines(db: Db, branchId: string, supplierId: string): Promise<OrderSuggestion[]> {
  const c = cols(db);
  const products = await c.products.find({ supplierId }, { projection: { name: 1 } }).sort({ name: 1 }).toArray();
  const skus = products.map((p) => p._id);
  const recalled = await c.batches.distinct("_id", { sku: { $in: skus }, status: "RECALLED" });
  const [policies, stock, onTheWay] = await Promise.all([
    c.stockPolicies.find({ branchId, sku: { $in: skus } }).toArray(),
    c.inventory
      .aggregate<{ _id: string; onHand: number }>([
        { $match: { branchId, sku: { $in: skus }, batchId: { $nin: recalled } } },
        { $group: { _id: "$sku", onHand: { $sum: "$onHand" } } },
      ])
      .toArray(),
    incomingUnits(c, { toBranchId: branchId, sku: { $in: skus } }, recalled),
  ]);
  const rp = new Map(policies.map((p) => [p.sku, p.reorderPoint]));
  const onHand = new Map(stock.map((r) => [r._id, r.onHand]));
  const incoming = new Map(onTheWay.map((r) => [r._id.sku, r.units]));
  return products.flatMap((p) => {
    const point = rp.get(p._id) ?? 0;
    const have = (onHand.get(p._id) ?? 0) + (incoming.get(p._id) ?? 0); // stock on its way from another branch counts
    return point > 0 && have < point ? [{ sku: p._id, name: p.name, onHand: onHand.get(p._id) ?? 0, reorderPoint: point, qty: 2 * point - have }] : [];
  });
}

export interface OrderRow extends PurchaseOrder {
  branchName: string;
  supplierName: string;
  supplierAdapter: string; // delivery-note format (src/domain/suppliers/deliveryNotes.ts)
  names: Record<string, string>;
  batchTracked: string[];
}

export async function listPurchaseOrders(db: Db, limit = 50): Promise<OrderRow[]> {
  const c = cols(db);
  const orders = await c.purchaseOrders.find({}).sort({ sentAt: -1 }).limit(limit).toArray();
  const skus = [...new Set(orders.flatMap((o) => o.lines.map((l) => l.sku)))];
  const [branches, suppliers, products] = await Promise.all([
    c.branches.find({}, { projection: { name: 1 } }).toArray(),
    c.suppliers.find({}, { projection: { name: 1, adapter: 1 } }).toArray(),
    c.products.find({ _id: { $in: skus } }, { projection: { name: 1, batchTracked: 1 } }).toArray(),
  ]);
  const branchName = new Map(branches.map((b) => [b._id, b.name]));
  const supplierName = new Map(suppliers.map((x) => [x._id, x.name]));
  const supplierAdapter = new Map(suppliers.map((x) => [x._id, x.adapter]));
  return orders.map((o) => ({
    ...o,
    branchName: branchName.get(o.branchId) ?? o.branchId,
    supplierName: supplierName.get(o.supplierId) ?? o.supplierId,
    supplierAdapter: supplierAdapter.get(o.supplierId) ?? "",
    names: Object.fromEntries(products.filter((p) => o.lines.some((l) => l.sku === p._id)).map((p) => [p._id, p.name])),
    batchTracked: products.filter((p) => p.batchTracked && o.lines.some((l) => l.sku === p._id)).map((p) => p._id),
  }));
}
