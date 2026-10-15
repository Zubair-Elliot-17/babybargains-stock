import { expect, test } from "@playwright/test";

// A supplier price list: preview what it changes, apply it once.
test("manager previews and applies a supplier price list", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Manager/ }).click();
  await page.waitForURL(/\/recall/);
  await page.goto("/orders");
  await page.getByRole("link", { name: "Supplier price lists" }).click();
  await page.waitForURL(/\/orders\/price-list/);
  await page.getByLabel("Supplier").selectOption({ label: "SafeSound Electronics" });
  await page.getByRole("button", { name: "Choose" }).click();
  await page.waitForURL(/supplier=SUP-SAFE/);

  // Another supplier's format is refused with the reason.
  const file = page.getByLabel("Price list file");
  await file.setInputFiles({ name: "list.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ priceList: "LO-1", products: [] })) });
  await expect(page.locator("main").getByRole("alert")).toContainText("Not this supplier's price-list format");

  await expect(async () => {
    await page.getByRole("button", { name: "Try a sample price list" }).click();
    await expect(page.getByText(/^Price list SS-PL-\w+: 3 changes, \d+ unchanged, 1 product not in our catalogue/)).toBeVisible({ timeout: 2000 });
  }).toPass(); // the button can render before it hydrates
  const ref = (await page.getByText(/^Price list SS-PL-/).innerText()).split(" ")[2].replace(":", "");
  await expect(page.locator("main tbody tr")).toHaveCount(3);
  await page.getByRole("button", { name: "Apply 3 changes" }).click();
  await expect(page.getByRole("status")).toHaveText(`Price list ${ref} applied: 3 products changed.`);
  await expect(page.getByRole("region", { name: "Applied price lists" })).toContainText(ref);
});
