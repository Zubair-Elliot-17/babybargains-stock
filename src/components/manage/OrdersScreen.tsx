"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { OrderRow, OrderSuggestion } from "@/domain/ledger/orders";

import { postCommand } from "@/lib/postCommand";
import styles from "./manage.module.css";

type Line = { sku: string; name: string; qty: number; include: boolean; note?: string };

// New order for one branch and supplier: prefilled with products below reorder point; any of the
// supplier's products can be added.
export function NewOrder(props: { branchId: string; supplierId: string; suggestions: OrderSuggestion[]; catalogue: { sku: string; name: string }[] }) {
  const router = useRouter();
  const id = useRef(crypto.randomUUID());
  const [lines, setLines] = useState<Line[]>(() =>
    props.suggestions.map((s) => ({ sku: s.sku, name: s.name, qty: s.qty, include: true, note: `${s.onHand} on hand, reorder at ${s.reorderPoint}` })),
  );
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false); // outcome unknown: only an identical resend is allowed
  const [error, setError] = useState<string | null>(null);
  const extra = props.catalogue.filter((p) => !lines.some((l) => l.sku === p.sku));
  const chosen = lines.filter((l) => l.include && l.qty > 0);
  const set = (sku: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.sku === sku ? { ...l, ...patch } : l)));

  async function create() {
    setBusy(true);
    setError(null);
    const r = await postCommand<{ _id: string }>("/api/orders", { branchId: props.branchId, supplierId: props.supplierId, lines: chosen.map((l) => ({ sku: l.sku, qty: l.qty })) }, id);
    setBusy(false);
    setLocked("error" in r && !!r.unknown);
    if ("error" in r) return setError(r.error);
    router.push(`/orders?created=${encodeURIComponent(r.result._id)}`);
    router.refresh();
  }

  return (
    <section aria-label="New order lines">
      {lines.length === 0 && <p className={styles.meta}>Nothing from this supplier is below its reorder point here. Add products below.</p>}
      {lines.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Product</th>
              <th scope="col" className="num">Quantity</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.sku}>
                <td><input type="checkbox" disabled={locked} aria-label={`Order ${l.name}`} checked={l.include} onChange={(e) => set(l.sku, { include: e.target.checked })} /></td>
                <th scope="row">{l.name}{l.note && <span className={styles.meta}> · {l.note}</span>}</th>
                <td className="num">
                  <input className={`input ${styles.lineInput}`} inputMode="numeric" disabled={locked} aria-label={`Quantity of ${l.name}`} value={l.qty}
                    onChange={(e) => set(l.sku, { qty: Math.min(9999, Number(e.target.value.replace(/\D/g, "")) || 0) })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className={styles.filters}>
        {extra.length > 0 && !locked && (
          <label>
            Add a product
            <select value="" onChange={(e) => {
              const p = extra.find((x) => x.sku === e.target.value);
              if (p) setLines((ls) => [...ls, { sku: p.sku, name: p.name, qty: 1, include: true }]);
            }}>
              <option value="">Choose…</option>
              {extra.map((p) => <option key={p.sku} value={p.sku}>{p.name}</option>)}
            </select>
          </label>
        )}
        <button className="btn btn-primary" onClick={create} disabled={busy || chosen.length === 0}>
          {busy ? "Sending…" : `${locked ? "Send again" : "Send order"} · ${chosen.reduce((n, l) => n + l.qty, 0)} units`}
        </button>
      </div>
      {error && <p className="banner banner-error" role="alert">{error}</p>}
    </section>
  );
}

// Receive a delivery against an order, or cancel it while nothing has arrived.
export function OrderActions({ order }: { order: OrderRow }) {
  const router = useRouter();
  const id = useRef(crypto.randomUUID());
  const [open, setOpen] = useState(false);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const outstanding = order.lines.filter((l) => l.received < l.ordered);
  const [lines, setLines] = useState(() =>
    outstanding.map((l) => ({ sku: l.sku, qty: l.ordered - l.received, batchCode: order.batchTracked.includes(l.sku) ? "" : `D-${today}` })),
  );

  async function send(path: "receive" | "cancel", body: object) {
    setBusy(true);
    setError(null);
    const r = await postCommand(`/api/orders/${order._id}/${path}`, body, id);
    setBusy(false);
    setLocked("error" in r && !!r.unknown);
    if ("error" in r) return setError(r.error);
    setOpen(false);
    router.refresh();
  }

  if (order.status === "RECEIVED" || order.status === "CANCELLED") return null;
  return (
    <div>
      {!open ? (
        <div className={styles.filters} style={{ margin: 0 }}>
          <button className="btn" onClick={() => setOpen(true)}>Receive delivery</button>
          {order.status === "SENT" && (
            <button className="btn" disabled={busy} onClick={() => (locked || confirm(`Cancel order ${order._id}?`) ) && send("cancel", {})}>{locked ? "Send cancel again" : "Cancel order"}</button>
          )}
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void send("receive", { lines }); }} aria-label={`Receive ${order._id}`}>
          <table>
            <thead>
              <tr><th scope="col">Product</th><th scope="col" className="num">Arrived</th><th scope="col">Batch code on label</th></tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const name = order.names[l.sku] ?? l.sku;
                const patch = (p: Partial<typeof l>) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, ...p } : x)));
                return (
                  <tr key={l.sku}>
                    <th scope="row">{name}</th>
                    <td className="num">
                      <input className={`input ${styles.lineInput}`} inputMode="numeric" disabled={locked} aria-label={`Units of ${name} arrived`} value={l.qty}
                        onChange={(e) => patch({ qty: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
                    </td>
                    <td><input className="input mono" disabled={locked} aria-label={`Batch code for ${name}`} value={l.batchCode} maxLength={40} onChange={(e) => patch({ batchCode: e.target.value })} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className={styles.filters}>
            <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Saving…" : locked ? "Send again" : "Record delivery"}</button>
            {!locked && <button className="btn" type="button" onClick={() => setOpen(false)}>Close</button>}
          </div>
        </form>
      )}
      {error && <p className="banner banner-error" role="alert">{error}</p>}
    </div>
  );
}

