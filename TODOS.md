# TODOs

Deferred during plan review. Each has the context needed to pick it up later.

## Found units on a recalled batch (P1)
- **What:** stocktake approval posts a positive count variance straight onto the counted batch, even
  when that batch is RECALLED (`planLine` in `src/domain/ledger/stocktake.ts`). That puts sellable-looking
  stock back on a recalled batch and breaks the "nothing touches a batch after its recall" invariant.
- **Why:** recalled units found on a shelf must stay quarantined, not return to stock.
- **Context:** found in the Milestone 3 /ship review. Transfers already ignore stock on RECALLED batches
  (`loadTransferInputs`); recall pull lists and stock screens don't. Decide whether approval records
  found recalled units as a quarantine movement or refuses the line, then add a ledger property case.

## Team stocktakes (P3)
- **What:** several clerks join one branch stocktake, with a per-clerk sync heartbeat gating Submit.
- **Why:** real stocktake days split aisles across staff.
- **Cons:** the most complex flow and the flakiest E2E test.
- **Context:** `stocktakeLines` will already store `clerkId`; add `stocktakeParticipants` and a join UI.
- **Depends on:** Milestone 2.

## Offline count queue (P2)
- **What:** localStorage queue, sync badge and disabled Submit while queued.
- **Why:** stockroom dead spots lose counts.
- **Context:** per-line saves are idempotent by `lineId`, so the queue is additive.
- **Depends on:** Milestone 2.

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
