// Lets a clerk reopen the count page in a stockroom dead spot. Counts themselves already survive
// offline in the page's queue (localStorage); this only keeps the page and its assets openable.
const PAGES = "bb-pages-v2"; // /count pages, saved on the page's request; cleared on sign-in and sign-out
const STATIC = "bb-static-v1"; // /_next/static files: content-hashed, so a cached copy never goes stale
const STATIC_MAX = 200;
const NETWORK_WAIT_MS = 4000; // dead spots often hang rather than fail
const SESSION_MS = 8 * 3_600_000; // src/auth/session.ts TTL_MS
const served = new Map(); // page key -> { fromCache, cachedAt, at }, so the page can say it is an offline copy
let epoch = 0; // bumped by sign-in/out, so a save still in flight can't bring back the last clerk's page

const pageKey = (url) => {
  const u = new URL(url);
  return u.origin + u.pathname; // the count pages read no query string
};
const isCountPage = (url) => url.pathname === "/count" || url.pathname.startsWith("/count/");

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== PAGES && k !== STATIC).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function forgetPages() {
  epoch++;
  return caches.delete(PAGES);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // A new or ended session must never see the previous clerk's page.
  if ((req.method === "POST" && url.pathname === "/logout") || (req.method !== "GET" && url.pathname === "/api/session")) {
    event.waitUntil(forgetPages());
    return;
  }
  if (req.method !== "GET") return;
  if (url.pathname.startsWith("/_next/static/")) return event.respondWith(staticFile(req));
  if (req.mode === "navigate" && isCountPage(url)) event.respondWith(page(event, req));
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

// Network first; the saved copy only when the network fails or hangs. Pages are saved by request (below),
// because the app reaches them by client-side navigation, which never comes through here.
async function page(event, req) {
  const network = fetch(req);
  event.waitUntil(network.catch(() => {}));
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_WAIT_MS, null));
  const fresh = await Promise.race([network.catch(() => null), timeout]);
  const key = pageKey(req.url);
  if (fresh) {
    if (fresh.type === "opaqueredirect") event.waitUntil(forgetPages()); // signed out or not theirs: drop copies
    served.set(key, { fromCache: false, at: Date.now() });
    return fresh;
  }
  const cached = await (await caches.open(PAGES)).match(key);
  if (cached && Date.now() < Number(cached.headers.get("x-expires-at"))) {
    served.set(key, { fromCache: true, cachedAt: Number(cached.headers.get("x-cached-at")), at: Date.now() });
    return cached;
  }
  return network; // nothing usable saved: let the browser show its own error (or a late response)
}

async function savePage(url, expiresAt) {
  const target = new URL(url);
  // Device clock: winding it back keeps a copy longer; unavoidable on the client. Capped at a session's length.
  const expires = Math.min(expiresAt, Date.now() + SESSION_MS);
  if (target.origin !== self.location.origin || !isCountPage(target) || !(expires > Date.now())) return;
  const started = epoch;
  const pages = await caches.open(PAGES); // opened before the epoch check: a later sign-out orphans this handle
  const res = await fetch(target.href, { redirect: "manual" });
  // Only this session's real page: not a redirect to /login or /count, not an error.
  if (!res.ok || res.type !== "basic") return;
  const html = await res.text();
  // After a deploy the fresh page needs chunks this phone never loaded: fetch them now, or don't keep it.
  const statics = await caches.open(STATIC);
  const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s\\)]+/g) ?? [])];
  const missing = (await Promise.all(assets.map(async (a) => ((await statics.match(a)) ? null : a)))).filter(Boolean);
  if (missing.length && !(await statics.addAll(missing).then(() => true, () => false))) return;
  if (epoch !== started) return; // signed in or out meanwhile
  const headers = { "content-type": res.headers.get("content-type") ?? "text/html", "x-cached-at": String(Date.now()), "x-expires-at": String(expires) };
  await pages.put(pageKey(target.href), new Response(html, { headers }));
}

self.addEventListener("message", (event) => {
  const data = event.data;
  // The page asks to be saved (expiresAt: its session's end, so a copy never outlives the sign-in).
  if (data?.type === "save") return event.waitUntil(savePage(data.url, Number(data.expiresAt)).catch(() => {}));
  // The page asks how it was served; answers only about a load in the last minute.
  if (data?.type === "served?" && event.ports[0]) {
    const s = served.get(pageKey(data.url));
    event.ports[0].postMessage(s && Date.now() - s.at < 60_000 ? s : { fromCache: false });
  }
});
