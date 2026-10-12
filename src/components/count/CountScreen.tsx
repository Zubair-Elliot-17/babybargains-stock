"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ClerkProduct, CountView } from "@/domain/ledger/read";
import { countKey, foldCounts } from "@/domain/ledger/stocktake";
import { count as plural } from "@/lib/plural";
import { Scanner } from "./Scanner";
import styles from "./count.module.css";

type Entry = CountView["entries"][number];
type BatchChoice = { batchId: string; batchCode: string };
type Pending = { lineId: string; sku: string; batchId?: string; counted: number; mode: "add" | "replace" };

const CATEGORY: Record<ClerkProduct["category"], string> = { cot: "Cots", pram: "Prams", monitor: "Monitors", clothing: "Clothing", toy: "Toys" };

// Blind count (design D5/D10/D14/D16/D28): one item at a time, nothing shows system stock.
export function CountScreen(props: {
  stocktakeId: string;
  branchName: string;
  openedAt: string;
  products: ClerkProduct[];
  initialEntries: Entry[];
}) {
  const [entries, setEntries] = useState<Entry[]>(props.initialEntries);
  const [tab, setTab] = useState<"count" | "uncounted">("count");
  const [query, setQuery] = useState("");
  const [product, setProduct] = useState<ClerkProduct | null>(null);
  const [qty, setQty] = useState(1);
  const [batches, setBatches] = useState<BatchChoice[] | null>(null);
  const [batchId, setBatchId] = useState<string | undefined>();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<{ pending: Pending; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | { kind: "repeat"; prev: number } | { kind: "submit"; uncounted: number }>(null);
  const [submitted, setSubmitted] = useState<null | { productsCounted: number; submittedAt: string }>(null);
  const [scanning, setScanning] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // Camera scanning only where the browser supports BarcodeDetector (false during SSR, no hydration mismatch).
  const canScan = useSyncExternalStore(noop, () => "BarcodeDetector" in window, () => false);

  const bySku = useMemo(() => new Map(props.products.map((p) => [p.sku, p])), [props.products]);
  const counts = useMemo(
    () => foldCounts(entries.map((e) => ({ sku: e.sku, batchId: e.batchId, counted: e.counted, mode: e.mode, countedAt: new Date(e.countedAt) }))),
    [entries],
  );
  const countedSkus = useMemo(() => new Set([...counts.values()].map((c) => c.sku)), [counts]);
  const uncounted = props.products.filter((p) => !countedSkus.has(p.sku));

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return props.products.filter((p) => p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)).slice(0, 8);
  }, [query, props.products]);

  // Batch-tracked products: load this branch's batch codes and prefill the last one used (D28).
  useEffect(() => {
    if (!product?.batchTracked) return;
    let cancelled = false;
    fetch(`/api/stocktakes/${props.stocktakeId}/batches?sku=${encodeURIComponent(product.sku)}`)
      .then((r) => (r.ok ? r.json() : { batches: [] }))
      .then((b: { batches: BatchChoice[] }) => {
        if (cancelled) return;
        setBatches(b.batches);
        setBatchId((current) => {
          if (current) return current;
          const remembered = safeGet(`bb-batch:${product.sku}`);
          return b.batches.find((x) => x.batchId === remembered)?.batchId ?? b.batches[0]?.batchId;
        });
      })
      .catch(() => !cancelled && setBatches([]));
    return () => {
      cancelled = true;
    };
  }, [product, props.stocktakeId]);

  function choose(p: ClerkProduct, opts: { batchId?: string; qty?: number; editing?: boolean } = {}) {
    setProduct(p);
    setBatches(null);
    setBatchId(opts.batchId);
    setQty(opts.qty ?? 1);
    setEditing(Boolean(opts.editing));
    setQuery("");
    setFailed(null);
    setNotice(null);
    setTab("count");
  }

  function onScan(value: string) {
    setScanning(false);
    const raw = value.trim();
    const p = bySku.get(raw) ?? props.products.find((x) => x.sku.toLowerCase() === raw.toLowerCase());
    if (p) return choose(p);
    const batch = batches?.find((b) => b.batchCode.toLowerCase() === raw.toLowerCase());
    if (batch) return setBatchId(batch.batchId);
    setQuery(raw);
    setNotice(`"${raw}" is not in the catalogue. Keep typing to search.`);
  }

  function requestSave() {
    if (!product) return;
    if (product.batchTracked && !batchId) return setNotice("Scan or pick the batch label for this product.");
    const prev = counts.get(countKey(product.sku, product.batchTracked ? batchId : undefined));
    if (prev && !editing) return setSheet({ kind: "repeat", prev: prev.counted });
    void save("replace");
  }

  async function save(mode: "add" | "replace", retry?: Pending) {
    if (!product && !retry) return;
    const pending: Pending = retry ?? {
      lineId: crypto.randomUUID(),
      sku: product!.sku,
      batchId: product!.batchTracked ? batchId : undefined,
      counted: qty,
      mode,
    };
    setSheet(null);
    setSaving(true);
    setFailed(null);
    try {
      const res = await fetch(`/api/stocktakes/${props.stocktakeId}/lines`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: pending.lineId, sku: pending.sku, batchId: pending.batchId, counted: pending.counted, mode: pending.mode }),
      });
      const body = await res.json().catch(() => null);
      // The line id is only reused by this retry, so COMMAND_ID_REUSED means the server already holds this
      // line (saved before a re-login). A new id would count it twice.
      const held = body?.error?.code === "COMMAND_ID_REUSED";
      if (!res.ok && !held) {
        setFailed({ pending, message: body?.error?.message ?? "Not saved. Retry" });
        return;
      }
      const result = held ? { counted: pending.counted, countedAt: new Date().toISOString() } : body.result;
      const name = bySku.get(pending.sku)?.name ?? pending.sku;
      setEntries((list) => [
        ...list,
        {
          _id: pending.lineId, sku: pending.sku, batchId: pending.batchId,
          batchCode: batches?.find((b) => b.batchId === pending.batchId)?.batchCode,
          counted: pending.counted, mode: pending.mode, countedAt: result.countedAt,
        },
      ]);
      if (pending.batchId) safeSet(`bb-batch:${pending.sku}`, pending.batchId);
      setNotice(`Saved · ${name} × ${result.counted}`);
      setProduct(null);
      setEditing(false);
      setQty(1);
      searchRef.current?.focus();
    } catch {
      setFailed({ pending, message: "Not saved: no connection. Retry" });
    } finally {
      setSaving(false);
    }
  }

  async function submit(uncountedMode: "zero" | "leave") {
    setSheet(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/stocktakes/${props.stocktakeId}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: crypto.randomUUID(), uncounted: uncountedMode }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) return setNotice(body?.error?.message ?? "Couldn't submit. Retry");
      setSubmitted({ productsCounted: body.result.productsCounted, submittedAt: body.result.submittedAt });
    } catch {
      setNotice("Couldn't reach the server. Retry");
    } finally {
      setSaving(false);
    }
  }

  if (submitted) {
    const mins = Math.max(1, Math.round((Date.parse(submitted.submittedAt) - Date.parse(props.openedAt)) / 60_000));
    const duration = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
    return (
      <div className={styles.home}>
        <h1>Stocktake sent to manager</h1>
        <p className={styles.doneLine}>{plural(submitted.productsCounted, "product")} · {duration}</p>
        <p className={styles.hint}>Your branch home will show when it&apos;s approved.</p>
        <Link className={`btn btn-primary ${styles.bigButton}`} href="/count">Done</Link>
      </div>
    );
  }

  const recent = [...entries].reverse().slice(0, 5);
  const productCount = props.products.length;

  return (
    <div className={styles.screen}>
      <div className={styles.tabs} role="tablist">
        <button role="tab" aria-selected={tab === "count"} className={styles.tabButton} onClick={() => setTab("count")}>Count</button>
        <button role="tab" aria-selected={tab === "uncounted"} className={styles.tabButton} onClick={() => setTab("uncounted")}>
          Not counted yet <span className={styles.badge}>{uncounted.length}</span>
        </button>
      </div>

      {tab === "count" ? (
        <>
          <div className={styles.searchBar}>
            <label htmlFor="sku-search" className="sr-only">Scan or search product</label>
            <input
              id="sku-search"
              ref={searchRef}
              className="input"
              placeholder="Scan or search product"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
            {canScan && (
              <button className="btn" onClick={() => setScanning(true)} aria-label="Scan with camera">Scan</button>
            )}
          </div>
          {matches.length > 0 && (
            <ul className={styles.results} role="listbox" aria-label="Matching products">
              {matches.map((p) => (
                <li key={p.sku}>
                  <button role="option" aria-selected={false} className={styles.result} onClick={() => choose(p)}>
                    <span>{p.name}</span>
                    <span className="mono">{p.sku}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {product ? (
            <section className={styles.item} aria-label="Count this product">
              <p className={styles.itemName}>{product.name}</p>
              <p className="mono">{product.sku}</p>
              <div className={styles.stepper}>
                <button className={styles.step} onClick={() => setQty((n) => Math.max(0, n - 1))} aria-label="One fewer">−</button>
                <input
                  className={styles.qty}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  aria-label="Counted quantity"
                  value={qty}
                  onChange={(e) => setQty(Math.min(9999, Math.max(0, Number(e.target.value.replace(/\D/g, "")) || 0)))}
                />
                <button className={styles.step} onClick={() => setQty((n) => Math.min(9999, n + 1))} aria-label="One more">+</button>
              </div>
              {product.batchTracked && (
                <div className={styles.batchRow}>
                  <label htmlFor="batch-pick">Batch</label>
                  {batches === null ? (
                    <span className={styles.hint}>Loading batches…</span>
                  ) : batches.length === 0 ? (
                    <span className={styles.hint}>No batches on record here. Scan the label.</span>
                  ) : (
                    <select id="batch-pick" className={`input mono ${styles.batchChip}`} value={batchId ?? ""} onChange={(e) => setBatchId(e.target.value)}>
                      {batches.map((b) => (
                        <option key={b.batchId} value={b.batchId}>Batch {b.batchCode}</option>
                      ))}
                    </select>
                  )}
                </div>
              )}
              {failed && (
                <p className="banner banner-error" role="alert">
                  {failed.message}{" "}
                  <button className="btn" onClick={() => save(failed.pending.mode, failed.pending)}>Retry</button>
                </p>
              )}
              <button className={`btn btn-primary ${styles.bigButton}`} onClick={requestSave} disabled={saving}>
                {saving ? "Saving…" : editing ? "Save correction" : "Save count"}
              </button>
            </section>
          ) : (
            <p className={styles.hint}>Scan a label or type at least two letters of a product name or SKU.</p>
          )}
          {notice && <p className={styles.notice} role="status">{notice}</p>}

          {recent.length > 0 && (
            <section aria-label="Recent counts">
              <h2 className={styles.subhead}>Recent</h2>
              <ul className={styles.recent}>
                {recent.map((e) => {
                  const p = bySku.get(e.sku);
                  const eff = counts.get(countKey(e.sku, e.batchId));
                  return (
                    <li key={e._id}>
                      <button className={styles.recentRow} onClick={() => p && choose(p, { batchId: e.batchId, qty: eff?.counted ?? e.counted, editing: true })}>
                        <span>{p?.name ?? e.sku}{e.batchCode ? ` · ${e.batchCode}` : ""}</span>
                        <span>{e.mode === "add" ? "+" : "×"} {e.counted}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      ) : (
        <section aria-label="Products not counted yet">
          {uncounted.length === 0 ? (
            <p className="banner">Every product has a count.</p>
          ) : (
            (Object.keys(CATEGORY) as ClerkProduct["category"][]).map((cat) => {
              const list = uncounted.filter((p) => p.category === cat);
              if (!list.length) return null;
              return (
                <div key={cat}>
                  <h2 className={styles.subhead}>{CATEGORY[cat]} · {list.length}</h2>
                  <ul className={styles.recent}>
                    {list.map((p) => (
                      <li key={p.sku}>
                        <button className={styles.recentRow} onClick={() => choose(p)}>
                          <span>{p.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })
          )}
        </section>
      )}

      <footer className={styles.footer}>
        <span aria-live="polite">{countedSkus.size} of {productCount} products counted</span>
        <button
          className="btn btn-primary"
          disabled={saving}
          onClick={() => (uncounted.length ? setSheet({ kind: "submit", uncounted: uncounted.length }) : submit("leave"))}
        >
          {saving ? "Saving…" : "Submit stocktake"}
        </button>
      </footer>

      {sheet?.kind === "repeat" && product && (
        <Sheet title={`Counted ${sheet.prev} earlier`} onClose={() => setSheet(null)}>
          <button className={`btn btn-primary ${styles.bigButton}`} onClick={() => save("add")}>Add {qty} (total {sheet.prev + qty})</button>
          <button className={`btn ${styles.bigButton}`} onClick={() => save("replace")}>Replace with {qty}</button>
        </Sheet>
      )}
      {sheet?.kind === "submit" && (
        <Sheet title={`${plural(sheet.uncounted, "product")} not counted`} onClose={() => setSheet(null)}>
          <p className={styles.hint}>Count as zero posts them as missing. Leave out skips them in this stocktake.</p>
          <button className={`btn ${styles.bigButton}`} onClick={() => submit("leave")}>Leave out and submit</button>
          <button className={`btn ${styles.bigButton}`} onClick={() => submit("zero")}>Count as zero and submit</button>
          <button className={`btn btn-primary ${styles.bigButton}`} onClick={() => { setSheet(null); setTab("uncounted"); }}>Keep counting</button>
        </Sheet>
      )}
      {scanning && <Scanner onResult={onScan} onClose={() => setScanning(false)} />}
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className={styles.sheet} onClose={onClose} aria-label={title}>
      <h2>{title}</h2>
      <div className={styles.sheetActions}>{children}</div>
      <button className={styles.sheetCancel} onClick={() => ref.current?.close()}>Cancel</button>
    </dialog>
  );
}

const noop = () => () => {};

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode); batch memory is a convenience only.
  }
}
