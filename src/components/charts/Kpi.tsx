import styles from "./charts.module.css";

// Signed change chip: arrow, sign and colour together, so colour is never the only signal (AC5).
export function Change({ value, period }: { value: number | null; period: string }) {
  if (value === null || !Number.isFinite(value)) return <span className={styles.change}>– vs {period}</span>;
  const pct = Math.round(value * 1000) / 10;
  const dir = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  return (
    <span className={styles.change} data-dir={dir}>
      <span aria-hidden>{dir === "up" ? "▲" : dir === "down" ? "▼" : "■"}</span> {pct > 0 ? "+" : pct < 0 ? "−" : "±"}
      {Math.abs(pct).toFixed(1)}% vs {period}
    </span>
  );
}

// One stat tile: label, value, then an optional change chip and trend (children).
export function Kpi({ label, value, warn, children }: { label: string; value: string; warn?: boolean; children?: React.ReactNode }) {
  return (
    <div className={styles.kpi}>
      <dt>{label}</dt>
      <dd className={warn ? styles.warn : undefined}>{value}</dd>
      {children && <dd className={styles.kpiFoot}>{children}</dd>}
    </div>
  );
}
