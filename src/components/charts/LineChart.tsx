import styles from "./charts.module.css";
import { SrTable } from "./SrTable";

// Area + 2px line over a fixed-height plot. Axis text is HTML, so it doesn't stretch with the viewBox.
export function LineChart(props: {
  label: string;
  caption: string;
  head: [string, string];
  points: { name: string; value: number }[];
  ticks: { at: number; label: string }[];
  format: (n: number) => string;
  height: number;
}) {
  const { points, format } = props;
  const max = niceCeil(Math.max(1, ...points.map((p) => p.value)));
  const n = points.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * 1000 : 500);
  const y = (v: number) => 100 - (v / max) * 100;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.value).toFixed(2)}`).join("");
  const last = points.at(-1);
  return (
    <div className={styles.chart}>
      <div className={styles.line} style={{ height: props.height }} role="img" aria-label={props.label}>
        <div className={styles.yAxis} aria-hidden>
          {[1, 0.5, 0].map((f) => <span key={f} style={{ top: `${(1 - f) * 100}%` }}>{format(max * f)}</span>)}
        </div>
        <div className={styles.plot}>
          {[0.5, 0].map((f) => <span key={f} className={styles.grid} style={{ top: `${(1 - f) * 100}%` }} />)}
          <svg viewBox="0 0 1000 100" preserveAspectRatio="none" focusable="false">
            <path className={styles.area} d={`${line}L1000 100L0 100Z`} />
            <path className={styles.stroke} d={line} vectorEffect="non-scaling-stroke" />
            {points.map((p, i) => (
              <rect key={p.name} className={styles.hit} x={x(i) - 500 / Math.max(1, n - 1)} y="0" width={1000 / Math.max(1, n - 1)} height="100">
                <title>{`${p.name}: ${format(p.value)}`}</title>
              </rect>
            ))}
          </svg>
          {last && <span className={styles.endDot} style={{ left: "100%", top: `${y(last.value)}%` }} />}
          <div className={styles.xAxis}>
            {props.ticks.map((t) => <span key={t.at} style={{ left: `${(x(t.at) / 1000) * 100}%` }}>{t.label}</span>)}
          </div>
        </div>
      </div>
      <SrTable caption={props.caption} head={props.head} rows={points.map((p) => [p.name, format(p.value)])} />
    </div>
  );
}

// 1, 2 or 5 times a power of ten, at or above n: clean axis maxima.
export function niceCeil(n: number): number {
  const p = 10 ** Math.floor(Math.log10(n));
  return ([1, 2, 5, 10].find((m) => m * p >= n) ?? 10) * p;
}
