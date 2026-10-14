"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./shell.module.css";

const RELEASED = 4; // highest milestone shipped; later items show as "coming"

const ITEMS = [
  { href: "/recall", label: "Recall", short: "Rec", milestone: 1 },
  { href: "/stock", label: "Stock", short: "Stk", milestone: 4 },
  { href: "/stocktakes", label: "Stocktakes", short: "Cnt", milestone: 1 },
  { href: "/transfers", label: "Transfers", short: "Trf", milestone: 3 },
  { href: "/orders", label: "Orders", short: "Ord", milestone: 4 },
  { href: "/analytics", label: "Analytics", short: "Ana", milestone: 4 },
];

export function NavLinks({ awaiting = 0 }: { awaiting?: number }) {
  const path = usePathname();
  return (
    <ul className={styles.nav}>
      {ITEMS.map((item) =>
        item.milestone <= RELEASED ? (
          <li key={item.href}>
            <Link href={item.href} className={styles.link} aria-current={path === item.href || path.startsWith(`${item.href}/`) ? "page" : undefined} title={item.label}>
              <span className={styles.full}>
                {item.label}
                {item.href === "/stocktakes" && awaiting > 0 && <span className={styles.badge} aria-label={`${awaiting} awaiting review`}>{awaiting}</span>}
              </span>
              <span className={styles.short} aria-hidden>{item.short}</span>
            </Link>
          </li>
        ) : (
          <li key={item.href}>
            <span className={`${styles.link} ${styles.soon}`} title={`${item.label} arrives in Milestone ${item.milestone}`}>
              <span className={styles.full}>{item.label} <small>M{item.milestone}</small></span>
              <span className={styles.short} aria-hidden>{item.short}</span>
            </span>
          </li>
        ),
      )}
    </ul>
  );
}
