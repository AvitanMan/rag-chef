/* The production app shell stays available when the local server is offline. */
const CACHE = "rag-chef-shell-v7";
let shellAllowed = true;
const noStore = response => /(?:^|,)\s*no-store\b/i.test(response.headers.get("cache-control") ?? "");
async function disableShell() {
  shellAllowed = false;
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith("rag-chef-shell-")).map(key => caches.delete(key)));
}
async function storeResponse(cache, request, response) {
  if (noStore(response)) { await disableShell(); return; }
  if (shellAllowed && response.ok) await cache.put(request, response.clone());
}
async function cacheUrl(cache, url) {
  if (!shellAllowed) return;
  const response = await fetch(url);
  await storeResponse(cache, url, response);
  if (!response.ok) throw new Error("Offline shell resource is unavailable.");
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const response = await fetch("/kitchen-shell.json", { cache: "no-store" });
    if (noStore(response)) { await disableShell(); throw new Error("This kitchen does not allow offline pages."); }
    if (!response.ok) throw new Error("Offline shell manifest is unavailable.");
    const manifest = await response.json();
    const urls = manifest.urls.filter(value => typeof value === "string" && value.startsWith("/assets/") && !value.startsWith("//"));
    await Promise.all(["/", ...urls].map(url => cacheUrl(cache, url)));
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
  if (event.data?.type === "DISABLE_SHELL") { event.waitUntil(disableShell()); return; }
  if (!shellAllowed || event.data?.type !== "CACHE_SHELL" || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.filter((value) => {
    try { const url = new URL(value, self.location.origin); return url.origin === self.location.origin && !url.pathname.startsWith("/api/"); }
    catch { return false; }
  }).slice(0, 150);
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.allSettled(urls.map(url => cacheUrl(cache, url)))));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.headers.has("authorization")) {
    // Leave authenticated requests to the browser's network handling. They must
    // never fall back to a page captured before the password was configured.
    event.waitUntil(disableShell().catch(() => {}));
    return;
  }
  if (!shellAllowed || request.method !== "GET" || url.pathname.startsWith("/api/") || url.pathname === "/kitchen-sw.js") return;
  if (request.cache === "no-store" || noStore(request)) return;
  if (request.mode !== "navigate" && !["script", "style", "font", "image"].includes(request.destination)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    let response;
    try { response = await fetch(request); }
    catch {
      if (!shellAllowed) return new Response("Connect to the kitchen server to open this page.", { status: 503 });
      // Vite's same-origin bundles can carry Vary: Origin. WebKit includes an
      // Origin header on module loads that cache.add() did not send. The bundle
      // URL identifies the static bytes, so reuse it across that header change.
      const staticBundle = url.pathname.startsWith("/assets/") && ["script", "style", "font"].includes(request.destination);
      const cached = await cache.match(request, { ignoreVary: staticBundle }) ?? (request.mode === "navigate" ? await cache.match("/") : undefined);
      return cached ?? new Response("Open RAG Chef once while the local server is running to save its offline shell.", { status: 503 });
    }
    // Cache failures must not replace a successful private/network response
    // with an older offline page.
    try { await storeResponse(cache, request, response); } catch { /* Browser storage can be unavailable. */ }
    return response;
  })());
});
