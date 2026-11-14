import styles from "./charts.module.css";
import { SrTable } from "./SrTable";

// Up to five series on one 0-100 index. Series differ by colour and dash, so hue is never the only signal (DESIGN.md "Charts").
export const SERIES = [
  { color: "var(--color-ink)", dash: undefined },
  { color: "var(--color-recall)", dash: "7 4" },
  { color: "var(--color-chart-2)", dash: undefined },
  { color: "var(--color-ink)", dash: "2 4" },
  { color: "var(--color-recall)", dash: "10 3 2 3" },
] as const;

export function SeriesKey({ i }: { i: number }) {
  return (
    <svg className={styles.seriesKey} viewBox="0 0 24 12" aria-hidden focusable="false">
      <line x1="1" y1="6" x2="23" y2="6" style={{ stroke: SERIES[i].color }} strokeDasharray={SERIES[i].dash} />
    </svg>
  );
}

export function TrendChart(props: {
  label: string;
  caption: string;
  names: string[]; // bucket names, oldest first
  series: { name: string; values: number[] }[];
  ticks: { at: number; label: string }[];
  height: number;
}) {
  const { names, series } = props;
  const n = names.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * 1000 : 500);
  const step = 1000 / Math.max(1, n - 1);
  return (
    <div className={styles.chart}>
      <div className={styles.line} style={{ height: props.height }} role="img" aria-label={props.label}>
        <div className={styles.yAxis} aria-hidden>
          {[100, 50, 0].map((v) => <span key={v} style={{ top: `${100 - v}%` }}>{v}</span>)}
        </div>
        <div className={styles.plot}>
          {[0.5, 0].map((f) => <span key={f} className={styles.grid} style={{ top: `${(1 - f) * 100}%` }} />)}
          <svg viewBox="0 0 1000 100" preserveAspectRatio="none" focusable="false">
            {series.map((s, i) => (
              <path
                key={s.name}
                className={styles.stroke}
                style={{ stroke: SERIES[i].color }}
                strokeDasharray={SERIES[i].dash}
                d={s.values.map((v, j) => `${j ? "L" : "M"}${x(j).toFixed(1)} ${100 - v}`).join("")}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {names.map((name, j) => (
              <rect key={name} className={styles.hit} x={x(j) - step / 2} y="0" width={step} height="100">
                <title>{[name, ...series.map((s) => `${s.name}: ${s.values[j]}`)].join("\n")}</title>
              </rect>
            ))}
          </svg>
          <div className={styles.xAxis}>
            {props.ticks.map((t) => <span key={t.at} style={{ left: `${(x(t.at) / 1000) * 100}%` }}>{t.label}</span>)}
          </div>
        </div>
      </div>
      <SrTable caption={props.caption} head={["Period starting", ...series.map((s) => s.name)]} rows={names.map((name, j) => [name, ...series.map((s) => s.values[j])])} />
    </div>
  );
}
