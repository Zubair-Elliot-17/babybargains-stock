import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { MongoClient, type Db } from "mongodb";
import { cols } from "@/domain/collections";
import { checkLedgerInvariants, listTransferSuggestions, projectionDiff } from "@/domain/ledger/read";

// Tester-owned acceptance checks for Milestone 3 not covered by transfers.spec.ts.
// Accepts here take 1 unit from a suggestion of 2+ so the suggestion count other specs rely on is unchanged.

test.describe.configure({ mode: "serial" });

let client: MongoClient;
let db: Db;
test.beforeAll(async () => {
  client = await MongoClient.connect(readFileSync(".data/e2e-mongo-uri", "utf8"));
  db = client.db("bb_e2e");
});
test.afterAll(async () => {
  expect(await projectionDiff(db)).toEqual([]);
  expect((await checkLedgerInvariants(db)).violations).toEqual([]);
  await client.close();
});

const transferMoves = () => cols(db).movements.countDocuments({ refType: "transfer" });

async function signInManager(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: /Manager/ }).click();
  await page.waitForURL(/\/recall/);
}

test("no session is refused with 403 and posts nothing", async ({ request }) => {
  const before = await transferMoves();
  const res = await request.post("/api/transfers", {
    data: { commandId: crypto.randomUUID(), sku: "X", fromBranchId: "BR-A", toBranchId: "BR-B", qty: 1 },
  });
  expect(res.status()).toBe(403);
  expect(await transferMoves()).toBe(before);
});

test("a clerk's valid-looking accept is refused with 403 and posts nothing", async ({ request }) => {
  const { suggestions } = await listTransferSuggestions(db);
  const s = suggestions[0];
  expect(s).toBeDefined();
  expect((await request.post("/api/session", { data: { role: "clerk", branchId: s.toBranchId } })).ok()).toBeTruthy();
  const before = await transferMoves();
  const res = await request.post("/api/transfers", {
    data: { commandId: crypto.randomUUID(), sku: s.sku, fromBranchId: s.fromBranchId, toBranchId: s.toBranchId, qty: 1 },
  });
  expect(res.status()).toBe(403);
  expect(await transferMoves()).toBe(before);
});

test("replaying a commandId posts nothing; reusing it with a different body is refused", async ({ page }) => {
  await signInManager(page);
  const { suggestions } = await listTransferSuggestions(db);
  const s = suggestions.find((x) => x.qty >= 2);
  expect(s, "needs a suggestion of 2+ units").toBeDefined();
  const body = { sku: s!.sku, fromBranchId: s!.fromBranchId, toBranchId: s!.toBranchId };
  const commandId = crypto.randomUUID();

  const before = await transferMoves();
  const first = await page.request.post("/api/transfers", { data: { commandId, ...body, qty: 1 } });
  expect(first.status()).toBe(200);
  const firstJson = await first.json();
  expect(firstJson).toMatchObject({ result: { moved: 1 }, replayed: false });
  expect(await transferMoves()).toBe(before + 2);

  const same = await page.request.post("/api/transfers", { data: { commandId, ...body, qty: 1 } });
  expect(await same.json()).toEqual({ result: firstJson.result, replayed: true });
  expect(await transferMoves()).toBe(before + 2);

  const otherBody = await page.request.post("/api/transfers", { data: { commandId, ...body, qty: 2 } });
  expect(otherBody.status()).toBe(409);
  expect((await otherBody.json()).error.code).toBe("COMMAND_ID_REUSED");
  expect(await transferMoves()).toBe(before + 2);
});

test("an out-of-range or malformed body is refused with 400", async ({ page }) => {
  await signInManager(page);
  const base = { sku: "X", fromBranchId: "BR-A", toBranchId: "BR-B" };
  for (const data of [
    { commandId: crypto.randomUUID(), ...base, qty: 0 },
    { commandId: crypto.randomUUID(), ...base, qty: 10_000 },
    { commandId: crypto.randomUUID(), ...base, qty: 1.5 },
    { commandId: "not-a-uuid", ...base, qty: 1 },
  ]) {
    const res = await page.request.post("/api/transfers", { data });
    expect(res.status(), JSON.stringify(data)).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_INPUT");
  }
});

test.describe("below 768px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("shows a needs-a-wider-screen note instead of the table", async ({ page }) => {
    await signInManager(page);
    await page.goto("/transfers");
    await expect(page.getByText("Transfers needs a wider screen. Open it on a tablet or desktop.")).toBeVisible();
    await expect(page.locator("table")).toBeHidden();
  });
});

test("at 768px the table is shown and the note is not", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await signInManager(page);
  await page.goto("/transfers");
  await expect(page.locator("table")).toBeVisible();
  await expect(page.getByText("Transfers needs a wider screen.")).toBeHidden();
});
