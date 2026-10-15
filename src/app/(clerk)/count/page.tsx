import { cols } from "@/domain/collections";
import { latestStocktakeForBranch, transfersInTransit } from "@/domain/ledger/read";
import { currentSession } from "@/lib/command";
import { getDb } from "@/lib/db";
import { IncomingTransfers } from "@/components/count/IncomingTransfers";
import { StartStocktake } from "@/components/count/StartStocktake";
import styles from "@/components/count/count.module.css";

export const metadata = { title: "Count stock · BabyBargains Stock" };

const fmt = (d: Date) => d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

export default async function ClerkHome() {
  const session = (await currentSession())!;
  const db = await getDb();
  const [latest, branch, open, incoming] = await Promise.all([
    latestStocktakeForBranch(db, session.branchId!),
    cols(db).branches.findOne({ _id: session.branchId! }),
    cols(db).stocktakes.findOne({ branchId: session.branchId!, status: "OPEN" }, { projection: { openedBy: 1, clerkLabel: 1, participants: 1 } }),
    transfersInTransit(db, session.branchId!),
  ]);
  const mine = latest?.status === "OPEN" && latest.openedBy === session.sid;
  const joined = !!open?.participants?.some((p) => p.sid === session.sid);
  return (
    <div className={styles.home}>
      <h1>Count stock · {branch?.name}</h1>
      {latest && latest.status !== "OPEN" && (
        <p className={styles.status} role="status">
          Last stocktake: {latest.status === "APPROVED" ? `Submitted → Approved ${fmt(latest.approvedAt!)} UTC` : `Submitted ${fmt(latest.submittedAt!)} UTC · waiting for manager`}
        </p>
      )}
      <StartStocktake
        resumeId={mine ? latest!._id : joined ? open!._id : null}
        openId={open && open.openedBy !== session.sid && !joined ? open._id : null}
        leadLabel={open?.clerkLabel ?? ""}
      />
      <IncomingTransfers rows={incoming} />
      <p className={styles.hint}>Counts are blind: you won&apos;t see the system&apos;s quantities. Scan or search each product, count it, save, repeat.</p>
    </div>
  );
}
