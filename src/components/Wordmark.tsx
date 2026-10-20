// Wordmark only: the name set like a shelf-ticket header, "Stock" in the batch-code mono.
export function Wordmark() {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6, whiteSpace: "nowrap", lineHeight: 1 }}>
      <span style={{ fontWeight: 800, fontStretch: "75%", fontSize: 22, letterSpacing: "-0.01em" }}>BabyBargains</span>
      <span className="mono" style={{ fontSize: 12, fontWeight: 500, padding: "2px 4px", background: "var(--color-ticket)", color: "var(--color-ink)" }}>STOCK</span>
    </span>
  );
}
