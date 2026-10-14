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
| `--color-accent` | #0E6B5C | links, primary buttons, focus | 6.41 / 5.85 |
| `--color-recall` | #B42318 | recall, destructive | 6.57 / 6.0 |
| `--color-warning` | #B54708 | past-view chip, warnings | 5.43 / 4.96 |
| `--color-control-border` | #7F8B87 | input and button borders | 3.53 / 3.23 |
| `--color-hairline` | #DCE1DF | dividers only (decorative) | — |

## Shape and motion
- 6px radius on inputs and buttons only. Hairline dividers; tables, not cards.
- No shadows except dialogs (`0 8px 24px rgba(0,0,0,.12)`).
- One authored motion: the number strip counts to new values (150 ms ease-out), off under
  `prefers-reduced-motion`.

## Spacing
4px base: 4 / 8 / 12 / 16 / 24 / 32 / 48.

## Components
Table · SidePanel · Dialog (confirm, typed-confirm) · BottomSheet · Stepper · StatusPill
(counted / expected / recalled / waiting: `--color-warning` text and 1px border, no fill) · Toast · Skeleton ·
Banner · Slider · Switch (native `role="switch"` checkbox in its label, 44px target, accent when on).

## Honest numbers
Counted or recorded figures are solid. Estimated figures (FIFO-attributed sales, expected stock) use a
dotted underline in text colour, a tooltip and screen-reader text "estimated".

## Copy
Headings name the task or object with live context ("Recall · B-4471"). Utility language, no mood
copy, no exclamation marks.

## Accessibility
44px minimum targets; visible labels; native `<dialog>` for focus trapping and Esc; slider keys
←/→ one day, PgUp/PgDn one week, Home/End; polite live region for the number strip.
