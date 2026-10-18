import Link from "next/link";
import { requireManagerPage } from "@/auth/session";
import { listTransferSuggestions, transfersInTransit, type InTransitRow, type TransfersView } from "@/domain/ledger/read";
import { VELOCITY_WEEKS } from "@/domain/ledger/transfers";
import { getDb } from "@/lib/db";
import { when } from "@/lib/format";
import { count } from "@/lib/plural";
import { TransfersScreen } from "@/components/transfers/TransfersScreen";
import styles from "@/components/transfers/transfers.module.css";

export const metadata = { title: "Transfers · BabyBargains Stock" };

export default async function TransfersPage({ searchParams }: { searchParams: Promise<{ to?: string }> }) {
  await requireManagerPage();
  const requested = (await searchParams).to;
  let view: TransfersView;
  let inTransit: InTransitRow[];
  try {
    const db = await getDb();
    [view, inTransit] = await Promise.all([listTransferSuggestions(db, { to: requested || undefined }), transfersInTransit(db)]);
  } catch (err) {
    console.error("transfers page: failed to load suggestions", err);
    return (
      <>
        <h1>Transfers</h1>
        <p className="banner banner-error" role="alert">
          Couldn&apos;t load suggestions. <Link href={requested ? `/transfers?to=${encodeURIComponent(requested)}` : "/transfers"}>Retry</Link>
        </p>
      </>
    );
  }
  const to = view.branches.find((b) => b._id === requested);
  if (requested && !to) {
    return (
      <>
        <h1>Transfers</h1>
        <p className="banner banner-error" role="alert">
          &ldquo;{requested}&rdquo; isn&apos;t a branch. <Link href="/transfers">Show all branches</Link>
        </p>
      </>
    );
  }
  const n = view.total;
  return (
    <>
      <header className="page-head">
        <h1>Transfers · {n ? `${count(n, "suggestion")}${to ? ` into ${to.name}` : ""}` : "nothing to move"}</h1>
        <p>
          Stock from branches with more than their overstock weeks of cover, to branches below their reorder point. Cover uses sales
          from the {VELOCITY_WEEKS} weeks before today, counting only the days a branch had stock. Accepting dispatches the stock, oldest batches first; it reaches the receiving branch when a clerk there confirms it.
        </p>
        <form className={`${styles.filter} toolbar`} action="/transfers" method="get">
          <div>
            <label htmlFor="to">Receiving branch</label>
            <select id="to" name="to" className="input" defaultValue={to?._id ?? ""}>
              <option value="">All branches</option>
              {view.branches.map((b) => (
                <option key={b._id} value={b._id}>{b.name}</option>
              ))}
            </select>
          </div>
          <button className="btn" type="submit">Show</button>
        </form>
      </header>
      {view.blocked.length > 0 && (
        <p className="banner" role="note">
          Left out while a stocktake is in progress: {view.blocked.map((b) => b.name).join(", ")}.
        </p>
      )}
      {view.total > view.suggestions.length && (
        <p className={styles.meta} role="note">
          Showing the top {view.suggestions.length} of {view.total}. Pick a receiving branch to narrow the list.
        </p>
      )}
      <TransfersScreen
        rows={view.suggestions}
        emptyText={to ? `No transfers into ${to.name} right now.` : "No branch is both over its cover and able to help one below its reorder point."}
      />
      {inTransit.length > 0 && (
        <section className={`panel ${styles.inTransit}`} aria-labelledby="in-transit">
          <h2 id="in-transit">In transit · {count(inTransit.reduce((n, r) => n + r.units, 0), "unit")}</h2>
          <table className="cards">
            <thead>
              <tr><th scope="col">Product</th><th scope="col">From</th><th scope="col">To</th><th scope="col" className="num">Units</th><th scope="col">Dispatched</th></tr>
            </thead>
            <tbody>
              {inTransit.map((r) => (
                <tr key={r._id}>
                  <th scope="row">{r.productName}</th>
                  <td data-label="From">{r.fromName}</td>
                  <td data-label="To">{r.toName}</td>
                  <td className="num" data-label="Units">{r.units}{r.recalledUnits ? ` (+${r.recalledUnits} recalled)` : ""}</td>
                  <td data-label="Dispatched">{when(r.dispatchedAt)} UTC</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
