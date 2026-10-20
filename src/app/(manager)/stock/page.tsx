import Link from "next/link";
import { requireManagerPage } from "@/auth/session";
import { cols } from "@/domain/collections";
import { stockView } from "@/domain/ledger/insights";
import { getDb } from "@/lib/db";
import styles from "@/components/manage/manage.module.css";

export const metadata = { title: "Stock · BabyBargains Stock" };

const SHOWN = 200;

export default async function StockPage({ searchParams }: { searchParams: Promise<{ branch?: string; q?: string; low?: string }> }) {
  await requireManagerPage();
  const params = await searchParams;
  const db = await getDb();
  const branches = await cols(db).branches.find({}, { projection: { name: 1 } }).sort({ name: 1 }).toArray();
  const branchId = branches.some((b) => b._id === params.branch) ? params.branch : undefined;
  const rows = await stockView(db, { branchId, q: params.q, lowOnly: params.low === "1" });
  const low = rows.filter((r) => r.low).length;
  const branchName = branches.find((b) => b._id === branchId)?.name;
  // Opens a supplier order for this branch with the low lines already suggested.
  const orderHref = (supplierId: string) => `/orders?branch=${encodeURIComponent(branchId ?? "")}&supplier=${encodeURIComponent(supplierId)}`;
  return (
    <>
      <header className="page-head">
        <h1>Stock · {branchName ?? "All branches"}</h1>
        <p>
          {rows.length} products{low ? ` · ${low} below reorder point` : ""}. On hand excludes recalled batches.
          {rows.length > SHOWN ? ` Showing the first ${SHOWN}; search to narrow.` : ""}
          {!branchId && low > 0 ? " Choose a branch to order what it's low on." : ""}
        </p>
        <form className={`${styles.filters} toolbar`} method="get">
          <label>
            Branch
            <select className="input" name="branch" defaultValue={branchId ?? ""}>
              <option value="">All branches</option>
              {branches.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
            </select>
          </label>
          <label>
            Product or SKU
            <input className="input" name="q" defaultValue={params.q ?? ""} type="search" />
          </label>
          <label className={styles.check}>
            <input type="checkbox" name="low" value="1" defaultChecked={params.low === "1"} /> Low stock only
          </label>
          <button className="btn" type="submit">Show</button>
        </form>
      </header>
      <div className={`panel ${styles.scroll}`}>
        <table className="cards">
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col">SKU</th>
              <th scope="col">Category</th>
              <th scope="col" className="num">On hand</th>
              <th scope="col" className="num">Reorder point</th>
              <th scope="col">Status</th>
              {branchId && <th scope="col"><span className="sr-only">Order</span></th>}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, SHOWN).map((r) => (
              <tr key={r.sku}>
                <th scope="row">{r.name}</th>
                <td className="mono" data-label="SKU">{r.sku}</td>
                <td data-label="Category">{r.category}</td>
                <td className="num" data-label="On hand">{r.onHand}</td>
                <td className="num" data-label="Reorder point">{r.reorderPoint || "–"}</td>
                <td data-label="Status">{r.low ? <span className="pill pill-warning">{branchId ? "Low" : "Low at a branch"}</span> : null}</td>
                {branchId && <td>{r.low && <Link className={styles.rowAction} href={orderHref(r.supplierId)} aria-label={`Order ${r.name} for ${branchName}`}>Order</Link>}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
