import { requireManagerPage } from "@/auth/session";
import { cols } from "@/domain/collections";
import { getDb } from "@/lib/db";
import { Wordmark } from "@/components/Wordmark";
import { awaitingReviewCount } from "@/domain/ledger/read";
import { NavLinks } from "./NavLinks";
import styles from "./shell.module.css";

async function resetStatus(): Promise<string> {
  try {
    const ops = await cols(await getDb()).ops.findOne({ _id: "status" });
    if (!ops?.lastResetAt) return "";
    const t = ops.lastResetAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    return ops.lastResetOk ? ` · Data reset ${t} UTC ✓` : ` · Last reset ${t} UTC failed`;
  } catch {
    return "";
  }
}

export default async function ManagerLayout({ children }: { children: React.ReactNode }) {
  await requireManagerPage();
  return (
    <div className={styles.shell}>
      <nav className={styles.rail} aria-label="Main">
        <div className={styles.brand}>
          <Wordmark />
        </div>
        <NavLinks awaiting={await awaitingReviewCount(await getDb()).catch(() => 0)} />
        <form action="/logout" method="post" className={styles.signout}>
          <span className={styles.who}>Manager (demo)</span>
          <button className="btn" type="submit">Sign out</button>
        </form>
      </nav>
      <div className={styles.main}>
        <div className={styles.demobar} role="note">Demo data resets nightly 03:00 UTC{await resetStatus()}</div>
        <main className={styles.content}>{children}</main>
      </div>
    </div>
  );
}
