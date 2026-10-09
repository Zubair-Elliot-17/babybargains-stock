import type { ClientSession, Db, MongoClient } from "mongodb";
import { cols, type Cols } from "@/domain/collections";
import { runCommand, type CommandCtx } from "@/domain/ledger/write";
import type { Batch, Product } from "@/domain/schemas";

// Small fixture world: 2 branches, a batch-tracked cot (2 batches) and a toy.
export const COT = "COT-T-OAK";
export const TOY = "TOY-T";
export const OLD = "SUP-OAK:B-1:COT-T-OAK";
export const NEW = "SUP-OAK:B-2:COT-T-OAK";
export const TOYB = "SUP-W:B-9:TOY-T";

let seq = 0;
export const ctx = (extra: Partial<CommandCtx> = {}): CommandCtx => ({
  commandId: `cmd-${process.pid}-${seq++}`,
  actor: "test",
  origin: "visitor",
  ...extra,
});

export async function buildWorld(db: Db) {
  const c = cols(db);
  await c.branches.insertMany([
    { _id: "BR-A", code: "AA", name: "Alpha", region: "X" },
    { _id: "BR-B", code: "BB", name: "Bravo", region: "X" },
  ]);
  const products: Product[] = [
    { _id: COT, parentSku: "COT-T", name: "Test Cot · Oak", supplierId: "SUP-OAK", price: 10000, batchTracked: true, category: "cot", attributes: { widthCm: 64, lengthCm: 126, finish: "Oak", safetyStandard: "BS" } },
    { _id: TOY, parentSku: TOY, name: "Test Toy", supplierId: "SUP-W", price: 500, batchTracked: false, category: "toy", attributes: { ageMonthsMin: 0, material: "Wood" } },
  ];
  await c.products.insertMany(products);
  const batches: Batch[] = [
    { _id: OLD, supplierId: "SUP-OAK", batchCode: "B-1", sku: COT, parentSku: "COT-T", receivedAt: new Date("2026-01-01"), status: "ACTIVE" },
    { _id: NEW, supplierId: "SUP-OAK", batchCode: "B-2", sku: COT, parentSku: "COT-T", receivedAt: new Date("2026-02-01"), status: "ACTIVE" },
    { _id: TOYB, supplierId: "SUP-W", batchCode: "B-9", sku: TOY, parentSku: TOY, receivedAt: new Date("2026-01-15"), status: "ACTIVE" },
  ];
  await c.batches.insertMany(batches);
}

export function runner(client: MongoClient, db: Db) {
  return <T>(fn: (c: Cols, s: ClientSession, k: CommandCtx) => Promise<T>, extra: Partial<CommandCtx> = {}) => {
    const k = ctx(extra);
    return runCommand<T>(client, db, "test", k, (c, s) => fn(c, s, k));
  };
}
