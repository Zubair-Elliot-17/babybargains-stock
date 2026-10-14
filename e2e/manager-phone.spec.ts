import { expect, test, type Page } from "@playwright/test";

async function signInManager(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: /Manager/ }).click();
  await page.waitForURL(/\/recall/);
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test("@phone every manager screen fits the width, with no sideways scroll", async ({ page }) => {
  await signInManager(page);
  for (const path of ["/recall", "/stock", "/stocktakes", "/stocktakes?tab=APPROVED", "/transfers", "/orders", "/analytics"]) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    expect(await overflow(page), path).toBeLessThanOrEqual(0);
  }
  await page.goto("/stocktakes?tab=APPROVED");
  await page.getByRole("link", { name: "View", exact: true }).first().click();
  await page.waitForURL(/\/stocktakes\/ST-/);
  expect(await overflow(page), "stocktake review").toBeLessThanOrEqual(0);
  // "/stocktakes/…" starts with "/stock": only Stocktakes may be the current page.
  const current = page.getByRole("navigation", { name: "Main" }).locator('[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute("href", "/stocktakes");
});

test("@phone transfers lists suggestions as cards and opens the review sheet", async ({ page }) => {
  await signInManager(page);
  await page.goto("/transfers");
  const first = page.locator("tbody tr").first();
  await expect(first).toBeVisible();
  await first.getByRole("button", { name: /^Review transfer of/ }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});
