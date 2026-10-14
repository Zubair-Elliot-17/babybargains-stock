# TODOs

Deferred during plan review. Each has the context needed to pick it up later.

## Velocity window: 56 whole days (P3)
- **What:** end the transfers velocity window at today 00:00 UTC so it covers 56 whole days.
- **Why:** today it is 55 whole days plus today's partial day over 8 weeks, so early in the UTC day
  velocity reads up to ~1.8% low and a donor near its overstock line can give slightly more.
- **Context:** `until`/`since` in `loadTransferInputs` (`src/domain/ledger/read.ts`); tests that count
  today's sales (`test/transfers.db.test.ts`) will need sales dated yesterday.

## In-transit transfers (P3)
- **What:** model a transfer as dispatch then receive (an in-transit holding location confirmed by the
  recipient) instead of an instant `TRANSFER_OUT/IN` pair.
- **Why:** between Accept and the goods arriving, a stocktake at either branch sees a mismatch and a
  sale at the donor can be refused for units still on its shelf.
- **Context:** Milestone 3 chose instant transfers on purpose (plan-m3); Accept assumes the stock moves now.

## Receive racing a recall (P3)
- **What:** take the branch lock in `receiveStock` (`await lockBranches(c, s, [input.branchId])`).
- **Why:** it checks `batch.status` without writing anything the recall writes, so a receive racing a
  recall could post RECEIVED onto a just-recalled batch.
- **Context:** `receiveStock` in `src/domain/ledger/write.ts`; a recall locks every branch. No API route
  calls it today (tests only), so fix it before adding a deliveries route.

## Quarantined lines in the stocktake review totals (P3)
- **What:** leave quarantined units out of the review's "Net units", and say why a quarantined line
  shown at £0.00 is still flagged (e.g. "(£60.00 if sellable)" in its note), or flag it on units only.
- **Why:** found units on a recalled batch never reach on-hand stock, but they still count towards Net
  units and can flag the line by retail value.
- **Context:** `net` in `src/components/stocktakes/ReviewScreen.tsx`; flagging in `planLine`
  (`src/domain/ledger/stocktake.ts`). Found in the review of the found-units fix.

## Rate limits per IP, not only per session (P3)
- **What:** add an IP-based limit on demo session creation or on the `quarantine` action class.
- **Why:** budgets are per session, so minting new demo sessions resets the one-recall-per-hour limit.
- **Context:** `src/app/api/session/route.ts` creates sessions; budgets and `consume` live in
  `src/auth/rateLimit.ts`.

## Transfers at scale (P3)
- **What:** covering index `{type, at, branchId, sku, qty}` (or a 56-day sales rollup) for the SOLD read;
  cap the suggestion list with a "showing N of M" note; fetch recalled batch ids once and start the
  `?to=` prefilter alongside the stocktake read. UX: let the toast stay while hovered/focused or add a
  dismiss button; make row-header product names read as primary text (`--text-table`, `--color-ink`).
- **Why:** fine at demo size (~45 ms on FULL), but cost grows with history and catalogue size.

## Code tidy-ups from the Milestone 3 review (P3)
- **What:** define the SAME_BRANCH error once (route, `transferStock`, `acceptTransferSuggestion`); export an
  `UNBATCHED` batch-code constant; rename `sold56` to `soldInWindow` and refer to `VELOCITY_WEEKS` in
  comments; hash a canonical raw body (or version the fingerprint) so a schema change can't turn a
  cross-deploy retry into 409 `COMMAND_ID_REUSED`.

## Team stocktakes (P3)
- **What:** several clerks join one branch stocktake, with a per-clerk sync heartbeat gating Submit.
- **Why:** real stocktake days split aisles across staff.
- **Cons:** the most complex flow and the flakiest E2E test.
- **Context:** `stocktakeLines` will already store `clerkId`; add `stocktakeParticipants` and a join UI.
- **Depends on:** Milestone 2.

## Open the count page offline (P3)
- **What:** cache the count page shell and catalogue with a service worker so a reload in a stockroom dead spot
  still opens the count screen; the offline queue itself is unchanged.
- **Why:** after the offline count queue, counts survive a reload, but a reload with no signal shows the browser's
  offline page until signal returns.
- **Cons:** service-worker caching and update complexity; harder E2E tests.
- **Context:** premise 4 of docs/designs/offline-count-queue.md kept this out of that sprint.
- **Depends on:** the offline count queue.

## Phone layouts for secondary manager screens (P3)
- **What:** <768px layouts for Stock, Stocktakes, Transfers, Orders, Imports, Analytics.
- **Context:** Recall and the clerk screens already have phone layouts; follow the Recall pattern.

## Stockout-adjusted velocity for transfers (P3)
- **What:** estimate demand on days a branch was out of stock instead of counting only recorded sales.
- **Why:** a branch that sold out looks slower than it is, so it is under-refilled and can look like
  a donor sooner after a restock.
- **Context:** velocity is SOLD over 8 weeks in `loadTransferInputs`; days at zero on hand can be
  derived from the ledger.

## Per-session cap on transfer accepts (P3)
- **What:** a separate rate-limit class for `acceptTransfer`, if visitors drain the suggestion list.
- **Context:** accepts use the `general` budget (60/hour); the nightly reset restores the seeded
  scenario. Not added in Milestone 3 by decision.

## Public recall feed (P3)
- **What:** adapter mapping a public recall JSON feed (e.g. US CPSC) onto catalogue matches.
- **Cons:** US data for a UK-style chain; fuzzy product matching.
- **Depends on:** Milestone 4 supplier adapters.

## Hero-screen mockups (P3)
- **What:** generate and approve mockups for Recall and Count before more UI work.
- **Depends on:** an OpenAI API key for the gstack designer.

## Supplier delivery-note and catalogue imports (P3)
- **What:** import a supplier's delivery note (JSON) against an order, and a catalogue import with a diff preview.
- **Why:** the original plan's adapter pattern; Milestone 4 receives deliveries with a form instead.
- **Context:** `receivePurchaseOrder` in `src/domain/ledger/orders.ts` already takes `{sku, qty, batchCode}` lines; an adapter maps a supplier format onto it.
