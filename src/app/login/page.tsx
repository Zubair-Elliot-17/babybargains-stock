import { connection } from "next/server";
import { cols } from "@/domain/collections";
import { getDb } from "@/lib/db";
import { Wordmark } from "@/components/Wordmark";
import { LoginChoice } from "./LoginChoice";
import styles from "./login.module.css";

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
  return (
    <main className={styles.page}>
      <section className={styles.hero} aria-label="About this demo">
        <div className={styles.label}>
          <div className={styles.labelHead}>
            <span>Batch</span>
            <span className="mono">B-4471</span>
          </div>
          <p className={styles.claim}>Every unit, every branch, one ledger.</p>
          <ol className={styles.points}>
            <li>Trace a recalled batch to each shelf and pull it everywhere at once.</li>
            <li>Count stock on a phone, even where the signal drops.</li>
            <li>Move stock between 15 branches before anyone runs out.</li>
          </ol>
          <div className={styles.labelFoot}>
            <Barcode code="B4471BBSTOCK" />
            <span className="mono">15 BRANCHES · UK</span>
          </div>
        </div>
        <p className={styles.footnote}>
          Fictional chain, synthetic data, resets nightly.{" "}
          <a href="https://github.com/Zubair-Elliot-17/babybargains-stock">Source on GitHub</a>
        </p>
      </section>
      <div className={styles.panel}>
        <Wordmark />
        <h1>Choose a demo role</h1>
        <p className={styles.lede}>Stock control for a fictional UK chain of baby-goods shops.</p>
        {list === null && (
          <p className="banner banner-error" role="alert">Couldn&apos;t load branches. Clerk sign-in is unavailable; reload to retry.</p>
        )}
        <LoginChoice branches={list ?? []} />
      </div>
    </main>
  );
}

// Decorative barcode: bar widths come from the code's characters, so it looks printed, not random.
function Barcode({ code }: { code: string }) {
  let x = 0;
  const bars = [...code].flatMap((ch) => {
    const n = ch.charCodeAt(0);
    return [1 + (n % 3), 1 + ((n >> 2) % 2), 1 + ((n >> 1) % 3), 1 + (n % 2)];
  }).map((w, i) => {
    const bar = i % 2 === 0 ? <rect key={i} x={x} width={w} height="40" /> : null;
    x += w;
    return bar;
  });
  return <svg className={styles.barcode} viewBox={`0 0 ${x} 40`} preserveAspectRatio="none" aria-hidden focusable="false">{bars}</svg>;
}
