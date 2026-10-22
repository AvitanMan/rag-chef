/* The production app shell stays available when the local server is offline. */
const CACHE = "rag-chef-shell-v2";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add("/")).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("rag-chef-shell-") && key !== CACHE).map((key) => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "CACHE_SHELL" || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.filter((value) => {
    try { const url = new URL(value, self.location.origin); return url.origin === self.location.origin && !url.pathname.startsWith("/api/"); }
    catch { return false; }
  }).slice(0, 150);
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.allSettled(urls.map((url) => cache.add(url)))));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/kitchen-sw.js") return;
  if (request.mode !== "navigate" && !["script", "style", "font", "image"].includes(request.destination)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch {
      const cached = await cache.match(request) ?? (request.mode === "navigate" ? await cache.match("/") : undefined);
      return cached ?? new Response("Open RAG Chef once while the local server is running to save its offline shell.", { status: 503 });
    }
  })());
});
