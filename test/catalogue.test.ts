import { describe, expect, it } from "vitest";
import { SUPPLIERS } from "@/seed/catalogue";
import { CATALOGUE_ADAPTERS, diffPriceList, readPriceList, samplePriceList } from "@/domain/suppliers/catalogue";

const products = [
  { sku: "COT-A", name: "Cot A", price: 12999 },
  { sku: "COT-B", name: "Cot B", price: 4550 },
  { sku: "COT-C", name: "Cot C", price: 999 },
  { sku: "COT-D", name: "Cot D", price: 100 },
];
const read = (adapter: string, json: unknown) => readPriceList(adapter, JSON.stringify(json));

describe("price-list adapters", () => {
  it("cover every seeded supplier", () => {
    for (const s of SUPPLIERS) expect(CATALOGUE_ADAPTERS[s.adapter], s.adapter).toBeDefined();
  });

  it.each(Object.keys(CATALOGUE_ADAPTERS))("%s reads back its own list, prices exact to the penny", (id) => {
    const r = read(id, CATALOGUE_ADAPTERS[id].example(products, "X1"));
    expect("list" in r && r.list.items).toEqual(products);
    expect("list" in r && r.list.ref).toMatch(/X1$/);
  });

  it.each(Object.keys(CATALOGUE_ADAPTERS))("%s's sample raises three prices and lists one product we don't stock", (id) => {
    const r = read(id, samplePriceList(id, products, "S1"));
    if (!("list" in r)) throw new Error(r.error);
    const diff = diffPriceList(r.list, products);
    expect(diff.changes.map((c) => [c.sku, c.after.price])).toEqual([["COT-A", 13699], ["COT-B", 4799], ["COT-C", 1099]]);
    expect(diff).toMatchObject({ unchanged: 1, unknown: ["NEW-S1"] });
  });

  it("refuses prices that aren't exact money, and other currencies", () => {
    const oak = (rrp: unknown) => read("little-oak-v1", { priceList: "PL-1", products: [{ code: "COT-A", title: "Cot A", rrp }] });
    expect(oak(129.999)).toHaveProperty("error");
    expect(oak("129.99")).toHaveProperty("error");
    expect(oak(0)).toHaveProperty("error");
    expect(oak(12.5)).toMatchObject({ list: { items: [{ price: 1250 }] } });
    const safe = (price_gbp: string) => read("safesound-v1", { list_no: "PL-1", items: [{ product_sku: "COT-A", description: "Cot A", price_gbp }] });
    expect(safe("59.99")).toMatchObject({ list: { items: [{ price: 5999 }] } });
    for (const bad of ["59.999", "£59.99", "1e3", "", "0.00"]) expect(safe(bad), bad).toHaveProperty("error");
    expect(read("wonder-v1", { id: "PL-1", toys: [{ item: { sku: "T", name: "T" }, price: { amount: 100, currency: "USD" } }] })).toHaveProperty("error");
  });

  it("explains bad files", () => {
    const csv = (rows: string[][]) => read("snuggle-csvjson", { ref: "SN-1", rows: [["sku", "name", "price"], ...rows] });
    expect(csv([["CLO-A", "Romper", "x"]])).toEqual({ error: "Couldn't read this price list: Row 2, price: a price like 129.99." });
    expect(csv([["CLO-A", "Romper", "9.99"], ["", "", ""]])).toMatchObject({ list: { items: [{ sku: "CLO-A", price: 999 }] } });
    expect(csv([["", "", ""]])).toEqual({ error: "Couldn't read this price list: No products listed." });
    expect(read("roam-v2", { catalogue: { id: "R-1", models: [{ sku: "P", name: "P", pricePence: 1 }, { sku: "P", name: "P2", pricePence: 2 }] } })).toEqual({ error: "P appears twice on the price list." });
    expect(readPriceList("roam-v2", "nope")).toEqual({ error: "Not this supplier's price-list format (not valid JSON)." });
    expect(read("nobody", {})).toEqual({ error: "This supplier has no price-list format yet." });
  });
});
