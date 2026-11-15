import { connection } from "next/server";
import { cols } from "@/domain/collections";
import { getDb } from "@/lib/db";
import { Wordmark } from "@/components/Wordmark";
import type { Metadata } from "next";
import { LoginChoice } from "./LoginChoice";
import styles from "./login.module.css";

export const metadata: Metadata = { title: "Choose a role · BabyBargains Stock" };

async function branches(): Promise<{ id: string; name: string }[] | null> {
  try {
    const rows = await cols(await getDb()).branches.find({}, { projection: { name: 1 } }).sort({ name: 1 }).toArray();
    return rows.map((b) => ({ id: b._id, name: b.name }));
  } catch (err) {
    console.error(JSON.stringify({ level: "error", at: new Date().toISOString(), command: "loginBranches", errorClass: err instanceof Error ? err.name : "unknown" }));
    return null;
  }
}

export default async function LoginPage() {
  await connection(); // render per request: the branch list must come from the live database, not the build
  const list = await branches();
  const points = (
    <ol className={styles.points}>
      <li>Trace a recalled batch to each shelf and pull it everywhere at once.</li>
      <li>Count stock on a phone, even where the signal drops.</li>
      <li>Move stock between 15 branches before anyone runs out.</li>
    </ol>
  );
  return (
    <main className={styles.page}>
      <section className={styles.hero} aria-label="About this demo">
        <div className={styles.label}>
          <div className={styles.labelHead}>
            <span>Batch recall demo</span>
            <span className="mono">B-4471</span>
          </div>
          <h1 className={styles.claim}>Every unit, every branch, one ledger.</h1>
          <div className={styles.pointsWide}>{points}</div>
          <details className={styles.pointsNarrow}>
            <summary>How it works</summary>
            {points}
          </details>
        </div>
        <p className={styles.footnote}>
          Fictional chain, synthetic data, resets nightly.{" "}
          <a href="https://github.com/Zubair-Elliot-17/babybargains-stock">Source on GitHub</a>
        </p>
      </section>
      <div className={styles.panel}>
        <Wordmark />
        <p className={styles.lede}>Stock control for a fictional UK chain of baby-goods shops.</p>
        <p className={styles.session}><span className="mono">Demo</span> No password. Pick a role to look around.</p>
        <h2>Choose a demo role</h2>
        {list === null && (
          <p className="banner banner-error" role="alert">Couldn&apos;t load branches. Clerk sign-in is unavailable; reload to retry.</p>
        )}
        <LoginChoice branches={list ?? []} />
      </div>
    </main>
  );
}
