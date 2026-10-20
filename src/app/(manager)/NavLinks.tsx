"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./shell.module.css";

const RELEASED = 4; // highest milestone shipped; later items show as "coming"

export interface NavItem {
  href: string;
  label: string;
  milestone: number;
}

export function NavLinks({ items, awaiting = 0 }: { items: NavItem[]; awaiting?: number }) {
  const path = usePathname();
  return (
    <ul className={styles.nav}>
      {items.map((item) =>
        item.milestone <= RELEASED ? (
          <li key={item.href}>
            <Link href={item.href} className={styles.link} aria-current={path === item.href || path.startsWith(`${item.href}/`) ? "page" : undefined}>
              {item.label}
              {item.href === "/stocktakes" && awaiting > 0 && <span className={styles.badge} aria-label={`${awaiting} awaiting review`}>{awaiting}</span>}
            </Link>
          </li>
        ) : (
          <li key={item.href}>
            <span className={`${styles.link} ${styles.soon}`} title={`${item.label} arrives in Milestone ${item.milestone}`}>
              {item.label} <small>M{item.milestone}</small>
            </span>
          </li>
        ),
      )}
    </ul>
  );
}
