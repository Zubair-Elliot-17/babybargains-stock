"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./count.module.css";

export function ClerkNav() {
  const path = usePathname();
  return (
    <nav className={styles.bottomBar} aria-label="Clerk">
      <Link className={styles.tab} aria-current={path.startsWith("/count") ? "page" : undefined} href="/count">Count</Link>
      <Link className={styles.tab} aria-current={path.startsWith("/sale") ? "page" : undefined} href="/sale">Record sale</Link>
    </nav>
  );
}
