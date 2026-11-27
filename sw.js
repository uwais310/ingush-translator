// Keeps the app shell available offline. Translations (/api) always go to the network.
// Pages and files open instantly from the cache, and a fresh copy is fetched in the background
// for the next launch (stale-while-revalidate). With nothing cached yet, the network is used.
// A new version of the site bumps CACHE: the new worker takes over and the page reloads once.
const CACHE = "ingush-v33";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"];
self.addEventListener("install", (e) => e.waitUntil(
  caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "no-store" })))).then(() => self.skipWaiting())
));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/") || url.origin !== location.origin) return;
  const isPage = e.request.mode === "navigate" || (e.request.headers.get("accept") || "").includes("text/html");
  // pages are stored without ?query (?splash and the like show the same page)
  const key = isPage ? url.origin + url.pathname : e.request;
  const fresh = fetch(e.request, isPage ? { cache: "no-store" } : undefined).then((res) => {
    if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
    return res;
  });
  e.respondWith(
    caches.match(key).then((hit) => {
      if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
      return fresh.catch(() => caches.match(isPage ? "/" : key).then((r) => r || Response.error()));
    })
  );
});
