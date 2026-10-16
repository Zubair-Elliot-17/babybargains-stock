"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./login.module.css";

const DEFAULT_BRANCH = "BR-LEE";

// Decorative role icons; the card text names the role.
const Icon = ({ d }: { d: string }) => (
  <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden focusable="false">
    <path d={d} />
  </svg>
);
const DESK = "M3 5h18v11H3zM8 20h8M12 16v4M7 12.5l3-3 2.5 2.5L17 7.5";
const PHONE = "M7 2.5h10v19H7zM10.5 18.5h3M10 9.5l1.5 1.5 3-3";

export function LoginChoice({ branches }: { branches: { id: string; name: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"manager" | "clerk" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branchId, setBranchId] = useState(branches.some((b) => b.id === DEFAULT_BRANCH) ? DEFAULT_BRANCH : (branches[0]?.id ?? ""));

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
      <button className={styles.choice} onClick={() => signIn("manager")} disabled={busy !== null}>
        <Icon d={DESK} />
        <span className={styles.role}>Manager</span>
        <span className={styles.task}>Track a recall across 15 branches</span>
        <span className={styles.hint}>Opens batch <span className="mono">B-4471</span></span>
      </button>
      <div className={`${styles.choice} ${styles.clerk}`}>
        <Icon d={PHONE} />
        <span className={styles.role}>Clerk</span>
        <span className={styles.task}>Count stock on a phone</span>
        <label htmlFor="branch">Branch</label>
        <div className={styles.clerkRow}>
          <select id="branch" className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={() => signIn("clerk")} disabled={busy !== null || !branchId}>
            Start counting
          </button>
        </div>
        <span className={styles.hint}>Opens in a phone-sized frame on desktop</span>
      </div>
      {error && <p role="alert" className="banner banner-error">{error}</p>}
    </div>
  );
}
