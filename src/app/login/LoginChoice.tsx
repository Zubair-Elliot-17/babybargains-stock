"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import styles from "./login.module.css";

const DEFAULT_BRANCH = "BR-LEE";

export function LoginChoice({ branches }: { branches: { id: string; name: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"manager" | "clerk" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clerkOpen, setClerkOpen] = useState(false);
  const [branchId, setBranchId] = useState(branches.some((b) => b.id === DEFAULT_BRANCH) ? DEFAULT_BRANCH : (branches[0]?.id ?? ""));
  const select = useRef<HTMLSelectElement>(null);
  const branchName = branches.find((b) => b.id === branchId)?.name;

  async function signIn(role: "manager" | "clerk") {
    setBusy(role);
    setError(null);
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(role === "clerk" ? { role, branchId } : { role }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      setError(body?.error?.message ?? "Couldn't sign in. Retry");
      setBusy(null);
      return;
    }
    router.push(body.next);
  }

  return (
    <div className={styles.choices}>
      <div className={styles.choice}>
        <h3 className={styles.role}>
          <button className={styles.roleBtn} onClick={() => signIn("manager")} disabled={busy !== null}>
            Manager
            <span className={styles.arrow} aria-hidden>→</span>
          </button>
        </h3>
        <span className={styles.task}>Track a recall across 15 branches</span>
        <span className={styles.hint}>Opens batch <span className="mono">B-4471</span></span>
      </div>
      <div className={`${styles.choice} ${clerkOpen ? styles.open : ""}`}>
        <h3 className={styles.role}>
          <button
            className={styles.roleBtn}
            aria-expanded={clerkOpen}
            aria-controls="clerk-form"
            onClick={() => {
              const next = !clerkOpen;
              setClerkOpen(next);
              if (next) setTimeout(() => select.current?.focus(), 0);
            }}
          >
            Clerk
            <span className={`${styles.arrow} ${clerkOpen ? styles.arrowOpen : ""}`} aria-hidden>→</span>
          </button>
        </h3>
        <span className={styles.task}>Count stock on a phone</span>
        <div id="clerk-form" className={styles.clerkForm} hidden={!clerkOpen}>
          <label htmlFor="branch">Branch</label>
          <select ref={select} id="branch" className={`input ${styles.select}`} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={() => signIn("clerk")} disabled={busy !== null || !branchId}>
            Start counting{branchName ? ` at ${branchName}` : ""}
            <span aria-hidden>→</span>
          </button>
        </div>
        <span className={styles.hint}>Opens in a phone-sized frame on desktop</span>
      </div>
      {error && <p role="alert" className="banner banner-error">{error}</p>}
    </div>
  );
}
