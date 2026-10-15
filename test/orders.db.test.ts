import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cols } from "@/domain/collections";
import { applyPriceList } from "@/domain/ledger/catalogue";
import { cancelPurchaseOrder, createPurchaseOrder, listPurchaseOrders, receivePurchaseOrder, suggestOrderLines } from "@/domain/ledger/orders";
import { checkLedgerInvariants } from "@/domain/ledger/read";
import { receiveStock } from "@/domain/ledger/write";
import { migrate, resetDemo } from "@/seed/apply";
import { freshDb } from "./helpers";
import { COT, OLD, TOY, TOYB, buildWorld, runner } from "./world";

let t: Awaited<ReturnType<typeof freshDb>>;
let run: ReturnType<typeof runner>;

beforeAll(async () => (t = await freshDb()));
afterAll(() => t.close());
beforeEach(async () => {
  await t.db.dropDatabase();
  await migrate(t.db);
  await buildWorld(t.db);
  await cols(t.db).suppliers.insertMany([
    { _id: "SUP-OAK", name: "Little Oak Ltd", adapter: "x" },
    { _id: "SUP-W", name: "Woodland Toys", adapter: "x" },
  ]);
  run = runner(t.client, t.db);
});

const create = (lines: { sku: string; qty: number }[], supplierId = "SUP-OAK") =>
  run((c, s, k) => createPurchaseOrder(c, s, k, { branchId: "BR-A", supplierId, lines }));
const receive = (orderId: string, lines: { sku: string; qty: number; batchCode: string }[]) =>
  run((c, s, k) => receivePurchaseOrder(c, s, k, { orderId, lines }));
const onHand = async (batchId: string) => (await cols(t.db).inventory.findOne({ branchId: "BR-A", batchId }))?.onHand ?? 0;

describe("purchase orders", () => {
  it("creates a sent order and refuses products from another supplier or repeated lines", async () => {
    const po = (await create([{ sku: COT, qty: 5 }])).result;
    expect(po).toMatchObject({ status: "SENT", branchId: "BR-A", lines: [{ sku: COT, ordered: 5, received: 0 }] });
    await expect(create([{ sku: TOY, qty: 1 }])).rejects.toMatchObject({ code: "WRONG_SUPPLIER" });
    await expect(create([{ sku: COT, qty: 1 }, { sku: COT, qty: 2 }])).rejects.toMatchObject({ code: "DUPLICATE_LINE" });
  });

  it("receives in two deliveries into named batches, then closes", async () => {
    const po = (await create([{ sku: COT, qty: 5 }])).result;
    const first = await receive(po._id, [{ sku: COT, qty: 2, batchCode: " b-77 " }]);
    expect(first.result).toMatchObject({ status: "PARTIAL", units: 2 });
    const batch = await cols(t.db).batches.findOne({ _id: `SUP-OAK:B-77:${COT}` });
    expect(batch).toMatchObject({ batchCode: "B-77", status: "ACTIVE", createdOrigin: "visitor", parentSku: "COT-T" });
    expect(await onHand(`SUP-OAK:B-77:${COT}`)).toBe(2);
    await receive(po._id, [{ sku: COT, qty: 3, batchCode: "B-1" }]); // existing batch
    expect(await onHand(OLD)).toBe(3);
    const done = await cols(t.db).purchaseOrders.findOne({ _id: po._id });
    expect(done).toMatchObject({ status: "RECEIVED", lines: [{ received: 5 }] });
    expect(done?.receivedAt).toBeInstanceOf(Date);
    await expect(receive(po._id, [{ sku: COT, qty: 1, batchCode: "B-1" }])).rejects.toMatchObject({ code: "ORDER_CLOSED" });
    const moves = await cols(t.db).movements.find({ refType: "delivery", refId: po._id }).toArray();
    expect(moves.map((m) => m.qty)).toEqual([2, 3]);
    expect((await checkLedgerInvariants(t.db)).ok).toBe(true);
  });

  it("refuses over-receiving, unknown lines, missing or reserved batch codes, and recalled batches", async () => {
    const po = (await create([{ sku: COT, qty: 2 }])).result;
    await expect(receive(po._id, [{ sku: COT, qty: 3, batchCode: "B-1" }])).rejects.toMatchObject({ code: "OVER_RECEIVED" });
    await expect(receive(po._id, [{ sku: TOY, qty: 1, batchCode: "B-1" }])).rejects.toMatchObject({ code: "NOT_ON_ORDER" });
    await expect(receive(po._id, [{ sku: COT, qty: 1, batchCode: "  " }])).rejects.toMatchObject({ code: "BATCH_CODE_REQUIRED" });
    await expect(receive(po._id, [{ sku: COT, qty: 1, batchCode: "unbatched" }])).rejects.toMatchObject({ code: "BATCH_CODE_REQUIRED" });
    await expect(receive(po._id, [{ sku: COT, qty: 0, batchCode: "B-1" }])).rejects.toMatchObject({ code: "NOTHING_RECEIVED" });
    await cols(t.db).batches.updateOne({ _id: OLD }, { $set: { status: "RECALLED" } });
    await expect(receive(po._id, [{ sku: COT, qty: 1, batchCode: "B-1" }])).rejects.toMatchObject({ code: "BATCH_RECALLED" });
    expect((await cols(t.db).purchaseOrders.findOne({ _id: po._id }))?.status).toBe("SENT");
  });

  it("refuses lookalike codes with invisible characters, and a code recalled on a sibling SKU", async () => {
    const po = (await create([{ sku: COT, qty: 2 }])).result;
    await expect(receive(po._id, [{ sku: COT, qty: 1, batchCode: "B-1\u200b" }])).rejects.toMatchObject({ code: "BATCH_CODE_INVALID" });
    await expect(receive(po._id, [{ sku: COT, qty: 1, batchCode: "B-1\u001d" }])).rejects.toMatchObject({ code: "BATCH_CODE_INVALID" });
    // The same lot code recalled on another SKU (another size or colour) still refuses.
    await cols(t.db).batches.insertOne({ _id: "SUP-OAK:B-50:OTHER", supplierId: "SUP-OAK", batchCode: "B-50", sku: "OTHER", parentSku: "COT-T", receivedAt: new Date(), status: "RECALLED" });
    await expect(receive(po._id, [{ sku: COT, qty: 1, batchCode: "b-50" }])).rejects.toMatchObject({ code: "BATCH_RECALLED" });
  });

  it("two deliveries racing for the last units: one lands, the other is refused", async () => {
    const po = (await create([{ sku: COT, qty: 2 }])).result;
    const results = await Promise.allSettled([
      receive(po._id, [{ sku: COT, qty: 2, batchCode: "B-NEW" }]),
      receive(po._id, [{ sku: COT, qty: 2, batchCode: "B-NEW" }]),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "ORDER_CLOSED" });
    expect(await onHand(`SUP-OAK:B-NEW:${COT}`)).toBe(2);
  });

  it("records a delivery note's ref and refuses the same note twice, even for units still to arrive", async () => {
    const po = (await create([{ sku: COT, qty: 5 }])).result;
    const viaNote = (noteId: string, qty: number) =>
      run((c, s, k) => receivePurchaseOrder(c, s, k, { orderId: po._id, lines: [{ sku: COT, qty, batchCode: "LO-1" }], noteId }));
    await viaNote("LO-1", 2);
    await expect(viaNote("LO-1", 2)).rejects.toMatchObject({ code: "NOTE_ALREADY_RECEIVED", status: 409 });
    expect(await onHand(`SUP-OAK:LO-1:${COT}`)).toBe(2);
    await viaNote("LO-2", 3);
    expect(await cols(t.db).purchaseOrders.findOne({ _id: po._id })).toMatchObject({ status: "RECEIVED", importedNotes: ["LO-1", "LO-2"] });
    expect((await checkLedgerInvariants(t.db)).ok).toBe(true);
  });

  it("two receives of the same note at once: one lands, the other is refused", async () => {
    const po = (await create([{ sku: COT, qty: 5 }])).result;
    const viaNote = () => run((c, s, k) => receivePurchaseOrder(c, s, k, { orderId: po._id, lines: [{ sku: COT, qty: 1, batchCode: "LO-1" }], noteId: "LO-1" }));
    const results = await Promise.allSettled([viaNote(), viaNote()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "NOTE_ALREADY_RECEIVED" } });
    expect(await onHand(`SUP-OAK:LO-1:${COT}`)).toBe(1);
  });

  it("refuses a note-based receive past the note cap with a clear message", async () => {
    const po = (await create([{ sku: COT, qty: 5 }])).result;
    await cols(t.db).purchaseOrders.updateOne({ _id: po._id }, { $set: { importedNotes: Array.from({ length: 200 }, (_, i) => `N-${i}`) } });
    await expect(run((c, s, k) => receivePurchaseOrder(c, s, k, { orderId: po._id, lines: [{ sku: COT, qty: 1, batchCode: "B-1" }], noteId: "N-X" }))).rejects.toMatchObject({ code: "TOO_MANY_NOTES", status: 409 });
    await run((c, s, k) => receivePurchaseOrder(c, s, k, { orderId: po._id, lines: [{ sku: COT, qty: 1, batchCode: "B-1" }] })); // by hand still works
  });

  it("cancels only while nothing has arrived", async () => {
    const a = (await create([{ sku: COT, qty: 2 }])).result;
    expect((await run((c, s, k) => cancelPurchaseOrder(c, s, k, { orderId: a._id }))).result.status).toBe("CANCELLED");
    const b = (await create([{ sku: COT, qty: 2 }])).result;
    await receive(b._id, [{ sku: COT, qty: 1, batchCode: "B-1" }]);
    await expect(run((c, s, k) => cancelPurchaseOrder(c, s, k, { orderId: b._id }))).rejects.toMatchObject({ code: "ORDER_CLOSED" });
  });

  it("suggests the supplier's products below reorder point, topped up to twice it", async () => {
    await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-A", sku: TOY, batchId: TOYB, qty: 1 }));
    await cols(t.db).stockPolicies.insertMany([
      { _id: `BR-A:${TOY}`, branchId: "BR-A", sku: TOY, reorderPoint: 4, overstockWeeks: 8 },
      { _id: `BR-A:${COT}`, branchId: "BR-A", sku: COT, reorderPoint: 2, overstockWeeks: 8 },
    ]);
    expect(await suggestOrderLines(t.db, "BR-A", "SUP-W")).toEqual([{ sku: TOY, name: "Test Toy", onHand: 1, reorderPoint: 4, qty: 7 }]);
    expect(await suggestOrderLines(t.db, "BR-A", "SUP-OAK")).toEqual([{ sku: COT, name: "Test Cot · Oak", onHand: 0, reorderPoint: 2, qty: 4 }]);
  });

  it("applies a price list once, to that supplier's products only, and the nightly reset undoes it", async () => {
    const apply = (ref: string, items: { sku: string; name: string; price: number }[], supplierId = "SUP-OAK") =>
      run((c, s, k) => applyPriceList(c, s, k, { supplierId, list: { ref, items } }));
    const { result } = await apply("PL-1", [{ sku: COT, name: "Test Cot · Oak", price: 10999 }, { sku: TOY, name: "Renamed toy", price: 1 }]);
    expect(result).toEqual({ ref: "PL-1", changed: 1, added: 0, unchanged: 0, unknown: 1 }); // TOY is another supplier's
    await expect(apply("PL-1", [{ sku: COT, name: "x", price: 1 }])).rejects.toMatchObject({ code: "PRICE_LIST_ALREADY_APPLIED", status: 409 });
    await apply("PL-2", [{ sku: COT, name: "Test Cot · Oak (2027)", price: 11999 }]);
    const p = cols(t.db).products;
    expect(await p.findOne({ _id: COT })).toMatchObject({ name: "Test Cot · Oak (2027)", price: 11999, seedName: "Test Cot · Oak", seedPrice: 10000 });
    await expect(apply("PL-3", [{ sku: COT, name: "Test Cot · Oak", price: 24000 }])).rejects.toMatchObject({ code: "PRICE_OUT_OF_RANGE" }); // > double
    expect(await p.findOne({ _id: TOY })).toMatchObject({ name: "Test Toy", price: 500 });
    await cols(t.db).ops.insertOne({ _id: "status", anchorAt: new Date(), seededAt: new Date() } as never);
    await resetDemo(t.db);
    expect(await p.findOne({ _id: COT })).toEqual(expect.objectContaining({ name: "Test Cot · Oak", price: 10000 })); // both lists unwound
    expect(await p.findOne({ _id: COT })).not.toHaveProperty("seedName");
    expect(await cols(t.db).catalogueImports.countDocuments()).toBe(0);
    // A list applied after (or during) a reset keeps the seed values again, so the next reset undoes it.
    await apply("PL-4", [{ sku: COT, name: "Late list", price: 10500 }]);
    await resetDemo(t.db);
    expect(await p.findOne({ _id: COT })).toMatchObject({ name: "Test Cot · Oak", price: 10000 });
  });

  it("adds listed products we don't stock, once, and the nightly reset removes them", async () => {
    const toy = { sku: "NEW-1", batchTracked: false, category: "toy" as const, attributes: { ageMonthsMin: 6, material: "Wood" } };
    const apply = (ref: string, items: { sku: string; name: string; price: number }[], add: (typeof toy)[]) =>
      run((c, s, k) => applyPriceList(c, s, k, { supplierId: "SUP-OAK", list: { ref, items }, add }));
    const items = [{ sku: COT, name: "Test Cot · Oak", price: 10000 }, { sku: "NEW-1", name: "Oak rattle", price: 1299 }, { sku: "NEW-2", name: "Oak blocks", price: 1999 }];
    const { result } = await apply("PL-N", items, [toy]);
    expect(result).toEqual({ ref: "PL-N", changed: 0, added: 1, unchanged: 1, unknown: 1 });
    const p = cols(t.db).products;
    expect(await p.findOne({ _id: "NEW-1" })).toMatchObject({ name: "Oak rattle", price: 1299, supplierId: "SUP-OAK", parentSku: "NEW-1", category: "toy", createdOrigin: "visitor" });
    expect(await cols(t.db).catalogueImports.findOne({ ref: "PL-N" })).toMatchObject({ added: ["NEW-1"] });
    // Not on the list, already stocked (here or by another supplier), or twice: refused.
    await expect(apply("PL-X1", items, [{ ...toy, sku: "NEW-9" }])).rejects.toMatchObject({ code: "NOT_A_NEW_PRODUCT" });
    await expect(apply("PL-X2", items, [{ ...toy, sku: COT }])).rejects.toMatchObject({ code: "NOT_A_NEW_PRODUCT" });
    await expect(apply("PL-X3", items, [{ ...toy, sku: "NEW-2" }, { ...toy, sku: "NEW-2" }])).rejects.toMatchObject({ code: "NOT_A_NEW_PRODUCT" });
    await expect(apply("PL-X4", [{ sku: TOY, name: "Test Toy", price: 500 }], [{ ...toy, sku: TOY }])).rejects.toMatchObject({ code: "SKU_TAKEN", status: 409 });
    await expect(apply("PL-X5", items, Array.from({ length: 21 }, (_, i) => ({ ...toy, sku: `N${i}` })))).rejects.toMatchObject({ code: "TOO_MANY_NEW_PRODUCTS" });
    // The new product can be ordered and received like any other.
    const order = await create([{ sku: "NEW-1", qty: 3 }]);
    await receive(order.result._id, [{ sku: "NEW-1", qty: 3, batchCode: "B1" }]);
    await cols(t.db).ops.insertOne({ _id: "status", anchorAt: new Date(), seededAt: new Date() } as never);
    await resetDemo(t.db);
    expect(await p.findOne({ _id: "NEW-1" })).toBeNull();
    expect(await cols(t.db).inventory.countDocuments({ sku: "NEW-1" })).toBe(0);
    expect((await checkLedgerInvariants(t.db)).ok).toBe(true);
  });

  it("two price lists on the same product at once: the second sees the first's result", async () => {
    const apply = (ref: string, price: number) => run((c, s, k) => applyPriceList(c, s, k, { supplierId: "SUP-OAK", list: { ref, items: [{ sku: COT, name: "Test Cot · Oak", price }] } }));
    await Promise.all([apply("PL-A", 11000), apply("PL-B", 12000)]);
    const imports = await cols(t.db).catalogueImports.find().sort({ appliedAt: 1 }).toArray();
    expect(imports.map((i) => i.changes[0].before.price)).toEqual([10000, imports[0].changes[0].after.price]);
    expect(await cols(t.db).products.findOne({ _id: COT })).toMatchObject({ seedPrice: 10000 });
  });

  it("lists orders with names, and the nightly reset removes visitor orders", async () => {
    await create([{ sku: COT, qty: 2 }]);
    const [row] = await listPurchaseOrders(t.db);
    expect(row).toMatchObject({ branchName: "Alpha", supplierName: "Little Oak Ltd", names: { [COT]: "Test Cot · Oak" }, batchTracked: [COT] });
    await cols(t.db).ops.insertOne({ _id: "status", anchorAt: new Date(), seededAt: new Date() } as never);
    await resetDemo(t.db);
    expect(await cols(t.db).purchaseOrders.countDocuments()).toBe(0);
  });
});
