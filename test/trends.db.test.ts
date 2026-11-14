import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cols } from "@/domain/collections";
import { parseTerms, trends } from "@/domain/ledger/trends";
import { migrate } from "@/seed/apply";
import { freshDb } from "./helpers";
import { COT, TOY, buildWorld } from "./world";

let t: Awaited<ReturnType<typeof freshDb>>;
const DAY = 86_400_000;
const NOW = new Date("2026-06-30T12:00:00Z");
const TODAY = Date.UTC(2026, 5, 30);

// One salesDays doc per branch-day, `ago` days before NOW.
const sale = (branchId: string, ago: number, lines: { sku: string; qty: number }[]) => {
  const day = new Date(TODAY - ago * DAY);
  return { _id: `${branchId}:${day.toISOString().slice(0, 10)}`, branchId, day, lines: lines.map((l) => ({ ...l, unitPrice: 100, allocations: [] })) };
};

beforeAll(async () => (t = await freshDb()));
afterAll(() => t.close());
beforeEach(async () => {
  await t.db.dropDatabase();
  await migrate(t.db);
  await buildWorld(t.db);
  await cols(t.db).salesDays.insertMany([
    sale("BR-A", 25, [{ sku: TOY, qty: 2 }]), // earlier half of 30d
    sale("BR-A", 2, [{ sku: TOY, qty: 6 }, { sku: COT, qty: 1 }]),
    sale("BR-B", 0, [{ sku: COT, qty: 5 }, { sku: TOY, qty: 1 }]), // today
    sale("BR-B", 40, [{ sku: COT, qty: 9 }]), // outside 30d
  ]);
});

describe("trends", () => {
  it("parses terms against the catalogue, dropping unknown and duplicates", () => {
    const products = [{ _id: COT }, { _id: TOY }];
    expect(parseTerms(["cat:toy", "cat:toy", "cat:nope", `sku:${COT}`, "sku:GONE", "junk", ""], products)).toEqual([{ kind: "cat", id: "toy" }, { kind: "sku", id: COT }]);
    expect(parseTerms(["cat:cot", "cat:pram", "cat:monitor", "cat:clothing", "cat:toy", `sku:${TOY}`], products)).toHaveLength(5);
  });

  it("indexes the busiest bucket to 100 and reads branch share, top and rising", async () => {
    const r = await trends(t.db, { terms: [{ kind: "cat", id: "toy" }, { kind: "sku", id: COT }], range: "30d", now: NOW });
    expect(r.buckets).toHaveLength(30);
    expect(r.buckets.at(-1)).toBe("2026-06-30");
    const [toy, cot] = r.terms;
    expect(toy.units).toBe(9);
    expect(cot.units).toBe(6); // the 40-day-old sale is out of range
    expect(toy.values[27]).toBe(100); // 6 toys two days ago is the peak
    expect(cot.values[29]).toBe(83); // 5 / 6
    expect(toy.values[4]).toBe(33); // 2 / 6

    // BR-A sold 8 toys of 9 units, BR-B 1 of 6: toy share is highest at A.
    expect(r.branches.map((b) => [b.code, b.units, b.index])).toEqual([["AA", [8, 1], [100, 13]], ["BB", [1, 5], [19, 100]]]);

    expect(r.top.map((p) => [p.sku, p.units, p.index])).toEqual([[TOY, 9, 100], [COT, 6, 67]]);
    // TOY: 2 early, 7 late; COT: 6 late, none early (breakout first).
    expect(r.rising.map((p) => [p.sku, p.growth])).toEqual([[COT, null], [TOY, 2.5]]);
  });

  it("filters the time series by branch and handles no sales", async () => {
    const r = await trends(t.db, { terms: [{ kind: "sku", id: COT }], range: "30d", branchId: "BR-A", now: NOW });
    expect(r.terms[0].units).toBe(1);
    const none = await trends(t.db, { terms: [{ kind: "cat", id: "pram" }], range: "12m", now: NOW });
    expect(none.buckets).toHaveLength(52);
    expect(none.terms[0]).toMatchObject({ units: 0, avg: 0 });
    expect(none.top).toEqual([]);
  });
});
