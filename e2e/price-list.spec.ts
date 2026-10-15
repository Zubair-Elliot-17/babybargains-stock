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

test("a price list adds a product we don't stock, which can then be ordered", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Manager/ }).click();
  await page.waitForURL(/\/recall/);
  await page.goto("/orders/price-list?supplier=SUP-WOND");
  await expect(async () => {
    await page.getByRole("button", { name: "Try a sample price list" }).click();
    await expect(page.getByText(/^Price list WT-PL-\w+: .*1 product not in our catalogue/)).toBeVisible({ timeout: 2000 });
  }).toPass(); // the button can render before it hydrates
  const sku = (await page.getByText(/^Price list WT-PL-/).innerText()).split(" ")[2].replace("WT-PL-", "NEW-").replace(":", "");

  await page.getByRole("checkbox", { name: new RegExp(`Add New season sample ${sku}`) }).check();
  await expect(page.getByLabel("Category")).toHaveValue("toy");
  await expect(page.getByRole("checkbox", { name: "Track batches" })).not.toBeChecked();
  await page.getByLabel("From age (months)").fill("6");
  await page.getByLabel("Material").fill("Beech wood");
  await page.getByRole("button", { name: /^(Apply \d+ changes?, add|Add) 1 product$/ }).click();
  await expect(page.getByRole("status")).toHaveText(/applied: \d+ products? changed, 1 product added\.$/);
  await expect(page.getByRole("region", { name: "Applied price lists" })).toContainText("1 added");

  await page.goto("/orders?branch=BR-LEE&supplier=SUP-WOND");
  const add = page.getByLabel("Add a product");
  await expect(add.locator("option", { hasText: "New season sample" })).toHaveCount(1);
});
