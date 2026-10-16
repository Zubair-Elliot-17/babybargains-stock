import Link from "next/link";
import { requireManagerPage } from "@/auth/session";
import { listStocktakes, type StocktakeSummary } from "@/domain/ledger/read";
import { getDb } from "@/lib/db";
import { when } from "@/lib/format";
import styles from "@/components/stocktakes/stocktakes.module.css";

export const metadata = { title: "Stocktakes · BabyBargains Stock" };

const TABS = [
  { id: "SUBMITTED", label: "Awaiting review" },
  { id: "OPEN", label: "In progress" },
  { id: "APPROVED", label: "Approved" },
] as const;

export default async function StocktakesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requireManagerPage();
  const requested = (await searchParams).tab;
  const tab = TABS.find((t) => t.id === requested)?.id ?? "SUBMITTED";
  const all = await listStocktakes(await getDb());
  const rows = all.filter((s) => s.status === tab);
  const awaiting = all.filter((s) => s.status === "SUBMITTED").length;
  return (
    <>
      <header className="page-head">
        <h1>Stocktakes{awaiting ? ` · ${awaiting} awaiting review` : ""}</h1>
        <p>Counts that clerks send from the shop floor. Review each one&apos;s variances, then approve it to post the adjustments.</p>
      </header>
      <nav className={styles.tabs} aria-label="Stocktake status">
        {TABS.map((t) => (
          <Link key={t.id} href={`/stocktakes?tab=${t.id}`} className={styles.tab} aria-current={t.id === tab ? "page" : undefined}>
            {t.label} <span className={styles.count}>{all.filter((s) => s.status === t.id).length}</span>
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <p className={`panel ${styles.empty}`}>{tab === "SUBMITTED" ? "Nothing waiting for review." : tab === "OPEN" ? "No branch is counting right now." : "No approved stocktakes yet."}</p>
      ) : (
        <div className="panel">
          <table className="cards">
            <thead>
              <tr>
                <th scope="col">Branch</th>
                <th scope="col">Clerk</th>
                <th scope="col" className="num">Products counted</th>
                <th scope="col">{tab === "OPEN" ? "Started" : tab === "SUBMITTED" ? "Submitted" : "Approved"}</th>
                <th scope="col"><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s: StocktakeSummary) => (
                <tr key={s._id}>
                  <th scope="row">{s.branchName}</th>
                  <td data-label="Clerk">{s.clerkLabel}</td>
                  <td className="num" data-label="Products counted">{s.productsCounted}</td>
                  <td data-label={tab === "OPEN" ? "Started" : tab === "SUBMITTED" ? "Submitted" : "Approved"}>{when(tab === "OPEN" ? s.openedAt : tab === "SUBMITTED" ? s.submittedAt! : s.approvedAt!)} UTC</td>
                  <td>{tab !== "OPEN" && <Link href={`/stocktakes/${s._id}`}>{tab === "SUBMITTED" ? "Review" : "View"}</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
