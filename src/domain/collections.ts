import type { Db, Collection, ObjectId } from "mongodb";
import type {
  Batch,
  Branch,
  InventoryRow,
  Movement,
  Product,
  SalesDay,
  StockPolicy,
  Stocktake,
  StocktakeLine,
  Supplier,
} from "./schemas";

export interface CommandLogEntry {
  _id: string; // client-generated commandId
  type: string;
  result: unknown;
  at: Date;
  origin: "seed" | "visitor";
}

export interface RateLimitEntry {
  _id: string; // `${sessionId}:${actionClass}:${hourBucket}`
  count: number;
  expiresAt: Date;
}

export interface OpsDoc {
  _id: "status";
  seededAt: Date;
  anchorAt: Date; // dates in the dataset are relative to this instant
  lastResetAt?: Date;
  lastResetOk?: boolean;
  invariantsOk?: boolean;
  counts?: Record<string, number>;
}

export function cols(db: Db) {
  return {
    branches: db.collection<Branch>("branches"),
    suppliers: db.collection<Supplier>("suppliers"),
    products: db.collection<Product>("products"),
    batches: db.collection<Batch>("batches"),
    movements: db.collection<Movement & { _id?: ObjectId }>("stockMovements"),
    inventory: db.collection<InventoryRow>("inventory"),
    salesDays: db.collection<SalesDay>("salesDays"),
    stockPolicies: db.collection<StockPolicy>("stockPolicies"),
    stocktakes: db.collection<Stocktake>("stocktakes"),
    stocktakeLines: db.collection<StocktakeLine>("stocktakeLines"),
    commandLog: db.collection<CommandLogEntry>("commandLog"),
    rateLimits: db.collection<RateLimitEntry>("rateLimits"),
    ops: db.collection<OpsDoc>("ops"),
  };
}
export type Cols = ReturnType<typeof cols>;

export async function ensureIndexes(db: Db): Promise<void> {
  const c = cols(db);
  await Promise.all([
    c.branches.createIndex({ code: 1 }, { unique: true }),
    c.products.createIndex({ parentSku: 1 }),
    c.products.createIndex({ category: 1 }),
    c.batches.createIndex({ supplierId: 1, batchCode: 1, sku: 1 }, { unique: true }),
    c.batches.createIndex({ batchCode: 1, parentSku: 1 }),
    c.batches.createIndex({ sku: 1, status: 1, receivedAt: 1 }),
    c.movements.createIndex({ sku: 1, batchId: 1, at: 1 }),
    c.movements.createIndex({ branchId: 1, sku: 1, at: 1 }),
    c.movements.createIndex({ type: 1, at: 1 }),
    c.movements.createIndex({ refType: 1, refId: 1 }),
    c.movements.createIndex({ origin: 1 }),
    c.inventory.createIndex({ branchId: 1, sku: 1, batchId: 1 }, { unique: true }),
    c.inventory.createIndex({ batchId: 1 }),
    c.inventory.createIndex({ sku: 1, branchId: 1 }), // transfer accept and suggestion preview read one SKU across branches
    c.stockPolicies.createIndex({ sku: 1 }),
    c.salesDays.createIndex({ branchId: 1, day: 1 }, { unique: true }),
    c.rateLimits.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.commandLog.createIndex({ origin: 1 }),
    // One OPEN stocktake per branch (team stocktakes are deferred, see TODOS.md).
    c.stocktakes.createIndex({ branchId: 1 }, { unique: true, partialFilterExpression: { status: "OPEN" }, name: "one_open_per_branch" }),
    c.stocktakes.createIndex({ branchId: 1, status: 1 }),
    c.stocktakes.createIndex({ status: 1, submittedAt: -1 }),
    c.stocktakeLines.createIndex({ stocktakeId: 1, sku: 1, batchId: 1, countedAt: 1 }),
    c.stocktakeLines.createIndex({ batchId: 1 }),
  ]);
}

export type AnyCollection = Collection<Record<string, unknown>>;
