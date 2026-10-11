import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: /Manager/ }).click();
  await page.waitForURL(/\/recall\?batch=B-4471/);
}

test.describe.configure({ mode: "serial" });

test("signed-out visitors are sent to the demo login", async ({ page }) => {
  await page.goto("/recall");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: "Start counting" })).toBeVisible();
});

test("health check reports the seeded database", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBeTruthy();
  expect(await res.json()).toMatchObject({ ok: true, db: "bb_e2e", invariantsOk: true });
});

test("recall shows the batch with honest estimated figures", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Recall · B-4471");
  await expect(page.getByText("ACTIVE", { exact: true })).toBeVisible();
  await expect(page.getByText(/FIFO-attributed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Quarantine batch everywhere" })).toBeVisible();
  await page.screenshot({ path: "e2e/__screens__/recall-desktop.png", fullPage: true });
});

test("unknown batch suggests close matches", async ({ page }) => {
  await signIn(page);
  await page.goto("/recall?batch=B-447");
  await expect(page.getByText(/No batch/)).toBeVisible();
  await expect(page.getByRole("link", { name: "B-4471" }).first()).toBeVisible();
});

test("scrubbing into the past replaces the destructive action", async ({ page }) => {
  await signIn(page);
  const slider = page.getByRole("slider", { name: "Replay date" });
  await slider.focus();
  await page.keyboard.press("Home");
  await expect(page.getByText(/^Viewing /)).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to today to quarantine" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Quarantine batch everywhere" })).toHaveCount(0);
  await page.getByRole("button", { name: "Next event" }).click();
  await page.screenshot({ path: "e2e/__screens__/recall-past.png" });
  await page.getByRole("button", { name: "Back to today to quarantine" }).click();
  await expect(page.getByRole("button", { name: "Quarantine batch everywhere" })).toBeVisible();
});

test("@phone keeps the quarantine action reachable on a phone", async ({ page }, info) => {
  await signIn(page);
  const action = page.getByRole("button", { name: "Quarantine batch everywhere" });
  await expect(action).toBeInViewport();
  await page.screenshot({ path: `e2e/__screens__/recall-${info.project.name}-viewport.png`, fullPage: false });
});

test("typed confirm quarantines the batch and shows a pull list", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Quarantine batch everywhere" }).click();
  const dialog = page.getByRole("dialog");
  const confirm = dialog.getByRole("button", { name: "Quarantine batch" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Type B-4471 to confirm").fill("b-4471");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog.getByRole("heading", { name: /Quarantined \d+ units? at \d+ branch(es)?/ })).toBeVisible();
  await expect(dialog.getByRole("columnheader", { name: "Units to pull" })).toBeVisible();
  await page.screenshot({ path: "e2e/__screens__/recall-receipt.png" });
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("RECALLED", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Quarantined / })).toBeDisabled();
});
