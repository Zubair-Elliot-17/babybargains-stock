import { cols } from "@/domain/collections";
import { latestStocktakeForBranch } from "@/domain/ledger/read";
import { currentSession } from "@/lib/command";
import { getDb } from "@/lib/db";
import { StartStocktake } from "@/components/count/StartStocktake";
import styles from "@/components/count/count.module.css";

export const metadata = { title: "Count stock · BabyBargains Stock" };

const fmt = (d: Date) => d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

export default async function ClerkHome() {
  const session = (await currentSession())!;
  const db = await getDb();
  const [latest, branch] = await Promise.all([
    latestStocktakeForBranch(db, session.branchId!),
    cols(db).branches.findOne({ _id: session.branchId! }),
  ]);
  const mine = latest?.status === "OPEN" && latest.openedBy === session.sid;
  return (
    <div className={styles.home}>
      <h1>Count stock · {branch?.name}</h1>
      {latest && latest.status !== "OPEN" && (
        <p className={styles.status} role="status">
          Last stocktake: {latest.status === "APPROVED" ? `Submitted → Approved ${fmt(latest.approvedAt!)} UTC` : `Submitted ${fmt(latest.submittedAt!)} UTC · waiting for manager`}
        </p>
      )}
      <StartStocktake resumeId={mine ? latest!._id : null} />
      <p className={styles.hint}>Counts are blind: you won&apos;t see the system&apos;s quantities. Scan or search each product, count it, save, repeat.</p>
    </div>
  );
}
