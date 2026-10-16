# UI overhaul and richer analytics

**Problem.** The owner says the app "looks plain". Every page is flat white with hairline tables; the
Analytics page has one bar chart under a wall of tables. For a portfolio piece, the first screen a
recruiter sees must look like a product.

**Audience.** Store managers on desktop (recall, stock, transfers, orders, analytics) and clerks on
phones (count, sale). Recruiters skim both in under a minute.

**The one bold idea.** Turn Analytics into the showcase: a KPI strip with change chips and sparklines,
then a set of charts that answer the questions a multi-branch retailer asks (is trade up, where is
stock sitting idle, which branches lag, which products carry the business). All server-rendered SVG,
zero new client JavaScript.

Research: `~/.claude/research/babybargains-ui-overhaul.md`. Baseline screenshots:
`.gstack/browse-reports/ui-before/`.

## Visual system (supersedes parts of DESIGN.md)
- **Surfaces.** Page `--color-canvas` #F3F5F4; content sits in white `.panel`s: 1px `--color-hairline`
  border, 10px radius, no shadow (white on the canvas is ~1.1:1, so the border carries the edge).
  Replaces "tables, not cards" (Decision D-UI1).
- **Grey scale with jobs.** canvas, `--color-surface-quiet` (hover/header), hairline, muted text.
- **Nav rail.** Inline SVG icon per item, inactive items muted, active item accent text on a tinted pill.
  Brand mark (small accent square + wordmark).
- **Page header.** Title, one-line context, filters as a toolbar row.
- **Pills.** Soft tinted fills (status colour at ~10% alpha) with the existing text colours; contrast
  stays ≥4.5:1.
- **Tables.** Inside panels; header row on surface-quiet, row hover, numbers tabular.
- **Login.** Two role cards with icons on a split hero; recall landing gets recent-recall cards.
- Clerk phone screens inherit tokens only; layouts untouched (44px targets, offline flows).

## Analytics (new)
Charts live in `src/components/charts/` (Sparkline, LineChart/area, BarList, Heatmap, StackedBar).
Each has `role="img"`, an `aria-label` summary and a visually hidden data table.

1. **KPI strip:** sales last 30 days (change vs previous 30, daily sparkline), units sold 30 days,
   stock on hand at retail, below reorder point, dead stock value.
2. **Sales trend:** weekly sales, 52 weeks, area line with month ticks (replaces the monthly bars).
3. **Sales by category:** share of last-12-month revenue, bar list.
4. **Weeks of cover by category** against the overstock policy band (healthy = 2..overstockWeeks).
5. **Branch league:** 15 branches, sales 30 days, change, 12-week sparkline, bar in cell.
6. **Weekday pattern:** branch × weekday heatmap of average daily sales over 12 weeks.
7. **Stock age:** on-hand retail value by batch age (0–30, 31–90, 91–180, 180+ days), stacked bar.
8. **ABC split:** share of SKUs vs share of revenue for A (top 80%), B (next 15%), C (last 5%).

Kept: low stock, dead stock, overdue orders, top movers, supplier orders. Left out: shrinkage (88
adjustments in the demo, too thin), supplier lead-time scatter (orders clear nightly), margin/GMROI
(no cost prices).

## Reuse
Existing tokens in globals.css, `cards` phone tables, `insights.ts` queries (`sellable`, salesDays),
`money`/`count` formatters. No chart library (research: Recharts ships ~100 kB client JS and needs
client components; server SVG ships none).

## Verify
vitest for each new metric with a fixed `now`; Playwright E2E unchanged and green; before/after
screenshots at 1440 and 390; axe-style checks via existing a11y E2E; /analytics first-load JS not up.
