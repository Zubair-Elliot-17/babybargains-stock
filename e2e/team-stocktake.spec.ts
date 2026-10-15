import { expect, test, type Browser, type Page } from "@playwright/test";

// Two phones count one Leeds stocktake. Submitted at the end: an OPEN stocktake would hold Leeds out of the transfer specs.

async function clerk(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/login");
  await page.getByLabel("Branch").selectOption({ label: "Leeds Kirkgate" });
  await page.getByRole("button", { name: "Start counting" }).click();
  await page.waitForURL(/\/count$/);
  return page;
}

async function countDreamtime(page: Page, qty: number) {
  await page.getByLabel("Scan or search product").fill("Dreamtime");
  await page.getByRole("option").first().click();
  await page.getByLabel("Counted quantity").fill(String(qty));
  await page.getByRole("button", { name: "Save count" }).click();
}

test("@phone a teammate joins, the lead's submit waits for their counts, then goes", async ({ browser }) => {
  test.setTimeout(90_000);
  const lead = await clerk(browser);
  await lead.getByRole("button", { name: /Start stocktake|Resume stocktake/ }).click();
  await lead.waitForURL(/\/count\/ST-/);
  const stocktakeId = lead.url().split("/count/")[1];

  const mate = await clerk(browser);
  await expect(async () => {
    await mate.getByRole("button", { name: /^Join Clerk \w+'s stocktake$/ }).click();
    await mate.waitForURL(`**/count/${stocktakeId}`, { timeout: 3000 });
  }).toPass(); // the button can render before it hydrates

  try {
    await countDreamtime(lead, 3);
    // The teammate's count can't reach the server yet: their phone reports it as waiting.
    await mate.route(/\/api\/stocktakes\/.+\/lines$/, (route) => route.fulfill({ status: 503, json: { error: { code: "INTERNAL", message: "down" } } }));
    await countDreamtime(mate, 2); // their own first count: no "counted earlier" prompt, though the lead counted it
    await expect(mate.getByRole("button", { name: "I'm done counting" })).toBeDisabled();

    await lead.getByRole("button", { name: "Submit stocktake" }).click();
    await lead.getByRole("dialog").getByRole("button", { name: "Leave out and submit" }).click();
    const wait = lead.getByRole("dialog", { name: "Your team may still have counts" });
    await expect(wait).toContainText(/Waiting for Clerk \w+ \(1 count not sent yet\)/);
    await wait.getByRole("button", { name: "Wait for them" }).click();

    await mate.unrouteAll();
    await expect(mate.getByRole("button", { name: "I'm done counting" })).toBeEnabled({ timeout: 30_000 }); // sent on retry
    const reported = mate.waitForResponse((r) => r.url().endsWith("/heartbeat") && r.request().postDataJSON().done === true);
    await mate.getByRole("button", { name: "I'm done counting" }).click();
    await reported;
    await expect(mate.getByText(/^Done\. Clerk \w+ submits once everyone's counts are in\.$/)).toBeVisible();

    await lead.getByRole("button", { name: "Submit stocktake" }).click();
    await lead.getByRole("dialog").getByRole("button", { name: "Leave out and submit" }).click();
    await expect(lead.getByRole("heading", { name: "Stocktake sent to manager" })).toBeVisible();

    // The manager's list shows a team of two.
    const manager = await (await browser.newContext()).newPage();
    await manager.goto("/login");
    await manager.getByRole("button", { name: /Manager/ }).click();
    await manager.waitForURL(/\/recall/);
    await manager.goto("/stocktakes");
    await expect(manager.getByRole("row", { name: /Leeds Kirkgate/ }).first()).toContainText(/Clerk \w+ \+ 1/);
  } finally {
    // Leave no OPEN stocktake behind (no-op once submitted).
    await lead.request.post(`/api/stocktakes/${stocktakeId}/submit`, { data: { commandId: crypto.randomUUID(), uncounted: "leave", withoutTeam: true } });
  }
});
