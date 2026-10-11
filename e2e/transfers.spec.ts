import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { MongoClient } from "mongodb";
import { checkLedgerInvariants, projectionDiff } from "@/domain/ledger/read";

test.describe.configure({ mode: "serial" });

interface Suggestion {
  label: string;
  sku: string;
  product: string;
  from: string;
  to: string;
  qty: number;
}

async function signInManager(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: /Manager/ }).click();
  await page.waitForURL(/\/recall/);
}

async function suggestions(page: Page): Promise<Suggestion[]> {
  return page.locator("tbody tr").evaluateAll((rows) =>
    rows.map((r) => {
      const label = r.querySelector("button")!.getAttribute("aria-label")!;
      const [, product, from, to] = /^Review transfer of (.+) from (.+) to (.+)$/.exec(label)!;
      return { label, sku: r.querySelector("th .mono")!.textContent!, product, from, to, qty: Number(r.querySelectorAll("td")[2].textContent) };
    }),
  );
}

// Branch name → id, from the receiving-branch filter.
async function branchIds(page: Page): Promise<Record<string, string>> {
  const options = await page.locator("#to option").evaluateAll((os) => os.map((o) => [o.textContent!, (o as HTMLOptionElement).value]));
  return Object.fromEntries(options.filter(([, id]) => id));
}

const accept = (page: Page, s: Suggestion, ids: Record<string, string>, qty = s.qty, commandId: string = crypto.randomUUID()) =>
  page.request.post("/api/transfers", { data: { commandId, sku: s.sku, fromBranchId: ids[s.from], toBranchId: ids[s.to], qty } });

test.afterAll(async () => {
  // Every accept in this file must leave the ledger exact.
  const client = await MongoClient.connect(readFileSync(".data/e2e-mongo-uri", "utf8"));
  try {
    const db = client.db("bb_e2e");
    expect(await projectionDiff(db)).toEqual([]);
    expect((await checkLedgerInvariants(db)).violations).toEqual([]);
  } finally {
    await client.close();
  }
});

test("manager reviews the top suggestion and accepts it", async ({ page }) => {
  await signInManager(page);
  await page.getByRole("link", { name: "Transfers" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Transfers · \d+ suggestions/);
  const before = await suggestions(page);
  expect(before.length).toBeGreaterThanOrEqual(10);
  await page.screenshot({ path: "e2e/__screens__/transfers-desktop.png", fullPage: true });

  const top = before[0];
  await page.getByRole("button", { name: top.label }).click();
  const panel = page.getByRole("complementary", { name: new RegExp(`^Move ${top.qty} units? · `) });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Batches that move (oldest first)")).toBeVisible();
  await expect(panel.locator("li")).not.toHaveCount(0);
  await expect(panel.getByText(/wks cover|no sales in 8 wks/).first()).toHaveClass(/estimated/);
  // An empty branch says so, rather than an estimate of "0.0 wks".
  await expect(panel).not.toContainText(/\b0\.0 wks/);
  if (/^0 on hand/.test(await page.locator("tbody tr[data-selected] td").nth(1).locator("span").innerText())) {
    await expect(panel).toContainText("out of stock");
  }
  await page.screenshot({ path: "e2e/__screens__/transfers-panel.png", fullPage: true });

  await panel.getByRole("button", { name: "Accept transfer" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Moved ${top.qty} unit` })).toContainText(`from ${top.from} to ${top.to}`);
  await expect(page.getByRole("button", { name: top.label })).toHaveCount(0);
  await expect(page.getByRole("complementary")).toHaveCount(0);
  // The accepted row is gone, so focus lands on the next suggestion rather than dropping to the page.
  await expect(page.locator("tbody button:focus")).toHaveCount(1);
});

test("Review buttons and Close stay disabled while an Accept is in flight", async ({ page }) => {
  await signInManager(page);
  await page.goto("/transfers");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("/api/transfers", async (route) => {
    await held;
    await route.fulfill({ status: 500, json: { error: { code: "INTERNAL", message: "Couldn't save. Retry" } } });
  });
  const [first] = await suggestions(page);
  await page.getByRole("button", { name: first.label }).click();
  await page.getByRole("button", { name: "Accept transfer" }).click();
  await expect(page.getByRole("button", { name: "Moving…" })).toBeDisabled();
  for (const b of await page.locator("tbody button").all()) await expect(b).toBeDisabled();
  // Closing mid-request would hide a failure, so the panel stays put until the answer arrives.
  await expect(page.getByRole("button", { name: "Close" })).toBeDisabled();
  await page.getByRole("heading", { name: /^Move / }).press("Escape");
  await expect(page.getByRole("complementary")).toBeVisible();
  release();
  await expect(page.getByRole("complementary").getByRole("alert")).toContainText("Couldn't save");
  for (const b of await page.locator("tbody button").all()) await expect(b).toBeEnabled();
});

test("the selected row stays on screen beside the panel, without the table running under it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await signInManager(page);
  await page.goto("/transfers");
  const last = page.locator("tbody tr").last();
  await last.scrollIntoViewIfNeeded();
  await last.getByRole("button").click();
  await expect(page.getByRole("complementary")).toBeVisible();
  await expect(page.locator("tbody tr[data-selected]")).toBeInViewport({ ratio: 0.95 });
  const tableRight = await page.locator("table").evaluate((t) => t.getBoundingClientRect().right);
  const panelLeft = await page.getByRole("complementary").evaluate((a) => a.getBoundingClientRect().left);
  expect(tableRight).toBeLessThanOrEqual(panelLeft);
});

test("an unknown receiving branch says so instead of showing an empty list", async ({ page }) => {
  await signInManager(page);
  await page.goto("/transfers?to=BR-NOPE");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("isn't a branch");
  await expect(page.getByText("No branch is both over its cover")).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("alert").getByRole("link", { name: "Show all branches" })).toHaveAttribute("href", "/transfers");
});

test("filtering by receiving branch shows only transfers into it", async ({ page }) => {
  await signInManager(page);
  await page.goto("/transfers");
  const [first] = await suggestions(page);
  await page.getByLabel("Receiving branch").selectOption({ label: first.to });
  await page.getByRole("button", { name: "Show" }).click();
  await page.waitForURL(/\/transfers\?to=/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(`into ${first.to}`);
  const rows = await suggestions(page);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r) => r.to === first.to)).toBe(true);
});

test("accept API refuses stale quantities, replays a resent command and refuses same-branch moves", async ({ page }) => {
  await signInManager(page);
  await page.goto("/transfers");
  const ids = await branchIds(page);
  const [s] = await suggestions(page);

  const over = await accept(page, s, ids, s.qty + 1);
  expect(over.status()).toBe(409);
  expect((await over.json()).error).toMatchObject({ code: "SUGGESTION_STALE", details: { suggestedQty: s.qty } });

  const commandId = crypto.randomUUID();
  const ok = await accept(page, s, ids, s.qty, commandId);
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toMatchObject({ result: { moved: s.qty }, replayed: false });
  const again = await accept(page, s, ids, s.qty, commandId);
  expect(await again.json()).toMatchObject({ result: { moved: s.qty }, replayed: true });

  const same = await page.request.post("/api/transfers", { data: { commandId: crypto.randomUUID(), sku: s.sku, fromBranchId: ids[s.from], toBranchId: ids[s.from], qty: 1 } });
  expect(same.status()).toBe(400);
  expect((await same.json()).error.code).toBe("SAME_BRANCH");
});

test("a branch that is counting stock is left out, and accepting into it is refused", async ({ page, browser }) => {
  await signInManager(page);
  await page.goto("/transfers");
  const ids = await branchIds(page);
  const [s] = await suggestions(page);

  // A clerk at the receiving branch starts a stocktake.
  const clerk = await browser.newContext();
  await clerk.request.post("/api/session", { data: { role: "clerk", branchId: ids[s.to] } });
  const opened = await clerk.request.post("/api/stocktakes", { data: { commandId: crypto.randomUUID() } });
  expect(opened.ok()).toBeTruthy();
  const stocktakeId = (await opened.json()).result._id;
  try {
    await page.reload();
    await expect(page.getByRole("note").filter({ hasText: "Left out while a stocktake is in progress" })).toContainText(s.to);
    const rows = await suggestions(page);
    expect(rows.some((r) => r.from === s.to || r.to === s.to)).toBe(false);

    const refused = await accept(page, s, ids);
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error.code).toBe("STOCKTAKE_OPEN");
  } finally {
    await clerk.request.post(`/api/stocktakes/${stocktakeId}/submit`, { data: { commandId: crypto.randomUUID(), uncounted: "leave" } });
    await clerk.close();
  }
});

test("clerk sessions cannot accept transfers", async ({ request }) => {
  const clerk = await request.post("/api/session", { data: { role: "clerk", branchId: "BR-BRS" } });
  expect(clerk.ok()).toBeTruthy();
  const res = await request.post("/api/transfers", { data: { commandId: crypto.randomUUID(), sku: "X", fromBranchId: "BR-A", toBranchId: "BR-B", qty: 1 } });
  expect(res.status()).toBe(403);
});
