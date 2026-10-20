# Design system

"Stock ticket": the app is printed like the shop's own paperwork (shelf-edge tickets, batch labels,
count sheets). Ink on paper, ruled not boxed, and one ticket-yellow that only ever means "needs action"
or "you are here". Research and the rejected directions: `~/.claude/research/babybargains-ui-rework.md`.
Tokens live as CSS variables in `src/app/globals.css`.

## What we don't do (the template tells)
No panels or cards on a grey canvas, no KPI tile row, no pill chips, no icons in tinted squares, no
sidebar of line icons, no rounded-square logo, no gradients. Every screen has one starting point: the
page title, then the figure or table that needs action.

## Type
- Archivo variable (weight 100-900, width 62-125%), bundled in `src/app/fonts`.
- Body and tables: width 100, 400/500, tabular figures everywhere.
- Titles, section heads and headline figures: width 75, weight 800 (titles, figures) or 700 (sections).
- Column headers and nav: width 87.5, weight 600, sentence case.
- IBM Plex Mono for SKUs, batch codes and the "STOCK" wordmark tag only.
- Scale: 13 meta · 15 table · 16 body · 20 section · 40 page title (32 phone) · 56 figure (44 phone).

## Colour
| Token | Value | Use | Contrast |
|---|---|---|---|
| `--color-ink` (`--color-accent`) | #141414 | text, links, primary buttons, focus, chart marks | 18.42 on white, 16.58 on shelf |
| `--color-ink-muted` | #57544D | context lines, meta, inactive nav | 7.55 / 6.80 |
| `--color-ticket` | #FFD100 | fill only, always behind ink (12.61) | never text or a bare mark (1.46 on white) |
| `--tint-accent` | #FFF4B8 | selected rows, current branch | ink 16.57 |
| `--color-recall` | #B8141B | recall, destructive, stockouts, out-of-band bars, falling change | 6.66; white on it 6.66 |
| `--color-warning` | #9C6B00 | past-view and kept-offline notices | 4.65 |
| `--color-control-border` | #76736C | input and button borders | 4.73 |
| `--color-chart-2` | #8A8781 | second chart series | 3.58 |
| `--color-hairline` | #D9D7D1 | row rules (decorative) | — |
| `--color-surface-quiet` | #F3F3F1 | shelf: table header strip, filter strip, login ground | — |

Yellow discipline: the current nav item, the action figure (e.g. "16 below reorder point"), a low-stock
ticket, the clerk's primary button, the wordmark tag. Nothing else. If it spreads it stops meaning anything.

## Structure
- Sections open on a 2px ink rule with the condensed title under it (`h2` and `.panel` both do this);
  content sits on the paper. No section has a border box. The one bordered object is the login's
  batch label.
- Tables: shelf header strip closed by a 1px ink rule, hairline rows, numbers right-aligned.
- Status tickets (`.pill`): rectangles with a 2px radius. Neutral states are quiet outlines; "OK" shows
  nothing. Low is ink on yellow with an ink edge; recalled/quarantined is white on recall red.
- Figure strips (analytics, recall, stocktake summary): one ruled row, 2px ink above, 1px ink below,
  hairlines between, big condensed figure over a muted label. Change is plain signed text
  ("▲ +4.5% vs previous 30 days"), falling in recall red.
- Radius: 2px on controls; 0 on sections. Shadows only on dialogs.
- Analytics is asymmetric: the trend takes two thirds beside the category split; cover, age and ABC
  share a row of three.

## Masthead (manager)
An ink demo bar, then wordmark, text nav and sign out on one line, closed by a 2px ink rule. The current
page is a yellow block with a 4px ink bar on the rule (`aria-current` names it). The Stocktakes count is
a white figure in a small ink box. Phone: the nav scrolls sideways under the wordmark.

## Clerk phone
Same masthead language in a phone frame (2px ink edge on desktop). The primary button is ink on yellow,
56px tall. Bottom tabs: 2px ink rule; the current tab has a 4px ink bar.

## Login
Left: a printed batch label (B-4471 on a yellow tag, the claim at 72px condensed, numbered points, a
decorative `aria-hidden` barcode). Right: the role choice as tear-off tickets (dashed top edge), no icons.

## Motion
One authored motion: the number strip counts to new values (150 ms ease-out). Hover transitions and the
skeleton shimmer sit inside `prefers-reduced-motion: no-preference`; with reduce, nothing moves.

## Spacing
4px base: 4 / 8 / 12 / 16 / 24 / 32 / 48.

## Components
Table · SidePanel · Dialog (confirm, typed-confirm) · BottomSheet · Stepper · StatusPill (ticket) ·
Toast · Skeleton · Banner · Slider · Switch (native `role="switch"` checkbox in its label, 44px target).

## Charts
Hand-made server SVG and HTML in `src/components/charts/`, no chart library and no client JS.
- Every chart is `role="img"` with a one-sentence `aria-label` that states the takeaway, plus a
  `<table class="sr-only">` sibling (never a child: `role="img"` hides children) with a caption and
  `th scope` headers. `.sr-only` tables use `table-layout: fixed` and a wrapping caption so their box
  stays 1px in Chromium and WebKit and never widens the page.
- Fixed heights: 320px for the sales trend, 180px for overview charts. An empty chart is one muted
  sentence at the same height.
- Ink marks (18.42), square-ended bars, a 2px ink line with no area fill, an ink baseline and hairline
  gridlines. Band washes are decorative; the band's 2px control-border edges carry 3:1.
- Series that must be told apart never rely on hue: ink, `--color-chart-2` (3.58), a diagonal ink hatch,
  then recall red for the oldest stock-age bucket. ABC uses the first three. Legend swatches carry a
  1px ink edge.
- Colour is never the only signal: change text carries an arrow and a sign; out-of-band cover bars are
  recall red and print "over" / "under".
- Heatmap is the one fill exception: ink mixed with white in steps 6/20/36/54/100%, and every cell
  prints its value, so the fill needn't reach 3:1. Ink on each step is 16.31 / 11.94 / 7.93 / 4.66;
  the full step uses white text (18.42). Branch names collapse to codes on a phone.
- Sparklines in the figure strip are `aria-hidden`; the change text states the trend. League
  sparklines are labelled with their 12 weekly values.

## Honest numbers
Counted or recorded figures are solid. Estimated figures (FIFO-attributed sales, expected stock) use a
dotted underline in text colour, a tooltip and screen-reader text "estimated".

## Copy
Headings name the task or object with live context ("Recall · B-4471"). Utility language, no mood
copy, no exclamation marks.

## Accessibility
44px minimum targets; visible labels; native `<dialog>` for focus trapping and Esc; slider keys
←/→ one day, PgUp/PgDn one week, Home/End; polite live region for the number strip.
