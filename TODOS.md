# TODOs

Deferred during plan review. Each has the context needed to pick it up later.

## Public recall feed (P3)
- **What:** adapter mapping a public recall JSON feed (e.g. US CPSC) onto catalogue matches.
- **Cons:** US data for a UK-style chain; fuzzy product matching.
- **Depends on:** Milestone 4 supplier adapters.

## Hero-screen mockups (P3)
- **What:** generate and approve mockups for Recall and Count before more UI work.
- **Depends on:** an OpenAI API key for the gstack designer.

## UI overhaul review leftovers (P3)
- **Panel clip:** `.panel { overflow: clip }` hides non-table overflow from the manager-phone overflow check, and its order against `.scroll` depends on the cascade.
- **Partial today:** weekday averages and the 30-day vs previous-30 KPI count today's unfinished day.
- **ABC values:** the ABC chart shows its values only on hover (the sr-only table has them).
- **Orphan SKUs:** revenue from SKUs missing from the catalogue makes category shares add up to less than 100%.
- **Link encoding:** analytics links build `?to=`/branch hrefs from an unencoded branchId (values come from the DB allowlist).
