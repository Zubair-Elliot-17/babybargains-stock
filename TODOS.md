# TODOs

Deferred during plan review. Each has the context needed to pick it up later.

## In-transit transfers (P3)
- **What:** model a transfer as dispatch then receive (an in-transit holding location confirmed by the
  recipient) instead of an instant `TRANSFER_OUT/IN` pair.
- **Why:** between Accept and the goods arriving, a stocktake at either branch sees a mismatch and a
  sale at the donor can be refused for units still on its shelf.
- **Context:** Milestone 3 chose instant transfers on purpose (plan-m3); Accept assumes the stock moves now.

## Transfers at scale (P3)
- **What:** covering index `{type, at, branchId, sku, qty}` (or a 56-day sales rollup) for the SOLD read;
  cap the suggestion list with a "showing N of M" note; fetch recalled batch ids once and start the
  `?to=` prefilter alongside the stocktake read. UX: let the toast stay while hovered/focused or add a
  dismiss button; make row-header product names read as primary text (`--text-table`, `--color-ink`).
- **Why:** fine at demo size (~45 ms on FULL), but cost grows with history and catalogue size.

## Team stocktakes (P3)
- **What:** several clerks join one branch stocktake, with a per-clerk sync heartbeat gating Submit.
- **Why:** real stocktake days split aisles across staff.
- **Cons:** the most complex flow and the flakiest E2E test.
- **Context:** `stocktakeLines` will already store `clerkId`; add `stocktakeParticipants` and a join UI.
- **Depends on:** Milestone 2.

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
