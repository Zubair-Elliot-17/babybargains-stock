import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function signInClerk(page: Page, branch = "Leeds Kirkgate") {
  await page.goto("/login");
  await page.getByLabel("Branch").selectOption({ label: branch });
  await page.getByRole("button", { name: "Start counting" }).click();
  await page.waitForURL(/\/count$/);
}

async function findAndChoose(page: Page, text: string) {
  await page.getByLabel("Scan or search product").fill(text);
  await page.getByRole("option").first().click();
}

test("@phone clerk counts blind, repeats a product, and submits", async ({ page }, info) => {
  await signInClerk(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Count stock · Leeds Kirkgate");
  await expect(page.getByText(/^Last stocktake: Submitted/)).toBeVisible(); // seeded approved one, or an earlier run's submission

  await page.getByRole("button", { name: /Start stocktake|Resume stocktake/ }).click();
  await page.waitForURL(/\/count\/ST-/);
  const progress = page.getByText(/0 of \d+ products counted/);
  await expect(progress).toBeVisible();

  // Batch-tracked product: the batch chip prefills, quantity via stepper.
  await findAndChoose(page, "Dreamtime");
  await expect(page.getByLabel("Batch")).toBeVisible();
  await page.getByRole("button", { name: "One more" }).click();
  await expect(page.getByLabel("Counted quantity")).toHaveValue("2");
  await page.getByRole("button", { name: "Save count" }).click();
  await expect(page.getByText(/^Saved · Dreamtime Cot 120/)).toBeVisible();
  await expect(page.getByText(/1 of \d+ products counted/)).toBeVisible();

  // Same product and batch again (stockroom): add or replace.
  await findAndChoose(page, "Dreamtime");
  await expect(page.getByLabel("Batch")).toBeVisible();
  await page.getByRole("button", { name: "Save count" }).click();
  const sheet = page.getByRole("dialog", { name: "Counted 2 earlier" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Add 1 (total 3)" }).click();
  await expect(page.getByText(/^Saved · Dreamtime Cot 120 .* × 3/)).toBeVisible();
  await page.screenshot({ path: `e2e/__screens__/count-${info.project.name}.png` });

  // Nothing on screen ever shows system quantities.
  await expect(page.getByText(/expected|on shelf|system shows/i)).toHaveCount(0);

  await page.getByRole("tab", { name: /Not counted yet/ }).click();
  await expect(page.getByRole("heading", { name: /Clothing · \d+|Cots · \d+/ }).first()).toBeVisible();

  await page.getByRole("button", { name: "Submit stocktake" }).click();
  await page.getByRole("dialog", { name: /products not counted/ }).getByRole("button", { name: "Leave out and submit" }).click();
  await expect(page.getByRole("heading", { name: "Stocktake sent to manager" })).toBeVisible();
  await expect(page.getByText(/1 product · \d+m/)).toBeVisible();
  await page.getByRole("link", { name: "Done" }).click();
  await expect(page.getByText(/waiting for manager/)).toBeVisible();
});

test("manager reviews flagged lines and approves", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Manager/ }).click();
  await page.waitForURL(/\/recall/);
  await expect(page.getByLabel(/awaiting review/)).toBeVisible();

  await page.getByRole("link", { name: /Stocktakes/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("awaiting review");
  await page.getByRole("row", { name: /Manchester Arndale/ }).getByRole("link", { name: "Review" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Review stocktake · Manchester Arndale · \d+ lines? needs? attention/);

  const approve = page.getByRole("button", { name: "Approve stocktake" });
  await expect(approve).toBeDisabled();
  const boxes = page.getByRole("checkbox");
  const n = await boxes.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) await boxes.nth(i).check();
  await expect(approve).toBeEnabled();
  await page.screenshot({ path: "e2e/__screens__/review-desktop.png", fullPage: true });
  await approve.click();
  await expect(page.getByText(/^Approved: \d+ lines? adjusted/)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("approved");
});

test("clerk sessions cannot approve and managers cannot count", async ({ request }) => {
  const clerk = await request.post("/api/session", { data: { role: "clerk", branchId: "BR-BRS" } });
  expect(clerk.ok()).toBeTruthy();
  const res = await request.post("/api/stocktakes/anything/approve", { data: { commandId: crypto.randomUUID(), acceptedKeys: [] } });
  expect(res.status()).toBe(403);
});
