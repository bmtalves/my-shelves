// Offline support: keeps the app itself available without a connection.
// Book lookups (Open Library, Google Books) always go to the network.
const CACHE = "myshelves-v6";
const SHELL = ["./", "index.html", "styles.css?v=9", "app.js?v=9", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png",
  "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const isShell = url.origin === location.origin || url.href.startsWith("https://cdn.jsdelivr.net/npm/@zxing/") || url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com");
  if (!isShell) return; // book data and covers: straight to the network
  // Network first for the app's own files (so updates arrive), cache as fallback offline.
  e.respondWith(
    // "no-cache" makes the browser check GitHub for a newer copy instead of reusing one for up to 10 minutes.
    fetch(req, url.origin === location.origin ? { cache: "no-cache" } : undefined).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((m) => m || caches.match("index.html")))
  );
});
