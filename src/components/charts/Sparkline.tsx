import styles from "./charts.module.css";

const W = 96;
const H = 28;

// Word-sized trend line, drawn at its pixel size so the end dot stays round. Decorative unless labelled.
export function Sparkline({ values, label }: { values: number[]; label?: string }) {
  const max = Math.max(1, ...values);
  const x = (i: number) => (values.length > 1 ? (i / (values.length - 1)) * (W - 6) + 3 : W / 2);
  const y = (v: number) => H - 3 - (v / max) * (H - 6);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join("");
  const last = values.length - 1;
  return (
    <svg className={styles.spark} width={W} height={H} viewBox={`0 0 ${W} ${H}`} {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })} focusable="false">
      <path d={d} />
      {last >= 0 && <circle cx={x(last)} cy={y(values[last])} r="2.5" />}
    </svg>
  );
}
