/* Household Finance service worker.
   Strategy: network-first with cache fallback for same-origin GETs, so the app
   is always fresh online and still opens offline. GitHub API calls (sync) are
   never intercepted or cached. */
"use strict";

const CACHE = "household-finance-v2";
const PRECACHE = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "quick/",
  "quick/index.html",
  "quick/quick.js",
  "quick/manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/quick-192.png",
  "icons/quick-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch api.github.com etc.

  event.respondWith(
    // no-cache: revalidate with the server instead of trusting the HTTP cache,
    // so a deploy can't leave the page with a mixed old-CSS/new-JS version.
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req, { ignoreSearch: true });
        if (hit) return hit;
        // Offline navigation to an uncached URL: serve the app shell.
        if (req.mode === "navigate") {
          const shell = await caches.match(url.pathname.includes("/quick") ? "quick/" : "./");
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
