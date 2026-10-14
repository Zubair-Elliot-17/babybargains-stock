import { z } from "zod";

// Zod is the single source of truth; MongoDB validators are generated from these (see mongoSchema.ts).

export const Id = z.string().min(1).max(120);
export const Pence = z.number().int().min(0);

export const MovementType = z.enum([
  "RECEIVED",
  "SOLD",
  "TRANSFER_OUT",
  "TRANSFER_IN",
  "ADJUSTMENT",
  "RECALLED",
]);
export type MovementType = z.infer<typeof MovementType>;

export const Origin = z.enum(["seed", "visitor"]);
export type Origin = z.infer<typeof Origin>;

export const Branch = z.object({
  _id: Id,
  code: z.string().min(2).max(8),
  name: z.string().min(1).max(80),
  region: z.string().min(1).max(40),
});
export type Branch = z.infer<typeof Branch>;

export const Supplier = z.object({
  _id: Id,
  name: z.string().min(1).max(80),
  adapter: z.string().min(1).max(40),
});
export type Supplier = z.infer<typeof Supplier>;

const ProductCore = {
  _id: Id, // sku
  parentSku: Id,
  name: z.string().min(1).max(120),
  supplierId: Id,
  price: Pence,
  batchTracked: z.boolean(),
};

export const Product = z.discriminatedUnion("category", [
  z.object({
    ...ProductCore,
    category: z.literal("cot"),
    attributes: z.object({
      widthCm: z.number().positive(),
      lengthCm: z.number().positive(),
      finish: z.string().max(30),
      safetyStandard: z.string().max(40),
    }),
  }),
  z.object({
    ...ProductCore,
    category: z.literal("pram"),
    attributes: z.object({
      weightKg: z.number().positive(),
      foldable: z.boolean(),
      safetyStandard: z.string().max(40),
    }),
  }),
  z.object({
    ...ProductCore,
    category: z.literal("monitor"),
    attributes: z.object({
      rangeM: z.number().int().positive(),
      video: z.boolean(),
      warrantyMonths: z.number().int().positive(),
    }),
  }),
  z.object({
    ...ProductCore,
    category: z.literal("clothing"),
    attributes: z.object({
      size: z.string().max(20),
      colour: z.string().max(30),
      material: z.string().max(40),
    }),
  }),
  z.object({
    ...ProductCore,
    category: z.literal("toy"),
    attributes: z.object({
      ageMonthsMin: z.number().int().min(0),
      material: z.string().max(40),
    }),
  }),
]);
export type Product = z.infer<typeof Product>;

export const BatchStatus = z.enum(["ACTIVE", "RECALLED"]);

export const Batch = z.object({
  _id: Id, // `${supplierId}:${batchCode}:${sku}`
  supplierId: Id,
  batchCode: z.string().min(1).max(40),
  sku: Id,
  parentSku: Id,
  receivedAt: z.date(),
  status: BatchStatus,
  recalledAt: z.date().optional(),
  recallOrigin: Origin.optional(),
  createdOrigin: Origin.optional(), // UNBATCHED batches created by a visitor's approval are removed on reset
});
export type Batch = z.infer<typeof Batch>;

export const Movement = z.object({
  type: MovementType,
  at: z.date(),
  effectiveAt: z.date().optional(), // stocktake adjustments: when the item was counted
  branchId: Id,
  sku: Id,
  batchId: Id,
  qty: z.number().int().refine((n) => n !== 0, "qty must be non-zero"),
  refType: z.enum(["seed", "sale", "transfer", "quarantine", "delivery", "stocktake"]),
  refId: Id,
  attributed: z.boolean(),
  actor: z.string().min(1).max(60),
  origin: Origin,
});
export type Movement = z.infer<typeof Movement>;

export const InventoryRow = z.object({
  branchId: Id,
  sku: Id,
  batchId: Id,
  onHand: z.number().int().min(0),
  updatedAt: z.date(),
});
export type InventoryRow = z.infer<typeof InventoryRow>;

export const SaleLine = z.object({
  sku: Id,
  qty: z.number().int().positive(),
  unitPrice: Pence,
  allocations: z.array(z.object({ batchId: Id, qty: z.number().int().positive() })),
  origin: Origin.optional(), // visitor lines are removed by the nightly reset
});

export const SalesDay = z.object({
  _id: Id, // `${branchId}:${yyyy-mm-dd}`
  branchId: Id,
  day: z.date(),
  lines: z.array(SaleLine),
});
export type SalesDay = z.infer<typeof SalesDay>;

export const StockPolicy = z.object({
  _id: Id, // `${branchId}:${sku}`
  branchId: Id,
  sku: Id,
  reorderPoint: z.number().int().min(0),
  overstockWeeks: z.number().int().positive(),
});
export type StockPolicy = z.infer<typeof StockPolicy>;

export const StocktakeStatus = z.enum(["OPEN", "SUBMITTED", "APPROVED"]);
export type StocktakeStatus = z.infer<typeof StocktakeStatus>;

export const Stocktake = z.object({
  _id: Id,
  branchId: Id,
  status: StocktakeStatus,
  openedAt: z.date(),
  openedBy: Id, // session id of the counting clerk
  clerkLabel: z.string().max(40),
  lastActivityAt: z.date(),
  submittedAt: z.date().optional(),
  uncounted: z.enum(["zero", "leave"]).optional(),
  approvedAt: z.date().optional(),
  approvedOrigin: Origin.optional(),
  resumeNonce: z.string().max(64).optional(), // the current resume key is HMAC(id:nonce); rotated on every open
  origin: Origin,
});
export type Stocktake = z.infer<typeof Stocktake>;

// Append-only count entries; "replace" resets the running count for a SKU/batch, "add" sums.
export const StocktakeLine = z.object({
  _id: Id, // client-generated lineId (idempotent retries)
  stocktakeId: Id,
  sku: Id,
  batchId: Id.optional(),
  counted: z.number().int().min(0).max(9999),
  mode: z.enum(["add", "replace"]),
  countedAt: z.date(),
  receivedAt: z.date().optional(), // server arrival; differs from countedAt for counts queued offline
  clerkId: Id,
  origin: Origin,
});
export type StocktakeLine = z.infer<typeof StocktakeLine>;

// Purchase orders: created as SENT (no draft step); receiving posts RECEIVED movements with refId = order id.
export const PurchaseOrderStatus = z.enum(["SENT", "PARTIAL", "RECEIVED", "CANCELLED"]);
export type PurchaseOrderStatus = z.infer<typeof PurchaseOrderStatus>;

export const PurchaseOrder = z.object({
  _id: Id,
  supplierId: Id,
  branchId: Id,
  status: PurchaseOrderStatus,
  lines: z.array(z.object({ sku: Id, ordered: z.number().int().positive().max(9999), received: z.number().int().min(0) })).min(1).max(200),
  sentAt: z.date(),
  receivedAt: z.date().optional(), // when the last outstanding unit arrived
  cancelledAt: z.date().optional(),
  importedNotes: z.array(z.string().min(1).max(60)).max(200).optional(), // supplier delivery-note refs already received
  origin: Origin,
});
export type PurchaseOrder = z.infer<typeof PurchaseOrder>;

// Validated collections; the migrate script applies these as $jsonSchema validators.
export const validatedCollections = {
  branches: Branch,
  suppliers: Supplier,
  products: Product,
  batches: Batch,
  stockMovements: Movement,
  salesDays: SalesDay,
  stockPolicies: StockPolicy,
  stocktakes: Stocktake,
  stocktakeLines: StocktakeLine,
  purchaseOrders: PurchaseOrder,
} as const;
