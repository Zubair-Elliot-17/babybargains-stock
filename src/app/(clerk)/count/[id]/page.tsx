import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { branchBatchChoices, countView } from "@/domain/ledger/read";
import { currentSession } from "@/lib/command";
import { getDb } from "@/lib/db";
import { CountScreen } from "@/components/count/CountScreen";
import { UnsentCounts } from "@/components/count/UnsentCounts";
import styles from "@/components/count/count.module.css";

export const metadata = { title: "Count · BabyBargains Stock" };

const fmt = (d: Date) => d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

export default async function CountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = (await currentSession())!;
  const db = await getDb();
  const view = await countView(db, id);
  if (!view || view.stocktake.branchId !== session.branchId) notFound();
  const st = view.stocktake;

  if (st.status !== "OPEN") {
    return (
      <div className={styles.home}>
        <h1>Stocktake · {view.branchName}</h1>
        <p className="banner" role="status">
          {st.status === "SUBMITTED" ? `Submitted by ${st.clerkLabel} ${fmt(st.submittedAt!)} UTC · waiting for manager` : `Approved ${fmt(st.approvedAt!)} UTC`}
        </p>
        <UnsentCounts stocktakeId={st._id} names={Object.fromEntries(view.products.map((p) => [p.sku, p.name]))} />
        <Link className="btn" href="/count">Back</Link>
      </div>
    );
  }
  const lead = st.openedBy === session.sid;
  // The home page resumes it with this phone's key, or lets a teammate join.
  if (!lead && !st.participants?.some((p) => p.sid === session.sid)) redirect("/count");

  return (
    <CountScreen
      stocktakeId={st._id}
      branchName={view.branchName}
      openedAt={st.openedAt.toISOString()}
      products={view.products}
      initialEntries={view.entries}
      batches={await branchBatchChoices(db, st.branchId)}
      lead={lead}
      leadLabel={st.clerkLabel}
    />
  );
}
