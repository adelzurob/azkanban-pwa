// Minimal service worker for offline asset caching.
//
// Strategy: precache the app shell (HTML/CSS/JS), use cache-first for static
// assets and network-first (with cache fallback) for everything else. The
// boards.json data is NOT cached here — it's stored in IndexedDB by store.js
// because it changes constantly and needs structured queries.
//
// Bump CACHE_VERSION whenever you change the precache list.

// Bump this whenever the precache list changes OR when shipped JS/HTML/CSS
// changes substantively. The activate handler deletes any cache that doesn't
// match this name, forcing fresh fetches for everything in the precache list.
const CACHE_VERSION = "azkanban-pwa-v9";

// Required URLs — install fails atomically if any of these can't be cached.
// Keep this list to assets we KNOW exist on the deployed origin.
const REQUIRED_PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./styles/app.css",
  "./src/app.js",
  "./src/auth.js",
  "./src/graph.js",
  "./src/store.js",
  "./src/config.js",
  "./src/mutations.js",
  "./src/ui/board.js",
  "./src/ui/card.js",
  "./src/ui/archive.js",
  "./src/ui/search.js",
];

// Optional URLs — best-effort cached, missing entries don't block install.
// (Icons are listed here so the install doesn't fail before the user has
// produced real PNGs from icons/source.svg.)
const OPTIONAL_PRECACHE = [
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Required: addAll for atomic guarantee — if any of these 404, install fails.
    await cache.addAll(REQUIRED_PRECACHE);
    // Optional: add() each individually so a single 404 doesn't break install.
    await Promise.all(OPTIONAL_PRECACHE.map((url) =>
      cache.add(url).catch((err) => {
        console.warn(`Optional precache miss for ${url}:`, err.message || err);
      })
    ));
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_VERSION)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache Graph API or login.microsoftonline.com responses.
  if (
    url.host === "graph.microsoft.com" ||
    url.host === "login.microsoftonline.com" ||
    url.host === "login.live.com"
  ) {
    return;
  }

  // Same-origin: cache-first for precached assets, network-first for everything else.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request)
          .then((response) => {
            // Don't cache opaque/error responses.
            if (!response.ok) return response;
            const responseClone = response.clone();
            caches
              .open(CACHE_VERSION)
              .then((cache) => cache.put(event.request, responseClone));
            return response;
          })
          .catch(() => caches.match("./index.html"));
      })
    );
  }
});
