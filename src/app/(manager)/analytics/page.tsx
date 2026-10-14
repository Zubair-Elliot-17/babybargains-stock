import Link from "next/link";
import { requireManagerPage } from "@/auth/session";
import { cols } from "@/domain/collections";
import { analytics, DEAD_DAYS, MOVER_DAYS, OVERDUE_DAYS } from "@/domain/ledger/insights";
import type { Product } from "@/domain/schemas";
import { getDb } from "@/lib/db";
import { money, when } from "@/lib/format";
import { count } from "@/lib/plural";
import styles from "@/components/manage/manage.module.css";
import summary from "@/components/stocktakes/stocktakes.module.css";

export const metadata = { title: "Analytics · BabyBargains Stock" };

const CATEGORIES: Record<Product["category"], string> = { cot: "Cots", pram: "Prams", monitor: "Monitors", clothing: "Clothing", toy: "Toys" };
const MONTH = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString("en-GB", { month: "short", timeZone: "UTC" });

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ branch?: string; category?: string }> }) {
  await requireManagerPage();
  const params = await searchParams;
  const db = await getDb();
  const branches = await cols(db).branches.find({}, { projection: { name: 1 } }).sort({ name: 1 }).toArray();
  const branchId = branches.some((b) => b._id === params.branch) ? params.branch : undefined;
  const category = params.category && Object.hasOwn(CATEGORIES, params.category) ? (params.category as Product["category"]) : undefined;
  const a = await analytics(db, { branchId, category });
  const peak = Math.max(1, ...a.salesByMonth.map((m) => m.pence));
  const year = a.salesByMonth.reduce((n, m) => n + m.pence, 0);
  const scope = [branchId ? branches.find((b) => b._id === branchId)?.name : "All branches", category ? CATEGORIES[category] : null].filter(Boolean).join(" · ");

  return (
    <>
      <h1>Analytics · {scope}</h1>
      <form className={styles.filters} method="get">
        <label>
          Branch
          <select name="branch" defaultValue={branchId ?? ""}>
            <option value="">All branches</option>
            {branches.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
        </label>
        <label>
          Category
          <select name="category" defaultValue={category ?? ""}>
            <option value="">All categories</option>
            {Object.entries(CATEGORIES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <button className="btn" type="submit">Show</button>
      </form>

      <h2>Needs action</h2>
      <dl className={summary.summary}>
        <div><dt>Below reorder point</dt><dd className={a.lowStockTotal ? summary.warn : undefined}>{a.lowStockTotal}</dd></div>
        <div><dt>Dead stock ({DEAD_DAYS}+ days unsold)</dt><dd>{money(a.deadStockValuePence)}</dd></div>
        <div><dt>Overdue orders</dt><dd className={a.overdueOrders.length ? summary.warn : undefined}>{a.overdueOrders.length}</dd></div>
        <div><dt>Open orders</dt><dd>{a.orders.open}</dd></div>
      </dl>

      <div className={`${styles.grid} ${styles.section}`}>
        <section aria-labelledby="low">
          <h3 id="low">Low stock {a.lowStockTotal > a.lowStock.length && <span className={styles.meta}>· top {a.lowStock.length} of {a.lowStockTotal}</span>}</h3>
          {a.lowStock.length === 0 ? <p className={styles.meta}>Nothing below its reorder point.</p> : (
            <table>
              <thead><tr><th scope="col">Product</th><th scope="col">Branch</th><th scope="col" className="num">On hand / point</th></tr></thead>
              <tbody>
                {a.lowStock.map((r) => (
                  <tr key={`${r.branchId}|${r.sku}`}>
                    <th scope="row">{r.name}</th>
                    <td>{r.branchName}</td>
                    <td className="num"><span className={styles.low}>{r.onHand}</span> / {r.reorderPoint}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className={styles.meta}><Link href={`/transfers${branchId ? `?to=${branchId}` : ""}`}>Cover from another branch</Link> or <Link href="/orders">order from the supplier</Link>.</p>
        </section>

        <section aria-labelledby="dead">
          <h3 id="dead">Dead stock {a.deadStockTotal > a.deadStock.length && <span className={styles.meta}>· top {a.deadStock.length} of {a.deadStockTotal} by value</span>}</h3>
          {a.deadStock.length === 0 ? <p className={styles.meta}>Everything on hand has sold in the last {DEAD_DAYS} days.</p> : (
            <table>
              <thead><tr><th scope="col">Product</th><th scope="col">Branch</th><th scope="col" className="num">On hand</th><th scope="col" className="num">Retail value</th></tr></thead>
              <tbody>
                {a.deadStock.map((r) => (
                  <tr key={`${r.branchId}|${r.sku}`}>
                    <th scope="row">{r.name}</th>
                    <td>{r.branchName}</td>
                    <td className="num">{r.onHand}</td>
                    <td className="num">{money(r.valuePence)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {a.overdueOrders.length > 0 && (
          <section aria-labelledby="overdue">
            <h3 id="overdue">Orders sent over {OVERDUE_DAYS} days ago</h3>
            <table>
              <thead><tr><th scope="col">Order</th><th scope="col">Supplier</th><th scope="col">Sent</th><th scope="col" className="num">Units due</th></tr></thead>
              <tbody>
                {a.overdueOrders.map((o) => (
                  <tr key={o._id}>
                    <th scope="row" className="mono"><Link href="/orders">{o._id}</Link></th>
                    <td>{o.supplierName}</td>
                    <td>{when(o.sentAt)} UTC</td>
                    <td className="num">{o.outstanding}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>

      <section className={styles.section} aria-labelledby="sales">
        <h2 id="sales">Sales, last 12 months · {money(year)}</h2>
        <div className={styles.bars} role="img" aria-label={`Monthly sales: ${a.salesByMonth.map((m) => `${MONTH(m.month)} ${money(m.pence)}`).join(", ")}`}>
          {a.salesByMonth.map((m) => (
            <div key={m.month} className={styles.bar} style={{ height: `${(m.pence / peak) * 100}%` }} title={`${MONTH(m.month)}: ${money(m.pence)} · ${count(m.units, "unit")}`} />
          ))}
        </div>
        <div className={styles.barLabels} aria-hidden>
          {a.salesByMonth.map((m) => <span key={m.month}>{MONTH(m.month)}</span>)}
        </div>
      </section>

      <div className={`${styles.grid} ${styles.section}`}>
        <section aria-labelledby="movers">
          <h3 id="movers">Top movers, last {MOVER_DAYS} days</h3>
          {a.topMovers.length === 0 ? <p className={styles.meta}>No sales in this period.</p> : (
            <table>
              <thead><tr><th scope="col">Product</th><th scope="col" className="num">Units sold</th></tr></thead>
              <tbody>{a.topMovers.map((m) => <tr key={m.sku}><th scope="row">{m.name}</th><td className="num">{m.units}</td></tr>)}</tbody>
            </table>
          )}
        </section>
        <section aria-labelledby="orders">
          <h3 id="orders">Supplier orders</h3>
          <dl className={summary.summary} style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
            <div><dt>Average lead time</dt><dd>{a.orders.avgLeadDays === null ? "–" : `${a.orders.avgLeadDays.toFixed(1)} days`}</dd></div>
            <div><dt>Fill rate</dt><dd>{a.orders.fillRate === null ? "–" : `${Math.round(a.orders.fillRate * 100)}%`}</dd></div>
          </dl>
          <p className={styles.meta}>From orders received or cancelled. Demo orders clear at the nightly reset.</p>
        </section>
      </div>
    </>
  );
}
