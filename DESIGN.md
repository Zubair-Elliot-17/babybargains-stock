# Design system

Operational app UI: calm, dense but readable, few colours. Use scene: a back office and a bright shop
floor, so the app is light with high contrast. Tokens live as CSS variables in `src/app/globals.css`.

## Type
- Instrument Sans for UI and body, 16px base, tabular figures everywhere.
- IBM Plex Mono only for SKUs and batch codes.
- Scale: 13 meta · 14 table · 16 body · 20 section · 28 page title · 40 number strip. Weights 400/500/600.

## Colour
| Token | Value | Use | Contrast on white / #F3F5F4 |
|---|---|---|---|
| `--color-ink` | #1F2A2E | text | 14.7 / 13.4 |
| `--color-ink-muted` | #4D5A57 | context lines, meta, inactive nav | 7.20 / 6.58 |
| `--color-accent` | #0E6B5C | links, primary buttons, focus | 6.41 / 5.85 |
| `--color-recall` | #B42318 | recall, destructive | 6.57 / 6.0 |
| `--color-warning` | #B54708 | past-view chip, warnings | 5.43 / 4.96 |
| `--color-control-border` | #7F8B87 | input and button borders | 3.53 / 3.23 |
| `--color-hairline` | #DCE1DF | dividers and panel borders (decorative) | — |

Grey scale has jobs: `--color-canvas` (#F3F5F4) is the manager shell background; `--color-surface`
(white) is a panel; `--color-surface-quiet` (#F3F5F4) is table headers, hover and empty bar tracks;
hairline draws edges; muted is secondary text. Clerk screens stay on white.

Tints are the colour mixed 10% with white (`--tint-accent/-warning/-recall`), never transparent, so text
on them reads the same on a panel and on the canvas: accent 5.53, recall 5.58, warning 4.72 on its own
tint; ink 12.67 and muted 6.21 on the accent tint (selected rows, current nav item).

## Shape and motion
- 6px radius on inputs and buttons; 10px on panels.
- Panels on a canvas (D-UI1, replaces "tables, not cards"): manager content sits in white `.panel`s
  with a hairline border on the grey canvas. A panel's own table runs edge to edge with a quiet header
  row. Page header (`.page-head`): the h1 with live context, one muted context line, then filters.
- No shadows except dialogs (`0 8px 24px rgba(0,0,0,.12)`).
- One authored motion: the number strip counts to new values (150 ms ease-out). Hover transitions
  and the skeleton shimmer sit inside `prefers-reduced-motion: no-preference`; with reduce, nothing moves.

## Spacing
4px base: 4 / 8 / 12 / 16 / 24 / 32 / 48.

## Components
Table · SidePanel · Dialog (confirm, typed-confirm) · BottomSheet · Stepper · StatusPill
(neutral: muted text on surface-quiet; `.pill-warning` / `.pill-recall` / `.pill-active`: the colour's
text on its tint; all with a 1px border at 28% of the text colour; the label always says the state) · Toast · Skeleton ·
Banner · Slider · Switch (native `role="switch"` checkbox in its label, 44px target, accent when on).

## Nav rail
Desktop: a muted rail on the canvas with a 20px inline SVG icon (`aria-hidden`) and label per item;
the current page is accent text on the accent tint, 600 weight. Tablet (≤1023px): 76px rail, icon over
a short label. Phone: a top bar of text links, icons hidden. Brand: accent square plus wordmark.

## Charts
Hand-made server SVG and HTML in `src/components/charts/`, no chart library and no client JS.
- Every chart is `role="img"` with a one-sentence `aria-label` that states the takeaway, plus a
  `<table class="sr-only">` sibling (never a child: `role="img"` hides children) with a caption and
  `th scope` headers. `.sr-only` tables use `table-layout: fixed` and a wrapping caption so their box
  stays 1px in Chromium and WebKit and never widens the page.
- Fixed heights: 320px for the sales trend, 180px for overview charts. An empty chart is one muted
  sentence at the same height.
- Marks are ≥3:1 on white: accent 6.41, warning 5.43, `#4A9085` 3.74, control border 3.53 (band
  edges). Area fills and band washes are decorative; the line or edge carries the contrast.
- Stock age uses an ordered ramp: accent, #4A9085, control border, then warning for the oldest bucket.
  ABC uses the first three steps.
- Colour is never the only signal: change chips carry an arrow and a sign; out-of-band cover bars
  carry "over" / "under".
- Heatmap is the one fill exception: accent mixed with white in steps 6/20/36/54/100%, and every cell
  prints its value, so the fill needn't reach 3:1. Ink on each step is 13.47 / 10.83 / 8.34 / 5.99;
  the full step uses white text (6.41). Branch names collapse to codes on a phone.
- Sparklines in KPI tiles are `aria-hidden`; the tile's change chip states the trend. League
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
