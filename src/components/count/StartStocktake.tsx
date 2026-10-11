"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./count.module.css";

export function StartStocktake({ resumeId }: { resumeId: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/stocktakes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId: crypto.randomUUID() }) });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const d = body?.error?.details;
        setError(
          body?.error?.code === "STOCKTAKE_BUSY" && d
            ? `${d.clerkLabel} is counting this branch (last activity ${new Date(d.lastActivityAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}). Sign out and pick another branch, or try again after 2 hours idle.`
            : (body?.error?.message ?? "Couldn't start. Retry"),
        );
        return;
      }
      router.push(`/count/${body.result._id}`);
    } catch {
      setError("Couldn't reach the server. Retry");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.startBox}>
      {resumeId ? (
        <Link className={`btn btn-primary ${styles.bigButton}`} href={`/count/${resumeId}`}>Resume stocktake</Link>
      ) : (
        <button className={`btn btn-primary ${styles.bigButton}`} onClick={start} disabled={busy}>{busy ? "Starting…" : "Start stocktake"}</button>
      )}
      {error && <p className="banner banner-error" role="alert">{error}</p>}
    </div>
  );
}
