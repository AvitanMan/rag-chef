import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";
const workerSources = await createSourceLoader({ name: "catalog-read-worker", overrides: {
  "app/lib/catalog-read-service.ts": `
    export const fixture = { calls: [], scope: {hosted:false,sourceIds:[]} };
    export const catalogReadScope = () => fixture.scope;
    export const localCatalogReadService = {
      async configured() { fixture.calls.push(['configured']); return true; },
      async list(limit = 1000, options = {}) { fixture.calls.push(['list',limit,options]); return [{recipe:{id:'rice'}}]; },
      async embeddings(model, kind = 'recipe-search-v2', recipeId) { fixture.calls.push(['embeddings',model,kind,recipeId]); return [{recipeId,kind,model}]; },
      async sourcePolicy(id) { fixture.calls.push(['sourcePolicy',id]); return {approval_status:'approved'}; },
      async search(options, model) { fixture.calls.push(['search',options,model]); if (fixture.error) throw fixture.error; return {recipes:[],signalSeen:Boolean(options.signal)}; },
    };
    export const createRuntimeCatalogReadService = () => localCatalogReadService;
  `,
  "app/lib/catalog-job-runner.ts": "export async function drainCatalogJobs() { throw new Error('Read requests cannot execute catalog jobs'); }",
} });
const clientSources = await createSourceLoader({ name: "catalog-read-client", externals: { "cloudflare:workers": "export const env = {};" } });
after(async () => { await workerSources.dispose(); await clientSources.dispose(); });
const { default: worker } = await workerSources.import("worker/catalog.ts");
const { fixture } = await workerSources.import("app/lib/catalog-read-service.ts");
const { catalogReadService, catalogReadScope } = await clientSources.import("app/lib/catalog-read-service.ts");
const household = await clientSources.import("app/lib/household.ts");
const { env } = await clientSources.import("cloudflare:workers");
const { serviceResponseHeaders } = await clientSources.import("app/lib/service-observability.ts");
const request = (method, args, scope = fixture.scope) => new Request("https://catalog.internal/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, args, scope }) });

test("the private read boundary preserves optional arguments and all three embedding selectors", async () => {
  const calls = [];
  env.CATALOG = { fetch: async (url, options) => {
    calls.push(JSON.parse(options.body)); assert.equal(url, "https://catalog.internal/read");
    return worker.fetch(new Request(url, options), {});
  } };
  fixture.calls.length = 0;
  assert.equal(await catalogReadService.configured(), true);
  assert.deepEqual(await catalogReadService.list(undefined), [{ recipe: { id: "rice" } }]);
  assert.deepEqual(await catalogReadService.embeddings(undefined, undefined, "rice"), [{ recipeId: "rice", kind: "recipe-search-v2" }]);
  await catalogReadService.embeddings("model", "recipe-step-v1", "rice");
  assert.deepEqual(fixture.calls, [["configured"], ["list", 1000, {}], ["embeddings", undefined, "recipe-search-v2", "rice"], ["embeddings", "model", "recipe-step-v1", "rice"]]);
  assert.deepEqual(calls[2], { version: 1, method: "embeddings", args: [null, null, "rice"], scope: { hosted: false, sourceIds: [] } });
  const controller = new AbortController();
  const result = await catalogReadService.search({ query: "rice", signal: controller.signal }, "model");
  assert.equal(result.signalSeen, true);
  assert.equal(Object.hasOwn(calls.at(-1).args[0], "signal"), false, "cancellation travels with the request, not its JSON payload");
  const workerSignal = fixture.calls.at(-1)[1].signal;
  controller.abort(); assert.equal(workerSignal.aborted, true);
});

test("a missing or unavailable service binding cannot silently read the application's database", async () => {
  delete env.CATALOG;
  Object.defineProperty(env, "DB", { configurable: true, get() { assert.fail("Application retrieval cannot fall back to direct D1 access"); } });
  await assert.rejects(catalogReadService.list(), /binding is unavailable/);
  env.CATALOG = { fetch: async () => Response.json({ error: "Unavailable" }, { status: 503 }) };
  await assert.rejects(catalogReadService.list(), /contract is incompatible/);
  env.CATALOG = { fetch: async () => Response.json({ error: "Unavailable" }, { status: 503, headers: serviceResponseHeaders() }) };
  await assert.rejects(catalogReadService.list(), /temporarily unavailable/);
  delete env.DB;
});

test("the private worker rejects mutation names, excess arguments and unrelated HTTP paths", async () => {
  fixture.calls.length = 0;
  for (const [method, args] of [
    ["upsertRecipe", [{}]], ["saveEmbeddings", [[]]], ["reviewMetadata", [[]]], ["__proto__", []],
    ["configured", [true]], ["list", [10, {}, "extra"]], ["list", [10, { sourceOverride: "all" }]],
    ["embeddings", ["a", "b", "c", "d"]], ["sourcePolicy", []], ["search", [null, "model"]],
  ]) assert.equal((await worker.fetch(request(method, args), {})).status, 400);
  assert.equal((await worker.fetch(new Request("https://catalog.internal/read"), {})).status, 404);
  assert.equal((await worker.fetch(new Request("https://catalog.internal/write", { method: "POST" }), {})).status, 404);
  assert.deepEqual(fixture.calls, []);
});

test("hosted and source allowlist mismatches fail closed before any worker read", async () => {
  fixture.calls.length = 0;
  fixture.scope = { hosted: true, sourceIds: ["rag-chef-starters", "wikibooks"] };
  for (const scope of [{ hosted: false, sourceIds: [] }, { hosted: true, sourceIds: ["rag-chef-starters"] }, { hosted: true, sourceIds: ["rag-chef-starters", "unapproved", "wikibooks"] }, null]) {
    const response = await worker.fetch(request("list", [], scope), {});
    assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(fixture.calls, []);
  assert.equal((await worker.fetch(request("list", []), {})).status, 200);
  household.configureHouseholdRuntime({ RAG_CHEF_HOSTED: "1", HOSTED_RECIPE_SOURCE_IDS: "wikibooks, rag-chef-starters, bad/id, wikibooks, z-source" });
  assert.deepEqual(catalogReadScope(), { hosted: true, sourceIds: ["rag-chef-starters", "wikibooks", "z-source"] });
  household.configureHouseholdRuntime(env); fixture.scope = { hosted: false, sourceIds: [] };
});

test("legacy Catalog reads remain supported while explicit protocol and control incompatibilities stop before retrieval", async () => {
  fixture.calls.length = 0;
  const body = { method: "list", args: [], scope: fixture.scope };
  assert.equal((await worker.fetch(new Request("https://catalog.internal/read", { method: "POST", body: JSON.stringify(body) }), {})).status, 200);
  fixture.calls.length = 0;
  for (const version of [0, 2, "1", null]) assert.equal((await worker.fetch(new Request("https://catalog.internal/read", { method: "POST", body: JSON.stringify({ ...body, version }) }), {})).status, 400);
  assert.equal((await worker.fetch(new Request("https://catalog.internal/read", { method: "POST", headers: { "x-rag-chef-required-controls": "2" }, body: JSON.stringify({ ...body, version: 1 }) }), {})).status, 503);
  assert.deepEqual(fixture.calls, []);
});

test("provider capacity rejection survives the Catalog service boundary without a lexical fallback", async () => {
  const { RuntimeAdmissionError } = await workerSources.import("app/lib/runtime-admission-types.ts");
  fixture.error = new RuntimeAdmissionError("service_busy", "Busy", 429, 17);
  env.CATALOG = { fetch: (url, init) => worker.fetch(new Request(url, init), {}) };
  try {
    await assert.rejects(catalogReadService.search({ query: "rice" }, "model"), error => error.code === "service_busy" && error.status === 429 && error.retryAfterSec === 17);
  } finally { delete fixture.error; }
});

test("Catalog deadlines and caller cancellation close detached response streams even when provider cleanup never settles", async () => {
  const originalTimeout = AbortSignal.timeout;
  let timeoutCalls = 0;
  try {
    for (const status of [200, 503]) {
      for (const canceledByCaller of [false, true]) {
        const controller = new AbortController();
        let closed = 0;
        AbortSignal.timeout = milliseconds => {
          assert.equal(milliseconds, 30_000); timeoutCalls++;
          return originalTimeout.call(AbortSignal, canceledByCaller ? 30_000 : 10);
        };
        env.CATALOG = { fetch: async () => new Response(new ReadableStream({
          start(stream) { stream.enqueue(new TextEncoder().encode('{"unfinished":')); },
          cancel() { closed++; return new Promise(() => {}); },
        }), { status, headers: serviceResponseHeaders() }) };
        const operation = catalogReadService.search({ query: "rice", signal: controller.signal }, "model");
        const abort = canceledByCaller ? setTimeout(() => controller.abort(), 10) : undefined;
        let bound;
        try {
          await assert.rejects(Promise.race([operation, new Promise((_, reject) => { bound = setTimeout(() => reject(new Error("Catalog body exceeded its cancellation deadline")), 500); })]),
            error => error.name === (canceledByCaller ? "AbortError" : "TimeoutError"));
          assert.equal(closed, 1);
        } finally { clearTimeout(bound); clearTimeout(abort); }
      }
    }
    assert.equal(timeoutCalls, 4);
  } finally { AbortSignal.timeout = originalTimeout; }
});

test("incompatible Catalog responses close their bodies without awaiting cleanup", async () => {
  let closed = 0;
  env.CATALOG = { fetch: async () => new Response(new ReadableStream({ cancel() { closed++; return new Promise(() => {}); } })) };
  await assert.rejects(catalogReadService.list(), /contract is incompatible/);
  assert.equal(closed, 1);
});
