import { requireManagerPage } from "@/auth/session";
import { cols } from "@/domain/collections";
import { getDb } from "@/lib/db";
import { Wordmark } from "@/components/Wordmark";
import { awaitingReviewCount } from "@/domain/ledger/read";
import { NavLinks, type NavItem } from "./NavLinks";
import styles from "./shell.module.css";

const ITEMS: NavItem[] = [
  { href: "/recall", label: "Recall", milestone: 1 },
  { href: "/stock", label: "Stock", milestone: 4 },
  { href: "/stocktakes", label: "Stocktakes", milestone: 1 },
  { href: "/transfers", label: "Transfers", milestone: 3 },
  { href: "/orders", label: "Orders", milestone: 4 },
  { href: "/analytics", label: "Analytics", milestone: 4 },
];

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
  const db = await getDb();
  const [awaiting, reset] = await Promise.all([awaitingReviewCount(db).catch(() => 0), resetStatus()]);
  return (
    <div className={styles.shell}>
      <div className={styles.demobar} role="note">Demo data resets nightly 03:00 UTC{reset}</div>
      <nav className={styles.mast} aria-label="Main">
        <Wordmark />
        <NavLinks items={ITEMS} awaiting={awaiting} />
        <form action="/logout" method="post" className={styles.signout}>
          <span className={styles.who}>Manager (demo)</span>
          <button className="btn" type="submit">Sign out</button>
        </form>
      </nav>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
