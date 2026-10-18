// The data behind a chart, for screen readers. A sibling of the role="img" element, never inside it (R5),
// with sr-only on the table itself so its box stays 1px wide (R6).
export function SrTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map(([first, ...rest], i) => (
          <tr key={i}>
            <th scope="row">{first}</th>
            {rest.map((c, j) => <td key={j}>{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
