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
  return (
    <>
      <h1>Stock · {branchId ? branches.find((b) => b._id === branchId)?.name : "All branches"}</h1>
      <form className={styles.filters} method="get">
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
      <p className={styles.meta}>
        {rows.length} products{low ? ` · ${low} below reorder point` : ""}. On hand excludes recalled batches.
        {rows.length > SHOWN ? ` Showing the first ${SHOWN}; search to narrow.` : ""}
      </p>
      <div className={styles.scroll}>
        <table className="cards">
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col">SKU</th>
              <th scope="col">Category</th>
              <th scope="col" className="num">On hand</th>
              <th scope="col" className="num">Reorder point</th>
              <th scope="col">Status</th>
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
                <td data-label="Status">{r.low ? <span className={styles.low}>{branchId ? "Low" : "Low at a branch"}</span> : "OK"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
