"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { ClerkProduct, CountView } from "@/domain/ledger/read";
import { countKey, foldCounts } from "@/domain/ledger/stocktake";
import { count as plural } from "@/lib/plural";
import { browserDeps, createCountQueue, type QueueSnapshot, type SentResult } from "./countQueue";
import { Scanner } from "./Scanner";
import { SyncBadge, syncAnnouncement } from "./SyncBadge";
import styles from "./count.module.css";

type Entry = CountView["entries"][number];
type BatchChoice = { batchId: string; batchCode: string };

const KEPT = "Kept on this phone";
const SAVE_WAIT_MS = 1_500; // after this the line is "Kept on this phone" and the button frees (design 4A)
const EMPTY: QueueSnapshot = { items: [], status: "idle", persistent: true, deadSpot: false };

const CATEGORY: Record<ClerkProduct["category"], string> = { cot: "Cots", pram: "Prams", monitor: "Monitors", clothing: "Clothing", toy: "Toys" };

// Blind count (design D5/D10/D14/D16/D28): one item at a time, nothing shows system stock.
export function CountScreen(props: {
  stocktakeId: string;
  branchName: string;
  openedAt: string;
  products: ClerkProduct[];
  initialEntries: Entry[];
  batches: Record<string, BatchChoice[]>;
}) {
  const [queue] = useState(() => createCountQueue(props.stocktakeId, browserDeps()));
  const snap = useSyncExternalStore(queue.subscribe, queue.snapshot, () => EMPTY);
  const [sent, setSent] = useState<Entry[]>(props.initialEntries);
  const [tab, setTab] = useState<"count" | "uncounted">("count");
  const [query, setQuery] = useState("");
  const [product, setProduct] = useState<ClerkProduct | null>(null);
  const [qty, setQty] = useState(1);
  const [batchId, setBatchId] = useState<string | undefined>();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSync, setShowSync] = useState(false); // footer status appears after the first save that wasn't sent at once
  const [sheet, setSheet] = useState<null | { kind: "repeat"; prev: number } | { kind: "submit"; uncounted: number } | { kind: "discard"; lineId: string; label: string }>(null);
  const [submitted, setSubmitted] = useState<null | { productsCounted: number; submittedAt: string }>(null);
  const [scanning, setScanning] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // Camera scanning only where the browser supports BarcodeDetector (false during SSR, no hydration mismatch).
  const canScan = useSyncExternalStore(noop, () => "BarcodeDetector" in window, () => false);
  const demoSlot = useSyncExternalStore(noop, () => document.getElementById("demo-slot"), () => null); // in the clerk layout's demo strip

  const bySku = useMemo(() => new Map(props.products.map((p) => [p.sku, p])), [props.products]);
  const codeOf = (sku: string, id?: string) => (id ? props.batches[sku]?.find((b) => b.batchId === id)?.batchCode : undefined);
  const batches = product?.batchTracked ? (props.batches[product.sku] ?? []) : null;
  // Queued lines count straight away; the server copy wins once it holds a line (dedupe by lineId).
  const failedLines = snap.items.filter((i) => i.state === "failed");
  const entries = useMemo(() => {
    const held = new Set(sent.map((e) => e._id));
    const queued = snap.items
      .filter((i) => i.state === "pending" && !held.has(i.lineId))
      .map((i): Entry => ({ _id: i.lineId, sku: i.sku, batchId: i.batchId, batchCode: codeOf(i.sku, i.batchId), counted: i.counted, mode: i.mode, countedAt: i.capturedAt }));
    return [...sent, ...queued].sort((a, b) => a.countedAt.localeCompare(b.countedAt) || a._id.localeCompare(b._id));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- codeOf only reads props.batches
  }, [sent, snap.items, props.batches]);
  const waiting = useMemo(() => new Set(snap.items.map((i) => i.lineId)), [snap.items]);
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

  useEffect(() => {
    // Lines the server already holds (a timed-out save that arrived) leave the queue; the rest start sending.
    queue.forget(props.initialEntries.map((e) => e._id));
    void queue.drain();
    const offSent = queue.onSent((r: SentResult) =>
      setSent((list) => {
        if (list.some((e) => e._id === r.lineId)) return list;
        const q = queue.snapshot().items.find((i) => i.lineId === r.lineId);
        return q ? [...list, { _id: q.lineId, sku: q.sku, batchId: q.batchId, batchCode: codeOf(q.sku, q.batchId), counted: q.counted, mode: q.mode, countedAt: r.countedAt }] : list;
      }),
    );
    const kick = () => document.visibilityState === "visible" && queue.kick();
    const onStorage = (e: StorageEvent) => e.key?.startsWith("bb-q:") && queue.refresh();
    const onUnload = (e: BeforeUnloadEvent) => {
      if (queue.snapshot().items.length) e.preventDefault(); // best-effort: iOS Safari ignores it
    };
    window.addEventListener("online", kick);
    document.addEventListener("visibilitychange", kick);
    window.addEventListener("storage", onStorage);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      offSent();
      window.removeEventListener("online", kick);
      document.removeEventListener("visibilitychange", kick);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("beforeunload", onUnload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per page life
  }, [queue]);

  // Footer appears once anything is stuck, not for saves that went straight through.
  // A line still queued while no save is in progress was not sent at once (or was queued before a reload).
  if (!showSync && snap.items.length > 0 && !saving) setShowSync(true);

  // A newly failed line is announced once (role=alert); state changes go to the polite region.
  const lastFailed = failedLines.at(-1);

  function choose(p: ClerkProduct, opts: { batchId?: string; qty?: number; editing?: boolean } = {}) {
    setProduct(p);
    const list = props.batches[p.sku] ?? [];
    const remembered = safeGet(`bb-batch:${p.sku}`);
    setBatchId(p.batchTracked ? (opts.batchId ?? list.find((x) => x.batchId === remembered)?.batchId ?? list[0]?.batchId) : undefined);
    setQty(opts.qty ?? 1);
    setEditing(Boolean(opts.editing));
    setQuery("");
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

  async function save(mode: "add" | "replace") {
    if (!product) return;
    const line = {
      lineId: crypto.randomUUID(),
      sku: product.sku,
      batchId: product.batchTracked ? batchId : undefined,
      counted: qty,
      mode,
      capturedAt: new Date().toISOString(),
    };
    setSheet(null);
    setSaving(true);
    const result = await Promise.race([queue.enqueue(line), new Promise<null>((r) => setTimeout(() => r(null), SAVE_WAIT_MS))]);
    const name = product.name;
    if (line.batchId) safeSet(`bb-batch:${line.sku}`, line.batchId);
    if (result) setNotice(`Saved · ${name} × ${result.counted}`);
    else {
      setNotice(`${KEPT} · ${name} × ${line.counted}`);
      setShowSync(true);
    }
    setSaving(false);
    setProduct(null);
    setEditing(false);
    setQty(1);
    searchRef.current?.focus();
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
  const pendingCount = snap.items.length - failedLines.length;
  const blocked = failedLines.length
    ? `Fix ${failedLines.length} not saved above`
    : pendingCount
      ? "Submit after counts are sent"
      : null;
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
                  {!batches?.length ? (
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
              <button className={`btn btn-primary ${styles.bigButton}`} onClick={requestSave} disabled={saving}>
                {saving ? "Saving…" : editing ? "Save correction" : "Save count"}
              </button>
            </section>
          ) : (
            <p className={styles.hint}>Scan a label or type at least two letters of a product name or SKU.</p>
          )}
          {notice && <p className={`${styles.notice} ${notice.startsWith(KEPT) ? styles.noticeKept : ""}`} role="status">{notice}</p>}

          {failedLines.length > 0 && (
            <section className={styles.unsaved} aria-labelledby="unsaved-head">
              <h2 id="unsaved-head" className={styles.subhead} style={{ margin: 0 }}>Not saved · {failedLines.length}</h2>
              <ul className={styles.recent}>
                {failedLines.map((l) => {
                  const label = `${bySku.get(l.sku)?.name ?? l.sku}${l.batchId ? ` · ${codeOf(l.sku, l.batchId) ?? ""}` : ""} ${l.mode === "add" ? "+" : "×"} ${l.counted}`;
                  return (
                    <li key={l.lineId} className={styles.unsavedRow}>
                      <span>{label}</span>
                      <span className={styles.unsavedMsg}>{l.error}</span>
                      <button className="btn" onClick={() => queue.retry(l.lineId)} aria-label={`Retry ${label}`}
                        title="Sends now; counts as the latest entry for this product">Retry</button>
                      <button className="btn" onClick={() => setSheet({ kind: "discard", lineId: l.lineId, label })} aria-label={`Discard ${label}`}>Discard</button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

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
                        <span>
                          {e.mode === "add" ? "+" : "×"} {e.counted}
                          {waiting.has(e._id) && <span className={styles.waiting}>Waiting</span>}
                        </span>
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
        <div className={styles.footerStack}>
          {showSync && <SyncBadge snap={snap} id="sync-status" />}
          {blocked && <p id="submit-reason" className={`${styles.sync} ${styles.syncWarn}`}>{blocked}</p>}
          <span aria-live="polite">{countedSkus.size} of {productCount} products counted</span>
        </div>
        <button
          className="btn btn-primary"
          disabled={saving || Boolean(blocked)}
          aria-describedby={blocked ? "submit-reason" : undefined}
          onClick={() => (uncounted.length ? setSheet({ kind: "submit", uncounted: uncounted.length }) : submit("leave"))}
        >
          {saving ? "Saving…" : "Submit stocktake"}
        </button>
        {snap.status === "closed" && (
          <button className="btn" onClick={() => setSheet({ kind: "discard", lineId: "*", label: `${snap.items.length} counts kept on this phone` })}>Clear</button>
        )}
      </footer>
      <p className="sr-only" role="status">{showSync ? syncAnnouncement(snap) : ""}</p>
      {lastFailed && <p key={lastFailed.lineId} className="sr-only" role="alert">{`Not saved: ${bySku.get(lastFailed.sku)?.name ?? lastFailed.sku}. ${lastFailed.error ?? ""}`}</p>}
      {!snap.persistent && (
        <p className="banner banner-error" role="alert">This browser can&apos;t store counts: any not yet sent are lost if you close the tab.</p>
      )}
      {demoSlot && createPortal(
        <label className={styles.switch}>
          <input type="checkbox" role="switch" checked={snap.deadSpot} onChange={(e) => queue.setDeadSpot(e.target.checked)} />
          Stockroom dead spot
        </label>,
        demoSlot,
      )}

      {sheet?.kind === "repeat" && product && (
        <Sheet title={`Counted ${sheet.prev} earlier`} onClose={() => setSheet(null)}>
          <button className={`btn btn-primary ${styles.bigButton}`} onClick={() => save("add")}>Add {qty} (total {sheet.prev + qty})</button>
          <button className={`btn ${styles.bigButton}`} onClick={() => save("replace")}>Replace with {qty}</button>
        </Sheet>
      )}
      {sheet?.kind === "discard" && (
        <Sheet title={sheet.lineId === "*" ? "Clear counts from this phone?" : "Discard this count?"} onClose={() => setSheet(null)}>
          <p className={styles.hint}>{sheet.label}. This can&apos;t be undone.</p>
          <button
            className={`btn ${styles.bigButton}`}
            onClick={() => {
              if (sheet.lineId === "*") queue.clear();
              else queue.discard(sheet.lineId);
              setSheet(null);
            }}
          >
            {sheet.lineId === "*" ? "Clear" : "Discard"}
          </button>
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
