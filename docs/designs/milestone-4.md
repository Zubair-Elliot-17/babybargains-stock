# Milestone 4: Record sale, Stock, Orders, Analytics

Status: decided by lead 2026-10-14 (user delegated all decisions). Smallest version of each screen that does
the core job from the original plan (`~/.gstack/projects/zubair/zubair-unknown-design-20261009-201818.md`,
Milestone 4 and design D7/D23).

## Screens
1. **Record sale (clerk, `/sale`)**: till-style basket reusing the count search + stepper. Lines carry the
   price; the button reads "Record sale £184.97". Posts `recordSale` (FIFO, already built and reset-safe).
   Short stock refuses the whole sale and shows "System shows only N" on the line. One commandId per basket
   attempt, so a resend never records twice.
2. **Stock (manager, `/stock`)**: on-hand by product for one branch or all, search, low-stock first, with
   reorder point and status (Low / OK).
3. **Orders (manager, `/orders`)**: purchase orders. New order: pick branch + supplier; lines prefill with
   that supplier's products below reorder point at that branch (qty up to 2 × reorder point). Create = SENT
   (no draft step). Receive: received qty + batch code per line, posts RECEIVED movements and upserts batches;
   status PARTIAL / RECEIVED. Cancel an order with nothing received. Recalled batch codes are refused.
4. **Analytics (manager, `/analytics`)**: exceptions first: low stock, dead stock (on hand, no sale in 90
   days), overdue orders (sent > 7 days, not received). Then sales by month (12 months, branch/category
   filter), top movers (30 days), and order stats (open orders, average lead time, fill rate).

## Data
- New validated collection `purchaseOrders`: `_id, supplierId, branchId, status (SENT|PARTIAL|RECEIVED|CANCELLED),
  lines[{sku, ordered, received}], sentAt, receivedAt?, origin`. Visitor orders are removed by the nightly reset
  (their RECEIVED movements and batches already are). No seeded orders: no re-seed.
- RECEIVED movements from an order use refType "delivery", refId = order id.

## Not in scope (named, skipped)
- Draft orders, editing a sent order, supplier JSON delivery-note import and catalogue import UI: a receive
  form does the job; imports stay a TODO.
- Charts beyond one bar chart; CSV export.
