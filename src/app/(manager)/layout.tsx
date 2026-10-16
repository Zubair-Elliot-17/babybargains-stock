import { requireManagerPage } from "@/auth/session";
import { cols } from "@/domain/collections";
import { getDb } from "@/lib/db";
import { Wordmark } from "@/components/Wordmark";
import { awaitingReviewCount } from "@/domain/ledger/read";
import { NavLinks, type NavItem } from "./NavLinks";
import styles from "./shell.module.css";

// 24px line icons, decorative: the link text names each item.
const icon = (d: string) => (
  <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden focusable="false">
    <path d={d} />
  </svg>
);

const ITEMS: NavItem[] = [
  { href: "/recall", label: "Recall", short: "Rec", milestone: 1, icon: icon("M12 3 3 19.5h18L12 3zM12 10v4.5M12 17.2v.3") },
  { href: "/stock", label: "Stock", short: "Stk", milestone: 4, icon: icon("M3.5 8 12 3.5 20.5 8v8L12 20.5 3.5 16zM3.5 8 12 12.5 20.5 8M12 12.5v8") },
  { href: "/stocktakes", label: "Stocktakes", short: "Cnt", milestone: 1, icon: icon("M9 4h6v3H9zM9 5.5H6v15h12v-15h-3M9 13.5l2 2 4-4.5") },
  { href: "/transfers", label: "Transfers", short: "Trf", milestone: 3, icon: icon("M4 8h14l-3.5-3.5M20 16H6l3.5 3.5") },
  { href: "/orders", label: "Orders", short: "Ord", milestone: 4, icon: icon("M2.5 6h11v10h-11zM13.5 9.5h4l3 3.5v3h-7M5.5 18a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M15.5 18a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0") },
  { href: "/analytics", label: "Analytics", short: "Ana", milestone: 4, icon: icon("M4 20h16M7 16.5v-5M12 16.5V6.5M17 16.5v-8") },
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
      <nav className={styles.rail} aria-label="Main">
        <div className={styles.brand}>
          <Wordmark />
        </div>
        <NavLinks items={ITEMS} awaiting={awaiting} />
        <form action="/logout" method="post" className={styles.signout}>
          <span className={styles.who}>Manager (demo)</span>
          <button className="btn" type="submit">Sign out</button>
        </form>
      </nav>
      <div className={styles.main}>
        <div className={styles.demobar} role="note">Demo data resets nightly 03:00 UTC{reset}</div>
        <main className={styles.content}>{children}</main>
      </div>
    </div>
  );
}
