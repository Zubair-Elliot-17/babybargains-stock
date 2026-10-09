import { Wordmark } from "@/components/Wordmark";
import { LoginChoice } from "./LoginChoice";
import styles from "./login.module.css";

export default function LoginPage() {
  return (
    <main className={styles.page}>
      <div className={styles.panel}>
        <Wordmark />
        <h1>Choose a demo role</h1>
        <p className={styles.lede}>Stock control for a fictional UK chain of baby-goods shops.</p>
        <LoginChoice />
        <p className={styles.footnote}>
          Fictional chain, synthetic data, resets nightly.{" "}
          <a href="https://github.com/Zubair-Elliot-17/babybargains-stock">Source on GitHub</a>
        </p>
      </div>
    </main>
  );
}
