import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";
import { catalogOperationResult, submitCatalogOperation } from "../tools/recipes/catalog-jobs.mjs";
const sources = await createSourceLoader({ name: "catalog-job-clients" });
after(() => sources.dispose());
const { waitForCatalogJob, CatalogJobFailedError } = await sources.import("app/lib/catalog-job-client.ts");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const path = "/api/admin/catalog/jobs/test-job";

test("browser progress reads only the constrained local status path and refuses redirected requests", async () => {
  const calls = [], job = { id: "test-job", status: "succeeded", result: { count: 3 } };
  const signal = new AbortController().signal;
  const result = await waitForCatalogJob(async (url, options) => {
    calls.push(url); assert.equal(options.method, undefined); assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error"); assert.strictEqual(options.signal, signal);
    return Response.json({ ok: true, job, statusUrl: path });
  }, path, signal);
  assert.deepEqual(result, job); assert.deepEqual(calls, [path]);
  for (const invalid of ["https://evil.test/status", "//evil.test/status", `${path}?next=https://evil.test`, "/api/admin/catalog/jobs/../private", "/api/kitchen"]) {
    await assert.rejects(waitForCatalogJob(async () => { assert.fail("Invalid status links must never be fetched"); }, invalid, signal), /invalid progress link/);
  }
});

test("terminal browser failures keep the worker error and aborted polling stops before another read", async () => {
  const controller = new AbortController(); let reads = 0;
  await assert.rejects(waitForCatalogJob(async () => Response.json({ job: { status: "failed", error: { message: "Source permissions changed" } } }), path, controller.signal),
    error => error instanceof CatalogJobFailedError && /Source permissions changed/.test(error.message));
  const pending = waitForCatalogJob(async () => { reads++; return Response.json({ job: { status: "queued" } }); }, path, controller.signal);
  await new Promise(setImmediate); controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError"); assert.equal(reads, 1);
});

test("CLI retries a lost acceptance response with the exact same idempotency key and body", async () => {
  const attempts = [];
  globalThis.fetch = async (url, options) => {
    attempts.push({ url, options }); assert.equal(options.redirect, "error");
    if (attempts.length === 1) throw new TypeError("Response lost after enqueue");
    return Response.json({ ok: true, job: { id: "test-job", status: "queued" }, statusUrl: path }, { status: 202 });
  };
  const response = await submitCatalogOperation("http://localhost:9999/api/admin/catalog/demo", undefined, { requestId: "stable-setup-request" });
  assert.equal(response.status, 202); assert.equal(attempts.length, 2);
  assert.equal(attempts[0].options.headers["Idempotency-Key"], "stable-setup-request");
  assert.deepEqual(attempts[1], attempts[0]);
});

test("CLI polls accepted work to its original result and never follows an external status link", async () => {
  const calls = [], result = { ok: true, count: 3 };
  globalThis.fetch = async (url, options) => {
    calls.push(String(url)); assert.equal(options.method, undefined); assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    return Response.json({ job: { id: "test-job", status: "succeeded", result }, statusUrl: path });
  };
  assert.deepEqual(await catalogOperationResult(Response.json({ job: { id: "test-job", status: "queued" }, statusUrl: path }, { status: 202 }), { base: "http://localhost:9999" }), result);
  assert.deepEqual(calls, [`http://localhost:9999${path}`]);
  for (const statusUrl of ["https://evil.test/status", "//evil.test/status", `${path}?redirect=elsewhere`]) {
    await assert.rejects(catalogOperationResult(Response.json({ job: { status: "queued" }, statusUrl }, { status: 202 }), { base: "http://localhost:9999" }), /invalid progress link/);
  }
  assert.equal(calls.length, 1);
});

test("CLI preserves terminal job errors and never resubmits an explicit authorization rejection", async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json({ error: { message: "Administrator required" } }, { status: 403 }); };
  const rejected = await submitCatalogOperation("http://localhost:9999/api/admin/catalog/demo");
  assert.equal(rejected.status, 403); assert.equal(requests, 1);
  await assert.rejects(catalogOperationResult(rejected), /Administrator required/);
  await assert.rejects(catalogOperationResult(Response.json({ job: { status: "failed", error: { message: "Source revoked while queued" } }, statusUrl: path }, { status: 202 }), { base: "http://localhost:9999" }), /Source revoked while queued/);
});
