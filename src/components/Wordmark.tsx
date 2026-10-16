// Brand mark (accent square with three stacked boxes) plus the wordmark.
export function Wordmark() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, fontWeight: 600, fontSize: 17, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden focusable="false">
        <rect width="28" height="28" rx="7" fill="var(--color-accent)" />
        <path d="M7.5 14.5h5.75v6H7.5zM14.75 14.5h5.75v6h-5.75zM11.1 7.5h5.8v5.5h-5.8z" fill="#fff" />
      </svg>
      <span>
        BabyBargains <span style={{ color: "var(--color-accent)" }}>Stock</span>
      </span>
    </span>
  );
}
