import Link from "next/link";
import { requireManagerPage } from "@/auth/session";
import { cols } from "@/domain/collections";
import { analytics, COVER_WEEKS, DEAD_DAYS, MOVER_DAYS, OVERDUE_DAYS } from "@/domain/ledger/insights";
import type { Product } from "@/domain/schemas";
import { getDb } from "@/lib/db";
import { money, moneyShort, moneyWhole, when } from "@/lib/format";
import { count } from "@/lib/plural";
import { BarList, Meter } from "@/components/charts/BarList";
import { Heatmap } from "@/components/charts/Heatmap";
import { Change, Kpi } from "@/components/charts/Kpi";
import { LineChart } from "@/components/charts/LineChart";
import { Sparkline } from "@/components/charts/Sparkline";
import { StackedBar } from "@/components/charts/StackedBar";
import charts from "@/components/charts/charts.module.css";
import styles from "@/components/manage/manage.module.css";

export const metadata = { title: "Analytics · BabyBargains Stock" };

const CATEGORIES: Record<Product["category"], string> = { cot: "Cots", pram: "Prams", monitor: "Monitors", clothing: "Clothing", toy: "Toys" };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Ink, grey, hatch, then recall for the oldest bucket: readable without hue (DESIGN.md "Charts").
const HATCH = "repeating-linear-gradient(135deg, var(--color-ink) 0 1.5px, var(--color-surface) 1.5px 5px)";
const RAMP = ["var(--color-ink)", "var(--color-chart-2)", HATCH, "var(--color-recall)"];
const OVERVIEW = 180;

const pct = (share: number) => `${Math.round(share * 100)}%`;
const day = (iso: string, year?: "numeric") => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year, timeZone: "UTC" });
const Empty = ({ height, children }: { height: number; children: string }) => <p className={charts.empty} style={{ minHeight: height }}>{children}</p>;

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ branch?: string; category?: string }> }) {
  await requireManagerPage();
  const params = await searchParams;
  const db = await getDb();
  const branches = await cols(db).branches.find({}, { projection: { name: 1 } }).sort({ name: 1 }).toArray();
  const branchId = branches.some((b) => b._id === params.branch) ? params.branch : undefined;
  const category = params.category && Object.hasOwn(CATEGORIES, params.category) ? (params.category as Product["category"]) : undefined;
  const a = await analytics(db, { branchId, category });
  const scope = [branchId ? branches.find((b) => b._id === branchId)?.name : "All branches", category ? CATEGORIES[category] : null].filter(Boolean).join(" · ");

  const weeks = a.salesByWeek;
  const year = weeks.reduce((n, w) => n + w.pence, 0);
  // A tick where a new month starts, every other month so labels fit at phone width.
  const ticks = weeks
    .map((w, i) => ({ at: i, month: w.start.slice(0, 7) }))
    .filter((t, i) => i > 0 && t.month !== weeks[i - 1].start.slice(0, 7))
    .filter((_, i) => i % 2 === 0)
    .map((t) => ({ at: t.at, label: new Date(`${t.month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }) }));
  const best = Math.max(0, ...weeks.map((w) => w.pence));

  const outOfBand = a.cover.filter((c) => c.band && c.weeks !== null && (c.weeks < c.band[0] || c.weeks > c.band[1])).length;
  const old = a.stockAge.at(-1)!;
  const abcA = a.abc[0];
  const leaguePeak = Math.max(0, ...a.league.map((b) => b.sales30));
  const deadPeak = a.deadStock[0]?.valuePence ?? 0;

  return (
    <>
      <header className="page-head">
        <h1>Analytics · {scope}</h1>
        <p>Sales, stock health and supplier orders from the stock ledger. Figures run to today, UTC.</p>
        <form className={`${styles.filters} toolbar`} method="get">
          <label>
            Branch
            <select className="input" name="branch" defaultValue={branchId ?? ""}>
              <option value="">All branches</option>
              {branches.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
            </select>
          </label>
          <label>
            Category
            <select className="input" name="category" defaultValue={category ?? ""}>
              <option value="">All categories</option>
              {Object.entries(CATEGORIES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <button className="btn" type="submit">Show</button>
        </form>
      </header>

      <section aria-labelledby="kpis">
        <h2 id="kpis" className="sr-only">Key figures</h2>
        <dl className={charts.kpis}>
          <Kpi label="Sales, last 30 days" value={moneyWhole(a.kpi.sales30)}>
            <Change value={a.kpi.salesChange} period="previous 30 days" />
            <Sparkline values={a.kpi.daily30} />
          </Kpi>
          <Kpi label="Units sold, last 30 days" value={a.kpi.units30.toLocaleString("en-GB")}>
            <Change value={a.kpi.unitsChange} period="previous 30 days" />
          </Kpi>
          <Kpi label="Stock on hand at retail" value={moneyWhole(a.kpi.stockPence)} />
          <Kpi label="Below reorder point" value={String(a.lowStockTotal)} warn={a.lowStockTotal > 0} />
          <Kpi label={`Dead stock (${DEAD_DAYS}+ days unsold)`} value={moneyWhole(a.deadStockValuePence)} />
        </dl>
      </section>

      <div className={`${charts.lead} ${styles.section}`}>
        <section className="panel" aria-labelledby="sales">
          <h2 id="sales">Sales, last 12 months · {money(year)}</h2>
          {year === 0 ? <Empty height={320}>No sales in the last 12 months.</Empty> : (
            <LineChart
              label={`Weekly sales over the last 52 weeks, ${moneyWhole(year)} in total; the latest week took ${moneyWhole(weeks.at(-1)!.pence)} and the best week ${moneyWhole(best)}.`}
              caption="Weekly sales, last 52 weeks"
              head={["Week starting", "Sales"]}
              points={weeks.map((w) => ({ name: day(w.start, "numeric"), value: w.pence }))}
              ticks={ticks}
              format={moneyShort}
              height={320}
            />
          )}
        </section>

        <section className="panel" aria-labelledby="categories">
          <h2 id="categories">Sales by category, last 12 months</h2>
          {year === 0 ? <Empty height={OVERVIEW}>No sales in the last 12 months.</Empty> : (
            <div className={charts.overview}>
              <BarList
                label={`Sales by category over the last 12 months: ${CATEGORIES[a.categories[0].category]} lead with ${pct(a.categories[0].share)} of revenue.`}
                caption="Sales by category, last 12 months"
                head={["Category", "Sales (share)"]}
                bars={a.categories.map((c) => ({ name: CATEGORIES[c.category], value: c.pence, text: `${moneyShort(c.pence)} · ${pct(c.share)}` }))}
              />
            </div>
          )}
        </section>

      </div>

      <div className={`${charts.pairs} ${styles.section}`}>
        <section className="panel" aria-labelledby="cover">
          <h2 id="cover">Weeks of cover by category</h2>
          {a.cover.every((c) => c.onHand === 0 && c.weeks === null) ? <Empty height={OVERVIEW}>No stock and no sales to measure cover against.</Empty> : (
            <div className={charts.overview}>
              <BarList
                label={`Weeks of cover by category against each healthy band: ${count(outOfBand, "category", "categories")} outside the band.`}
                caption={`Weeks of cover by category, from the last ${COVER_WEEKS} weeks of sales`}
                head={["Category", "Weeks of cover", "Healthy band (weeks)", "Status"]}
                bars={a.cover.map((c) => ({
                  name: CATEGORIES[c.category],
                  value: c.weeks ?? 0,
                  text: c.weeks === null ? "–" : `${c.weeks.toFixed(1)} wk`,
                  band: c.band ?? undefined,
                  note: c.weeks === null ? (c.onHand > 0 ? "no sales" : undefined) : c.band && c.weeks < c.band[0] ? "under" : c.band && c.weeks > c.band[1] ? "over" : undefined,
                }))}
              />
              <p className={styles.meta}>On hand ÷ average weekly units over the last {COVER_WEEKS} weeks. The band runs from reorder point to overstock policy.</p>
            </div>
          )}
        </section>

        <section className="panel" aria-labelledby="age">
          <h2 id="age">Stock age at retail</h2>
          {a.kpi.stockPence === 0 ? <Empty height={OVERVIEW}>No stock on the shelves.</Empty> : (
            <div className={charts.overview}>
              <StackedBar
                label={`Shelf stock at retail by batch age: ${pct(old.pence / a.kpi.stockPence)} of ${moneyWhole(a.kpi.stockPence)} is ${old.bucket.toLowerCase()} old.`}
                caption="Shelf stock at retail by batch age"
                series={a.stockAge.map((b, i) => ({ name: b.bucket, color: RAMP[i] }))}
                rows={[{ name: "Stock at retail", values: a.stockAge.map((b) => b.pence), text: moneyShort }]}
              />
            </div>
          )}
        </section>

        <section className="panel" aria-labelledby="abc">
          <h2 id="abc">ABC split, last 12 months</h2>
          {year === 0 ? <Empty height={OVERVIEW}>No sales in the last 12 months.</Empty> : (
            <div className={charts.overview}>
              <StackedBar
                label={`ABC split: A products are ${pct(abcA.skuShare)} of products and take ${pct(abcA.revenueShare)} of revenue.`}
                caption="ABC split by the last 12 months of revenue"
                series={[
                  { name: "A (top 80% of sales)", color: RAMP[0] },
                  { name: "B (next 15%)", color: RAMP[1] },
                  { name: "C (last 5%)", color: RAMP[2] },
                ]}
                rows={[
                  { name: "Products", values: a.abc.map((r) => r.skus), text: (v) => count(v, "product") },
                  { name: "Revenue", values: a.abc.map((r) => r.pence), text: moneyShort },
                ]}
              />
            </div>
          )}
        </section>
      </div>

      <section className={`panel ${styles.section}`} aria-labelledby="league">
        <h2 id="league">Branch league, last 30 days</h2>
        <table className={`cards ${charts.league}`}>
          <thead>
            <tr><th scope="col">Branch</th><th scope="col" className="num">Sales, 30 days</th><th scope="col">Change</th><th scope="col">Last 12 weeks</th></tr>
          </thead>
          <tbody>
            {a.league.map((b) => (
              <tr key={b.branchId} data-current={b.branchId === branchId ? "" : undefined}>
                <th scope="row">{b.name}{b.branchId === branchId && <span className={styles.meta}> · selected</span>}</th>
                <td className="num" data-label="Sales, 30 days"><div>{moneyWhole(b.sales30)}<Meter value={b.sales30} max={leaguePeak} /></div></td>
                <td data-label="Change"><Change value={b.change} period="prev. 30 days" /></td>
                <td data-label="Last 12 weeks"><Sparkline values={b.weekly} label={`${b.name}, weekly sales over the last 12 weeks: ${b.weekly.map(moneyShort).join(", ")}.`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className={`panel ${styles.section}`} aria-labelledby="weekday">
        <h2 id="weekday">Average daily sales by weekday, last 12 weeks</h2>
        {a.weekday.every((b) => b.avg.every((v) => v === 0)) ? <Empty height={OVERVIEW}>No sales in the last 12 weeks.</Empty> : (
          <Heatmap
            label={`Average daily sales by branch and weekday over the last 12 weeks; ${busiest(a.weekday)} is the busiest day across branches.`}
            caption="Average daily sales by branch and weekday, last 12 weeks"
            cols={WEEKDAYS}
            rows={a.weekday.map((b) => ({ name: b.name, short: b.code, values: b.avg, current: b.branchId === branchId }))}
            format={moneyShort}
          />
        )}
      </section>

      <h2>Needs action</h2>
      <div className={styles.grid}>
        <section className="panel" aria-labelledby="low">
          <h3 id="low">Low stock {a.lowStockTotal > a.lowStock.length && <span className={styles.meta}>· top {a.lowStock.length} of {a.lowStockTotal}</span>}</h3>
          {a.lowStock.length === 0 ? <p className={styles.meta}>Nothing below its reorder point.</p> : (
            <table>
              <thead><tr><th scope="col">Product</th><th scope="col">Branch</th><th scope="col" className="num">On hand / point</th></tr></thead>
              <tbody>
                {a.lowStock.map((r) => (
                  <tr key={`${r.branchId}|${r.sku}`}>
                    <th scope="row">{r.name}</th>
                    <td>{r.branchName}</td>
                    <td className="num"><span className={styles.low}>{r.onHand}</span> / {r.reorderPoint}<Meter value={r.onHand} max={r.reorderPoint} tone="warn" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className={styles.meta}><Link href={`/transfers${branchId ? `?to=${branchId}` : ""}`}>Cover from another branch</Link> or <Link href="/orders">order from the supplier</Link>.</p>
        </section>

        <section className="panel" aria-labelledby="dead">
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
                    <td className="num">{money(r.valuePence)}<Meter value={r.valuePence} max={deadPeak} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {a.overdueOrders.length > 0 && (
          <section className="panel" aria-labelledby="overdue">
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

      <div className={`${styles.grid} ${styles.section}`}>
        <section className="panel" aria-labelledby="movers">
          <h2 id="movers">Top movers, last {MOVER_DAYS} days</h2>
          {a.topMovers.length === 0 ? <p className={styles.meta}>No sales in this period.</p> : (
            <table>
              <thead><tr><th scope="col">Product</th><th scope="col" className="num">Units sold</th></tr></thead>
              <tbody>{a.topMovers.map((m) => <tr key={m.sku}><th scope="row">{m.name}</th><td className="num">{m.units}</td></tr>)}</tbody>
            </table>
          )}
        </section>
        <section className="panel" aria-labelledby="orders">
          <h2 id="orders">Supplier orders</h2>
          <dl className={charts.facts}>
            <div>
              <dt>Open orders</dt>
              <dd>{a.orders.open} {a.overdueOrders.length > 0 && <span className="pill pill-warning">{a.overdueOrders.length} overdue</span>}</dd>
            </div>
            <div><dt>Average lead time</dt><dd>{a.orders.avgLeadDays === null ? "–" : `${a.orders.avgLeadDays.toFixed(1)} days`}</dd></div>
            <div><dt>Fill rate</dt><dd>{a.orders.fillRate === null ? "–" : `${Math.round(a.orders.fillRate * 100)}%`}</dd></div>
          </dl>
          <p className={styles.meta}>From orders received or cancelled. Demo orders clear at the nightly reset.</p>
        </section>
      </div>
    </>
  );
}

// The weekday with the highest summed average across branches.
function busiest(rows: { avg: number[] }[]) {
  const totals = WEEKDAYS.map((_, i) => rows.reduce((n, r) => n + r.avg[i], 0));
  return ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][totals.indexOf(Math.max(...totals))];
}
