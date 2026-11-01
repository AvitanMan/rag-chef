/* The production app shell stays available when the local server is offline. */
const CACHE = "rag-chef-shell-v4";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const response = await fetch("/kitchen-shell.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Offline shell manifest is unavailable.");
    const manifest = await response.json();
    const urls = manifest.urls.filter(value => typeof value === "string" && value.startsWith("/assets/") && !value.startsWith("//"));
    await cache.addAll(["/", ...urls]);
    await self.skipWaiting();
  })());
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
      // Vite's same-origin bundles can carry Vary: Origin. WebKit includes an
      // Origin header on module loads that cache.add() did not send. The bundle
      // URL identifies the static bytes, so reuse it across that header change.
      const staticBundle = url.pathname.startsWith("/assets/") && ["script", "style", "font"].includes(request.destination);
      const cached = await cache.match(request, { ignoreVary: staticBundle }) ?? (request.mode === "navigate" ? await cache.match("/") : undefined);
      return cached ?? new Response("Open RAG Chef once while the local server is running to save its offline shell.", { status: 503 });
    }
  })());
});
