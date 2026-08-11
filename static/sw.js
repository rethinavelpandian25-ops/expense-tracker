// Service worker for Ledger. Scope is intentionally narrow:
//
//   - Same-origin static files (CSS, JS, icons) are cached so the app shell
//     can still paint if the network is briefly unavailable, and repeat
//     loads are faster.
//   - Every HTML page and every /api/* request is ALWAYS fetched fresh
//     from the network, never cached. This is a financial app — serving a
//     stale dashboard or a stale transaction list because it was cached
//     would be actively misleading, not just an inconvenience. If the
//     network is unreachable for a page/API request, the fetch simply
//     fails the way it would with no service worker at all, rather than
//     silently showing old data.
//
// This is what makes the app installable as a standalone Android app (via
// PWABuilder/TWA) — a service worker is one of the PWA installability
// requirements — without taking on the risk that comes with caching
// anything sensitive.

const CACHE_NAME = "ledger-static-v1";

const STATIC_ASSETS = [
  "/static/css/style.css",
  "/static/js/auth.js",
  "/static/js/password-toggle.js",
  "/static/js/dashboard.js",
  "/static/js/transactions.js",
  "/static/js/reports.js",
  "/static/js/money-flow.js",
  "/static/js/settings.js",
  "/static/favicon.svg",
  "/static/favicon.ico",
  "/static/icons/favicon-16x16.png",
  "/static/icons/favicon-32x32.png",
  "/static/icons/favicon-48x48.png",
  "/static/icons/apple-touch-icon.png",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
  "/static/icons/icon-maskable-192.png",
  "/static/icons/icon-maskable-512.png",
  "/static/site.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Best-effort: don't fail install if one asset 404s (e.g. a future
      // version removes a file this list hasn't been updated for yet).
      Promise.allSettled(STATIC_ASSETS.map((url) => cache.add(url)))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

function isStaticAsset(url) {
  return url.origin === self.location.origin && (
    url.pathname.startsWith("/static/css/") ||
    url.pathname.startsWith("/static/js/") ||
    url.pathname.startsWith("/static/icons/") ||
    url.pathname === "/static/favicon.svg" ||
    url.pathname === "/static/favicon.ico" ||
    url.pathname === "/static/site.webmanifest"
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never intercept POST/PUT/DELETE — those must always hit the server

  const url = new URL(req.url);

  if (!isStaticAsset(url)) {
    // Pages and /api/* — network only, never served from cache.
    return;
  }

  // Static assets: cache-first, falling back to network and re-caching.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
