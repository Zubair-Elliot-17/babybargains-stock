# TODOs

Deferred during plan review. Each has the context needed to pick it up later.

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

## Public recall feed (P3)
- **What:** adapter mapping a public recall JSON feed (e.g. US CPSC) onto catalogue matches.
- **Cons:** US data for a UK-style chain; fuzzy product matching.
- **Depends on:** Milestone 4 supplier adapters.

## Hero-screen mockups (P3)
- **What:** generate and approve mockups for Recall and Count before more UI work.
- **Depends on:** an OpenAI API key for the gstack designer.
