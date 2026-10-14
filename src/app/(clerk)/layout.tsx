import { redirect } from "next/navigation";
import { cols } from "@/domain/collections";
import { currentSession } from "@/lib/command";
import { getDb } from "@/lib/db";
import { ClerkNav } from "@/components/count/ClerkNav";
import styles from "@/components/count/count.module.css";

export default async function ClerkLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  if (!session || session.role !== "clerk" || !session.branchId) redirect("/login");
  const branch = await cols(await getDb()).branches.findOne({ _id: session.branchId });
  return (
    <div className={styles.frameWrap}>
      <div className={styles.frame}>
        <header className={styles.header}>
          <span className={styles.brand}>
            BabyBargains <span style={{ color: "var(--color-accent)" }}>Stock</span>
          </span>
          <span className={styles.branch}>{branch?.name}</span>
          <form action="/logout" method="post">
            <button className={styles.signout} type="submit">Sign out</button>
          </form>
        </header>
        <div className={styles.demobar}>
          <span role="note">Demo data resets nightly 03:00 UTC</span>
          <span id="demo-slot" />
        </div>
        <div className={styles.body}>{children}</div>
        <ClerkNav />
      </div>
    </div>
  );
}
