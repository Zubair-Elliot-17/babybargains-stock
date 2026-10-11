import Link from "next/link";
import { listTransferSuggestions, type TransfersView } from "@/domain/ledger/read";
import { getDb } from "@/lib/db";
import { count } from "@/lib/plural";
import { TransfersScreen } from "@/components/transfers/TransfersScreen";
import styles from "@/components/transfers/transfers.module.css";

export const metadata = { title: "Transfers · BabyBargains Stock" };

export default async function TransfersPage({ searchParams }: { searchParams: Promise<{ to?: string }> }) {
  const requested = (await searchParams).to;
  let view: TransfersView;
  try {
    view = await listTransferSuggestions(await getDb(), { to: requested || undefined });
  } catch {
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
  const n = view.suggestions.length;
  return (
    <>
      <h1>Transfers · {n ? `${count(n, "suggestion")}${to ? ` into ${to.name}` : ""}` : "nothing to move"}</h1>
      <p className={styles.meta}>
        Stock from branches with more than their overstock weeks of cover, to branches below their reorder point. Cover uses sales
        from the last 8 weeks. Accepting moves the stock now, oldest batches first.
      </p>
      <form className={styles.filter} action="/transfers" method="get">
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
      {view.blocked.length > 0 && (
        <p className="banner" role="note">
          Left out while a stocktake is in progress: {view.blocked.map((b) => b.name).join(", ")}.
        </p>
      )}
      {n === 0 ? (
        <p className={styles.empty}>
          {to ? `No transfers into ${to.name} right now.` : "No branch is both over its cover and able to help one below its reorder point."}
        </p>
      ) : (
        <TransfersScreen rows={view.suggestions} />
      )}
    </>
  );
}
