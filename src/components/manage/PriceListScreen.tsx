"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { diffPriceList, PRICE_RANGE_TEXT, readPriceList, samplePriceList, type PriceList } from "@/domain/suppliers/catalogue";
import { money } from "@/lib/format";
import { count } from "@/lib/plural";
import { postCommand } from "@/lib/postCommand";
import styles from "./manage.module.css";

type P = { sku: string; name: string; price: number };

// Load a supplier price list (file or sample), preview what it changes, then apply it.
export function PriceListImport(props: { supplierId: string; supplierName: string; adapter: string; products: P[] }) {
  const router = useRouter();
  const id = useRef(crypto.randomUUID());
  const [list, setList] = useState<{ list: PriceList; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const diff = list && diffPriceList(list.list, props.products);
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
  async function apply() {
    if (!list) return;
    setBusy(true);
    setError(null);
    const r = await postCommand<{ ref: string; changed: number }>("/api/price-lists", { supplierId: props.supplierId, ref: list.list.ref, items: list.list.items }, id);
    setBusy(false);
    setLocked("error" in r && !!r.unknown);
    if ("error" in r) return setError(r.error);
    setList(null);
    setDone(`Price list ${r.result.ref} applied: ${count(r.result.changed, "product")} changed.`);
    router.refresh();
  }

  return (
    <section className={styles.section} aria-labelledby="price-list">
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
        <>
          <p className={styles.meta}>
            Price list <span className="mono">{list.list.ref}</span>: {count(diff.changes.length, "change")}, {diff.unchanged} unchanged
            {diff.unknown.length ? `, ${count(diff.unknown.length, "product")} not in our catalogue (not added: new products need their details set up first)` : ""}.
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
          {diff.unknown.length > 0 && <p className={styles.meta}>Not in our catalogue: <span className="mono">{diff.unknown.join(", ")}</span></p>}
          <details>
            <summary>Show the price list</summary>
            <pre className={`mono ${styles.note}`}>{list.text}</pre>
          </details>
          <div className={styles.filters}>
            <button className="btn btn-primary" type="button" disabled={busy || !diff.changes.length || diff.outOfRange.length > 0} onClick={() => void apply()}>
              {busy ? "Applying…" : locked ? "Send again" : diff.changes.length ? `Apply ${count(diff.changes.length, "change")}` : "Nothing to change"}
            </button>
            {!locked && !busy && (
              <button className="btn" type="button" onClick={() => { setList(null); setError(null); }}>Discard</button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
