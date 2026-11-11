// Wordmark only: the name in the UI face, "Stock" as a small mono tag on the accent.
export function Wordmark() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", lineHeight: 1 }}>
      <span style={{ fontWeight: 600, fontSize: 17, letterSpacing: "-0.03em" }}>BabyBargains</span>{" "}
      <span className="mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", padding: "3px 5px", borderRadius: 4, background: "var(--color-ticket)", color: "var(--color-ink)", textTransform: "uppercase" }}>Stock</span>
    </span>
  );
}
