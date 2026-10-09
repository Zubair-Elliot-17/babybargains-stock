"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./login.module.css";

export function LoginChoice() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "manager" }) });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      setError(body?.error?.message ?? "Couldn't sign in. Retry");
      setBusy(false);
      return;
    }
    router.push(body.next);
  }

  return (
    <div className={styles.choices}>
      <button className={styles.choice} onClick={signIn} disabled={busy}>
        <span className={styles.role}>Manager</span>
        <span className={styles.task}>Track a recall across 15 branches</span>
        <span className={styles.hint}>Opens batch <span className="mono">B-4471</span></span>
      </button>
      <div className={`${styles.choice} ${styles.disabled}`} aria-disabled="true">
        <span className={styles.role}>Clerk</span>
        <span className={styles.task}>Count stock on a phone</span>
        <span className={styles.hint}>Arrives with stocktake in Milestone 2</span>
      </div>
      {error && <p role="alert" className="banner banner-error">{error}</p>}
    </div>
  );
}
