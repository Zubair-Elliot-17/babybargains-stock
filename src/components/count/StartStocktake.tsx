"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { browserStorage, deviceId, getResumeKey, setResumeKey, sweepOld } from "./countQueue";
import styles from "./count.module.css";

// openId: the branch's OPEN stocktake held by another session. This phone may hold its resume key (re-login).
export function StartStocktake({ resumeId, openId, leadLabel }: { resumeId: string | null; openId: string | null; leadLabel: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasKey = useSyncExternalStore(noop, () => !!openId && !!getResumeKey(browserStorage(), openId), () => false);

  useEffect(() => sweepOld(browserStorage()), []);

  async function open(resume?: { stocktakeId: string; key: string }): Promise<void> {
    const res = await fetch("/api/stocktakes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: crypto.randomUUID(), resume }),
    });
    const body = await res.json().catch(() => null);
    if (res.ok) {
      if (body.result.resumeKey) setResumeKey(browserStorage(), body.result._id, body.result.resumeKey);
      return router.push(`/count/${body.result._id}`);
    }
    const d = body?.error?.details;
    const key = d?.stocktakeId && !resume ? getResumeKey(browserStorage(), d.stocktakeId) : null;
    if (key) return open({ stocktakeId: d.stocktakeId, key }); // this phone counted it before the re-login
    setError(
      body?.error?.code === "STOCKTAKE_BUSY" && d?.clerkLabel
        ? `${d.clerkLabel} is counting this branch (last activity ${new Date(d.lastActivityAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}). Sign out and pick another branch, or try again after 2 hours idle.`
        : (body?.error?.message ?? "Couldn't start. Retry"),
    );
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await open();
    } catch {
      setError("Couldn't reach the server. Retry");
    } finally {
      setBusy(false);
    }
  }

  // Team stocktakes: count alongside the clerk who opened it, from this phone.
  async function join() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/stocktakes/${openId}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: crypto.randomUUID(), deviceId: deviceId(browserStorage()) }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) return router.push(`/count/${openId}`);
      setError(body?.error?.message ?? "Couldn't join. Retry");
    } catch {
      setError("Couldn't reach the server. Retry");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.startBox}>
      {openId && !hasKey ? (
        <>
          <button className={`btn btn-primary ${styles.bigButton}`} onClick={join} disabled={busy}>
            {busy ? "Joining…" : `Join ${leadLabel}'s stocktake`}
          </button>
          <p className={styles.hint}>{leadLabel} is counting this branch. Join to count other aisles: your counts add to theirs.</p>
        </>
      ) : resumeId ? (
        <Link className={`btn btn-primary ${styles.bigButton}`} href={`/count/${resumeId}`}>Resume stocktake</Link>
      ) : (
        <button className={`btn btn-primary ${styles.bigButton}`} onClick={start} disabled={busy}>
          {busy ? "Starting…" : hasKey ? "Resume stocktake" : "Start stocktake"}
        </button>
      )}
      {error && <p className="banner banner-error" role="alert">{error}</p>}
    </div>
  );
}

const noop = () => () => {};
