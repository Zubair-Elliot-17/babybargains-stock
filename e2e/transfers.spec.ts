import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { MongoClient } from "mongodb";
import { checkLedgerInvariants, projectionDiff } from "@/domain/ledger/read";

test.describe.configure({ mode: "serial" });

interface Suggestion {
  label: string;
  sku: string;
  product: string;
  from: string;
  to: string;
  qty: number;
}

async function signInManager(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: /Manager/ }).click();
  await page.waitForURL(/\/recall/);
}

async function suggestions(page: Page): Promise<Suggestion[]> {
  // Suggestion rows only, not the In transit list.
  return page.locator("tbody tr:has(button)").evaluateAll((rows) =>
    rows.map((r) => {
      const label = r.querySelector("button")!.getAttribute("aria-label")!;
      const [, product, from, to] = /^Review transfer of (.+) from (.+) to (.+)$/.exec(label)!;
      return { label, sku: r.querySelector("th .mono")!.textContent!, product, from, to, qty: Number(r.querySelectorAll("td")[2].textContent) };
    }),
  );
}

// Branch name → id, from the receiving-branch filter.
async function branchIds(page: Page): Promise<Record<string, string>> {
  const options = await page.locator("#to option").evaluateAll((os) => os.map((o) => [o.textContent!, (o as HTMLOptionElement).value]));
  return Object.fromEntries(options.filter(([, id]) => id));
}

const accept = (page: Page, s: Suggestion, ids: Record<string, string>, qty = s.qty, commandId: string = crypto.randomUUID()) =>
  page.request.post("/api/transfers", { data: { commandId, sku: s.sku, fromBranchId: ids[s.from], toBranchId: ids[s.to], qty } });

test.afterAll(async () => {
  // Every accept in this file must leave the ledger exact.
  const client = await MongoClient.connect(readFileSync(".data/e2e-mongo-uri", "utf8"));
  try {
    const db = client.db("bb_e2e");
    expect(await projectionDiff(db)).toEqual([]);
    expect((await checkLedgerInvariants(db)).violations).toEqual([]);
  } finally {
    await client.close();
  }
});

test("manager reviews the top suggestion and accepts it", async ({ page }) => {
  await signInManager(page);
  await page.getByRole("link", { name: "Transfers" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Transfers · \d+ suggestions/);
  const before = await suggestions(page);
  expect(before.length).toBeGreaterThanOrEqual(10);
  await page.screenshot({ path: "e2e/__screens__/transfers-desktop.png", fullPage: true });

  const top = before[0];
  await page.getByRole("button", { name: top.label }).click();
  const panel = page.getByRole("complementary", { name: new RegExp(`^Move ${top.qty} units? · `) });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Batches that move (oldest first)")).toBeVisible();
  await expect(panel.locator("li")).not.toHaveCount(0);
  await expect(panel.getByText(/wks cover|no sales in 8 wks/).first()).toHaveClass(/estimated/);
  // An empty branch says so, rather than an estimate of "0.0 wks".
  await expect(panel).not.toContainText(/\b0\.0 wks/);
  if (/^0 on hand/.test(await page.locator("tbody tr[data-selected] td").nth(1).locator("span").innerText())) {
    await expect(panel).toContainText("out of stock");
  }
  await page.screenshot({ path: "e2e/__screens__/transfers-panel.png", fullPage: true });

  await panel.getByRole("button", { name: "Accept transfer" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Dispatched ${top.qty} unit` })).toContainText(`from ${top.from} to ${top.to}`);
  await expect(page.getByRole("button", { name: top.label })).toHaveCount(0);
  await expect(page.getByRole("complementary")).toHaveCount(0);
  // The accepted row is gone, so focus lands on the next suggestion rather than dropping to the page.
  await expect(page.locator("tbody button:focus")).toHaveCount(1);

  // It's on the road until a clerk at the receiving branch confirms it.
  const onRoad = page.getByRole("region", { name: /^In transit · \d+ units$/ }).getByRole("row", { name: new RegExp(top.from) }).filter({ hasText: top.to });
  await expect(onRoad.first()).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/login");
  await page.getByLabel("Branch").selectOption({ label: top.to });
  await page.getByRole("button", { name: "Start counting" }).click();
  await page.waitForURL(/\/count$/);
  const incoming = page.getByRole("region", { name: "Incoming stock" });
  const confirm = incoming.getByRole("button", { name: new RegExp(`^Received ${top.qty} .* from ${top.from}$`) }).first();
  await confirm.click();
  await expect(incoming.getByRole("status").first()).toHaveText(`${top.qty} unit${top.qty === 1 ? "" : "s"} received.`);
});

test("Review buttons and Close stay disabled while an Accept is in flight", async ({ page }) => {
  await signInManager(page);
  await page.goto("/transfers");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("/api/transfers", async (route) => {
    await held;
    await route.fulfill({ status: 500, json: { error: { code: "INTERNAL", message: "Couldn't save. Retry" } } });
  });
  const [first] = await suggestions(page);
  await page.getByRole("button", { name: first.label }).click();
  await page.getByRole("button", { name: "Accept transfer" }).click();
  await expect(page.getByRole("button", { name: "Moving…" })).toBeDisabled();
  for (const b of await page.locator("tbody button").all()) await expect(b).toBeDisabled();
  // Closing mid-request would hide a failure, so the panel stays put until the answer arrives.
  await expect(page.getByRole("button", { name: "Close" })).toBeDisabled();
  await page.getByRole("heading", { name: /^Move / }).press("Escape");
  await expect(page.getByRole("complementary")).toBeVisible();
  release();
  await expect(page.getByRole("complementary").getByRole("alert")).toContainText("Couldn't save");
  for (const b of await page.locator("tbody button").all()) await expect(b).toBeEnabled();
});

// Generated by /ship coverage audit.
// Value: protects=a network failure shows a retryable error and the retry resends the same commandId (no double move);
// fails_when=the fetch catch is dropped or commandId is minted per click; why_new=only a 500 reply is tested, never retry ids;
// seam=none; no_claim=server-side replay (requests are intercepted; replay itself is covered by the accept API test)
test("after a network failure, Retry resends the same request ID; reopening a suggestion gets a new one", async ({ page }) => {
  await signInManager(page);
  await page.goto("/transfers");
  const ids: string[] = [];
  let calls = 0;
  await page.route("/api/transfers", async (route) => {
    ids.push(route.request().postDataJSON().commandId);
    if (calls++ === 0) return route.abort("internetdisconnected");
    await route.fulfill({ status: 500, json: { error: { code: "INTERNAL", message: "Couldn't save. Retry" } } });
  });
  const [first] = await suggestions(page);
  const panel = page.getByRole("complementary");
  await page.getByRole("button", { name: first.label }).click();
  await panel.getByRole("button", { name: "Accept transfer" }).click();
  await expect(panel.getByRole("alert")).toHaveText("Couldn't reach the server. Retry");
  await expect(panel.getByRole("button", { name: "Accept transfer" })).toBeEnabled();
  await panel.getByRole("button", { name: "Accept transfer" }).click();
  await expect(panel.getByRole("alert")).toHaveText("Couldn't save. Retry");
  await panel.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: first.label }).click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await panel.getByRole("button", { name: "Accept transfer" }).click();
  await expect(panel.getByRole("alert")).toHaveText("Couldn't save. Retry");
  expect(ids).toHaveLength(3);
  expect(ids[1]).toBe(ids[0]);
  expect(ids[2]).not.toBe(ids[0]);
});

// With the body fixed per opened suggestion, COMMAND_ID_REUSED means this Accept already ran (under an
// earlier sign-in): the screen must not offer to move the stock again.
test("a reused request ID means the transfer was already sent: the panel closes and the list refreshes", async ({ page }) => {
  await signInManager(page);
  await page.goto("/transfers");
  let posts = 0;
  await page.route("/api/transfers", (route) => {
    posts++;
    return route.fulfill({ status: 409, json: { error: { code: "COMMAND_ID_REUSED", message: "This request ID was already used for a different request" } } });
  });
  const [first] = await suggestions(page);
  await page.getByRole("button", { name: first.label }).click();
  await page.getByRole("complementary").getByRole("button", { name: "Accept transfer" }).click();
  await expect(page.getByRole("status")).toHaveText("This transfer was already sent. The list is up to date.");
  await expect(page.getByRole("complementary")).toHaveCount(0);
  expect(posts).toBe(1);
});

// Generated by /ship coverage audit.
// Value: protects=a 409 STOCKTAKE_OPEN closes the panel and reloads the list with the server's message as a toast;
// fails_when=STOCKTAKE_OPEN drops out of the reload codes and the user is stuck on an error in the panel; why_new=only
// SUGGESTION_STALE drives the reload in the UI; seam=none; no_claim=the real stocktake race (response mocked via page.route)
test("a stocktake starting before Accept closes the panel and shows why as a toast", async ({ page }) => {
  await signInManager(page);
  await page.goto("/transfers");
  const message = "A stocktake is in progress at one of these branches. Try again once it is submitted";
  await page.route("/api/transfers", (route) => route.fulfill({ status: 409, json: { error: { code: "STOCKTAKE_OPEN", message } } }));
  const [first] = await suggestions(page);
  await page.getByRole("button", { name: first.label }).click();
  await page.getByRole("complementary").getByRole("button", { name: "Accept transfer" }).click();
  await expect(page.getByRole("status")).toHaveText(message);
  await expect(page.getByRole("complementary")).toHaveCount(0);
});

test("the selected row stays on screen beside the panel, without the table running under it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await signInManager(page);
  await page.goto("/transfers");
  const last = page.locator("tbody tr:has(button)").last();
  await last.scrollIntoViewIfNeeded();
  await last.getByRole("button").click();
  await expect(page.getByRole("complementary")).toBeVisible();
  await expect(page.locator("tbody tr[data-selected]")).toBeInViewport({ ratio: 0.95 });
  const tableRight = await page.locator("table:has(tbody button)").evaluate((t) => t.getBoundingClientRect().right);
  const panelLeft = await page.getByRole("complementary").evaluate((a) => a.getBoundingClientRect().left);
  expect(tableRight).toBeLessThanOrEqual(panelLeft);
  // Generated by /ship coverage audit. Value: protects=at 1280px+ the panel is non-modal, and shrinking below 1280px re-shows it modal;
  // fails_when=showModal() runs at every size or the media-query change listener is dropped; why_new=only opening at <1280px
  // was asserted; seam=none; no_claim=other desktop widths
  const modal = () => page.getByRole("dialog").evaluate((d: HTMLDialogElement) => d.matches(":modal"));
  expect(await modal()).toBe(false);
  await page.setViewportSize({ width: 1024, height: 720 });
  await expect.poll(modal).toBe(true);
});

test("below 1280px the panel opens modal over the table and Escape returns focus", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await signInManager(page);
  await page.goto("/transfers");
  const [first] = await suggestions(page);
  const opener = page.getByRole("button", { name: first.label });
  await opener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { level: 2 })).toBeFocused();
  // Modal, so the page behind is inert: Tab stays in the panel and the table can't be clicked.
  expect(await dialog.evaluate((d: HTMLDialogElement) => d.matches(":modal"))).toBe(true);
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  const box = (await page.locator("tbody button").first().boundingBox())!;
  expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest("table"), [box.x + 5, box.y + 5])).toBe(false);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("if the browser closes the modal panel itself, the screen follows and the panel reopens", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await signInManager(page);
  await page.goto("/transfers");
  const [first] = await suggestions(page);
  const opener = page.getByRole("button", { name: first.label });
  await opener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // Chrome closes a modal dialog natively on a repeated Escape, even when the cancel event is prevented.
  await dialog.evaluate((d: HTMLDialogElement) => d.close());
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(dialog).toBeVisible();
});

test("the toast's live region is in the accessibility tree before any message, so screen readers announce it", async ({ page }) => {
  await signInManager(page);
  await page.goto("/transfers");
  await expect(page.locator("tbody tr").first()).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(1); // getByRole skips display:none regions
  await expect(page.getByRole("status")).toHaveText("");
});

test("an unknown receiving branch says so instead of showing an empty list", async ({ page }) => {
  await signInManager(page);
  await page.goto("/transfers?to=BR-NOPE");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("isn't a branch");
  await expect(page.getByText("No branch is both over its cover")).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("alert").getByRole("link", { name: "Show all branches" })).toHaveAttribute("href", "/transfers");
});

test("filtering by receiving branch shows only transfers into it", async ({ page }) => {
  await signInManager(page);
  await page.goto("/transfers");
  const [first] = await suggestions(page);
  await page.getByLabel("Receiving branch").selectOption({ label: first.to });
  await page.getByRole("button", { name: "Show" }).click();
  await page.waitForURL(/\/transfers\?to=/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(`into ${first.to}`);
  const rows = await suggestions(page);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r) => r.to === first.to)).toBe(true);
});

test("accept API refuses stale quantities, replays a resent command and refuses same-branch moves", async ({ page }) => {
  await signInManager(page);
  await page.goto("/transfers");
  const ids = await branchIds(page);
  const [s] = await suggestions(page);

  const over = await accept(page, s, ids, s.qty + 1);
  expect(over.status()).toBe(409);
  expect((await over.json()).error).toMatchObject({ code: "SUGGESTION_STALE", details: { suggestedQty: s.qty } });

  const commandId = crypto.randomUUID();
  const ok = await accept(page, s, ids, s.qty, commandId);
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toMatchObject({ result: { moved: s.qty }, replayed: false });
  const again = await accept(page, s, ids, s.qty, commandId);
  expect(await again.json()).toMatchObject({ result: { moved: s.qty }, replayed: true });

  const same = await page.request.post("/api/transfers", { data: { commandId: crypto.randomUUID(), sku: s.sku, fromBranchId: ids[s.from], toBranchId: ids[s.from], qty: 1 } });
  expect(same.status()).toBe(400);
  expect((await same.json()).error.code).toBe("SAME_BRANCH");
});

test("a branch that is counting stock is left out, and accepting into it is refused", async ({ page, browser }) => {
  await signInManager(page);
  await page.goto("/transfers");
  const ids = await branchIds(page);
  const [s] = await suggestions(page);

  // A clerk at the receiving branch starts a stocktake.
  const clerk = await browser.newContext();
  await clerk.request.post("/api/session", { data: { role: "clerk", branchId: ids[s.to] } });
  const opened = await clerk.request.post("/api/stocktakes", { data: { commandId: crypto.randomUUID() } });
  expect(opened.ok()).toBeTruthy();
  const stocktakeId = (await opened.json()).result._id;
  try {
    await page.reload();
    await expect(page.getByRole("note").filter({ hasText: "Left out while a stocktake is in progress" })).toContainText(s.to);
    const rows = await suggestions(page);
    expect(rows.some((r) => r.from === s.to || r.to === s.to)).toBe(false);

    const refused = await accept(page, s, ids);
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error.code).toBe("STOCKTAKE_OPEN");
  } finally {
    await clerk.request.post(`/api/stocktakes/${stocktakeId}/submit`, { data: { commandId: crypto.randomUUID(), uncounted: "leave" } });
    await clerk.close();
  }
});

test("clerk sessions cannot accept transfers", async ({ request }) => {
  const clerk = await request.post("/api/session", { data: { role: "clerk", branchId: "BR-BRS" } });
  expect(clerk.ok()).toBeTruthy();
  const res = await request.post("/api/transfers", { data: { commandId: crypto.randomUUID(), sku: "X", fromBranchId: "BR-A", toBranchId: "BR-B", qty: 1 } });
  expect(res.status()).toBe(403);
});
