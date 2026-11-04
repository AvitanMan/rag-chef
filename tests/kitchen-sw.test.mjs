import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../public/kitchen-sw.js", import.meta.url), "utf8");
const origin = "https://ragchef.local:3443";
const request = (path = "/", headers = {}) => ({ url: new URL(path, origin).href, method: "GET", mode: "navigate", destination: "document", cache: "default", headers: new Headers(headers) });
function worker() {
  const listeners = new Map(), stores = new Map();
  let network = async () => new Response("network page");
  const key = value => new URL(typeof value === "string" ? value : value.url, origin).href;
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name),
    open: async name => {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return { put: async (url, response) => entries.set(key(url), response.clone()), match: async url => entries.get(key(url))?.clone() };
    },
  };
  runInNewContext(source, { URL, Response, caches, fetch: (...args) => network(...args), self: { location: { origin }, addEventListener: (name, action) => listeners.set(name, action), skipWaiting: async () => {}, clients: { claim: async () => {} } } });
  const dispatch = async (kind, data) => {
    let response;
    const work = [];
    listeners.get(kind)({ ...data, respondWith: value => { response = value; }, waitUntil: value => work.push(value) });
    await Promise.all(work);
    return response === undefined ? undefined : await response;
  };
  return { caches, stores, dispatch, network: fn => { network = fn; }, async seed() { await (await caches.open("rag-chef-shell-v5")).put("/", new Response("old offline page")); } };
}

test("authenticated requests bypass the worker and remove old offline pages", async () => {
  const w = worker(); await w.seed();
  w.network(() => { throw new Error("The worker must leave this request to the browser."); });
  assert.equal(await w.dispatch("fetch", { request: request("/", { authorization: "Basic example" }) }), undefined);
  assert.deepEqual(await w.caches.keys(), []);
  assert.equal(await w.dispatch("fetch", { request: request() }), undefined, "A disabled shell cannot serve cached pages on later requests.");
});

test("no-store responses replace stale offline pages without being cached", async () => {
  const w = worker(); await w.seed();
  w.network(async () => new Response("private live page", { headers: { "cache-control": "private, no-store, max-age=0" } }));
  const response = await w.dispatch("fetch", { request: request() });
  assert.equal(await response.text(), "private live page");
  assert.deepEqual(await w.caches.keys(), []);
  await w.dispatch("message", { data: { type: "CACHE_SHELL", urls: ["/"] } });
  assert.deepEqual(await w.caches.keys(), [], "Later prefetch messages cannot rebuild private pages.");
});

test("a cache cleanup failure cannot substitute stale HTML for the live no-store response", async () => {
  const w = worker(); await w.seed();
  w.caches.keys = async () => { throw new Error("Storage denied."); };
  w.network(async () => new Response("private live page", { headers: { "cache-control": "no-store" } }));
  assert.equal(await (await w.dispatch("fetch", { request: request() })).text(), "private live page");
  assert.equal(await w.dispatch("fetch", { request: request() }), undefined);
});

test("offline-shell prefetch honors no-store responses too", async () => {
  const w = worker(); await w.seed();
  w.network(async () => new Response("private prefetch", { headers: { "cache-control": "no-store" } }));
  await w.dispatch("message", { data: { type: "CACHE_SHELL", urls: ["/"] } });
  assert.deepEqual(await w.caches.keys(), []);
});

test("a protected shell manifest cannot install an offline shell", async () => {
  const w = worker(); await w.seed();
  w.network(async () => Response.json({ urls: [] }, { headers: { "cache-control": "no-store" } }));
  await assert.rejects(w.dispatch("install", {}), /does not allow offline pages/);
  assert.deepEqual(await w.caches.keys(), []);
});

test("ordinary local pages remain available when their server goes offline", async () => {
  const w = worker();
  w.network(async () => new Response("saved local page", { headers: { "cache-control": "private, no-cache" } }));
  assert.equal(await (await w.dispatch("fetch", { request: request() })).text(), "saved local page");
  w.network(async () => { throw new Error("Offline."); });
  assert.equal(await (await w.dispatch("fetch", { request: request() })).text(), "saved local page");
});
