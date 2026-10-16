import styles from "./charts.module.css";
import { SrTable } from "./SrTable";

export interface Bar {
  name: string;
  value: number;
  text: string; // the value as shown at the bar's tip
  band?: [number, number]; // healthy range on the same scale
  note?: string; // text marker, e.g. "over" (colour is never the only signal)
}

// Horizontal bars from one baseline, each optionally against its own band.
export function BarList({ label, caption, head, bars, max }: { label: string; caption: string; head: string[]; bars: Bar[]; max?: number }) {
  const top = max ?? Math.max(1, ...bars.map((b) => Math.max(b.value, b.band?.[1] ?? 0)));
  const pct = (v: number) => `${Math.min(100, (v / top) * 100)}%`;
  return (
    <div className={styles.chart}>
      <div className={styles.bars} role="img" aria-label={label}>
        {bars.map((b) => (
          <div key={b.name} className={styles.barRow} title={`${b.name}: ${b.text}${b.note ? ` (${b.note})` : ""}`}>
            <span className={styles.barName}>{b.name}</span>
            <span className={styles.track}>
              {b.band && <span className={styles.band} style={{ left: pct(b.band[0]), width: `calc(${pct(b.band[1])} - ${pct(b.band[0])})` }} />}
              <span className={styles.bar} data-tone={b.note ? "warn" : undefined} style={{ width: pct(b.value) }} />
            </span>
            <span className={styles.barValue}>
              {b.text}
              {b.note && <span className={styles.note}> {b.note}</span>}
            </span>
          </div>
        ))}
      </div>
      <SrTable caption={caption} head={head} rows={bars.map((b) => [b.name, b.text, ...(b.band ? [`${b.band[0].toFixed(1)}–${b.band[1].toFixed(1)}`, b.note ?? "in range"] : [])])} />
    </div>
  );
}

// A thin bar inside a table cell; the cell's number says the same thing, so it is decorative.
export function Meter({ value, max, tone }: { value: number; max: number; tone?: "warn" }) {
  return (
    <span className={styles.meter} aria-hidden>
      <span data-tone={tone} style={{ width: `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%` }} />
    </span>
  );
}
