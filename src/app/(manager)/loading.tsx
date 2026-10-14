// Shown at once on navigation between manager pages while the server renders the next one.
export default function Loading() {
  return (
    <div role="status" aria-label="Loading">
      <div className="skeleton" style={{ height: 32, width: "40%", marginBottom: 24 }} />
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 20, marginBottom: 12 }} />
      ))}
    </div>
  );
}
