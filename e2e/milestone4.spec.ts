import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { MongoClient } from "mongodb";

// A clothing product Leeds holds at least 2 sellable units of (ACTIVE batches), read from the e2e database.
async function inStockAtLeeds(): Promise<string> {
  const client = await MongoClient.connect(readFileSync(".data/e2e-mongo-uri", "utf8"));
  try {
    const db = client.db("bb_e2e");
    const active = await db.collection("batches").distinct("_id", { status: "ACTIVE" });
    const [row] = await db.collection<{ _id: string }>("inventory").aggregate<{ _id: string }>([
      { $match: { branchId: "BR-LEE", batchId: { $in: active }, sku: /^CLO-/ } },
      { $group: { _id: "$sku", onHand: { $sum: "$onHand" } } },
      { $match: { onHand: { $gte: 2 } } },
      { $sort: { _id: 1 } },
      { $limit: 1 },
    ]).toArray();
    const product = await db.collection<{ _id: string; name: string }>("products").findOne({ _id: row._id });
    return product!.name;
  } finally {
    await client.close();
  }
}

// Milestone 4: Record sale (clerk), Orders, Stock and Analytics (manager).

test("@phone clerk records a sale and sees short lines marked without system quantities", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Branch").selectOption({ label: "Leeds Kirkgate" });
  await page.getByRole("button", { name: "Start counting" }).click();
  await page.waitForURL(/\/count$/);
  await page.getByRole("navigation", { name: "Clerk" }).getByRole("link", { name: "Record sale" }).click();
  await page.waitForURL(/\/sale$/);

  const search = page.getByLabel("Scan or search product");
  await search.fill("Roam City Pram");
  await page.getByRole("option").first().click();
  await expect(page.getByRole("button", { name: /^Record sale £/ })).toBeEnabled();

  // Short stock refuses the whole sale (server response mocked): the line says what the system holds.
  await page.route("**/api/sales", (route) =>
    route.fulfill({ status: 409, json: { error: { code: "INSUFFICIENT_STOCK", message: "x", details: [{ sku: "PRAM-ROAMCITYPRAM-GRAPHITE" }] } } }),
  );
  await search.fill("Roam City Pram · Graphite");
  await page.getByRole("option").first().click(); // second unit of the same line, or a new line
  await page.getByRole("button", { name: /^Record sale £/ }).click();
  await expect(page.getByText("Not enough on record")).toBeVisible();
  await page.unrouteAll();

  // Real sale: drop the short line, sell a product Leeds holds.
  const minus = page.getByRole("button", { name: /^One fewer Roam City Pram/ });
  while (await minus.count()) await minus.first().click();
  const name = await inStockAtLeeds();
  await search.fill(name);
  await page.getByRole("option").filter({ hasText: name }).first().click();
  const record = page.getByRole("button", { name: /^Record sale £/ });
  const label = await record.innerText();
  await record.click();
  await expect(page.getByText(`Sale recorded · ${label.replace("Record sale ", "")}`)).toBeVisible();
  await expect(page.getByRole("region", { name: "Sale" })).toHaveCount(0);
});

test("a low row's Order link opens that branch's supplier order with the product suggested", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Manager/ }).click();
  await page.waitForURL(/\/recall/);
  await page.goto("/stock?branch=BR-LEE&low=1");
  const order = page.getByRole("link", { name: /^Order .+ for Leeds Kirkgate$/ }).first();
  const product = (await order.getAttribute("aria-label"))!.replace(/^Order (.+) for Leeds Kirkgate$/, "$1");
  await order.click();
  await page.waitForURL(/\/orders\?branch=BR-LEE&supplier=SUP-/);
  await expect(page.getByLabel("Branch")).toHaveValue("BR-LEE");
  await expect(page.getByRole("region", { name: "New order lines" }).getByRole("checkbox", { name: `Order ${product}` })).toBeChecked();
  await page.goto("/analytics");
  await expect(page.getByRole("link", { name: /^Order .+ for .+$/ }).first()).toHaveAttribute("href", /^\/orders\?branch=BR-[A-Z]+&supplier=SUP-[A-Z]+$/);
});

test("manager sends an order, receives it, and sees stock and analytics", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Manager/ }).click();
  await page.waitForURL(/\/recall/);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Orders" }).click();
  await page.waitForURL(/\/orders/);

  await page.getByLabel("Branch").selectOption({ label: "Bristol Cabot" });
  await page.getByLabel("Supplier").selectOption({ label: "Roam Prams" });
  await page.getByRole("button", { name: "Suggest lines" }).click();
  await page.waitForURL(/supplier=SUP-ROAM/);
  const lines = page.getByRole("region", { name: "New order lines" });
  await expect(lines).toBeVisible();
  // Order exactly one known product so the receive step is deterministic.
  for (const box of await lines.getByRole("checkbox").all()) await box.uncheck();
  const add = lines.getByLabel("Add a product");
  if (await add.isVisible()) await add.selectOption({ label: "Glide Compact Stroller · Graphite" });
  else await lines.getByRole("checkbox", { name: "Order Glide Compact Stroller · Graphite" }).check();
  await lines.getByLabel("Quantity of Glide Compact Stroller · Graphite").fill("3");
  await lines.getByRole("button", { name: "Send order · 3 units" }).click();
  await expect(page.getByText(/^Order PO-BRS-\d{8}-\w+ sent\.$/)).toBeVisible();
  const orderId = (await page.getByText(/^Order PO-BRS/).innerText()).split(" ")[1];

  const row = page.getByRole("row", { name: new RegExp(orderId) });
  await expect(row).toContainText("0 of 3");
  await row.getByRole("button", { name: "Receive delivery" }).click();
  const form = page.getByRole("form", { name: `Receive ${orderId}` });
  await form.getByLabel("Units of Glide Compact Stroller · Graphite arrived").fill("2");
  await form.getByLabel("Batch code for Glide Compact Stroller · Graphite").fill("e2e-77");
  await form.getByRole("button", { name: "Record delivery" }).click();
  await expect(row).toContainText("2 of 3");
  await expect(row).toContainText("Part received");
  await expect(row.getByRole("button", { name: "Cancel order" })).toHaveCount(0); // something arrived

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Stock", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stock · All branches");
  await page.getByLabel("Branch").selectOption({ label: "Bristol Cabot" });
  await page.getByLabel("Product or SKU").fill("Glide Compact Stroller · Graphite");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stock · Bristol Cabot");
  await expect(page.getByRole("row", { name: /Glide Compact Stroller · Graphite/ })).toBeVisible();

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Analytics" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Analytics · All branches");
  await expect(page.getByRole("heading", { name: "Needs action" })).toBeVisible();
  await expect(page.getByRole("img", { name: /^Weekly sales/ })).toBeVisible();
  await expect(page.getByText("Open orders")).toBeVisible();
});

test("analytics charts each have a name and their data as a table beside them", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Manager/ }).click();
  await page.waitForURL(/\/recall/);
  await page.goto("/analytics");
  const charts = [/^Weekly sales/, /^Sales by category/, /^Weeks of cover/, /^Shelf stock at retail by batch age/, /^ABC split/, /^Average daily sales by branch and weekday/];
  for (const name of charts) {
    const chart = page.getByRole("img", { name });
    await expect(chart).toBeVisible();
    // The table is a sibling, so role="img" does not hide it, and it has a caption and header cells.
    const table = chart.locator("xpath=following-sibling::table[contains(@class, 'sr-only')]");
    await expect(table.locator("caption")).not.toBeEmpty();
    expect(await table.locator("th[scope]").count()).toBeGreaterThan(1);
  }
  // Branch league: a real table, one labelled 12-week sparkline per branch.
  const league = page.getByRole("region", { name: "Branch league, last 30 days" });
  const branches = await league.locator("tbody tr").count();
  expect(branches).toBeGreaterThan(1);
  await expect(league.getByRole("img", { name: /weekly sales over the last 12 weeks/ })).toHaveCount(branches);
  // KPI sparkline is decorative: the tile's change chip states the trend.
  await expect(page.locator("dl svg[aria-hidden]").first()).toBeAttached();
});
