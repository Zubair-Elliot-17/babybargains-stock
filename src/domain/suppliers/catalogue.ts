import { z } from "zod";
import { NoteRef } from "./deliveryNotes";

// One adapter per supplier price-list format (suppliers.adapter), like deliveryNotes.ts. A price list
// updates names and prices of the supplier's products; it can't add products (those need category
// details a price list doesn't carry), so unknown SKUs are listed, not created.

export interface PriceList {
  ref: string; // the supplier's own reference; the same list can't be applied twice
  items: { sku: string; name: string; price: number }[]; // price in pence
}

interface Adapter {
  parse(json: unknown): PriceList;
  example(products: { sku: string; name: string; price: number }[], ref: string): unknown;
}

const Sku = z.string().trim().min(1).max(80);
// Printable names only: no control, zero-width or bidi characters (they'd hide or reorder text on every
// screen), no combining marks (they stack over neighbouring rows). The price-list route uses the same.
export const ProductName = z.string().transform((s) => s.normalize("NFC").trim()).pipe(z.string().min(1).max(120).regex(/^[\p{L}\p{N}\p{P}\p{S} ]+$/u, "letters, digits, spaces and punctuation only"));
const Name = ProductName;
export const Pence = z.number().int().min(1).max(10_000_000);
const PoundsNumber = z.number().positive().max(100_000).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, "at most 2 decimals").transform((n) => Math.round(n * 100)).pipe(Pence);
const PoundsString = z.string().trim().regex(/^\d{1,6}(\.\d{1,2})?$/, "a price like 129.99").transform((s) => Math.round(Number(s) * 100)).pipe(Pence);
const List = <T extends z.ZodType>(item: T) => z.array(item).min(1).max(500);

const littleOak = z.object({ priceList: NoteRef, products: List(z.object({ code: Sku, title: Name, rrp: PoundsNumber })) });
const roam = z.object({ catalogue: z.object({ id: NoteRef, models: List(z.object({ sku: Sku, name: Name, pricePence: Pence })) }) });
const safesound = z.object({ list_no: NoteRef, items: List(z.object({ product_sku: Sku, description: Name, price_gbp: PoundsString })) });
const snuggle = z.object({ ref: NoteRef, rows: z.array(z.array(z.string().max(120))).min(2).max(501) });
const wonder = z.object({ id: NoteRef, toys: List(z.object({ item: z.object({ sku: Sku, name: Name }), price: z.object({ amount: Pence, currency: z.literal("GBP") }) })) });

const SNUGGLE_HEADER = ["sku", "name", "price"];
const pounds = (pence: number) => (pence / 100).toFixed(2);

export const CATALOGUE_ADAPTERS: Record<string, Adapter> = {
  "little-oak-v1": {
    parse: (j) => {
      const n = littleOak.parse(j);
      return { ref: n.priceList, items: n.products.map((p) => ({ sku: p.code, name: p.title, price: p.rrp })) };
    },
    example: (ps, ref) => ({ priceList: `LO-PL-${ref}`, products: ps.map((p) => ({ code: p.sku, title: p.name, rrp: p.price / 100 })) }),
  },
  "roam-v2": {
    parse: (j) => {
      const { catalogue: c } = roam.parse(j);
      return { ref: c.id, items: c.models.map((m) => ({ sku: m.sku, name: m.name, price: m.pricePence })) };
    },
    example: (ps, ref) => ({ catalogue: { id: `RC-${ref}`, models: ps.map((p) => ({ sku: p.sku, name: p.name, pricePence: p.price })) } }),
  },
  "safesound-v1": {
    parse: (j) => {
      const n = safesound.parse(j);
      return { ref: n.list_no, items: n.items.map((i) => ({ sku: i.product_sku, name: i.description, price: i.price_gbp })) };
    },
    example: (ps, ref) => ({ list_no: `SS-PL-${ref}`, items: ps.map((p) => ({ product_sku: p.sku, description: p.name, price_gbp: pounds(p.price) })) }),
  },
  "snuggle-csvjson": {
    parse: (j) => {
      const n = snuggle.parse(j);
      const [header, ...rows] = n.rows;
      if (header.map((h) => h.trim().toLowerCase()).join() !== SNUGGLE_HEADER.join()) throw new Error(`Header row must be ${SNUGGLE_HEADER.join(", ")}`);
      const cell = <T>(schema: z.ZodType<T>, value: string | undefined, row: number, column: string): T => {
        const r = schema.safeParse(value);
        if (!r.success) throw new Error(`Row ${row}, ${column}: ${r.error.issues[0].message}`);
        return r.data;
      };
      const items = rows.flatMap((r, i) => {
        if (r.every((v) => !v.trim())) return []; // a blank trailing row from a CSV export
        if (r.length !== 3) throw new Error(`Row ${i + 2} needs 3 values`);
        return [{ sku: cell(Sku, r[0], i + 2, "sku"), name: cell(Name, r[1], i + 2, "name"), price: cell(PoundsString, r[2], i + 2, "price") }];
      });
      if (!items.length) throw new Error("No products listed");
      return { ref: n.ref, items };
    },
    example: (ps, ref) => ({ ref: `SN-PL-${ref}`, rows: [SNUGGLE_HEADER, ...ps.map((p) => [p.sku, p.name, pounds(p.price)])] }),
  },
  "wonder-v1": {
    parse: (j) => {
      const n = wonder.parse(j);
      return { ref: n.id, items: n.toys.map((t) => ({ sku: t.item.sku, name: t.item.name, price: t.price.amount })) };
    },
    example: (ps, ref) => ({ id: `WT-PL-${ref}`, toys: ps.map((p) => ({ item: { sku: p.sku, name: p.name }, price: { amount: p.price, currency: "GBP" } })) }),
  },
};

export interface CatalogueChange {
  sku: string;
  before: { name: string; price: number };
  after: { name: string; price: number };
}

// Demo guard: a list may move a price to between half and double what it is now (a public demo can't
// let visitors set £0.01 or £100k prices across the catalogue). shortcut: drop for a real deployment.
const PRICE_RANGE = [0.5, 2] as const;

// What applying the list would change for this supplier's products, and what it can't apply.
export function diffPriceList(list: PriceList, products: { sku: string; name: string; price: number }[]) {
  const bySku = new Map(products.map((p) => [p.sku, p]));
  const changes: CatalogueChange[] = [];
  const unknown: string[] = [];
  const outOfRange: string[] = [];
  let unchanged = 0;
  for (const i of list.items) {
    const p = bySku.get(i.sku);
    if (!p) unknown.push(i.sku);
    else if (p.name === i.name && p.price === i.price) unchanged++;
    else {
      if (i.price < p.price * PRICE_RANGE[0] || i.price > p.price * PRICE_RANGE[1]) outOfRange.push(i.sku);
      changes.push({ sku: i.sku, before: { name: p.name, price: p.price }, after: { name: i.name, price: i.price } });
    }
  }
  return { changes, unchanged, unknown, outOfRange };
}
export const PRICE_RANGE_TEXT = "between half and double the current price";

// Text of a price-list file -> the list, or what is wrong with it.
export function readPriceList(adapterId: string, text: string): { list: PriceList } | { error: string } {
  const adapter = CATALOGUE_ADAPTERS[adapterId];
  if (!adapter) return { error: "This supplier has no price-list format yet." };
  let list: PriceList;
  try {
    list = adapter.parse(JSON.parse(text));
  } catch (e) {
    if (e instanceof z.ZodError) return { error: `Not this supplier's price-list format (${e.issues.map((i) => `${i.path.join(".") || "list"}: ${i.message}`).slice(0, 3).join("; ")}).` };
    if (e instanceof SyntaxError) return { error: "Not this supplier's price-list format (not valid JSON)." };
    return { error: `Couldn't read this price list: ${(e as Error).message}.` };
  }
  const skus = list.items.map((i) => i.sku);
  const twice = skus.find((s, i) => skus.indexOf(s) !== i);
  if (twice) return { error: `${twice} appears twice on the price list.` };
  return { list };
}

// A demo price list in the supplier's format: a few price rises and one SKU not in the catalogue.
export function samplePriceList(adapterId: string, products: { sku: string; name: string; price: number }[], ref: string): unknown {
  const bumped = products.map((p, i) => (i < 3 ? { ...p, price: Math.ceil((p.price * 1.05) / 100) * 100 - 1 } : p)); // +5%, to .99
  return CATALOGUE_ADAPTERS[adapterId]?.example([...bumped, { sku: `NEW-${ref}`, name: "New season sample", price: 1999 }], ref);
}
