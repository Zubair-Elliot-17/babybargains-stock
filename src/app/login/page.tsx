import { cols } from "@/domain/collections";
import { getDb } from "@/lib/db";
import { Wordmark } from "@/components/Wordmark";
import { LoginChoice } from "./LoginChoice";
import styles from "./login.module.css";

async function branches() {
  try {
    return await cols(await getDb()).branches.find({}, { projection: { name: 1 } }).sort({ name: 1 }).toArray();
  } catch {
    return [];
  }
}

export default async function LoginPage() {
  const list = (await branches()).map((b) => ({ id: b._id, name: b.name }));
  return (
    <main className={styles.page}>
      <div className={styles.panel}>
        <Wordmark />
        <h1>Choose a demo role</h1>
        <p className={styles.lede}>Stock control for a fictional UK chain of baby-goods shops.</p>
        <LoginChoice branches={list} />
        <p className={styles.footnote}>
          Fictional chain, synthetic data, resets nightly.{" "}
          <a href="https://github.com/Zubair-Elliot-17/babybargains-stock">Source on GitHub</a>
        </p>
      </div>
    </main>
  );
}
