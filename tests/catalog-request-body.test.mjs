import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const sources = await createSourceLoader({ name: "catalog-request-body", externals: { "cloudflare:workers": "export const env = {};" } });
const household = await sources.import("app/lib/household.ts");
const { env } = await sources.import("cloudflare:workers");
let databaseCalls = 0;
beforeEach(t => {
  databaseCalls = 0;
  Object.assign(env, { RAG_CHEF_HOSTED: "0", CATALOG_ADMIN_TOKEN: "", DB: { prepare() { databaseCalls++; assert.fail("Rejected bodies cannot access catalog storage"); } } });
  household.configureHouseholdRuntime(env);
  t.mock.method(console, "info", () => {});
});

test("Catalog body validation cancels rejected producers and releases stream locks", async () => {
  const { catalogRequestText, CatalogBodyTooLargeError } = await sources.import("app/lib/catalog-job-api.ts");
  for (const kind of ["declared-size", "invalid-utf8", "already-aborted", "abort-pending"]) {
    let cancelled = 0, timer;
    const controller = new AbortController();
    const body = new ReadableStream({
      start(stream) { if (kind === "invalid-utf8") stream.enqueue(new Uint8Array([255])); },
      cancel() { cancelled++; return new Promise(() => {}); },
    });
    if (kind === "already-aborted") controller.abort();
    const request = new Request("http://localhost/api/admin/catalog", { method: "POST", body, duplex: "half", signal: controller.signal,
      headers: kind === "declared-size" ? { "content-length": "2048" } : {} });
    const pending = catalogRequestText(request, 1024);
    if (kind === "abort-pending") controller.abort();
    try {
      await assert.rejects(Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Rejected Catalog stream stayed pending")), 500); })]),
        error => kind === "declared-size" ? error instanceof CatalogBodyTooLargeError : kind === "invalid-utf8" ? error instanceof TypeError : error.name === "AbortError");
      assert.equal(cancelled, 1); assert.equal(request.body.locked, false);
    } finally { clearTimeout(timer); }
  }
});
after(() => sources.dispose());

for (const [path, limit, status] of [
  ["admin/catalog", 1024, 413], ["admin/catalog/demo", 1024, 400],
  ["admin/recipes/import", 1_000_000, 413], ["admin/recipes/metadata", 1_000_000, 413],
]) test(`${path} rejects an oversized stream without waiting for cancellation cleanup`, async () => {
  const route = await sources.import(`app/api/${path}/route.ts`);
  let cancelled = 0, timer;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(limit + 1)); },
    cancel() { cancelled++; return new Promise(() => {}); },
  });
  try {
    const response = await Promise.race([
      route.POST(new Request(`http://localhost/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Oversized body rejection hung during cancellation")), 500); }),
    ]);
    assert.equal(response.status, status); assert.equal(cancelled, 1); assert.equal(databaseCalls, 0);
  } finally { clearTimeout(timer); }
});
