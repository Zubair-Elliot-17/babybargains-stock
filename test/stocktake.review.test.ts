import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
const { ReviewScreen } = await import("@/components/stocktakes/ReviewScreen");

const line = (quarantined: number) => ({
  key: `S|B${quarantined}`, sku: "S", productName: `Cot ${quarantined}`, batchCode: "B-1", counted: quarantined, expected: 0, variance: quarantined,
  valuePence: 100, flagged: false, clampedBy: 0, quarantined, countedAt: "2026-10-10T09:00:00.000Z",
});
const html = (lines: ReturnType<typeof line>[]) =>
  renderToStaticMarkup(createElement(ReviewScreen, { stocktakeId: "st", branchName: "Alpha", status: "SUBMITTED", clerkLabel: "C", submittedAt: null, approvedAt: null, lines }));

describe("stocktake review", () => {
  it("says found units on a recalled batch will be quarantined", () => {
    expect(html([line(3)])).toContain("Recalled batch: 3 found units quarantined");
    expect(html([line(1)])).toContain("Recalled batch: 1 found unit quarantined");
    expect(html([line(0)])).not.toContain("Recalled batch");
  });

  // CSS module class names keep the source name (e.g. _warn_1a2b3c), so match on that.
  const row = (markup: string) => markup.match(/<tbody>.*<\/tbody>/)![0];
  it("shows a quarantined line as worth nothing, in neutral variance and a warning note", () => {
    const q = row(html([{ ...line(3), valuePence: 900 }]));
    expect(q).toContain("£0.00");
    expect(q).not.toContain("£9.00");
    expect(q).not.toMatch(/_pos_/);
    expect(q).toMatch(/<span class="[^"]*_warn_[^"]*">Recalled batch: 3 found units quarantined<\/span>/);
  });

  it("keeps a found-stock line green with its value", () => {
    const found = row(html([{ ...line(0), variance: 2, counted: 2, valuePence: 900 }]));
    expect(found).toContain("£9.00");
    expect(found).toMatch(/_pos_/);
  });
});
