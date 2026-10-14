// Lets a clerk reopen the count page in a stockroom dead spot. Counts themselves already survive
// offline in the page's queue (localStorage); this only keeps the page and its assets openable.
const PAGES = "bb-pages-v1"; // /count pages, per signed-in clerk; cleared on sign-in and sign-out
const STATIC = "bb-static-v1"; // /_next/static files: content-hashed, so a cached copy never goes stale
const STATIC_MAX = 200;
const NETWORK_WAIT_MS = 4000; // dead spots often hang rather than fail
const PAGE_MAX_AGE_MS = 8 * 3_600_000; // the session's lifetime: never show a copy older than a sign-in
const served = new Map(); // url -> { fromCache, cachedAt, at }, so the page can say it is an offline copy

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== PAGES && k !== STATIC).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // A new or ended session must never see the previous clerk's page.
  if (req.method === "POST" && (url.pathname === "/logout" || url.pathname === "/api/session")) {
    event.waitUntil(caches.delete(PAGES));
    return;
  }
  if (req.method !== "GET") return;
  if (url.pathname.startsWith("/_next/static/")) return event.respondWith(staticFile(req));
  if (req.mode === "navigate" && (url.pathname === "/count" || url.pathname.startsWith("/count/"))) {
    event.respondWith(page(event, req));
  }
});

async function staticFile(req) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - STATIC_MAX)).map((k) => cache.delete(k))); // oldest first
  }
  return res;
}

async function page(event, req) {
  const network = fetch(req).then(async (res) => {
    // Only a real page for this session: not a redirect to /login or /count, not an error.
    if (res.ok && !res.redirected && res.type === "basic") {
      const copy = new Headers(res.headers);
      copy.set("x-cached-at", String(Date.now()));
      const body = await res.clone().arrayBuffer();
      await (await caches.open(PAGES)).put(req.url, new Response(body, { status: res.status, headers: copy }));
    }
    return res;
  });
  event.waitUntil(network.catch(() => {})); // a slow page still refreshes the copy after we fall back
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_WAIT_MS, null));
  const fresh = await Promise.race([network.catch(() => null), timeout]);
  if (fresh) {
    served.set(req.url, { fromCache: false, at: Date.now() });
    return fresh;
  }
  const cached = await (await caches.open(PAGES)).match(req.url);
  const cachedAt = Number(cached?.headers.get("x-cached-at"));
  if (cached && Date.now() - cachedAt < PAGE_MAX_AGE_MS) {
    served.set(req.url, { fromCache: true, cachedAt, at: Date.now() });
    return cached;
  }
  return network; // nothing usable saved: let the browser show its own error (or a late response)
}

// The page asks how it was served; answers only about a load in the last minute.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "served?" || !event.ports[0]) return;
  const s = served.get(event.data.url);
  event.ports[0].postMessage(s && Date.now() - s.at < 60_000 ? s : { fromCache: false });
});
