import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
const { ApprovedBanner, ReviewScreen } = await import("@/components/stocktakes/ReviewScreen");

const line = (quarantined: number) => ({
  key: `S|B${quarantined}`, sku: "S", productName: `Cot ${quarantined}`, batchCode: "B-1", counted: quarantined, expected: 0, variance: quarantined,
  valuePence: 100, flagged: false, clampedBy: 0, quarantined, countedAt: "2026-10-10T09:00:00.000Z",
});
const html = (lines: (ReturnType<typeof line> & { lateMs?: number })[]) =>
  renderToStaticMarkup(createElement(ReviewScreen, { stocktakeId: "st", branchName: "Alpha", status: "SUBMITTED", clerkLabel: "C", submittedAt: null, approvedAt: null, lines }));

describe("stocktake review", () => {
  it("flags a line that arrived more than 15 minutes after it was counted", () => {
    expect(html([{ ...line(0), flagged: true, lateMs: 65 * 60_000 }])).toContain("Counted offline, arrived 1h 5m later");
    expect(html([{ ...line(0), flagged: true, lateMs: 15 * 60_000 }])).not.toContain("Counted offline");
    expect(html([{ ...line(0), flagged: true }])).not.toContain("Counted offline");
  });

  it("says found units on a recalled batch will be quarantined", () => {
    expect(html([line(3)])).toContain("Recalled batch: 3 found units quarantined (£1.00 if sellable)");
    expect(html([line(1)])).toContain("Recalled batch: 1 found unit quarantined (£1.00 if sellable)");
    expect(html([line(0)])).not.toContain("Recalled batch");
  });

  // CSS module class names keep the source name (e.g. _warn_1a2b3c), so match on that.
  const row = (markup: string) => markup.match(/<tbody>.*<\/tbody>/)![0];
  it("shows a quarantined line as worth nothing, in neutral variance and a warning note with its would-be value", () => {
    const q = row(html([{ ...line(3), valuePence: 900, flagged: true }]));
    expect(q).toContain('<td class="num">£0.00</td>');
    expect(q).not.toMatch(/_pos_/);
    expect(q).toMatch(/<span class="[^"]*_warn_[^"]*">Recalled batch: 3 found units quarantined \(£9.00 if sellable\)<\/span>/);
  });

  it("leaves quarantined units out of Net units", () => {
    const net = (lines: ReturnType<typeof line>[]) => html(lines).match(/<dt>Net units<\/dt><dd>([^<]*)<\/dd>/)![1];
    expect(net([line(3), { ...line(0), key: "S|found", variance: 2 }, { ...line(0), key: "S|lost", variance: -5 }])).toBe("-3");
    expect(net([line(3)])).toBe("0");
  });

  it("keeps a found-stock line green with its value", () => {
    const found = row(html([{ ...line(0), variance: 2, counted: 2, valuePence: 900 }]));
    expect(found).toContain("£9.00");
    expect(found).toMatch(/_pos_/);
  });

  it("approval banner pluralises units", () => {
    const banner = (unitsRemoved: number, unitsAdded: number, unitsQuarantined?: number) =>
      renderToStaticMarkup(createElement(ApprovedBanner, { result: { adjustedLines: 1, unitsRemoved, unitsAdded, unitsQuarantined, valuePence: 699 } }));
    expect(banner(1, 0)).toContain("Approved: 1 line adjusted, 1 unit removed, 0 added (£6.99 at retail).");
    expect(banner(2, 1)).toContain("2 units removed, 1 added (");
    expect(banner(0, 2, 2)).toContain("0 units removed, 2 added, 2 quarantined (");
  });
});
