// sw.js — LovCryptic service worker (auto-versioned via /version.json)

async function getVersion() {
  try {
    const res = await fetch("./version.json", { cache: "no-store" });
    const js = await res.json();
    return String(js?.build || "dev");
  } catch {
    return "dev";
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const v = await getVersion();
      const cacheName = `lovcryptic-shell-${v}`;

      const shell = [
        "./",
        "./index.html",
        "./styles.css",
        `./app.js?v=${v}`,
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
      const v = await getVersion();
      const keep = `lovcryptic-shell-${v}`;
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

  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(req, { cache: "no-store" }));
    return;
  }

  const isShell =
    req.mode === "navigate" ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("/styles.css") ||
    url.pathname.endsWith("/idb.js") ||
    url.pathname.endsWith("/manifest.webmanifest") ||
    url.pathname.endsWith("/version.json") ||
    url.pathname.endsWith("/app.js");

  // Network-first for shell (stays fresh), cache fallback for offline
  if (isShell) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req, { cache: "no-store" });
          // store into whatever the current version cache is
          const v = await getVersion();
          const cache = await caches.open(`lovcryptic-shell-${v}`);
          cache.put(req, fresh.clone());
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
      })()
    );
    return;
  }

  // puzzle json: cache-first
  const isPuzzleJson = url.pathname.startsWith("/LovCryptics/puzzles/") || url.pathname.startsWith("/puzzles/");
  if (isPuzzleJson && url.pathname.endsWith(".json")) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const fresh = await fetch(req, { cache: "no-store" });
        if (fresh && fresh.ok) {
          const v = await getVersion();
          const cache = await caches.open(`lovcryptic-shell-${v}`);
          cache.put(req, fresh.clone());
        }
        return fresh;
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      return fetch(req);
    })()
  );
});
