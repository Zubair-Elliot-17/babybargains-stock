"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./recall.module.css";

interface PullRow {
  branchId: string;
  sku: string;
  batchId: string;
  units: number;
}

interface Result {
  alreadyRecalled: boolean;
  recalledAt: string;
  pullList: PullRow[];
  units: number;
  branches: number;
}

// Typed-confirm quarantine (design D13). Native <dialog> traps focus and closes on Esc.
export function QuarantineDialog(props: {
  batchCode: string;
  units: number;
  branches: number;
  branchNames: Record<string, string>;
  onClose: (changed: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const commandId = useRef(crypto.randomUUID()); // one id per dialog, so a resend can't double-post
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const matches = typed.trim().toUpperCase() === props.batchCode;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/quarantine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: commandId.current, batchCode: props.batchCode, confirmCode: typed }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const retryAt = body?.error?.details?.retryAt;
        setError(
          body?.error?.code === "RATE_LIMITED" && retryAt
            ? `Demo limit: one quarantine per hour. Next quarantine available ${new Date(retryAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.`
            : (body?.error?.message ?? "Couldn't save. Retry"),
        );
        return;
      }
      setResult(body.result);
    } catch {
      setError("Couldn't reach the server. Retry");
    } finally {
      setBusy(false);
    }
  }

  const name = (id: string) => props.branchNames[id] ?? id;
  const tsv = () =>
    ["Branch\tSKU\tBatch\tUnits", ...(result?.pullList ?? []).map((r) => `${name(r.branchId)}\t${r.sku}\t${props.batchCode}\t${r.units}`)].join("\n");

  return (
    <dialog ref={ref} className={styles.dialog} onClose={() => props.onClose(Boolean(result))} aria-labelledby="q-title">
      {!result ? (
        <form onSubmit={submit}>
          <h2 id="q-title">Pull {props.units} units from {props.branches} branches?</h2>
          <p>
            Every unit of batch <span className="mono">{props.batchCode}</span> on a shelf is quarantined and can no longer be sold or transferred. This
            can&apos;t be undone.
          </p>
          <label htmlFor="confirm-code">Type {props.batchCode} to confirm</label>
          <input id="confirm-code" className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus />
          {error && <p className="banner banner-error" role="alert">{error}</p>}
          <div className={styles.dialogActions}>
            <button type="button" className="btn" onClick={() => ref.current?.close()}>Cancel</button>
            <button type="submit" className="btn btn-recall" disabled={!matches || busy}>{busy ? "Quarantining…" : "Quarantine batch"}</button>
          </div>
        </form>
      ) : (
        <div>
          <h2 id="q-title">{result.alreadyRecalled ? "Already quarantined" : `Quarantined ${result.units} units at ${result.branches} branches`}</h2>
          {result.pullList.length > 0 ? (
            <>
              <p>Pull list for store teams:</p>
              <table>
                <thead>
                  <tr><th scope="col">Branch</th><th scope="col">SKU variant</th><th scope="col">Batch</th><th scope="col" className="num">Units to pull</th></tr>
                </thead>
                <tbody>
                  {result.pullList.map((r) => (
                    <tr key={`${r.branchId}-${r.sku}`}>
                      <th scope="row">{name(r.branchId)}</th>
                      <td className="mono">{r.sku}</td>
                      <td className="mono">{props.batchCode}</td>
                      <td className="num">{r.units}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p>No units were on a shelf; the batch is now blocked from any future sale or delivery.</p>
          )}
          <div className={styles.dialogActions}>
            <button className="btn" onClick={() => window.print()}>Print</button>
            <button className="btn" onClick={() => navigator.clipboard.writeText(tsv())}>Copy</button>
            <button className="btn btn-primary" onClick={() => ref.current?.close()} autoFocus>Done</button>
          </div>
        </div>
      )}
    </dialog>
  );
}
