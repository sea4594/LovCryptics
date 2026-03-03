// sw.js — LovCryptic SW (auto-versioned via /version.json commit SHA)

async function getBuild() {
  try {
    const res = await fetch("./version.json", { cache: "no-store" });
    const js = await res.json();
    return String(js?.build || "dev");
  } catch {
    return "dev";
  }
}

async function cacheNameFor(build) {
  return `lovcryptic-shell-${build}`;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const build = await getBuild();
      const cacheName = await cacheNameFor(build);

      const shell = [
        "./",
        "./index.html",
        "./styles.css",
        `./app.js?v=${build}`,
        "./idb.js",
        "./manifest.webmanifest",
        "./puzzles/index.json",
        "./version.json",
      ];

      const cache = await caches.open(cacheName);
      await cache.addAll(shell.map((u) => new Request(u, { cache: "reload" })));
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const build = await getBuild();
      const keep = await cacheNameFor(build);

      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k === keep ? null : caches.delete(k))));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Don’t cache cross-origin
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(req, { cache: "no-store" }));
    return;
  }

  const isNavigate = req.mode === "navigate";
  const isShell =
    isNavigate ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("/styles.css") ||
    url.pathname.endsWith("/idb.js") ||
    url.pathname.endsWith("/manifest.webmanifest") ||
    url.pathname.endsWith("/version.json");

  // app.js (and any query variants)
  const isAppJs = url.pathname.endsWith("/app.js");

  // Index / shell: network-first so you pick up new builds quickly
  if (isShell || isAppJs) {
    event.respondWith(
      (async () => {
        try {
          // Special case: always fetch app.js as versioned URL, never bare
          if (isAppJs) {
            const build = await getBuild();
            const vurl = new URL(req.url);
            vurl.searchParams.set("v", build);
            const fresh = await fetch(vurl.toString(), { cache: "no-store" });

            if (fresh.ok) {
              const cache = await caches.open(await cacheNameFor(build));
              cache.put(req, fresh.clone()); // store under bare /app.js request key
              cache.put(vurl.toString(), fresh.clone()); // also store under versioned URL
            }
            return fresh;
          }

          const fresh = await fetch(req, { cache: "no-store" });
          if (fresh.ok && req.method === "GET") {
            const build = await getBuild();
            const cache = await caches.open(await cacheNameFor(build));
            cache.put(req, fresh.clone());
          }
          return fresh;
        } catch {
          const cached = await caches.match(req);
          if (cached) return cached;
          if (isNavigate) {
            const fallback = await caches.match("./index.html");
            if (fallback) return fallback;
          }
          return new Response("Offline", { status: 503 });
        }
      })()
    );
    return;
  }

  // Puzzle JSON: cache-first (fast offline), fetch if missing
  const isPuzzleJson =
    (url.pathname.includes("/puzzles/") && url.pathname.endsWith(".json")) ||
    url.pathname.endsWith("/puzzles/index.json");

  if (isPuzzleJson) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const fresh = await fetch(req, { cache: "no-store" });
        if (fresh.ok && req.method === "GET") {
          const build = await getBuild();
          const cache = await caches.open(await cacheNameFor(build));
          cache.put(req, fresh.clone());
        }
        return fresh;
      })()
    );
    return;
  }

  // Default: cache-first
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      return fetch(req);
    })()
  );
});
