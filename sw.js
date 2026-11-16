// Keeps the app shell available offline. Translations (/api) always go to the network.
// Network-first for everything; pages (HTML) bypass the HTTP cache so a new version shows up immediately.
const CACHE = "ingush-v13";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/") || url.origin !== location.origin) return;
  const isPage = e.request.mode === "navigate" || (e.request.headers.get("accept") || "").includes("text/html");
  e.respondWith(
    fetch(e.request, isPage ? { cache: "no-store" } : undefined).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match("/")))
  );
});
