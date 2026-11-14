import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const sources = await createSourceLoader({ name: "service-observability" });
const trace = await sources.import("app/lib/service-observability.ts");
after(() => sources.dispose());
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const publicId = "11111111-1111-4111-8111-111111111111";
function capture(t) {
  const entries = [];
  t.mock.method(console, "info", (...args) => { assert.equal(args.length, 1); entries.push(JSON.parse(args[0])); });
  return entries;
}

test("gateway traces ignore public IDs and retain one correlation ID across nested routes and private hops", async t => {
  const entries = capture(t), observed = [], context = { marker: true };
  const route = trace.withGatewayTrace("chef.answer", async (_request, passedContext) => {
    assert.strictEqual(passedContext, context); const gateway = trace.currentServiceTrace(); observed.push(gateway);
    const response = await trace.withInternalTrace("chef", "chef.answer", new Request("https://chef.internal/answer", { headers: trace.serviceRequestHeaders() }), async () => {
      observed.push(trace.currentServiceTrace());
      return trace.withInternalTrace("catalog", "catalog.read", new Request("https://catalog.internal/read", { headers: trace.serviceRequestHeaders() }), async () => {
        observed.push(trace.currentServiceTrace()); return Response.json({ ok: true });
      });
    });
    assert.strictEqual(trace.currentServiceTrace(), gateway);
    assert.equal(trace.compatibleServiceResponse(response), true);
    return response;
  });
  const gateway = trace.withGatewayTrace("gateway.request", route);
  const response = await gateway(new Request("http://localhost/api/chef", { headers: { "x-request-id": publicId, "x-rag-chef-request-id": publicId } }), context);
  const id = response.headers.get("x-request-id");
  assert.match(id, uuid); assert.notEqual(id, publicId);
  assert.deepEqual(observed.map(value => value.service), ["gateway", "chef", "catalog"]);
  assert.ok(observed.every(value => value.requestId === id));
  assert.ok(entries.every(value => value.requestId === id && Number.isFinite(value.durationMs)));
  assert.deepEqual(entries.map(value => value.operation), ["catalog.read", "chef.answer", "chef.answer", "gateway.request"]);
  assert.equal(trace.currentServiceTrace(), undefined);
});

test("overlapping asynchronous requests cannot exchange trace identity or service state", async t => {
  const entries = capture(t), contexts = new Map(); let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const handle = trace.withGatewayTrace("gateway.request", async request => {
    const name = new URL(request.url).pathname, before = trace.currentServiceTrace(); contexts.set(name, before);
    if (contexts.size === 2) release();
    await barrier; await Promise.resolve();
    assert.strictEqual(trace.currentServiceTrace(), before);
    return trace.withInternalTrace("chef", "chef.answer", new Request("https://chef.internal/answer", { headers: trace.serviceRequestHeaders() }), async () => {
      await Promise.resolve(); assert.equal(trace.currentServiceTrace().requestId, before.requestId); return Response.json({ ok: true });
    });
  });
  const responses = await Promise.all([handle(new Request("http://localhost/first")), handle(new Request("http://localhost/second"))]);
  assert.notEqual(contexts.get("/first").requestId, contexts.get("/second").requestId);
  for (const [index, name] of ["/first", "/second"].entries()) {
    assert.equal(responses[index].headers.get("x-request-id"), contexts.get(name).requestId);
    assert.deepEqual(entries.filter(entry => entry.requestId === contexts.get(name).requestId).map(entry => entry.service), ["chef", "gateway"]);
  }
  assert.equal(trace.currentServiceTrace(), undefined);
});

test("events redact untrusted content and keep only bounded operational metadata and timings", async t => {
  const entries = capture(t), sensitive = "private-query-cookie-key-profile-session";
  await trace.withInternalTrace("chef", "chef.answer", new Request("https://chef.internal/answer", { headers: { "x-rag-chef-request-id": publicId } }), async () => {
    trace.recordServiceEvent({ operation: "model.generation", status: 429, durationMs: 12.6, provider: "openai", attempt: 2,
      query: sensitive, prompt: sensitive, pantry: sensitive, profile: sensitive, userId: sensitive, householdId: sensitive, sessionId: sensitive, cookie: sensitive, authorization: sensitive, apiKey: sensitive, error: new Error(sensitive),
      timings: { retrievalMs: 1.6, generationMs: 3.4, verificationMs: -1, totalMs: Infinity, prompt: sensitive } });
    trace.recordServiceEvent({ operation: sensitive, status: 200, durationMs: 1 });
    trace.recordServiceEvent({ operation: "model.embedding", status: 999, durationMs: NaN, provider: sensitive, jobId: sensitive, attempt: -1, timings: { totalMs: -1, query: sensitive } });
    return Response.json({ ok: true });
  });
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { event: "service.operation", service: "chef", requestId: publicId, operation: "model.generation", status: 429, durationMs: 13, provider: "openai", attempt: 2, timings: { retrievalMs: 2, generationMs: 3 } });
  assert.deepEqual(entries[1], { event: "service.operation", service: "chef", requestId: publicId, operation: "model.embedding" });
  assert.ok(!JSON.stringify(entries).includes(sensitive));
});

test("job executions use stable job correlation without inheriting a submitting browser trace", async t => {
  const entries = capture(t), jobId = "22222222-2222-4222-8222-222222222222";
  for (const attempt of [1, 2]) await trace.withJobTrace(jobId, async () => {
    assert.deepEqual(trace.currentServiceTrace(), { service: "catalog", requestId: jobId, jobId });
    await Promise.resolve(); trace.recordServiceEvent({ operation: "catalog.job.run", status: 200, durationMs: 5, attempt });
  });
  assert.ok(entries.every(entry => entry.requestId === jobId && entry.jobId === jobId));
  assert.deepEqual(entries.map(entry => entry.attempt), [1, 2]);
  await trace.withJobTrace("untrusted-job-text", async () => { assert.match(trace.currentServiceTrace().requestId, uuid); });
});

test("incompatible service controls fail closed while legacy callers can request supported work", () => {
  assert.equal(trace.compatibleServiceResponse(new Response(null)), false);
  assert.equal(trace.compatibleServiceResponse(new Response(null, { headers: trace.serviceResponseHeaders() })), true);
  for (const headers of [{ "x-rag-chef-protocol": "2", "x-rag-chef-controls": "1" }, { "x-rag-chef-protocol": "1", "x-rag-chef-controls": "2" }]) assert.equal(trace.compatibleServiceResponse(new Response(null, { headers })), false);
  assert.equal(trace.requestedControlsSupported(new Request("https://chef.internal/ready")), true);
  assert.equal(trace.requestedControlsSupported(new Request("https://chef.internal/ready", { headers: { "x-rag-chef-required-controls": "1" } })), true);
  assert.equal(trace.requestedControlsSupported(new Request("https://chef.internal/ready", { headers: { "x-rag-chef-required-controls": "2" } })), false);
});

test("diagnostic failures cannot fail a request and invalid internal IDs are replaced", async t => {
  t.mock.method(console, "info", () => { throw new Error("Diagnostic sink unavailable"); });
  const response = await trace.withInternalTrace("catalog", "catalog.read", new Request("https://catalog.internal/read", { headers: { "x-rag-chef-request-id": "private-session-id" } }), async () => Response.json({ ok: true }));
  assert.equal(response.status, 200); assert.match(response.headers.get("x-request-id"), uuid);
  assert.notEqual(response.headers.get("x-request-id"), "private-session-id");
});
