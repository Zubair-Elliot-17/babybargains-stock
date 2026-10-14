"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { FLAG_PENCE, FLAG_UNITS, LATE_MS } from "@/domain/ledger/stocktake";
import { money, when } from "@/lib/format";
import { count } from "@/lib/plural";
import styles from "./stocktakes.module.css";

export interface ReviewLine {
  key: string;
  sku: string;
  productName: string;
  batchCode?: string;
  counted: number;
  expected: number;
  variance: number;
  valuePence: number;
  flagged: boolean;
  clampedBy: number;
  quarantined: number;
  countedAt: string;
  lateMs?: number; // longest gap between count and arrival (counted offline)
}

interface Approved {
  adjustedLines: number;
  unitsAdded: number;
  unitsRemoved: number;
  unitsQuarantined?: number;
  valuePence: number;
}

// Exceptions first (design D6): flagged lines need an explicit Accept; small differences approve together.
export function ReviewScreen(props: {
  stocktakeId: string;
  branchName: string;
  status: "OPEN" | "SUBMITTED" | "APPROVED";
  clerkLabel: string;
  submittedAt: string | null;
  approvedAt: string | null;
  lines: ReviewLine[];
}) {
  const router = useRouter();
  const commandId = useRef(crypto.randomUUID());
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Approved | null>(null);

  const flagged = props.lines.filter((l) => l.flagged);
  const small = props.lines.filter((l) => !l.flagged && l.variance !== 0);
  const matched = props.lines.filter((l) => l.variance === 0 && !l.flagged).length;
  const allAccepted = flagged.every((l) => accepted.has(l.key));
  const reviewable = props.status === "SUBMITTED" && !result;
  // Quarantined units never reach on-hand stock, so they don't move the net.
  const net = useMemo(() => props.lines.reduce((n, l) => n + l.variance - l.quarantined, 0), [props.lines]);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/stocktakes/${props.stocktakeId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: commandId.current, acceptedKeys: [...accepted] }),
      });
      const body = await res.json().catch(() => null);
      if (body?.error?.code === "COMMAND_ID_REUSED") {
        commandId.current = crypto.randomUUID(); // a fresh id gets a real answer (approved, or the current state)
        return setError("That request was already sent. Approve again to retry.");
      }
      if (!res.ok) return setError(body?.error?.message ?? "Couldn't approve. Retry");
      setResult(body.result);
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Retry");
    } finally {
      setBusy(false);
    }
  }

  const toggle = (key: string) =>
    setAccepted((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const heading =
    props.status === "APPROVED" || result
      ? `Stocktake · ${props.branchName} · approved`
      : `Review stocktake · ${props.branchName} · ${flagged.length ? `${count(flagged.length, "line")} ${flagged.length === 1 ? "needs" : "need"} attention` : "nothing flagged"}`;

  return (
    <div className={styles.review}>
      <p><Link href="/stocktakes">← Stocktakes</Link></p>
      <h1>{heading}</h1>
      <p className={styles.meta}>
        Counted by {props.clerkLabel}
        {props.submittedAt && ` · submitted ${when(props.submittedAt)} UTC`}
        {props.approvedAt && ` · approved ${when(props.approvedAt)} UTC`}
        {" · "}Flagged when off by {FLAG_UNITS}+ units or {money(FLAG_PENCE)}+
      </p>

      <dl className={styles.summary}>
        <div><dt>Lines</dt><dd>{props.lines.length}</dd></div>
        <div><dt>Match</dt><dd>{matched}</dd></div>
        <div><dt>Flagged</dt><dd className={flagged.length ? styles.warn : undefined}>{flagged.length}</dd></div>
        <div><dt>Net units</dt><dd>{net > 0 ? `+${net}` : net}</dd></div>
      </dl>

      {result && <ApprovedBanner result={result} />}

      {flagged.length > 0 && (
        <section aria-label="Flagged lines">
          <h2>Needs attention</h2>
          <LineTable lines={flagged} accept={reviewable ? { accepted, toggle } : undefined} />
        </section>
      )}

      {small.length > 0 && (
        <section aria-label="Small differences">
          <h2>Within threshold · {small.length}</h2>
          <LineTable lines={small} />
        </section>
      )}

      {matched > 0 && <p className={styles.meta}>{count(matched, "line")} {matched === 1 ? "matches" : "match"} the system exactly.</p>}
      {props.lines.length === 0 && <p className={styles.empty}>No lines were counted.</p>}

      {reviewable && (
        <div className={styles.approveBar}>
          {error && <p className="banner banner-error" role="alert">{error}</p>}
          <span className={styles.meta}>
            {allAccepted ? `Posts adjustments for ${count(flagged.length + small.length, "line")}.` : `Accept ${count(flagged.length - accepted.size, "flagged line")} to approve.`}
          </span>
          <button className="btn btn-primary" disabled={!allAccepted || busy} onClick={approve}>
            {busy ? "Approving…" : "Approve stocktake"}
          </button>
        </div>
      )}
    </div>
  );
}

export function ApprovedBanner({ result }: { result: Approved }) {
  return (
    <p className="banner" role="status">
      Approved: {count(result.adjustedLines, "line")} adjusted, {count(result.unitsRemoved, "unit")} removed, {result.unitsAdded} added{result.unitsQuarantined ? `, ${result.unitsQuarantined} quarantined` : ""} ({money(result.valuePence)} at retail).
    </p>
  );
}

function LineTable({ lines, accept }: { lines: ReviewLine[]; accept?: { accepted: Set<string>; toggle: (k: string) => void } }) {
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Product</th>
          <th scope="col">Batch</th>
          <th scope="col" className="num">Expected</th>
          <th scope="col" className="num">Counted</th>
          <th scope="col" className="num">Variance</th>
          <th scope="col" className="num">Value</th>
          {accept && <th scope="col">Accept</th>}
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.key}>
            <th scope="row">
              {l.productName}
              <span className={styles.sub}>counted {when(l.countedAt)} UTC{l.clampedBy ? ` · ${l.clampedBy} sold since; adjustment capped` : ""}
                {l.quarantined ? <> · <span className={styles.warn}>{`Recalled batch: ${count(l.quarantined, "found unit")} quarantined (${money(l.valuePence)} if sellable)`}</span></> : null}
                {(l.lateMs ?? 0) > LATE_MS ? <> · <span className={styles.warn}>{`Counted offline, arrived ${duration(l.lateMs!)} later`}</span></> : null}</span>
            </th>
            <td className={`mono ${styles.code}`}>{l.batchCode ?? "–"}</td>
            <td className="num"><span className="estimated" title="System stock at the moment this line was counted">{l.expected}</span></td>
            <td className="num">{l.counted}</td>
            {/* Quarantined units never become sellable: neutral variance, no retail value (matches the approval total). */}
            <td className={`num ${l.quarantined ? "" : l.variance < 0 ? styles.neg : styles.pos}`}>{l.variance > 0 ? `+${l.variance}` : l.variance}</td>
            <td className="num">{money(l.quarantined ? 0 : l.valuePence)}</td>
            {accept && (
              <td>
                <label className={styles.accept}>
                  <input type="checkbox" checked={accept.accepted.has(l.key)} onChange={() => accept.toggle(l.key)} />
                  <span className="sr-only">Accept {l.productName}</span>
                </label>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function duration(ms: number) {
  const mins = Math.round(ms / 60_000);
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
}
