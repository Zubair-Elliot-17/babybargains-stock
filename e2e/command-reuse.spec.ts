import { expect, test, type Page, type Route } from "@playwright/test";

// A request ID the server has already used (409 COMMAND_ID_REUSED, e.g. a retry after a lost response
// or a fresh sign-in) must never leave a screen stuck. Responses are mocked so shared demo data is untouched.

test.describe.configure({ mode: "serial" });

const reused = { code: "COMMAND_ID_REUSED", message: "This request ID was already used for a different request" };

// First call answers COMMAND_ID_REUSED, later calls a 500; records each request's commandId.
function mockReuseThen500(ids: string[]) {
  return (route: Route) => {
    ids.push(route.request().postDataJSON().commandId);
    const error = ids.length === 1 ? reused : { code: "INTERNAL", message: "Couldn't save. Retry" };
    return route.fulfill({ status: ids.length === 1 ? 409 : 500, json: { error } });
  };
}

async function signInManager(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: /Manager/ }).click();
  await page.waitForURL(/\/recall/);
}

test("approving again after a reused request ID sends a new one", async ({ page }) => {
  await signInManager(page);
  await page.goto("/stocktakes");
  await page.getByRole("row", { name: /Manchester Arndale/ }).getByRole("link", { name: "Review" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Review stocktake");
  const approve = page.getByRole("button", { name: "Approve stocktake" });
  await expect(approve).toBeDisabled();
  const boxes = page.getByRole("checkbox");
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check();
  const ids: string[] = [];
  await page.route(/\/api\/stocktakes\/.+\/approve$/, mockReuseThen500(ids));
  await approve.click();
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toHaveText("That request was already sent. Approve again to retry.");
  await approve.click();
  await expect(alert).toHaveText("Couldn't save. Retry");
  expect(ids).toHaveLength(2);
  expect(ids[1]).not.toBe(ids[0]);
});

test("quarantining again after a reused request ID sends a new one", async ({ page }) => {
  await signInManager(page);
  const ids: string[] = [];
  await page.route("/api/quarantine", mockReuseThen500(ids));
  await page.getByRole("button", { name: "Quarantine batch everywhere" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Type B-4471 to confirm").fill("B-4471");
  const confirm = dialog.getByRole("button", { name: "Quarantine batch" });
  await confirm.click();
  await expect(dialog.getByRole("alert")).toHaveText("That request was already sent. Quarantine again to retry.");
  await confirm.click();
  await expect(dialog.getByRole("alert")).toHaveText("Couldn't save. Retry");
  expect(ids).toHaveLength(2);
  expect(ids[1]).not.toBe(ids[0]);
});

test("a count line the server already holds counts as saved", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Branch").selectOption({ label: "Bristol Cabot" });
  await page.getByRole("button", { name: "Start counting" }).click();
  await page.waitForURL(/\/count$/);
  await page.getByRole("button", { name: /Start stocktake|Resume stocktake/ }).click();
  await page.waitForURL(/\/count\/ST-/);
  const stocktakeId = page.url().split("/count/")[1];
  try {
    await page.route(/\/api\/stocktakes\/.+\/lines$/, (route) => route.fulfill({ status: 409, json: { error: reused } }));
    await page.getByLabel("Scan or search product").fill("Dreamtime");
    await page.getByRole("option").first().click();
    await page.getByRole("button", { name: "Save count" }).click();
    await expect(page.getByText(/^Saved · Dreamtime Cot 120/)).toBeVisible();
    await expect(page.getByText(/1 of \d+ products counted/)).toBeVisible();
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  } finally {
    // Leave no OPEN stocktake behind: it would hold Bristol out of the transfer specs.
    await page.unrouteAll();
    const res = await page.request.post(`/api/stocktakes/${stocktakeId}/submit`, { data: { commandId: crypto.randomUUID(), uncounted: "leave" } });
    expect(res.ok()).toBeTruthy();
  }
});
