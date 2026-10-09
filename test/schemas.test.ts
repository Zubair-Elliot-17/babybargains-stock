import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoServerError } from "mongodb";
import { generatedValidators } from "@/seed/apply";
import { freshDb } from "./helpers";

let ctx: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => (ctx = await freshDb()));
afterAll(() => ctx.close());

const cot = {
  _id: "COT-X-OAK", parentSku: "COT-X", name: "Cot X · Oak", supplierId: "SUP-OAK", price: 14999, batchTracked: true,
  category: "cot", attributes: { widthCm: 64, lengthCm: 126, finish: "Oak", safetyStandard: "BS EN 716-1:2017" },
};

async function rejects(p: Promise<unknown>) {
  const err = await p.catch((e) => e);
  expect(err).toBeInstanceOf(MongoServerError);
  expect((err as MongoServerError).code).toBe(121); // DocumentValidationFailure
}

describe("generated MongoDB validators", () => {
  it("applied validators equal the ones generated from Zod (no drift)", async () => {
    const want = generatedValidators();
    const infos = await ctx.db.listCollections({ name: { $in: Object.keys(want) } }).toArray();
    expect(infos).toHaveLength(Object.keys(want).length);
    for (const info of infos) {
      expect((info as unknown as { options: { validator: unknown } }).options.validator).toEqual(want[info.name]);
    }
  });

  it("accepts a valid polymorphic product", async () => {
    await expect(ctx.db.collection("products").insertOne(cot as never)).resolves.toBeTruthy();
  });

  it("rejects a cot carrying clothing attributes", async () => {
    await rejects(
      ctx.db.collection("products").insertOne({ ...cot, _id: "COT-Y", attributes: { size: "0-3m", colour: "Oat", material: "Cotton" } } as never),
    );
  });

  it("rejects unknown categories and negative prices", async () => {
    await rejects(ctx.db.collection("products").insertOne({ ...cot, _id: "C2", category: "sofa" } as never));
    await rejects(ctx.db.collection("products").insertOne({ ...cot, _id: "C3", price: -1 } as never));
  });

  it("rejects a movement with a string date or unknown type", async () => {
    const m = { type: "SOLD", at: new Date(), branchId: "B", sku: "S", batchId: "X", qty: -1, refType: "sale", refId: "r", attributed: true, actor: "a", origin: "visitor" };
    await expect(ctx.db.collection("stockMovements").insertOne({ ...m })).resolves.toBeTruthy();
    await rejects(ctx.db.collection("stockMovements").insertOne({ ...m, at: "2026-01-01" }));
    await rejects(ctx.db.collection("stockMovements").insertOne({ ...m, type: "STOLEN" }));
  });
});
