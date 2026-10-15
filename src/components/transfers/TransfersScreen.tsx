"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { TransferRow } from "@/domain/ledger/read";
import { VELOCITY_WEEKS } from "@/domain/ledger/transfers";
import { money } from "@/lib/format";
import { count } from "@/lib/plural";
import styles from "./transfers.module.css";

const rowKey = (r: TransferRow) => `${r.sku}|${r.fromBranchId}|${r.toBranchId}`;

// Weeks of cover is derived from VELOCITY_WEEKS of sales, so it is shown as an estimate (DESIGN.md).
function Cover({ weeks }: { weeks: number | null }) {
  if (weeks === 0) return <span>out of stock</span>; // a fact, not an estimate
  const text = weeks === null ? `no sales in ${VELOCITY_WEEKS} wks` : `${weeks < 10 ? weeks.toFixed(1) : Math.round(weeks)} wks cover`;
  return (
    <span className="estimated" title={`Estimated from sales over the ${VELOCITY_WEEKS} weeks before today`}>
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
  const sheet = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const table = useRef<HTMLTableElement>(null);
  const empty = useRef<HTMLParagraphElement>(null);
  const refocus = useRef(false); // after an Accept, once the refreshed rows arrive
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Below 1280px the panel covers the table, so it opens modal: the page behind goes inert under a backdrop.
  const isOpen = selected !== null;
  useEffect(() => {
    const d = sheet.current;
    if (!isOpen || !d) return;
    const narrow = matchMedia("(max-width: 1279px)"); // same breakpoint as transfers.module.css
    const sync = () => {
      if (d.open) d.close();
      if (narrow.matches) d.showModal();
      else d.show();
      heading.current?.focus({ preventScroll: true });
    };
    sync();
    narrow.addEventListener("change", sync);
    return () => narrow.removeEventListener("change", sync);
  }, [isOpen]);

  // Opening the panel narrows the table, which can push the selected row off screen.
  useEffect(() => {
    if (!selected) return;
    heading.current?.focus({ preventScroll: true });
    table.current?.querySelector("tr[data-selected]")?.scrollIntoView({ block: "nearest" });
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
    sheet.current?.close(); // a modal dialog keeps the opener inert until it closes
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
      const code = body?.error?.code;
      // The body is fixed per opened suggestion, so a reused id means this Accept already ran (under an
      // earlier sign-in). Never offer to move it again; show the refreshed list instead.
      const sent = code === "COMMAND_ID_REUSED";
      if (!res.ok && !sent && code !== "SUGGESTION_STALE" && code !== "STOCKTAKE_OPEN") return setError(message);
      // Moved, already sent, or the list is out of date (stock changed or a stocktake started): reload it.
      setSelected(null);
      notify(
        res.ok
          ? `Dispatched ${count(row.qty, "unit")} of ${row.productName} from ${row.fromName} to ${row.toName}. They count at ${row.toName} once a clerk there confirms them.`
          : sent ? "This transfer was already sent. The list is up to date." : message,
      );
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
          <table className={`${styles.table} cards`} ref={table}>
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
                  <td data-label="From">
                    <div>
                      {r.fromName}
                      <span className={styles.sub}>{r.from.onHand} on hand · <Cover weeks={r.from.coverWeeks} /></span>
                    </div>
                  </td>
                  <td data-label="To">
                    <div>
                      {r.toName}
                      <span className={styles.sub}>{r.to.onHand} on hand · reorder at {r.to.reorderPoint}</span>
                    </div>
                  </td>
                  <td className="num" data-label="Units">{r.qty}</td>
                  <td className="num" data-label="Value">{money(r.valuePence)}</td>
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
        <dialog
          ref={sheet}
          className={styles.sheet}
          aria-labelledby="transfer-heading"
          onCancel={(e) => e.preventDefault()}
          onClose={() => !sheet.current?.open && close()} // the browser can still close it (repeated Escape)
        >
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
        </dialog>
      )}

      <p className={styles.toast} role="status">{toast}</p>
    </div>
  );
}
