import { expect, test, type Page } from "@playwright/test";

// Offline count queue end to end: the demo's dead-spot switch, a reload, a re-login resume, and a save that
// reached the server but timed out on the phone. Manchester is not used by the other clerk specs.

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Branch").selectOption({ label: "Manchester Arndale" });
  await page.getByRole("button", { name: "Start counting" }).click();
  await page.waitForURL(/\/count$/);
}

async function countDreamtime(page: Page, qty: number, repeat?: "Add" | "Replace") {
  await page.getByLabel("Scan or search product").fill("Dreamtime");
  await page.getByRole("option").first().click();
  await page.getByLabel("Counted quantity").fill(String(qty));
  await page.getByRole("button", { name: "Save count" }).click();
  if (repeat) await page.getByRole("dialog").getByRole("button", { name: new RegExp(`^${repeat} `) }).click();
}

test("@phone counts in a dead spot survive reload and re-login, then send in order", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: /Start stocktake|Resume stocktake/ }).click();
  await page.waitForURL(/\/count\/ST-/);
  const stocktakeId = page.url().split("/count/")[1];
  const status = page.locator("#sync-status");
  const submit = page.getByRole("button", { name: "Submit stocktake" });
  const deadSpot = page.getByRole("switch", { name: "Stockroom dead spot" });

  try {
    await deadSpot.check();
    await countDreamtime(page, 2);
    await expect(page.getByText(/^Kept on this phone · Dreamtime Cot 120 .* × 2/)).toBeVisible();
    await countDreamtime(page, 1, "Add"); // the repeat sheet sees the queued line
    await expect(status).toHaveText("Dead-spot demo on · 2 counts waiting for signal");
    await expect(page.getByText("Waiting", { exact: true })).toHaveCount(2);
    await expect(submit).toBeDisabled();
    await expect(page.getByText("Submit after counts are sent")).toBeVisible();

    await page.reload();
    await expect(page.getByText("Waiting", { exact: true })).toHaveCount(2);
    await expect(deadSpot).toBeChecked();

    // Re-login: a new session. The stored resume key takes the stocktake back without the 2-hour wait.
    await page.getByRole("button", { name: "Sign out" }).click();
    await signIn(page);
    await page.getByRole("button", { name: "Resume stocktake" }).click();
    await page.waitForURL(`**/count/${stocktakeId}`);
    await expect(page.getByText("Waiting", { exact: true })).toHaveCount(2);

    await page.getByRole("switch", { name: "Stockroom dead spot" }).uncheck();
    await expect(status).toHaveText("All counts saved");
    await expect(page.getByText("Waiting", { exact: true })).toHaveCount(0);
    await expect(submit).toBeEnabled();

    // Server holds both lines in capture order: replace 2 then add 1 = 3.
    await page.reload();
    await page.getByLabel("Scan or search product").fill("Dreamtime");
    await page.getByRole("option").first().click();
    await page.getByRole("button", { name: "Save count" }).click();
    await expect(page.getByRole("dialog", { name: "Counted 3 earlier" })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

    // A save that reaches the server but whose answer is lost is stored once.
    let first = true;
    await page.route(/\/api\/stocktakes\/.+\/lines$/, async (route) => {
      if (!first) return route.continue();
      first = false;
      await route.fetch(); // the server stores it…
      await route.abort("failed"); // …but the phone never hears back
    });
    await countDreamtime(page, 5, "Replace");
    await expect(status).toHaveText("All counts saved", { timeout: 15_000 });
    await page.unrouteAll();
    await page.reload();
    await expect(page.getByRole("region", { name: "Recent counts" }).getByRole("listitem")).toHaveCount(3);
  } finally {
    await page.unrouteAll();
    // Leave no OPEN stocktake behind: it would hold Manchester out of the transfer specs.
    const res = await page.request.post(`/api/stocktakes/${stocktakeId}/submit`, { data: { commandId: crypto.randomUUID(), uncounted: "leave" } });
    expect(res.ok()).toBeTruthy();
  }
});
