"use client";

import { useMemo, useRef, useState } from "react";
import { money } from "@/lib/format";
import { postCommand } from "@/lib/postCommand";
import styles from "./count.module.css";

type SaleProduct = { sku: string; name: string; price: number };
type Line = { sku: string; name: string; price: number; qty: number; short?: boolean };

// Till-style basket (design D23): search, quantity, add; one sale posts every line FIFO or none.
export function SaleScreen({ products }: { products: SaleProduct[] }) {
  const id = useRef(crypto.randomUUID());
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [basket, setBasket] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [locked, setLocked] = useState(false); // outcome unknown: only an identical resend is allowed
  const total = basket.reduce((n, l) => n + l.qty * l.price, 0);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return products.filter((p) => p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)).slice(0, 8);
  }, [query, products]);

  function add(p: SaleProduct) {
    if (locked) return;
    setBasket((b) => (b.some((l) => l.sku === p.sku) ? b.map((l) => (l.sku === p.sku ? { ...l, qty: Math.min(999, l.qty + 1), short: false } : l)) : [...b, { ...p, qty: 1 }]));
    setQuery("");
    setNotice(null);
    setError(null);
    searchRef.current?.focus();
  }

  const setQty = (sku: string, qty: number) =>
    !locked && setBasket((b) => (qty <= 0 ? b.filter((l) => l.sku !== sku) : b.map((l) => (l.sku === sku ? { ...l, qty: Math.min(999, qty), short: false } : l))));

  async function record() {
    setBusy(true);
    setError(null);
    const r = await postCommand<{ total: number }>("/api/sales", { lines: basket.map((l) => ({ sku: l.sku, qty: l.qty })) }, id);
    setBusy(false);
    setLocked("error" in r && !!r.unknown);
    if ("error" in r) {
      // Short stock refuses the whole sale; mark every short line (no quantities: the count stays blind).
      if (r.code === "INSUFFICIENT_STOCK" && Array.isArray(r.details)) {
        const short = new Set((r.details as { sku: string }[]).map((d) => d.sku));
        setBasket((b) => b.map((l) => ({ ...l, short: short.has(l.sku) })));
      }
      return setError(r.error);
    }
    setNotice(`Sale recorded · ${money(r.result.total)}`);
    setBasket([]);
    searchRef.current?.focus();
  }

  return (
    <div className={styles.screen}>
      <h1 className="sr-only">Record sale</h1>
      <div className={styles.searchBar}>
        <label htmlFor="sale-search" className="sr-only">Scan or search product</label>
        <input id="sale-search" ref={searchRef} className="input" placeholder="Scan or search product" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" disabled={locked} />
      </div>
      {matches.length > 0 && (
        <ul className={styles.results} role="listbox" aria-label="Matching products">
          {matches.map((p) => (
            <li key={p.sku}>
              <button role="option" aria-selected={false} className={styles.result} onClick={() => add(p)}>
                <span>{p.name}</span>
                <span className="mono">{money(p.price)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {notice && <p className={styles.notice} role="status">{notice}</p>}

      {basket.length === 0 ? (
        <p className={styles.hint}>Scan a label or type at least two letters to add products to the sale.</p>
      ) : (
        <section aria-label="Sale">
          <h2 className={styles.subhead}>Sale · {basket.length} {basket.length === 1 ? "line" : "lines"}</h2>
          <ul className={styles.recent}>
            {basket.map((l) => (
              <li key={l.sku} className={styles.saleLine}>
                <span>
                  {l.name}
                  {l.short && <span className={styles.saleShort}> · Not enough on record</span>}
                </span>
                <span className={styles.stepper}>
                  <button className={styles.step} disabled={locked} onClick={() => setQty(l.sku, l.qty - 1)} aria-label={`One fewer ${l.name}`}>−</button>
                  <span aria-label={`Quantity of ${l.name}`}>{l.qty}</span>
                  <button className={styles.step} disabled={locked} onClick={() => setQty(l.sku, l.qty + 1)} aria-label={`One more ${l.name}`}>+</button>
                </span>
                <span className="num">{money(l.qty * l.price)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {error && <p className="banner banner-error" role="alert">{error}</p>}

      <footer className={styles.footer}>
        <span>{money(total)}</span>
        <button className="btn btn-primary" disabled={busy || basket.length === 0} onClick={record}>
          {busy ? "Recording…" : locked ? `Send again ${money(total)}` : `Record sale ${money(total)}`}
        </button>
      </footer>
    </div>
  );
}
