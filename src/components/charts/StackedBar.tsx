import styles from "./charts.module.css";
import { SrTable } from "./SrTable";

// One or more 100% bars split into ordered segments with 2px gaps, plus a legend that carries the values.
export function StackedBar(props: {
  label: string;
  caption: string;
  series: { name: string; color: string }[];
  rows: { name: string; values: number[]; text: (v: number) => string }[];
}) {
  const { series, rows } = props;
  const single = rows.length === 1;
  return (
    <div className={styles.chart}>
      <div className={styles.stacks} role="img" aria-label={props.label}>
        {rows.map((r) => {
          const total = r.values.reduce((a, b) => a + b, 0);
          return (
            <div key={r.name}>
              {!single && <span className={styles.stackName}>{r.name}</span>}
              <span className={styles.stack}>
                {r.values.map((v, i) => v > 0 && (
                  <span key={series[i].name} style={{ flexGrow: v, background: series[i].color }} title={`${series[i].name}: ${r.text(v)} (${share(v, total)})`} />
                ))}
              </span>
            </div>
          );
        })}
        <ul className={styles.legend}>
          {series.map((s, i) => (
            <li key={s.name}>
              <span className={styles.swatch} style={{ background: s.color }} />
              {s.name}
              {single && <strong>{rows[0].text(rows[0].values[i])} · {share(rows[0].values[i], rows[0].values.reduce((a, b) => a + b, 0))}</strong>}
            </li>
          ))}
        </ul>
      </div>
      <SrTable
        caption={props.caption}
        head={["", ...series.map((s) => s.name)]}
        rows={rows.map((r) => { const t = r.values.reduce((a, b) => a + b, 0); return [r.name, ...r.values.map((v) => `${r.text(v)} (${share(v, t)})`)]; })}
      />
    </div>
  );
}

const share = (v: number, total: number) => `${total ? Math.round((v / total) * 1000) / 10 : 0}%`;
