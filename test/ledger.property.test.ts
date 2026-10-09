import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "@/domain/errors";
import { checkLedgerInvariants, projectionDiff } from "@/domain/ledger/read";
import { quarantineBatch, receiveStock, recordSale, transferStock } from "@/domain/ledger/write";
import { migrate } from "@/seed/apply";
import { freshDb } from "./helpers";
import { COT, NEW, OLD, TOY, TOYB, buildWorld, runner } from "./world";

let t: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => (t = await freshDb()));
afterAll(() => t.close());

const branch = fc.constantFrom("BR-A", "BR-B");
const qty = fc.integer({ min: 1, max: 4 });
const sku = fc.constantFrom(COT, TOY);

const command = fc.oneof(
  fc.record({ kind: fc.constant("receive" as const), branchId: branch, pick: fc.constantFrom<[string, string]>([COT, OLD], [COT, NEW], [TOY, TOYB]), qty }),
  fc.record({ kind: fc.constant("sale" as const), branchId: branch, lines: fc.array(fc.record({ sku, qty }), { minLength: 1, maxLength: 2 }) }),
  fc.record({ kind: fc.constant("transfer" as const), from: branch, sku, qty }),
  fc.record({ kind: fc.constant("quarantine" as const), batchCode: fc.constantFrom("B-1", "B-2", "B-9") }),
);

describe("ledger properties", () => {
  it("random command sequences keep every invariant and an exact projection", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 25 }), async (cmds) => {
        await t.db.dropDatabase();
        await migrate(t.db);
        await buildWorld(t.db);
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
            } else {
              await run((c, ss, k) => quarantineBatch(c, ss, k, { batchCode: x.batchCode }));
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
