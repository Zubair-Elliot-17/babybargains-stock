import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BarList } from "@/components/charts/BarList";
import { Heatmap } from "@/components/charts/Heatmap";
import { LineChart, niceCeil } from "@/components/charts/LineChart";
import { Sparkline } from "@/components/charts/Sparkline";
import { StackedBar } from "@/components/charts/StackedBar";

// Each chart: a role="img" with a one-sentence label, then a sibling sr-only table (not inside the img).
function parts(el: ReactElement) {
  const html = renderToStaticMarkup(el);
  const [visual, table = ""] = html.split('<table class="sr-only">');
  return { visual, table, label: visual.match(/role="img" aria-label="([^"]*)"/)?.[1], rows: table.match(/<th scope="row">/g)?.length ?? 0 };
}

describe("chart primitives", () => {
  it("line chart labels the plot and lists every point in its table", () => {
    const p = parts(createElement(LineChart, {
      label: "Weekly sales, rising.", caption: "Weekly sales", head: ["Week", "Sales"], height: 320,
      points: [{ name: "w1", value: 5 }, { name: "w2", value: 9 }, { name: "w3", value: 7 }], ticks: [{ at: 0, label: "Oct" }], format: String,
    }));
    expect(p.label).toBe("Weekly sales, rising.");
    expect(p.rows).toBe(3);
    expect(p.visual).not.toContain("<table");
    expect(p.table).toContain('<th scope="col">Week</th>');
  });

  it("bar list marks out-of-band bars in text, not only colour", () => {
    const p = parts(createElement(BarList, {
      label: "Cover by category.", caption: "Cover", head: ["Category", "Cover", "Band", "Status"],
      bars: [{ name: "Cots", value: 9, text: "9.0 wks", band: [2, 6], note: "over" }, { name: "Toys", value: 4, text: "4.0 wks", band: [2, 6] }],
    }));
    expect(p.label).toBe("Cover by category.");
    expect(p.rows).toBe(2);
    expect(p.visual).toContain("over");
    expect(p.table).toContain("<td>in range</td>");
  });

  it("bar list keeps every table row as wide as its header when a bar has no band", () => {
    const p = parts(createElement(BarList, {
      label: "Cover.", caption: "Cover", head: ["Category", "Cover", "Band", "Status"],
      bars: [{ name: "Cots", value: 0, text: "–", note: "no sales" }, { name: "Toys", value: 4, text: "4.0 wks", band: [2, 6] }],
    }));
    expect(p.table).toContain("<th scope=\"row\">Cots</th><td>–</td><td>–</td><td>no sales</td>");
  });

  it("stacked bar has one table row per bar and a legend with values", () => {
    const p = parts(createElement(StackedBar, {
      label: "Stock by age.", caption: "Stock age", series: [{ name: "0–30 days", color: "red" }, { name: "31+ days", color: "blue" }],
      rows: [{ name: "Retail value", values: [3, 1], text: String }],
    }));
    expect(p.rows).toBe(1);
    expect(p.visual).toContain("75%");
    expect(p.table).toContain("<td>3 (75%)</td>");
  });

  it("heatmap prints every value in its cell and names the selected row", () => {
    const p = parts(createElement(Heatmap, {
      label: "Average sales by weekday.", caption: "Weekday", cols: ["Mon", "Tue"], format: (n: number) => `£${n}`,
      rows: [{ name: "Alpha", short: "AA", values: [1, 10] }, { name: "Bravo", short: "BB", values: [0, 5], current: true }],
    }));
    expect(p.rows).toBe(2);
    expect(p.visual).toContain(">£10<");
    expect(p.table).toContain("Bravo (selected)");
  });

  it("sparkline is decorative unless labelled", () => {
    expect(renderToStaticMarkup(createElement(Sparkline, { values: [1, 2] }))).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(createElement(Sparkline, { values: [1, 2], label: "Rising." }))).toContain('aria-label="Rising."');
  });

  it("rounds axis maxima to 1, 2 or 5 times a power of ten", () => {
    expect([niceCeil(1), niceCeil(7), niceCeil(12), niceCeil(26_000), niceCeil(5_000_001)]).toEqual([1, 10, 20, 50_000, 10_000_000]);
  });
});

describe("change chip", () => {
  it("shows a dash, never Infinity, when there is nothing to compare with", async () => {
    const { Change } = await import("@/components/charts/Kpi");
    const html = (v: number | null) => renderToStaticMarkup(createElement(Change, { value: v, period: "previous 30 days" }));
    expect(html(null)).toBe('<span class="' + html(null).match(/class="([^"]*)"/)![1] + '">– vs previous 30 days</span>');
    expect(html(Infinity)).toContain("– vs previous 30 days");
    expect(html(0.042)).toMatch(/▲<\/span> \+4\.2% vs previous 30 days/);
    expect(html(-0.5)).toMatch(/▼<\/span> −50\.0% vs previous 30 days/);
  });
});
