import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createSession } from "@/auth/session";
import { cols } from "@/domain/collections";
import { checkLedgerInvariants, listTransferSuggestions, loadTransferInputs, projectionDiff } from "@/domain/ledger/read";
import { acceptTransferSuggestion, quarantineBatch, receiveStock } from "@/domain/ledger/write";
import { migrate, writeSeed } from "@/seed/apply";
import { FULL, generateSeed } from "@/seed/generate";
import { freshDb } from "./helpers";
import { COT, NEW, OLD, buildWorld, runner } from "./world";

// Tester-owned acceptance checks for Milestone 3 that the implementer's tests do not cover.

let t: Awaited<ReturnType<typeof freshDb>>;
// The transfers page checks the manager role itself (requireManagerPage), so it needs a session cookie.
let token = "";
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: token }) }) }));
let run: ReturnType<typeof runner>;

beforeAll(async () => (t = await freshDb()));
afterAll(() => t.close());

describe("transfers acceptance (ledger)", () => {
  beforeEach(async () => {
    await t.db.dropDatabase();
    await migrate(t.db);
    await buildWorld(t.db);
    run = runner(t.client, t.db);
    await cols(t.db).stockPolicies.insertMany([
      { _id: `BR-A:${COT}`, branchId: "BR-A", sku: COT, reorderPoint: 1, overstockWeeks: 6 },
      { _id: `BR-B:${COT}`, branchId: "BR-B", sku: COT, reorderPoint: 2, overstockWeeks: 6 },
    ]);
    // Alpha holds an older batch (B-1) and a newer one (B-2); Bravo has none.
    await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-A", sku: COT, batchId: OLD, qty: 6 }));
    await run((c, s, k) => receiveStock(c, s, k, { branchId: "BR-A", sku: COT, batchId: NEW, qty: 6 }));
  });

  it("never counts or moves stock from a RECALLED batch, even when it is the oldest", async () => {
    await run((c, s, k) => quarantineBatch(c, s, k, { batchCode: "B-1" }));
    const [cot] = await loadTransferInputs(cols(t.db), new Date(), { sku: COT });
    expect(cot.branches.find((b) => b.branchId === "BR-A")!.onHand).toBe(6);

    const view = await listTransferSuggestions(t.db);
    expect(view.suggestions).toHaveLength(1);
    expect(view.suggestions[0].preview).toEqual([{ batchCode: "B-2", qty: 3 }]);

    const { result } = await run((c, s, k) =>
      acceptTransferSuggestion(c, s, k, { sku: COT, fromBranchId: "BR-A", toBranchId: "BR-B", qty: 3 }),
    );
    expect(result.allocations).toEqual([{ batchId: NEW, qty: 3 }]);
    const moved = await cols(t.db).movements.find({ refType: "transfer" }).toArray();
    expect(moved.every((m) => m.batchId === NEW)).toBe(true);
    expect(await cols(t.db).inventory.findOne({ branchId: "BR-B", batchId: OLD })).toBeNull();
    expect((await checkLedgerInvariants(t.db)).violations).toEqual([]);
    expect(await projectionDiff(t.db)).toEqual([]);
  });

  it("with every batch recalled, the donor has nothing to offer", async () => {
    await run((c, s, k) => quarantineBatch(c, s, k, { batchCode: "B-1" }));
    await run((c, s, k) => quarantineBatch(c, s, k, { batchCode: "B-2" }));
    expect((await listTransferSuggestions(t.db)).suggestions).toEqual([]);
    await expect(
      run((c, s, k) => acceptTransferSuggestion(c, s, k, { sku: COT, fromBranchId: "BR-A", toBranchId: "BR-B", qty: 1 })),
    ).rejects.toMatchObject({ code: "SUGGESTION_STALE", details: { suggestedQty: 0 } });
  });

  it("a replayed commandId posts nothing, even with a different body", async () => {
    const first = await run(
      (c, s, k) => acceptTransferSuggestion(c, s, k, { sku: COT, fromBranchId: "BR-A", toBranchId: "BR-B", qty: 2 }),
      { commandId: "acc-same" },
    );
    const count = () => cols(t.db).movements.countDocuments({ refType: "transfer" });
    expect(await count()).toBe(2);
    const same = await run(
      (c, s, k) => acceptTransferSuggestion(c, s, k, { sku: COT, fromBranchId: "BR-A", toBranchId: "BR-B", qty: 2 }),
      { commandId: "acc-same" },
    );
    expect(same).toEqual({ result: first.result, replayed: true });
    const different = await run(
      (c, s, k) => acceptTransferSuggestion(c, s, k, { sku: COT, fromBranchId: "BR-A", toBranchId: "BR-B", qty: 1 }),
      { commandId: "acc-same" },
    );
    expect(different).toEqual({ result: first.result, replayed: true });
    expect(await count()).toBe(2);
    expect(await projectionDiff(t.db)).toEqual([]);
  });

  // One read of the OPEN stocktakes feeds both the suggestions and the "blocked" note, so they can't disagree.
  it("the suggestions list reads the stocktakes collection once", async () => {
    await t.db.command({ profile: 2 });
    try {
      await listTransferSuggestions(t.db);
    } finally {
      await t.db.command({ profile: 0 });
    }
    const reads = await t.db.collection("system.profile").find({ ns: `${t.db.databaseName}.stocktakes` }).project({ op: 1, command: 1 }).toArray();
    expect(reads).toHaveLength(1);
  });
});

describe("transfers page on FULL data", () => {
  it("the server page loads suggestions and builds its markup in under a second", async () => {
    const anchor = new Date();
    const db = t.client.db(`${t.db.databaseName}_page`);
    const saved = { uri: process.env.MONGODB_URI, db: process.env.MONGODB_DB };
    token = createSession("manager").token;
    try {
      await writeSeed(db, generateSeed({ ...FULL, anchor }), anchor);
      process.env.MONGODB_URI = inject("mongoUri");
      process.env.MONGODB_DB = db.databaseName;
      const { default: TransfersPage } = await import("@/app/(manager)/transfers/page");
      await TransfersPage({ searchParams: Promise.resolve({}) }); // warm the cached client
      const timings: number[] = [];
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        const el = await TransfersPage({ searchParams: Promise.resolve({}) });
        timings.push(performance.now() - started);
        const markup = JSON.stringify(el.props);
        expect(markup).not.toContain("Couldn't load suggestions");
        expect(markup).toMatch(/\d+ suggestions/);
      }
      console.log(`transfers page on FULL: ${timings.map((ms) => ms.toFixed(0)).join(", ")} ms`);
      expect(Math.max(...timings)).toBeLessThan(1000);
    } finally {
      process.env.MONGODB_URI = saved.uri;
      process.env.MONGODB_DB = saved.db;
      await db.dropDatabase();
    }
  });
});
