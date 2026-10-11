"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { TransferRow } from "@/domain/ledger/read";
import { money } from "@/lib/format";
import { count } from "@/lib/plural";
import styles from "./transfers.module.css";

const rowKey = (r: TransferRow) => `${r.sku}|${r.fromBranchId}|${r.toBranchId}`;

// Weeks of cover is derived from 8 weeks of sales, so it is shown as an estimate (DESIGN.md).
function Cover({ weeks }: { weeks: number | null }) {
  const text = weeks === null ? "no sales in 8 wks" : `${weeks < 10 ? weeks.toFixed(1) : Math.round(weeks)} wks cover`;
  return (
    <span className="estimated" title="Estimated from sales over the last 8 weeks">
      {text}
      <span className="sr-only"> (estimated)</span>
    </span>
  );
}

export function TransfersScreen({ rows, emptyText }: { rows: TransferRow[]; emptyText: string }) {
  const router = useRouter();
  const [selected, setSelected] = useState<TransferRow | null>(null);
  const [commandId, setCommandId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const table = useRef<HTMLTableElement>(null);
  const empty = useRef<HTMLParagraphElement>(null);
  const refocus = useRef(false); // after an Accept, once the refreshed rows arrive
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (selected) heading.current?.focus();
  }, [selected]);

  // The accepted row usually disappears on refresh, taking its Review button (and focus) with it.
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const target = opener.current?.isConnected ? opener.current : (table.current?.querySelector<HTMLButtonElement>("tbody button") ?? empty.current);
    target?.focus();
  }, [rows]);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  function open(row: TransferRow, button: HTMLButtonElement) {
    opener.current = button;
    refocus.current = false; // a refresh that never landed shouldn't move focus later
    setSelected(row);
    setCommandId(crypto.randomUUID()); // one id per opened suggestion, so a retried Accept is idempotent
    setError(null);
  }

  function notify(message: string) {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }

  function close() {
    setSelected(null);
    setError(null);
    opener.current?.focus();
  }

  async function accept(row: TransferRow) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/transfers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, sku: row.sku, fromBranchId: row.fromBranchId, toBranchId: row.toBranchId, qty: row.qty }),
      });
      const body = await res.json().catch(() => null);
      const message = body?.error?.message ?? "Couldn't move the stock. Retry";
      if (!res.ok && res.status !== 409) return setError(message);
      // Moved, or stock changed since this list loaded (409): either way, reload the suggestions.
      setSelected(null);
      notify(res.ok ? `Moved ${count(row.qty, "unit")} of ${row.productName} from ${row.fromName} to ${row.toName}.` : message);
      refocus.current = true;
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Retry");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={selected ? styles.withPanel : undefined}>
      {rows.length === 0 ? (
        <p className={styles.empty} ref={empty} tabIndex={-1}>{emptyText}</p>
      ) : (
        <>
          <p className={styles.narrow}>Transfers needs a wider screen. Open it on a tablet or desktop.</p>
          <table className={styles.table} ref={table}>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col" className="num">Units</th>
                <th scope="col" className="num">Value</th>
                <th scope="col"><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={rowKey(r)} data-selected={selected && rowKey(selected) === rowKey(r) ? "" : undefined}>
                  <th scope="row">
                    {r.productName}
                    <span className={`${styles.sub} mono`}>{r.sku}</span>
                  </th>
                  <td>
                    {r.fromName}
                    <span className={styles.sub}>{r.from.onHand} on hand · <Cover weeks={r.from.coverWeeks} /></span>
                  </td>
                  <td>
                    {r.toName}
                    <span className={styles.sub}>{r.to.onHand} on hand · reorder at {r.to.reorderPoint}</span>
                  </td>
                  <td className="num">{r.qty}</td>
                  <td className="num">{money(r.valuePence)}</td>
                  <td>
                    <button className="btn" type="button" disabled={busy} onClick={(e) => open(r, e.currentTarget)} aria-label={`Review transfer of ${r.productName} from ${r.fromName} to ${r.toName}`}>
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {selected && (
        <aside className={styles.panel} aria-labelledby="transfer-heading" onKeyDown={(e) => e.key === "Escape" && !busy && close()}>
          <h2 id="transfer-heading" ref={heading} tabIndex={-1}>
            Move {count(selected.qty, "unit")} · {selected.productName}
          </h2>
          <p className={`${styles.sub} mono`}>{selected.sku}</p>
          <dl className={styles.facts}>
            <div>
              <dt>From {selected.fromName}</dt>
              <dd>{selected.from.onHand} → {selected.from.onHand - selected.qty} on hand</dd>
              <dd className={styles.sub}><Cover weeks={selected.from.coverWeeks} /> · keeps at least {selected.from.keep}</dd>
            </div>
            <div>
              <dt>To {selected.toName}</dt>
              <dd>{selected.to.onHand} → {selected.to.onHand + selected.qty} on hand</dd>
              <dd className={styles.sub}>Reorder point {selected.to.reorderPoint} · <Cover weeks={selected.to.coverWeeks} /></dd>
            </div>
            <div>
              <dt>Saves reordering</dt>
              <dd>{count(selected.unitsSaved, "unit")} · {money(selected.valuePence)} at retail</dd>
            </div>
          </dl>
          <h3 className={styles.small}>Batches that move (oldest first)</h3>
          <ul className={styles.batches}>
            {selected.preview.map((p) => (
              <li key={p.batchCode}>
                <span className="mono">{p.batchCode}</span> × {p.qty}
              </li>
            ))}
          </ul>
          {error && <p className="banner banner-error" role="alert">{error}</p>}
          <div className={styles.actions}>
            <button className="btn" type="button" disabled={busy} onClick={close}>Close</button>
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => accept(selected)}>
              {busy ? "Moving…" : "Accept transfer"}
            </button>
          </div>
        </aside>
      )}

      <p className={styles.toast} role="status">{toast}</p>
    </div>
  );
}
