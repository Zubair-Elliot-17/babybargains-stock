import type { ClientSession } from "mongodb";
import type { Cols } from "../collections";
import { DomainError, NotFound } from "../errors";
import { diffPriceList, MAX_NEW_PRODUCTS, PRICE_RANGE_TEXT, type NewProduct, type PriceList } from "../suppliers/catalogue";
import type { CommandCtx } from "./write";

// Applies a supplier price list to that supplier's products (names and prices), once per list ref, and adds
// the listed products the manager set up (`add`). Recomputes the diff inside the transaction, so a stale
// preview can't write old "before" values.
export async function applyPriceList(c: Cols, s: ClientSession, ctx: CommandCtx, input: { supplierId: string; list: PriceList; add?: NewProduct[] }) {
  const add = input.add ?? [];
  const now = ctx.now ?? new Date();
  const supplier = await c.suppliers.findOne({ _id: input.supplierId }, { session: s });
  if (!supplier) throw new NotFound(`Supplier ${input.supplierId} not found`);
  const _id = `${supplier._id}:${input.list.ref}`;
  if (await c.catalogueImports.findOne({ _id }, { session: s, projection: { _id: 1 } })) {
    throw new DomainError("PRICE_LIST_ALREADY_APPLIED", `Price list ${input.list.ref} is already applied`, 409);
  }
  const products = await c.products
    .find({ supplierId: supplier._id, _id: { $in: input.list.items.map((i) => i.sku) } }, { session: s, projection: { name: 1, price: 1 } })
    .toArray();
  const { changes, unchanged, unknown, outOfRange } = diffPriceList(input.list, products.map((p) => ({ sku: p._id, name: p.name, price: p.price })));
  if (outOfRange.length) throw new DomainError("PRICE_OUT_OF_RANGE", `Demo limit: prices can move ${PRICE_RANGE_TEXT} (${outOfRange.slice(0, 3).join(", ")})`, 400);
  if (add.length > MAX_NEW_PRODUCTS) throw new DomainError("TOO_MANY_NEW_PRODUCTS", `Demo limit: ${MAX_NEW_PRODUCTS} new products per price list`, 400);
  const listed = new Map(input.list.items.map((i) => [i.sku, i]));
  const notNew = add.filter((a) => !unknown.includes(a.sku) || add.filter((b) => b.sku === a.sku).length > 1);
  if (notNew.length) throw new DomainError("NOT_A_NEW_PRODUCT", `Only products on the list that we don't stock can be added, once each (${notNew[0].sku})`, 400);
  if (add.length) {
    const taken = await c.products.findOne({ _id: { $in: add.map((a) => a.sku) } }, { session: s, projection: { _id: 1 } });
    if (taken) throw new DomainError("SKU_TAKEN", `${taken._id} is already another supplier's product`, 409);
    await c.products.insertMany(
      add.map(({ sku, ...p }) => ({ ...p, _id: sku, parentSku: sku, name: listed.get(sku)!.name, price: listed.get(sku)!.price, supplierId: supplier._id, createdOrigin: ctx.origin })),
      { session: s },
    );
  }
  if (changes.length) {
    // The first change keeps the seeded name and price on the product; the nightly reset restores them
    // from there, so it doesn't depend on unwinding imports in order (or racing one applied mid-reset).
    await c.products.bulkWrite(
      changes.map((ch) => ({
        updateOne: {
          filter: { _id: ch.sku },
          update: [{ $set: { seedName: { $ifNull: ["$seedName", "$name"] }, seedPrice: { $ifNull: ["$seedPrice", "$price"] }, name: ch.after.name, price: ch.after.price } }],
        },
      })),
      { session: s },
    );
  }
  await c.catalogueImports.insertOne({ _id, supplierId: supplier._id, ref: input.list.ref, appliedAt: now, changes, ...(add.length ? { added: add.map((a) => a.sku) } : {}), origin: ctx.origin }, { session: s });
  return { ref: input.list.ref, changed: changes.length, added: add.length, unchanged, unknown: unknown.length - add.length };
}
