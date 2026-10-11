import { expect, test, type Page, type Request } from "@playwright/test";

// A client-side navigation fetches only the changed segment's RSC payload, so the (manager) layout's
// role check does not run for it. Each manager page must check the role itself.

async function navigate(page: Page, click: () => Promise<void>, path: RegExp): Promise<Request> {
  const [req] = await Promise.all([
    page.waitForRequest((r) => !!r.headers()["rsc"] && !r.headers()["next-router-prefetch"] && path.test(new URL(r.url()).pathname)),
    click(),
  ]);
  await page.waitForURL((u) => path.test(u.pathname));
  return req;
}

test("a clerk replaying a manager page's navigation payload gets none of its data", async ({ page, playwright, baseURL }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Manager/ }).click();
  await page.waitForURL(/\/recall/);
  const nav = (name: string) => () => page.getByRole("navigation", { name: "Main" }).getByRole("link", { name }).click();

  // [request, text only the page's data would contain]
  const captured: [Request, string][] = [];
  // Use the Approved tab: the seed always has one APPROVED stocktake, whereas the SUBMITTED list is
  // emptied by stocktake.spec.ts, so this test passes in any file order.
  await navigate(page, nav("Stocktakes"), /^\/stocktakes$/);
  captured.push([await navigate(page, () => page.getByRole("link", { name: /^Approved/ }).click(), /^\/stocktakes$/), "-seed"]);
  captured.push([await navigate(page, () => page.getByRole("link", { name: "View", exact: true }).first().click(), /^\/stocktakes\/ST-/), "valuePence"]);
  captured.push([await navigate(page, nav("Transfers"), /^\/transfers$/), "fromBranchId"]);
  captured.push([await navigate(page, nav("Recall"), /^\/recall$/), "B-3920"]);

  const clerk = await playwright.request.newContext({ baseURL });
  const branchId = "BR-LEE";
  expect((await clerk.post("/api/session", { data: { role: "clerk", branchId } })).ok()).toBeTruthy();
  try {
    for (const [req, marker] of captured) {
      const headers = Object.fromEntries(Object.entries(req.headers()).filter(([k]) => k === "rsc" || k.startsWith("next-")));
      const asManager = await (await page.request.get(req.url(), { headers })).text();
      expect(asManager, `manager payload for ${req.url()}`).toContain(marker);
      const res = await clerk.get(req.url(), { headers, maxRedirects: 0 });
      expect(await res.text(), `clerk payload for ${req.url()}`).not.toContain(marker);
    }
  } finally {
    await clerk.dispose();
  }
});
