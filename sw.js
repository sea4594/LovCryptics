/* sw.js — LovCryptic
   Guarantees updates propagate on GitHub Pages (network-first app shell),
   avoids caching cross-origin JSON, and activates immediately.
*/

const CACHE_NAME = "lovcryptic-shell-v1";

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./idb.js",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // cache:reload forces fresh fetches during install
    await cache.addAll(APP_SHELL.map((u) => new Request(u, { cache: "reload" })));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Purge older caches
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k))));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never cache cross-origin (puzzle JSON)
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(req, { cache: "no-store" }));
    return;
  }

  const isShell =
    req.mode === "navigate" ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("/app.js") ||
    url.pathname.endsWith("/styles.css") ||
    url.pathname.endsWith("/idb.js") ||
    url.pathname.endsWith("/manifest.webmanifest");

  // App shell: NETWORK-FIRST so GitHub deploys show immediately
  if (isShell) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: "no-store" });

        if (req.method === "GET" && fresh && fresh.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;

        if (req.mode === "navigate") {
          const fallback = await caches.match("./index.html");
          if (fallback) return fallback;
        }
        return new Response("Offline", { status: 503, statusText: "Offline" });
      }
    })());
    return;
  }

  // Other same-origin assets: cache-first
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;

    const fresh = await fetch(req);
    if (req.method === "GET" && fresh && fresh.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone());
    }
    return fresh;
  })());
});