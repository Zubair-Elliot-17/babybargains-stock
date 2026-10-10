# BabyBargains Stock

Stock control for a fictional UK chain of baby-goods shops, built on MongoDB with an append-only stock ledger.

> **Recall finder.** Type a batch code and see every unit across every branch and size/colour variant:
> received, transferred, sold, on shelf. Drag the date slider to replay where the batch went, then
> quarantine it everywhere with one typed confirmation and get a pull list for store teams.

<!-- Recall GIF goes here once the live demo is deployed. -->

**Live demo:** [babybargains-stock.vercel.app](https://babybargains-stock.vercel.app) (choose Manager) · Fictional chain, synthetic data, resets nightly.

## Why a ledger, not a counter

Most stock tutorials store `onHand` as a number and decrement it. That answers "how many?" but not
"which ones, where, and since when?", which is exactly what a product recall asks.

Here every change is a movement in `stockMovements` (`RECEIVED`, `SOLD`, `TRANSFER_OUT/IN`,
`ADJUSTMENT`, `RECALLED`), tagged with branch, SKU and supplier batch. `inventory` is a projection of
that ledger, updated in the same transaction.

```
command ─► commandLog insert (duplicate commandId → return the first result)
        ─► FIFO allocation (pure function, shared by seed, server and browser)
        ─► postMovements, one transaction:
              negative qty: inventory.updateOne({.., onHand ≥ n}, {$inc: -n}); no match → abort
              positive qty: inventory upsert {$inc: +n}
              insert stockMovements
```

**Honest numbers.** Tills don't record batch numbers, so a sale's batch is *inferred* oldest-first
(FIFO). The UI says so: estimated figures have a dotted underline and a plain-English tooltip; only
recorded or counted figures are solid.

## What's in Milestone 1

- Polymorphic catalogue (cots, prams, monitors, clothing variants, toys) in one `products`
  collection; Zod schemas are the source of truth and MongoDB `$jsonSchema` validators are generated
  from them, with a drift test.
- Ledger write path: sales (multi-line, all-or-nothing), transfers, quarantine, deliveries. Every
  command is idempotent by `commandId`.
- Recall screen: number strip, day-by-day slider with event ticks and Play, branch table,
  typed-confirm quarantine with a printable pull list. Desktop, tablet and phone layouts.
- Deterministic seed: 15 branches, 300 SKUs, 12 months, ~250k movements, ~125 MB.
- Nightly server-side reset that removes visitor changes and shifts dates to end today, so the
  free Atlas tier never re-uploads the dataset.
- Demo safety: signed session cookie, server-side role checks, per-session rate limits
  (quarantine 1/hour), structured JSON logs per command, `/api/health`.

Stocktake (clerk phone screen), transfer suggestions, orders/imports and analytics are Milestones 2–4.

## Correctness checks

| Check | Where |
|---|---|
| Running balance per branch/SKU/batch never negative; transfers net to zero; nothing touches a batch after its recall; sale allocations match SOLD movements | `checkLedgerInvariants` after every seed and reset, and in tests |
| Live projection equals a fresh fold of the ledger | `projectionDiff` in tests and `npm run verify` |
| Random command sequences keep every invariant | fast-check property test (found a real bug: deliveries into a recalled batch) |
| Concurrent sales of the last unit never oversell | integration test, six concurrent sales |
| Sale vs quarantine in both completion orders | interleaving test |
| Applied validators equal the ones generated from Zod | `test/schemas.test.ts` |

## Run it locally

Requires Node 24. No MongoDB install needed: the dev script runs a real single-node replica set.

```bash
npm install
npm run db:local          # leave running; prints MONGODB_URI
cp .env.example .env.local  # paste the URI, set SESSION_SECRET
npm run seed              # ~10 s, prints sizes and invariant results
npm run dev               # http://localhost:3000 → Manager → batch B-4471
```

| Command | What it does |
|---|---|
| `npm test` | Unit, integration and property tests (in-memory replica set) |
| `npm run test:e2e` | Playwright against a seeded in-memory database |
| `npm run verify -- --batch B-4471` | Invariants, projection diff and a batch's totals |
| `npm run reset` | The nightly reset, on demand |
| `npm run seed -- --profile preview` | Small dataset (3 branches, 60 SKUs) for preview deploys |

## Deploying

1. Create a free MongoDB Atlas cluster with two databases: `bb_demo` (production) and `bb_preview`
   (Vercel previews). Seed both: `MONGODB_DB=bb_demo npm run seed` and
   `MONGODB_DB=bb_preview npm run seed -- --profile preview`.
2. Import the repo into Vercel and set `MONGODB_URI`, `SESSION_SECRET` and `MONGODB_DB` per environment.
   The `vercel-build` script applies the generated validators (moderate level) before `next build`,
   so a failed migration means the deployment is never promoted.
3. Add `MONGODB_URI` as a GitHub Actions secret and set the repo variable `DEMO_DB_READY=true` for the
   nightly reset. A smoke check hits `/api/health` after every successful Vercel deployment.

## Stack

Next.js 16 (App Router) · TypeScript · MongoDB 8 driver · Zod 4 · Vitest + mongodb-memory-server +
fast-check · Playwright. Design tokens and components are documented in [DESIGN.md](DESIGN.md).
