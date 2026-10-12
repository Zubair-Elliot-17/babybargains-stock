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
});
