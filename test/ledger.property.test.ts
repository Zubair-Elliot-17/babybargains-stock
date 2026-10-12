import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "@/domain/errors";
import { cols } from "@/domain/collections";
import { checkLedgerInvariants, computeStocktakePlan, listTransferSuggestions, projectionDiff } from "@/domain/ledger/read";
import { acceptTransferSuggestion, approveStocktake, openStocktake, quarantineBatch, receiveStock, recordSale, saveCountLine, submitStocktake, transferStock } from "@/domain/ledger/write";
import { migrate } from "@/seed/apply";
import { freshDb } from "./helpers";
import { COT, NEW, OLD, TOY, TOYB, buildWorld, runner } from "./world";

let t: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => (t = await freshDb()));
afterAll(() => t.close());

const branch = fc.constantFrom("BR-A", "BR-B");
const qty = fc.integer({ min: 1, max: 4 });
const sku = fc.constantFrom(COT, TOY);

const policies = () =>
  ["BR-A", "BR-B"].flatMap((branchId) => [COT, TOY].map((sku) => ({ _id: `${branchId}:${sku}`, branchId, sku, reorderPoint: 2, overstockWeeks: 2 })));

const command = fc.oneof(
  fc.record({ kind: fc.constant("receive" as const), branchId: branch, pick: fc.constantFrom<[string, string]>([COT, OLD], [COT, NEW], [TOY, TOYB]), qty }),
  fc.record({ kind: fc.constant("sale" as const), branchId: branch, lines: fc.array(fc.record({ sku, qty }), { minLength: 1, maxLength: 2 }) }),
  fc.record({ kind: fc.constant("transfer" as const), from: branch, sku, qty }),
  fc.record({ kind: fc.constant("quarantine" as const), batchCode: fc.constantFrom("B-1", "B-2", "B-9") }),
  // Accept one of the current suggestions, sometimes asking for one unit more than suggested.
  fc.record({ kind: fc.constant("accept" as const), pick: fc.nat(), extra: fc.constantFrom(0, 0, 1) }),
);

describe("ledger properties", () => {
  it("random command sequences keep every invariant and an exact projection", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 25 }), async (cmds) => {
        await t.db.dropDatabase();
        await migrate(t.db);
        await buildWorld(t.db);
        await cols(t.db).stockPolicies.insertMany(policies());
        const run = runner(t.client, t.db);
        for (const x of cmds) {
          try {
            if (x.kind === "receive") {
              const [s, batchId] = x.pick;
              await run((c, ss, k) => receiveStock(c, ss, k, { branchId: x.branchId, sku: s, batchId, qty: x.qty }));
            } else if (x.kind === "sale") {
              await run((c, ss, k) => recordSale(c, ss, k, { branchId: x.branchId, lines: x.lines }));
            } else if (x.kind === "transfer") {
              const to = x.from === "BR-A" ? "BR-B" : "BR-A";
              await run((c, ss, k) => transferStock(c, ss, k, { fromBranchId: x.from, toBranchId: to, sku: x.sku, qty: x.qty }));
            } else if (x.kind === "quarantine") {
              await run((c, ss, k) => quarantineBatch(c, ss, k, { batchCode: x.batchCode }));
            } else {
              const { suggestions } = await listTransferSuggestions(t.db);
              const s = suggestions[x.pick % Math.max(1, suggestions.length)];
              if (s) await run((c, ss, k) => acceptTransferSuggestion(c, ss, k, { sku: s.sku, fromBranchId: s.fromBranchId, toBranchId: s.toBranchId, qty: s.qty + x.extra }));
            }
          } catch (err) {
            if (!(err instanceof DomainError)) throw err; // expected rejections only
          }
        }
        const report = await checkLedgerInvariants(t.db);
        expect(report.violations).toEqual([]);
        expect(await projectionDiff(t.db)).toEqual([]);
      }),
      { numRuns: 40 },
    );
  });
});

const transferStep = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("accept" as const), pick: fc.nat(), extra: fc.constantFrom(0, 0, 0, 1) }), weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant("receive" as const), branchId: branch, pick: fc.constantFrom<[string, string]>([COT, OLD], [COT, NEW], [TOY, TOYB]), qty }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("sale" as const), branchId: branch, sku, qty }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("stocktake" as const), branchId: branch }), weight: 1 },
);

describe("transfer accept properties", () => {
  it("accepting suggestions amid trading and stocktakes keeps every invariant and never overdraws a donor", async () => {
    let accepted = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(transferStep, { minLength: 1, maxLength: 15 }), async (steps) => {
        await t.db.dropDatabase();
        await migrate(t.db);
        await buildWorld(t.db);
        await cols(t.db).stockPolicies.insertMany(policies());
        const run = runner(t.client, t.db);
        await run((c, ss, k) => receiveStock(c, ss, k, { branchId: "BR-A", sku: COT, batchId: OLD, qty: 6 }));
        await run((c, ss, k) => receiveStock(c, ss, k, { branchId: "BR-A", sku: TOY, batchId: TOYB, qty: 8 }));
        for (const x of steps) {
          try {
            if (x.kind === "accept") {
              const { suggestions } = await listTransferSuggestions(t.db);
              const s = suggestions[x.pick % Math.max(1, suggestions.length)];
              if (!s) continue;
              await run((c, ss, k) => acceptTransferSuggestion(c, ss, k, { sku: s.sku, fromBranchId: s.fromBranchId, toBranchId: s.toBranchId, qty: s.qty + x.extra }));
              expect(x.extra).toBe(0); // asking for more than suggested must be refused
              accepted++;
              const after = await cols(t.db).inventory.find({ branchId: s.fromBranchId, sku: s.sku }).toArray();
              expect(after.reduce((n, r) => n + r.onHand, 0)).toBeGreaterThanOrEqual(s.from.keep);
            } else if (x.kind === "receive") {
              const [sk, batchId] = x.pick;
              await run((c, ss, k) => receiveStock(c, ss, k, { branchId: x.branchId, sku: sk, batchId, qty: x.qty }));
            } else if (x.kind === "sale") {
              await run((c, ss, k) => recordSale(c, ss, k, { branchId: x.branchId, lines: [{ sku: x.sku, qty: x.qty }] }));
            } else {
              await run((c, ss, k) => openStocktake(c, ss, k, { branchId: x.branchId, sid: `p-${x.branchId}`, clerkLabel: "P" }));
            }
          } catch (err) {
            if (!(err instanceof DomainError)) throw err;
          }
        }
        expect((await checkLedgerInvariants(t.db)).violations).toEqual([]);
        expect(await projectionDiff(t.db)).toEqual([]);
      }),
      { numRuns: 30 },
    );
    expect(accepted).toBeGreaterThan(5); // the property must actually exercise successful accepts
  });
});

const stocktakeStep = fc.oneof(
  fc.record({ kind: fc.constant("count" as const), pick: fc.constantFrom<[string, string | undefined]>([COT, OLD], [COT, NEW], [TOY, undefined]), counted: fc.integer({ min: 0, max: 8 }), mode: fc.constantFrom("add" as const, "replace" as const) }),
  fc.record({ kind: fc.constant("sale" as const), sku: fc.constantFrom(COT, TOY), qty: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ kind: fc.constant("receive" as const), pick: fc.constantFrom<[string, string]>([COT, OLD], [COT, NEW], [TOY, TOYB]), qty: fc.integer({ min: 1, max: 4 }) }),
);

describe("stocktake properties", () => {
  it("counts interleaved with trading, then approval, keep every invariant", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stocktakeStep, { minLength: 1, maxLength: 20 }), fc.constantFrom("zero" as const, "leave" as const), async (steps, uncounted) => {
        await t.db.dropDatabase();
        await migrate(t.db);
        await buildWorld(t.db);
        const run = runner(t.client, t.db);
        await run((c, ss, k) => receiveStock(c, ss, k, { branchId: "BR-A", sku: TOY, batchId: TOYB, qty: 3 }));
        const st = (await run((c, ss, k) => openStocktake(c, ss, k, { branchId: "BR-A", sid: "p", clerkLabel: "P" }))).result;
        let n = 0;
        for (const x of steps) {
          try {
            if (x.kind === "count") {
              const [sku, batchId] = x.pick;
              await run((c, ss, k) => saveCountLine(c, ss, k, { stocktakeId: st._id, lineId: `l${n++}`, sid: "p", sku, batchId, counted: x.counted, mode: x.mode }));
            } else if (x.kind === "sale") {
              await run((c, ss, k) => recordSale(c, ss, k, { branchId: "BR-A", lines: [{ sku: x.sku, qty: x.qty }] }));
            } else {
              const [sku, batchId] = x.pick;
              await run((c, ss, k) => receiveStock(c, ss, k, { branchId: "BR-A", sku, batchId, qty: x.qty }));
            }
          } catch (err) {
            if (!(err instanceof DomainError)) throw err;
          }
        }
        await run((c, ss, k) => submitStocktake(c, ss, k, { stocktakeId: st._id, sid: "p", uncounted }));
        const plan = await computeStocktakePlan(cols(t.db), st._id);
        await run((c, ss, k) => approveStocktake(c, ss, k, { stocktakeId: st._id, acceptedKeys: plan.lines.map((l) => l.key) }));
        expect((await checkLedgerInvariants(t.db)).violations).toEqual([]);
        expect(await projectionDiff(t.db)).toEqual([]);
      }),
      { numRuns: 30 },
    );
  });
});
