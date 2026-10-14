import { expect, test, type Page } from "@playwright/test";

// Offline count queue end to end: the demo's dead-spot switch, a reload, a re-login resume, and a save that
// reached the server but timed out on the phone. Leeds: manager specs pick Manchester/Bristol rows, and stocktake.spec starts its own Leeds stocktake after this one.

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Branch").selectOption({ label: "Leeds Kirkgate" });
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
  test.setTimeout(90_000); // one journey: reload, re-login, drain, and a lost response with backoff
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
    // The retry may land inside the 1.5 s save window ("Saved") or after it ("Kept on this phone").
    await expect(page.getByText(/^(Saved|Kept on this phone) · Dreamtime Cot 120 .* × 5/)).toBeVisible();
    await expect(page.getByText("Waiting", { exact: true })).toHaveCount(0, { timeout: 15_000 });
    await page.unrouteAll();
    await page.reload();
    await expect(page.getByRole("region", { name: "Recent counts" }).getByRole("listitem")).toHaveCount(3);
  } finally {
    await page.unrouteAll();
    // Leave no OPEN stocktake behind: it would hold Leeds out of the transfer specs and stocktake.spec.
    const res = await page.request.post(`/api/stocktakes/${stocktakeId}/submit`, { data: { commandId: crypto.randomUUID(), uncounted: "leave" } });
    expect(res.ok()).toBeTruthy();
  }
});

test("@phone the count page reopens with no signal, and sign-out forgets the saved copy", async ({ page, context }) => {
  test.skip(!process.env.E2E_PROD, "the service worker only registers in production builds");
  test.setTimeout(90_000);
  await signIn(page);
  await page.getByRole("button", { name: /Start stocktake|Resume stocktake/ }).click();
  await page.waitForURL(/\/count\/ST-/);
  const stocktakeId = page.url().split("/count/")[1];
  let submitted = false;
  const submit = async () => {
    const res = await page.request.post(`/api/stocktakes/${stocktakeId}/submit`, { data: { commandId: crypto.randomUUID(), uncounted: "leave" } });
    expect(res.ok()).toBeTruthy();
    submitted = true;
  };
  const savedPages = () => page.evaluate(async () => (await (await caches.open("bb-pages-v2")).keys()).length);

  try {
    // Reached by client-side navigation (Start stocktake), as clerks do: the page asks to be saved.
    await expect.poll(savedPages, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(page.getByText(/^Offline copy/)).toHaveCount(0); // a live page says nothing

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByText(/^Offline copy of this page, saved at \d\d:\d\d/)).toBeVisible();
    // It can't see counts sent after it was saved, so even a first-looking count asks before replacing.
    await countDreamtime(page, 2);
    await expect(page.getByRole("dialog", { name: /^Counted since \d\d:\d\d\?$/ })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Add 2" }).click();
    await expect(page.getByText(/^Kept on this phone · Dreamtime Cot 120 .* × 2/)).toBeVisible();

    await context.setOffline(false);
    await expect(page.locator("#sync-status")).toHaveText("All counts saved", { timeout: 30_000 });

    await submit(); // while signed in: leave no OPEN stocktake for the other specs
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/login/);
    await expect.poll(savedPages).toBe(0);
  } finally {
    await context.setOffline(false);
    if (!submitted) await submit();
  }
});
