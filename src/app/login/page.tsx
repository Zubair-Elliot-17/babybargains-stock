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
      <div className={styles.panel}>
        <Wordmark />
        <h1>Choose a demo role</h1>
        <p className={styles.lede}>Stock control for a fictional UK chain of baby-goods shops.</p>
        {list === null && (
          <p className="banner banner-error" role="alert">Couldn&apos;t load branches. Clerk sign-in is unavailable; reload to retry.</p>
        )}
        <LoginChoice branches={list ?? []} />
        <p className={styles.footnote}>
          Fictional chain, synthetic data, resets nightly.{" "}
          <a href="https://github.com/Zubair-Elliot-17/babybargains-stock">Source on GitHub</a>
        </p>
      </div>
    </main>
  );
}
