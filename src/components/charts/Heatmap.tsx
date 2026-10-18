import styles from "./charts.module.css";
import { SrTable } from "./SrTable";

// Accent tint steps; the last is full accent with white text. Every cell prints its value (R8).
const STEPS = [0.06, 0.2, 0.36, 0.54, 1];

// Rows × columns of HTML cells. Row names collapse to short codes on a phone.
export function Heatmap(props: {
  label: string;
  caption: string;
  cols: string[];
  rows: { name: string; short: string; values: number[]; current?: boolean }[];
  format: (n: number) => string;
}) {
  const max = Math.max(1, ...props.rows.flatMap((r) => r.values));
  const step = (v: number) => (v <= 0 ? -1 : Math.min(STEPS.length - 1, Math.floor((v / max) * STEPS.length)));
  return (
    <div className={styles.chart}>
      <div className={styles.heat} style={{ gridTemplateColumns: `auto repeat(${props.cols.length}, minmax(0, 1fr))` }} role="img" aria-label={props.label}>
        <span />
        {props.cols.map((c) => <span key={c} className={styles.heatCol}>{c}</span>)}
        {props.rows.map((r) => [
          <span key={r.name} className={styles.heatRow} data-current={r.current ? "" : undefined}>
            <span className={styles.full}>{r.name}</span>
            <span className={styles.short}>{r.short}</span>
          </span>,
          ...r.values.map((v, i) => {
            const s = step(v);
            return (
              <span key={`${r.name}-${i}`} className={styles.cell} data-dark={s === STEPS.length - 1 ? "" : undefined}
                style={{ background: s < 0 ? undefined : `color-mix(in srgb, var(--color-accent) ${STEPS[s] * 100}%, white)` }}
                title={`${r.name}, ${props.cols[i]}: ${props.format(v)}`}>
                {props.format(v)}
              </span>
            );
          }),
        ])}
      </div>
      <SrTable caption={props.caption} head={["Branch", ...props.cols]} rows={props.rows.map((r) => [`${r.name}${r.current ? " (selected)" : ""}`, ...r.values.map(props.format)])} />
    </div>
  );
}
