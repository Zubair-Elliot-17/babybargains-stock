import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { MongoClient } from "mongodb";
import { checkLedgerInvariants, projectionDiff } from "@/domain/ledger/read";
import { RECALLED_BATCH } from "@/seed/generate";

// Units found on the seed's already-recalled batch: the review warns, approval quarantines them again.
// Uses Bristol (no other spec counts there) and the seeded recalled batch, which no spec touches.
test("units found on a recalled batch are shown and reported as quarantined", async ({ page, request }) => {
  const client = await MongoClient.connect(readFileSync(".data/e2e-mongo-uri", "utf8"));
  try {
    const db = client.db("bb_e2e");
    const batch = await db.collection<{ _id: string; sku: string }>("batches").findOne({ batchCode: RECALLED_BATCH, status: "RECALLED" });
    expect(batch).toBeTruthy();

    // Clerk (own request context) counts 2 units on the recalled batch and submits.
    const post = (url: string, data: object) => request.post(url, { data: { commandId: crypto.randomUUID(), ...data } });
    expect((await request.post("/api/session", { data: { role: "clerk", branchId: "BR-BRS" } })).ok()).toBeTruthy();
    const opened = await post("/api/stocktakes", {});
    expect(opened.ok()).toBeTruthy();
    const stocktakeId: string = (await opened.json()).result._id;
    expect((await post(`/api/stocktakes/${stocktakeId}/lines`, { sku: batch!.sku, batchId: batch!._id, counted: 2, mode: "replace" })).ok()).toBeTruthy();
    expect((await post(`/api/stocktakes/${stocktakeId}/submit`, { uncounted: "leave" })).ok()).toBeTruthy();

    await page.goto("/login");
    await page.getByRole("button", { name: /Manager/ }).click();
    await page.waitForURL(/\/recall/);
    await page.goto(`/stocktakes/${stocktakeId}`);
    await expect(page.getByText("Recalled batch: 2 found units quarantined")).toBeVisible();
    const boxes = page.getByRole("checkbox");
    for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check();
    await page.getByRole("button", { name: "Approve stocktake" }).click();
    await expect(page.getByRole("status").filter({ hasText: /^Approved:/ })).toContainText("0 units removed, 2 added, 2 quarantined (");

    const onHand = await db.collection("inventory").find({ batchId: batch!._id, onHand: { $gt: 0 } }).toArray();
    expect(onHand).toEqual([]);
    expect(await projectionDiff(db)).toEqual([]);
    expect((await checkLedgerInvariants(db)).violations).toEqual([]);
  } finally {
    await client.close();
  }
});
