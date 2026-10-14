import { expect, test } from "@playwright/test";

// A supplier's delivery note fills the receive form; the manager checks it and records it as usual.
test("manager receives an order from the supplier's delivery note", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Manager/ }).click();
  await page.waitForURL(/\/recall/);
  await page.goto("/orders");
  await page.getByLabel("Branch").selectOption({ label: "Bristol Cabot" });
  await page.getByLabel("Supplier").selectOption({ label: "SafeSound Electronics" });
  await page.getByRole("button", { name: "Suggest lines" }).click();
  await page.waitForURL(/supplier=SUP-SAFE/);
  const lines = page.getByRole("region", { name: "New order lines" });
  // At least one line, whatever is low today; retried because the select can render before it hydrates.
  await expect(async () => {
    if (!(await lines.getByRole("checkbox").count())) await lines.getByLabel("Add a product").selectOption({ label: "Echo Duo Audio" });
    expect(await lines.getByRole("checkbox").count()).toBeGreaterThan(0);
  }).toPass();
  await lines.getByRole("button", { name: /^Send order · \d+ units$/ }).click();
  await expect(page.getByText(/^Order PO-BRS-\d{8}-\w+ sent\.$/)).toBeVisible();
  const orderId = (await page.getByText(/^Order PO-BRS/).innerText()).split(" ")[1];

  const row = page.getByRole("row", { name: new RegExp(orderId) });
  await row.getByRole("button", { name: "Receive delivery" }).click();
  const form = page.getByRole("form", { name: `Receive ${orderId}` });
  const file = form.getByLabel("Delivery note (SafeSound JSON)");

  // Another supplier's file is refused with the reason, and fills nothing.
  await file.setInputFiles({ name: "note.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ deliveryNote: "LO-1", purchaseOrder: orderId, items: [] })) });
  await expect(row.getByRole("alert")).toContainText("Not a SafeSound JSON delivery note");

  await form.getByRole("button", { name: "Try a sample note" }).click();
  await expect(form.getByRole("status")).toContainText(/Filled from delivery note SS-\w+/);
  await expect(row.getByRole("alert")).toHaveCount(0);
  const codes = await form.getByLabel(/^Batch code for /).all();
  for (const c of codes) await expect(c).toHaveValue(/^SS\/\w+$/);

  await form.getByRole("button", { name: "Record delivery" }).click();
  await expect(row).toContainText("Received");
  await expect(row.getByRole("button", { name: "Receive delivery" })).toHaveCount(0);
});
