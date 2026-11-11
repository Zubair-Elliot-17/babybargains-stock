# Design system

"Ledger": a finance-tool look for a stock ledger. White page, warm off-white blocks, hairline cells with
soft corners, Geist for text and Geist Mono caps for labels, black buttons, and one lime that only ever
means "needs action" or "you are here". The benchmark is Ramp's product system (calm, dense, figure-led),
with Katana as the in-field reference for inventory screens. Tokens live as CSS variables in
`src/app/globals.css`.

## What we don't do
No gradients, no drop shadows on cells, no icons in tinted squares, no coloured KPI tiles, no second
accent colour, no decorative illustration. Lime is never text and never a bare mark. Every screen has
one starting point: the page title, then the figure or table that needs action.

## Type
- Geist variable for everything read as text; Geist Mono for SKUs, batch codes, column heads, figure
  labels and the "STOCK" wordmark tag. Both bundled in `src/app/fonts` (SIL OFL, `OFL-geist.txt`).
- Titles 600 with -0.03em tracking; section heads 600; body 400/500; tabular figures everywhere.
- Labels (`.label-caps`, `thead th`): mono, 11px, caps, 0.06em tracking, muted.
- Scale: 11 label · 13 meta · 14 table · 15 body · 17 section · 30 page title (26 phone) ·
  40 figure (30 phone).

## Colour
| Token | Value | Use | Contrast |
|---|---|---|---|
| `--color-ink` (`--color-accent`) | #171512 | text, links, primary buttons, focus, chart marks | 18.22 on white, 16.70 on quiet |
| `--color-ink-muted` | #625E56 | context lines, labels, inactive nav | 6.45 / 5.91 |
| `--color-ticket` | #E4F222 | lime fill only, always behind ink (14.77) | never text or a bare mark (1.23 on white) |
| `--tint-accent`, `--tint-warning` | #F6FBC9 | selected rows, current branch, notices | ink 16.97 |
| `--color-recall` | #C0261D | recall, destructive, stockouts, out-of-band bars, falling change | 5.94 on white, 5.44 on quiet; white on it 5.94 |
| `--tint-recall` | #FCEBE9 | error banner ground | recall on it 5.15 |
| `--color-warning` | #8A5A00 | past-view and kept-offline notices | 5.93 on white, 5.52 on tint |
| `--color-control-border`, `--color-chart-2` | #8A867D | input and button borders, second chart series | 3.63 on white, 3.33 on quiet |
| `--color-hairline` | #E7E4DC | cell edges and row rules (decorative) | — |
| `--color-surface-quiet`, `--color-canvas` | #F6F5F1 | sidebar, table header strip, filter strip, hover, login ground | — |

Lime discipline: the current nav marker, the action figure (e.g. "16 below reorder point"), a Low tag,
the clerk's primary button, the wordmark tag, text selection. Nothing else. If it spreads it stops
meaning anything.

## Structure
- Cells (`.panel`): 1px hairline, 12px radius, 16px padding, content on white. Empty states are a dashed
  cell on the quiet ground.
- Tables: a quiet header strip with rounded ends and mono caps heads, hairline rows, numbers
  right-aligned, a faint row hover. Heads wrap when a table runs out of room, so no table widens the page.
- Status tags (`.pill`): 6px radius. Neutral states are quiet; "OK" shows nothing. Low is ink on lime;
  recalled/quarantined is white on recall red.
- Figure strips (analytics, recall, stocktake summary): one hairline cell split by hairlines, a mono
  caps label over a 40px figure. Change is plain signed text ("▲ +4.5% vs previous 30 days"), falling
  in recall red.
- Radius: 8px on controls, 12px on cells. Shadows only on dialogs and the desktop phone frame; buttons
  and the current nav item or tab carry a 1px edge shadow.
- Analytics is asymmetric: the trend takes two thirds beside the category split; cover, age and ABC
  share a row of three.

## Sidebar (manager)
A 232px sticky sidebar on the quiet ground: wordmark, text nav, then who is signed in and sign out at
the bottom. The current page is a white block with a lime marker edged in ink (`aria-current` names it).
The Stocktakes count is a white figure in a small ink badge. The demo notice is a mono caps line above
the content. Below 1024px the sidebar becomes a top bar and the nav scrolls sideways under the wordmark.

## Clerk phone
The same language in a phone frame (hairline edge with a 28px radius on desktop, 440px wide). The
primary button is ink on lime, 56px tall. Bottom tabs sit on a hairline; the current tab has an ink bar.

## Login
Left, on the quiet ground: a mono caps line with B-4471 on a lime tag, the claim at 64px, and three
numbered points in one hairline cell. Right: the role choice as two hairline cells, no icons.

## Motion
One authored motion: the number strip counts to new values (150 ms ease-out). Hover transitions and the
skeleton shimmer sit inside `prefers-reduced-motion: no-preference`; with reduce, nothing moves.

## Spacing
4px base: 4 / 8 / 12 / 16 / 24 / 32 / 48.

## Components
Table · SidePanel · Dialog (confirm, typed-confirm) · BottomSheet · Stepper · StatusPill (tag) ·
Toast · Skeleton · Banner · Slider · Switch (native `role="switch"` checkbox in its label, 44px target).

## Charts
Hand-made server SVG and HTML in `src/components/charts/`, no chart library and no client JS.
- Every chart is `role="img"` with a one-sentence `aria-label` that states the takeaway, plus a
  `<table class="sr-only">` sibling (never a child: `role="img"` hides children) with a caption and
  `th scope` headers. `.sr-only` tables use `table-layout: fixed` and a wrapping caption so their box
  stays 1px in Chromium and WebKit and never widens the page.
- Fixed heights: 320px for the sales trend, 180px for overview charts. An empty chart is one muted
  sentence at the same height.
- Ink marks (18.22), a 2px ink line with no area fill, hairline gridlines. Band washes are decorative;
  the band's control-border edges carry 3:1.
- Series that must be told apart never rely on hue: ink, `--color-chart-2` (3.63), a diagonal ink hatch,
  then recall red for the oldest stock-age bucket. ABC uses the first three.
- Colour is never the only signal: change text carries an arrow and a sign; out-of-band cover bars are
  recall red and print "over" / "under".
- Heatmap is the one fill exception: ink mixed with white in steps 6/20/36/54/100%, and every cell
  prints its value, so the fill needn't reach 3:1. Ink on each step is 16.13 / 11.84 / 7.93 / 4.68;
  the full step uses white text (18.22). Branch names collapse to codes on a phone.
- Sparklines in the figure strip are `aria-hidden`; the change text states the trend. League
  sparklines are labelled with their 12 weekly values.

## Honest numbers
Counted or recorded figures are solid. Estimated figures (FIFO-attributed sales, expected stock) use a
dotted underline in muted ink, a tooltip and screen-reader text "estimated".

## Copy
Headings name the task or object with live context ("Recall · B-4471"). Utility language, no mood
copy, no exclamation marks.

## Accessibility
44px minimum targets; visible labels; native `<dialog>` for focus trapping and Esc; slider keys
←/→ one day, PgUp/PgDn one week, Home/End; polite live region for the number strip. Checked with no
sideways page scroll at 320, 390, 800, 1024 and 1440 in Chromium and at 390 and 1280 in WebKit.
