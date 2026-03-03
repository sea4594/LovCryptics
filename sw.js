const CACHE_NAME = "lovcryptic-shell-v1";

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./idb.js",
  "./manifest.webmanifest",
  "./puzzles/index.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL.map((u) => new Request(u, { cache: "reload" })));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
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

  // Never cache cross-origin
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(req, { cache: "no-store" }));
    return;
  }

  const isPuzzleJson = url.pathname.startsWith("/puzzles/") && url.pathname.endsWith(".json");
  const isIndexJson = url.pathname.endsWith("/puzzles/index.json");

  const isShell =
    req.mode === "navigate" ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("/app.js") ||
    url.pathname.endsWith("/styles.css") ||
    url.pathname.endsWith("/idb.js") ||
    url.pathname.endsWith("/manifest.webmanifest");

  // App shell: network-first
  if (isShell || isIndexJson) {
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
        return new Response("Offline", { status: 503 });
      }
    })());
    return;
  }

  // Puzzle JSON: cache-first (permanent until repo updates)
  if (isPuzzleJson) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const fresh = await fetch(req, { cache: "no-store" });
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
      }
      return fresh;
    })());
    return;
  }

  // Other same-origin: cache-first
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
