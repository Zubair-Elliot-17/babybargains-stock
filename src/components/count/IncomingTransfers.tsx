"use client";

import { useRef, useState } from "react";
import type { InTransitRow } from "@/domain/ledger/read";
import { count } from "@/lib/plural";
import { postCommand } from "@/lib/postCommand";
import styles from "./count.module.css";

const time = (d: Date) => new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

// Stock another branch has dispatched here: the clerk confirms it once it is on the shelf.
export function IncomingTransfers({ rows }: { rows: InTransitRow[] }) {
  if (!rows.length) return null;
  return (
    <section aria-labelledby="incoming" className={styles.incoming}>
      <h2 id="incoming">Incoming stock</h2>
      <ul>
        {rows.map((r) => <Incoming key={r._id} row={r} />)}
      </ul>
    </section>
  );
}

function Incoming({ row }: { row: InTransitRow }) {
  const id = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [locked, setLocked] = useState(false);
  const [done, setDone] = useState(false);

  async function receive() {
    setBusy(true);
    const r = await postCommand<{ units: number; recalledUnits: number }>(`/api/transfers/${row._id}/receive`, {}, id);
    setBusy(false);
    setLocked("error" in r && !!r.unknown);
    if ("error" in r) return setMessage({ text: r.error, error: true });
    setMessage({
      text: r.result.recalledUnits
        ? `${count(r.result.units, "unit")} received. ${count(r.result.recalledUnits, "unit")} recalled on the way: don't shelve those.`
        : `${count(r.result.units, "unit")} received.`,
      error: false,
    });
    setDone(true); // stays listed with its confirmation; gone on the next visit
  }

  return (
    <li>
      <span>
        <strong>{row.productName}</strong> × {row.units}
        <span className={styles.hint}> from {row.fromName}, sent {time(row.dispatchedAt)} UTC</span>
      </span>
      {!done && <button className="btn" type="button" disabled={busy} onClick={() => void receive()} aria-label={`Received ${row.units} ${row.productName} from ${row.fromName}`}>
        {busy ? "Saving…" : locked ? "Send again" : "Received"}
      </button>}
      {message && <p className={message.error ? "banner banner-error" : "banner"} role={message.error ? "alert" : "status"}>{message.text}</p>}
    </li>
  );
}
