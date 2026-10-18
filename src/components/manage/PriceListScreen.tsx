"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { ProductCategory } from "@/domain/schemas";
import { BATCH_TRACKED_BY_DEFAULT, diffPriceList, MAX_NEW_PRODUCTS, NewProduct, NewSku, PRICE_RANGE_TEXT, readPriceList, samplePriceList, type PriceList } from "@/domain/suppliers/catalogue";
import { money } from "@/lib/format";
import { count } from "@/lib/plural";
import { postCommand } from "@/lib/postCommand";
import styles from "./manage.module.css";

type P = { sku: string; name: string; price: number };
type Adding = Record<string, { category: ProductCategory; batchTracked: boolean }>;

// The details a price list doesn't carry, per category (schemas.ts Product attributes).
const FIELDS: Record<ProductCategory, [key: string, label: string, kind: "number" | "int" | "text" | "check"][]> = {
  cot: [["widthCm", "Width (cm)", "number"], ["lengthCm", "Length (cm)", "number"], ["finish", "Finish", "text"], ["safetyStandard", "Safety standard", "text"]],
  pram: [["weightKg", "Weight (kg)", "number"], ["foldable", "Folds", "check"], ["safetyStandard", "Safety standard", "text"]],
  monitor: [["rangeM", "Range (m)", "int"], ["video", "Video", "check"], ["warrantyMonths", "Warranty (months)", "int"]],
  clothing: [["size", "Size", "text"], ["colour", "Colour", "text"], ["material", "Material", "text"]],
  toy: [["ageMonthsMin", "From age (months)", "int"], ["material", "Material", "text"]],
};
const CATEGORIES = Object.keys(FIELDS) as ProductCategory[];

// The ticked products as NewProduct inputs, read from the form, or the first thing wrong with one.
function readNewProducts(form: HTMLFormElement, adding: Adding): { add: NewProduct[] } | { error: string } {
  const fd = new FormData(form);
  const add: NewProduct[] = [];
  for (const [sku, a] of Object.entries(adding)) {
    const attributes = Object.fromEntries(
      FIELDS[a.category].map(([key, , kind]) => {
        const v = fd.get(`${sku}:${key}`);
        return [key, kind === "check" ? v !== null : kind === "text" ? v : v === "" || v === null ? NaN : Number(v)];
      }),
    );
    const r = NewProduct.safeParse({ sku, batchTracked: a.batchTracked, category: a.category, attributes });
    if (!r.success) {
      const issue = r.error.issues[0];
      const label = FIELDS[a.category].find(([key]) => key === issue.path.at(-1))?.[1] ?? issue.path.join(".");
      return { error: `${sku}, ${label}: ${issue.message}` };
    }
    add.push(r.data);
  }
  return { add };
}

// Load a supplier price list (file or sample), preview what it changes, then apply it.
export function PriceListImport(props: { supplierId: string; supplierName: string; adapter: string; products: P[] }) {
  const router = useRouter();
  const id = useRef(crypto.randomUUID());
  const [list, setList] = useState<{ list: PriceList; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [adding, setAdding] = useState<Adding>({});
  const diff = list && diffPriceList(list.list, props.products);
  const adds = Object.keys(adding).length;
  const names = new Map(props.products.map((p) => [p.sku, p.name]));

  function load(text: string) {
    setDone(null);
    const r = readPriceList(props.adapter, text);
    if ("error" in r) {
      setList(null);
      return setError(r.error);
    }
    setError(null);
    id.current = crypto.randomUUID(); // a new list is a new command
    setAdding({});
    setList({ list: r.list, text });
  }
  async function loadFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = ""; // picking the same file again must load it again
    if (!file) return;
    if (file.size > 500_000) return setError("That file is too big for a price list (500 KB max).");
    try {
      load(await file.text());
    } catch {
      setError("Couldn't read that file. Pick it again.");
    }
  }
  async function apply(form: HTMLFormElement) {
    if (!list) return;
    const added = readNewProducts(form, adding);
    if ("error" in added) return setError(added.error);
    setBusy(true);
    setError(null);
    const body = { supplierId: props.supplierId, ref: list.list.ref, items: list.list.items, ...(added.add.length ? { add: added.add } : {}) };
    const r = await postCommand<{ ref: string; changed: number; added: number }>("/api/price-lists", body, id);
    setBusy(false);
    setLocked("error" in r && !!r.unknown);
    if ("error" in r) return setError(r.error);
    setList(null);
    setAdding({});
    setDone(`Price list ${r.result.ref} applied: ${count(r.result.changed, "product")} changed${r.result.added ? `, ${count(r.result.added, "product")} added` : ""}.`);
    router.refresh();
  }

  return (
    <section className={`panel ${styles.section}`} aria-labelledby="price-list">
      <h2 id="price-list">{props.supplierName}</h2>
      {!locked && !busy && (
        <div className={styles.filters}>
          <label>
            Price list file
            <input className="input" type="file" accept="application/json,.json" onChange={(e) => void loadFile(e.target)} />
          </label>
          <button className="btn" type="button" onClick={() => load(JSON.stringify(samplePriceList(props.adapter, props.products, Date.now().toString(36).toUpperCase().slice(-6)), null, 2))}>
            Try a sample price list
          </button>
        </div>
      )}
      {done && <p className="banner" role="status">{done}</p>}
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      {list && diff && (
        <form onSubmit={(e) => { e.preventDefault(); void apply(e.currentTarget); }}>
          <p className={styles.meta}>
            Price list <span className="mono">{list.list.ref}</span>: {count(diff.changes.length, "change")}, {diff.unchanged} unchanged
            {diff.unknown.length ? `, ${count(diff.unknown.length, "product")} not in our catalogue` : ""}.
          </p>
          {diff.changes.length > 0 && (
            <table className="cards">
              <thead>
                <tr><th scope="col">Product</th><th scope="col">New name</th><th scope="col" className="num">Price now</th><th scope="col" className="num">New price</th></tr>
              </thead>
              <tbody>
                {diff.changes.map((ch) => (
                  <tr key={ch.sku}>
                    <th scope="row">{names.get(ch.sku)}<span className={`${styles.meta} mono`}> {ch.sku}</span></th>
                    <td data-label="New name">{ch.after.name === ch.before.name ? "–" : ch.after.name}</td>
                    <td className="num" data-label="Price now">{money(ch.before.price)}</td>
                    <td className="num" data-label="New price">{ch.after.price === ch.before.price ? "–" : money(ch.after.price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {diff.outOfRange.length > 0 && (
            <p className="banner banner-error" role="alert">
              Demo limit: prices can move {PRICE_RANGE_TEXT}. Outside it: <span className="mono">{diff.outOfRange.join(", ")}</span>.
            </p>
          )}
          {diff.unknown.length > 0 && (
            <NewProducts
              items={list.list.items.filter((i) => diff.unknown.includes(i.sku))}
              adding={adding}
              disabled={busy || locked}
              onChange={(next) => {
                setAdding(next);
                id.current = crypto.randomUUID(); // a different set of products is a different command
              }}
            />
          )}
          <details>
            <summary>Show the price list</summary>
            <pre className={`mono ${styles.note}`}>{list.text}</pre>
          </details>
          <div className={styles.filters}>
            <button className="btn btn-primary" type="submit" disabled={busy || !(diff.changes.length || adds) || diff.outOfRange.length > 0}>
              {busy ? "Applying…" : locked ? "Send again" : diff.changes.length ? `Apply ${count(diff.changes.length, "change")}${adds ? `, add ${count(adds, "product")}` : ""}` : adds ? `Add ${count(adds, "product")}` : "Nothing to change"}
            </button>
            {!locked && !busy && (
              <button className="btn" type="button" onClick={() => { setList(null); setError(null); setAdding({}); }}>Discard</button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}

// Listed products we don't stock: tick one to add it, then fill in its category details.
function NewProducts(props: { items: P[]; adding: Adding; disabled: boolean; onChange: (next: Adding) => void }) {
  const full = Object.keys(props.adding).length >= MAX_NEW_PRODUCTS;
  const set = (sku: string, a: Adding[string] | null) => {
    const next = { ...props.adding };
    if (a) next[sku] = a;
    else delete next[sku];
    props.onChange(next);
  };
  return (
    <section aria-labelledby="new-products">
      <h3 id="new-products">Not in our catalogue</h3>
      <p className={styles.meta}>Tick a product to add it with the list&apos;s name and price. Demo limit: {MAX_NEW_PRODUCTS} per list; added products go at the nightly reset.</p>
      {props.items.map((i) => {
        const a = props.adding[i.sku];
        const valid = NewSku.safeParse(i.sku).success;
        return (
          <fieldset key={i.sku} className={styles.newProduct} disabled={props.disabled}>
            <legend>
              <label className={styles.check}>
                <input type="checkbox" checked={!!a} disabled={props.disabled || !valid || (!a && full)} onChange={(e) => set(i.sku, e.target.checked ? { category: "toy", batchTracked: BATCH_TRACKED_BY_DEFAULT.toy } : null)} />
                Add {i.name} <span className="mono">{i.sku}</span> · {money(i.price)}
              </label>
            </legend>
            {!valid && <p className={styles.meta}>Can&apos;t add: an SKU needs letters, digits, . _ or - only (40 max).</p>}
            {a && (
              <div className={styles.filters}>
                <label>
                  Category
                  <select className="input" value={a.category} onChange={(e) => { const category = e.target.value as ProductCategory; set(i.sku, { category, batchTracked: BATCH_TRACKED_BY_DEFAULT[category] }); }}>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
                  </select>
                </label>
                {FIELDS[a.category].map(([key, label, kind]) =>
                  kind === "check" ? (
                    <label key={key} className={styles.check}><input type="checkbox" name={`${i.sku}:${key}`} /> {label}</label>
                  ) : (
                    <label key={key}>
                      {label}
                      <input className={`input ${kind === "text" ? "" : styles.lineInput}`} name={`${i.sku}:${key}`} required type={kind === "text" ? "text" : "number"} step={kind === "number" ? "any" : "1"} min={kind === "text" ? undefined : 0} maxLength={kind === "text" ? 40 : undefined} />
                    </label>
                  ),
                )}
                <label className={styles.check}><input type="checkbox" checked={a.batchTracked} onChange={(e) => set(i.sku, { ...a, batchTracked: e.target.checked })} /> Track batches</label>
              </div>
            )}
          </fieldset>
        );
      })}
    </section>
  );
}
