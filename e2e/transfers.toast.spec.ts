import { expect, test, type Page } from "@playwright/test";

// Tester-owned checks for the Transfers screen's toast and focus after an Accept.

test.describe.configure({ mode: "serial" });

async function signInManager(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: /Manager/ }).click();
  await page.waitForURL(/\/recall/);
}

const reviewButtons = (page: Page) => page.locator("tbody button");

test("a repeated toast message stays for its full six seconds", async ({ page }) => {
  await signInManager(page);
  await page.goto("/transfers");
  const message = "Stock changed since this list loaded. Check the new suggestion";
  await page.route("/api/transfers", (route) => route.fulfill({ status: 409, json: { error: { code: "SUGGESTION_STALE", message } } }));
  const toast = page.getByRole("status").filter({ hasText: message });

  const acceptFirst = async () => {
    await reviewButtons(page).first().click();
    await page.getByRole("button", { name: "Accept transfer" }).click();
    await expect(toast).toBeVisible();
  };
  await acceptFirst();
  await page.waitForTimeout(3500);
  await acceptFirst();
  // ~7s after the first toast and ~3.5s after the second: the first one's timer must not hide the second.
  await page.waitForTimeout(3500);
  await expect(toast).toBeVisible();
  await expect(toast).toHaveCount(0, { timeout: 5000 });
});

test("the last accept into a branch keeps its toast and moves focus to the empty text", async ({ page }) => {
  await signInManager(page);
  await page.goto("/transfers");
  // Pick the receiving branch with the fewest suggestions, so this test uses up as few as possible.
  const ids = Object.fromEntries(
    (await page.locator("#to option").evaluateAll((os) => os.map((o) => [o.textContent!, (o as HTMLOptionElement).value]))).filter(([, id]) => id),
  );
  const labels = await reviewButtons(page).evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")!));
  const counts = new Map<string, number>();
  for (const l of labels) {
    const to = /^Review transfer of .+ from .+ to (.+)$/.exec(l)![1];
    counts.set(to, (counts.get(to) ?? 0) + 1);
  }
  const [toName] = [...counts.entries()].sort((a, b) => a[1] - b[1])[0];
  await page.goto(`/transfers?to=${ids[toName]}`);

  // Accept all but one through the API.
  for (let n = await reviewButtons(page).count(); n > 1; n = await reviewButtons(page).count()) {
    const row = page.locator("tbody tr").first();
    const label = (await row.locator("button").getAttribute("aria-label"))!;
    const [, , from] = /^Review transfer of (.+) from (.+) to (.+)$/.exec(label)!;
    const sku = (await row.locator("th .mono").textContent())!;
    const qty = Number(await row.locator("td").nth(2).textContent());
    const res = await page.request.post("/api/transfers", { data: { commandId: crypto.randomUUID(), sku, fromBranchId: ids[from], toBranchId: ids[toName], qty } });
    expect(res.ok(), await res.text()).toBeTruthy();
    await page.reload();
  }

  await expect(reviewButtons(page)).toHaveCount(1);
  await reviewButtons(page).click();
  await page.getByRole("button", { name: "Accept transfer" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Dispatched / })).toContainText(`to ${toName}`);
  const empty = page.getByText(`No transfers into ${toName} right now.`);
  await expect(empty).toBeVisible();
  await expect(empty).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: /^Dispatched / })).toBeVisible();
});
