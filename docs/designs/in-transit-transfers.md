# In-transit transfers

Status: built (2026-10-15). Replaces Milestone 3's instant transfers (plan-m3 chose them on purpose; TODOS.md "In-transit transfers").

## Problem
Accept posts `TRANSFER_OUT` at the donor and `TRANSFER_IN` at the recipient at once. Until the van arrives, the
recipient's system stock includes goods that aren't there: a stocktake there shows a false shortage when they are
missing, and a sale there can be allocated to units still on the road.

## Decisions
1. **A virtual location, `IN-TRANSIT`.** Accept (dispatch) moves the units from the donor into `IN-TRANSIT`; the
   recipient's confirmation moves them from `IN-TRANSIT` to the recipient. Both pairs share the transfer's `refId`, so
   every transfer still nets to zero and the ledger invariants, projection and fold are unchanged. It is not a branch:
   no policies, no stocktakes, never in branch lists.
2. **Recalls reach goods on the road.** A recall pulls `IN-TRANSIT` rows like any other location; the recall screen
   shows them as "In transit". Receiving a transfer skips lines whose batch was recalled meanwhile (already quarantined).
3. **The recipient confirms.** A clerk at the receiving branch sees "Incoming stock" on their home screen and taps
   Received. Refused while that branch has a stocktake open (same rule as Accept).
4. **Suggestions count goods on the way.** Units in transit to a branch count towards its stock, so the same shortfall
   isn't suggested twice. Stock and dead-stock views show shelf stock only.
5. **Seed history stays instant** (past transfers were delivered); only new transfers go through `IN-TRANSIT`.
6. Nightly reset deletes visitor transfers with their movements, as for orders.

## Out of scope
Partial receipt (a short delivery), dispatch notes, cancelling a dispatched transfer.
