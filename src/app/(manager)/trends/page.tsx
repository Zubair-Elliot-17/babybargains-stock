import Link from "next/link";
import { requireManagerPage } from "@/auth/session";
import { cols } from "@/domain/collections";
import { CATEGORY_LABELS, MAX_TERMS, parseTerms, RANGES, termKey, trends, type Range, type Term } from "@/domain/ledger/trends";
import { getDb } from "@/lib/db";
import { Meter } from "@/components/charts/BarList";
import { SeriesKey, TrendChart } from "@/components/charts/TrendChart";
import charts from "@/components/charts/charts.module.css";
import styles from "@/components/manage/manage.module.css";

export const metadata = { title: "Trends · BabyBargains Stock" };

const day = (iso: string, year?: "numeric") => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year, timeZone: "UTC" });
const growth = (g: number) => `+${Math.round(g * 100).toLocaleString("en-GB")}%`;
const Empty = ({ height, children }: { height: number; children: string }) => <p className={charts.empty} style={{ minHeight: height }}>{children}</p>;

type Params = { t?: string | string[]; range?: string; branch?: string };

export default async function TrendsPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireManagerPage();
  const params = await searchParams;
  const db = await getDb();
  const [branches, products] = await Promise.all([
    cols(db).branches.find({}, { projection: { name: 1 } }).sort({ name: 1 }).toArray(),
    cols(db).products.find({}, { projection: { name: 1, category: 1 } }).sort({ name: 1 }).toArray(),
  ]);
  // Default: every category the catalogue actually stocks.
  const defaults = Object.keys(CATEGORY_LABELS).filter((c) => products.some((p) => p.category === c)).map((c) => `cat:${c}`);
  const parsed = parseTerms(params.t === undefined ? defaults : [params.t].flat(), products);
  const terms = parsed.length ? parsed : parseTerms(defaults, products);
  const range: Range = params.range && Object.hasOwn(RANGES, params.range) ? (params.range as Range) : "12m";
  const branchId = branches.some((b) => b._id === params.branch) ? params.branch : undefined;
  const t = await trends(db, { terms, range, branchId });

  // Links keep the other filters; Google-style "explore" opens one product on its own.
  const href = (next: Term[] | string[]) => {
    const q = new URLSearchParams();
    for (const x of next) q.append("t", typeof x === "string" ? x : termKey(x));
    q.set("range", range);
    if (branchId) q.set("branch", branchId);
    return `/trends?${q}`;
  };
  const scope = branchId ? branches.find((b) => b._id === branchId)!.name : "All branches";
  const used = new Set(terms.map(termKey));
  const empty = t.terms.every((s) => s.units === 0);
  const leader = [...t.terms].sort((a, b) => b.avg - a.avg)[0];

  // Weekly ranges tick at each new month (every other month over a year); the daily range ticks weekly.
  const ticks =
    range === "30d"
      ? t.buckets.map((b, i) => ({ at: i, label: day(b) })).filter((_, i) => i % 7 === 0)
      : t.buckets
          .map((b, i) => ({ at: i, month: b.slice(0, 7) }))
          .filter((x, i) => i > 0 && x.month !== t.buckets[i - 1].slice(0, 7))
          .filter((_, i) => range === "90d" || i % 2 === 0)
          .map((x) => ({ at: x.at, label: new Date(`${x.month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }) }));

  return (
    <>
      <header className="page-head">
        <h1>Trends · {scope}</h1>
        <p>Units sold, indexed so the busiest {RANGES[range].size === 1 ? "day" : "week"} in view is 100. Compare up to {MAX_TERMS} categories or products.</p>
        <form className={`${styles.filters} toolbar`} method="get">
          {terms.map((x) => <input key={termKey(x)} type="hidden" name="t" value={termKey(x)} />)}
          {terms.length < MAX_TERMS && (
            <label>
              Compare
              <select className="input" name="t" defaultValue="">
                <option value="">Add a comparison…</option>
                <optgroup label="Categories">
                  {Object.entries(CATEGORY_LABELS).filter(([id]) => !used.has(`cat:${id}`)).map(([id, label]) => <option key={id} value={`cat:${id}`}>{label}</option>)}
                </optgroup>
                <optgroup label="Products">
                  {products.filter((p) => !used.has(`sku:${p._id}`)).map((p) => <option key={p._id} value={`sku:${p._id}`}>{p.name}</option>)}
                </optgroup>
              </select>
            </label>
          )}
          <label>
            Period
            <select className="input" name="range" defaultValue={range}>
              {Object.entries(RANGES).map(([id, r]) => <option key={id} value={id}>{r.label}</option>)}
            </select>
          </label>
          <label>
            Branch
            <select className="input" name="branch" defaultValue={branchId ?? ""}>
              <option value="">All branches</option>
              {branches.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
            </select>
          </label>
          <button className="btn" type="submit">Show</button>
        </form>
      </header>

      <section className={`panel ${styles.section}`} aria-labelledby="interest">
        <h2 id="interest">Interest over time · {RANGES[range].label}</h2>
        <ul className={charts.legend} aria-label="Compared">
          {t.terms.map((s, i) => (
            <li key={s.key}>
              <SeriesKey i={i} />
              {s.name} <strong>{s.avg}</strong>
              <span className={styles.meta}>avg</span>
              {terms.length > 1 && (
                <Link className={styles.rowAction} href={href(terms.filter((x) => termKey(x) !== s.key))} aria-label={`Remove ${s.name}`}>×</Link>
              )}
            </li>
          ))}
        </ul>
        {empty ? <Empty height={320}>No sales for these in the period.</Empty> : (
          <TrendChart
            label={`Interest over time, ${RANGES[range].label.toLowerCase()}: ${leader.name} leads with an average of ${leader.avg}; latest ${t.terms.map((s) => `${s.name} ${s.values.at(-1)}`).join(", ")}.`}
            caption={`Interest over time, ${RANGES[range].label.toLowerCase()} (100 = busiest ${RANGES[range].size === 1 ? "day" : "week"})`}
            names={t.buckets.map((b) => day(b, "numeric"))}
            series={t.terms.map((s) => ({ name: s.name, values: s.values }))}
            ticks={ticks}
            height={320}
          />
        )}
      </section>

      <section className={`panel ${styles.section}`} aria-labelledby="branches">
        <h2 id="branches">Interest by branch</h2>
        <p className={styles.meta}>Share of each branch&apos;s units, all branches, 100 = the branch where it takes the biggest share.</p>
        {empty ? <Empty height={180}>No sales for these in the period.</Empty> : (
          <div className={styles.scroll}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Branch</th>
                  {t.terms.map((s, i) => <th key={s.key} scope="col" className="num"><SeriesKey i={i} /> {s.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {t.branches.map((b) => (
                  <tr key={b.branchId} data-current={b.branchId === branchId ? "" : undefined}>
                    <th scope="row">{b.name}{b.branchId === branchId && <span className={styles.meta}> · selected</span>}</th>
                    {b.index.map((v, i) => (
                      <td key={t.terms[i].key} className="num" title={`${b.units[i].toLocaleString("en-GB")} units`}>
                        {v}<Meter value={v} max={100} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className={`${styles.grid} ${styles.section}`}>
        <section className="panel" aria-labelledby="top">
          <h2 id="top">Related products · top</h2>
          {t.top.length === 0 ? <p className={styles.meta}>No sales in the period.</p> : (
            <table>
              <thead><tr><th scope="col">Product</th><th scope="col" className="num">Interest</th></tr></thead>
              <tbody>
                {t.top.map((p) => (
                  <tr key={p.sku}>
                    <th scope="row"><Link href={href([`sku:${p.sku}`])}>{p.name}</Link></th>
                    <td className="num" title={`${p.units.toLocaleString("en-GB")} units`}>{p.index}<Meter value={p.index} max={100} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="panel" aria-labelledby="rising">
          <h2 id="rising">Related products · rising</h2>
          {t.rising.length === 0 ? <p className={styles.meta}>Nothing selling faster in the second half of the period.</p> : (
            <table>
              <thead><tr><th scope="col">Product</th><th scope="col" className="num">Growth</th></tr></thead>
              <tbody>
                {t.rising.map((p) => (
                  <tr key={p.sku}>
                    <th scope="row"><Link href={href([`sku:${p.sku}`])}>{p.name}</Link></th>
                    <td className="num">{p.growth === null ? <span className="pill pill-warning">Breakout</span> : growth(p.growth)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className={styles.meta}>Daily units in the second half of the period against the first. Breakout: no sales in the first half.</p>
        </section>
      </div>
    </>
  );
}
