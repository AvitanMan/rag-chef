import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";
import { createSqliteD1 } from "./helpers/sqlite-d1.mjs";

const sources = await createSourceLoader({ name: "model-admission-integration" });
const sql = await createSqliteD1();
const household = await sources.import("app/lib/household.ts");
const { createRuntimeAdmissionStore } = await sources.import("app/lib/runtime-admission.ts");
const { createRuntimeModelAdmission } = await sources.import("app/lib/runtime-model-admission.ts");
const { createChefModelTransport } = await sources.import("app/lib/chef-provider.ts");
const { precomputeRecipeEmbeddings, embedTextsWithOllama } = await sources.import("app/lib/recipe-embeddings.ts");
const { fetchProviderHealth } = await sources.import("app/lib/provider-readiness.ts");
const store = createRuntimeAdmissionStore({ db: async () => sql.binding, setting: key => key === "MODEL_OLLAMA_CONCURRENCY" ? "1" : undefined });
const admission = () => createRuntimeModelAdmission({ store });
const active = () => sql.db.prepare("SELECT count(*) AS n FROM runtime_model_permits").get().n;
const request = { provider: "ollama", model: "test-model", systemPrompt: "Test", userPrompt: "Test", schema: {} };
const busy = error => error.status === 429 && error.code === "service_busy";
beforeEach(() => { household.configureHouseholdRuntime({}); sql.db.exec("DELETE FROM runtime_model_permits"); sql.queries.length = 0; });
after(async () => { sql.close(); await sources.dispose(); });

test("Chef generation and Catalog embedding clients share the same durable provider capacity through complete response parsing", async () => {
  let entered, finish, calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const first = createChefModelTransport({ admission: admission(), fetchImpl: async () => {
    calls++; entered();
    return new Response(new ReadableStream({ start(controller) { finish = () => {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: '{"answer":"ready"}' } }))); controller.close();
    }; } }));
  } });
  const second = createChefModelTransport({ admission: admission(), fetchImpl: async () => { calls++; return Response.json({ embeddings: [[1, 2, 3]] }); } });
  const pending = first.generate(request); await started;
  assert.equal(active(), 1, "response headers do not release the permit");
  await assert.rejects(second.embed("rice", "test-embed"), busy); assert.equal(calls, 1);
  finish(); assert.deepEqual(await pending, { answer: "ready" }); assert.equal(active(), 0);
  assert.deepEqual(await second.embed("rice", "test-embed"), [1, 2, 3]); assert.equal(calls, 2); assert.equal(active(), 0);
});

test("provider errors and malformed responses release permits without retrying the provider", async () => {
  for (const response of [() => new Response("broken JSON"), () => Response.json({ error: "Unavailable" }, { status: 503 })]) {
    let calls = 0;
    const transport = createChefModelTransport({ admission: admission(), fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(transport.generate(request));
    assert.equal(calls, 1); assert.equal(active(), 0);
    const permit = await store.acquireModelPermit("ollama"); await store.releaseModelPermit(permit);
  }
});

test("caller abort keeps capacity occupied until an unfinished operation actually stops", async () => {
  const controller = new AbortController(); let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const running = admission().run("ollama", "generation", async signal => {
    entered(); await new Promise(resolve => { finish = resolve; }); assert.equal(signal.aborted, true); return "late output";
  }, { signal: controller.signal });
  await started; controller.abort("user stopped");
  assert.equal(active(), 1); await assert.rejects(store.acquireModelPermit("ollama"), busy);
  finish(); await assert.rejects(running, error => error === "user stopped"); assert.equal(active(), 0);
});

test("cancellation and deadlines stop provider bodies before releasing their permits", async () => {
  for (const timed of [false, true]) {
    const controller = new AbortController(); let entered, aborted = false;
    const started = new Promise(resolve => { entered = resolve; });
    const transport = createChefModelTransport({ admission: admission(), timeoutMs: timed ? 20 : 1_000, fetchImpl: async (_url, init) => {
      entered(); return new Response(new ReadableStream({ start(stream) {
        init.signal.addEventListener("abort", () => { aborted = true; stream.error(init.signal.reason); }, { once: true });
      } }));
    } });
    const pending = transport.generate({ ...request, signal: controller.signal }); await started;
    assert.equal(active(), 1); if (!timed) controller.abort();
    await assert.rejects(pending); assert.equal(aborted, true); assert.equal(active(), 0);
  }
});

test("each embedding network batch gets one permit and persistence runs after release", async () => {
  const recipes = Array.from({ length: 3 }, (_, index) => ({ id: `rice-${index}`, title: `Rice ${index}`, image: null, category: "Dinner", cuisine: "Test", tags: [], ingredients: [{ name: "rice", measure: "200 g" }], instructions: ["Cook rice."], sourceUrl: `https://example.test/rice-${index}` }));
  let acquisitions = 0, calls = 0; const saved = [];
  const wrapped = createRuntimeModelAdmission({ store: { acquireModelPermit: (...args) => { acquisitions++; return store.acquireModelPermit(...args); }, releaseModelPermit: store.releaseModelPermit } });
  const result = await precomputeRecipeEmbeddings(recipes, [], { model: "test-embed", batchSize: 2, admission: wrapped,
    fetchImpl: async (_url, init) => { calls++; assert.equal(active(), 1); return Response.json({ embeddings: JSON.parse(init.body).input.map(() => [1, 2, 3]) }); },
    onBatchComplete: async rows => { assert.equal(active(), 0); saved.push(rows.map(row => row.recipeId)); },
  });
  assert.equal(result.completedCount, 3); assert.equal(acquisitions, 2); assert.equal(calls, 2);
  assert.deepEqual(saved, [["rice-0", "rice-1"], ["rice-2"]]);
});

test("hosted provider rejection happens before durable admission and storage", async () => {
  household.configureHouseholdRuntime({ RAG_CHEF_HOSTED: "1" });
  const transport = createChefModelTransport({ admission: admission(), fetchImpl: async () => assert.fail("Hosted requests cannot reach a provider") });
  await assert.rejects(transport.generate(request), error => error.code === "hosted_ai_unavailable");
  await assert.rejects(transport.embed("rice", "test-embed"), error => error.code === "hosted_ai_unavailable");
  assert.deepEqual(sql.queries, []); assert.equal(active(), 0);
});

test("rejected embedding responses release their permit even when stream cancellation never settles", async () => {
  let cancellations = 0;
  const transport = createChefModelTransport({ admission: admission(), fetchImpl: async () => new Response(new ReadableStream({
    cancel() { cancellations++; return new Promise(() => {}); },
  }), { status: 503 }) });
  let timer;
  try {
    const result = await Promise.race([
      transport.embed("rice", "test-embed").then(() => "resolved", error => error.code),
      new Promise(resolve => { timer = setTimeout(() => resolve("still-pending"), 100); }),
    ]);
    assert.equal(result, "provider_rejected");
    assert.equal(cancellations, 1);
    assert.equal(active(), 0);
  } finally { clearTimeout(timer); }
});

test("provider body deadlines actively cancel streams that do not inherit the fetch signal", async () => {
  const answer = { answer: "Cook the rice.", recommendations: [], sourceFacts: [], chefChanges: [], citations: [], warnings: [] };
  for (const [operation, status] of [["generation", 200], ["generation", 503], ["embedding", 200], ["verification", 200]]) {
    let cancellations = 0, calls = 0, timer;
    const fetchImpl = async () => {
      calls++;
      return new Response(new ReadableStream({ cancel() { cancellations++; return new Promise(() => {}); } }), { status });
    };
    const transport = createChefModelTransport({ admission: admission(), timeoutMs: 20, fetchImpl });
    const pending = operation === "generation" ? transport.generate(request)
      : operation === "embedding" ? embedTextsWithOllama(["rice"], { model: "test-embed", timeoutMs: 20, admission: admission(), fetchImpl })
      : transport.verify(answer, [{ recipeId: "rice", evidenceId: "S1", text: "Cook the rice." }], { baseUrl: "http://localhost:11434", model: "test-model", metadata: {}, timeoutMs: 20 });
    try {
      const result = await Promise.race([pending.then(() => "resolved", () => "rejected"), new Promise(resolve => { timer = setTimeout(() => resolve("still-pending"), 200); })]);
      assert.equal(result, "rejected", `${operation} ${status}`);
      assert.equal(cancellations, 1, operation);
      assert.equal(calls, 1, operation);
      assert.equal(active(), 0, operation);
    } finally { clearTimeout(timer); }
  }
});

test("health deadlines and rejected verification close streams without awaiting underlying cleanup", async () => {
  let cancellations = 0, timer;
  const fetchImpl = async () => new Response(new ReadableStream({ cancel() { cancellations++; return new Promise(() => {}); } }), { status: 503 });
  try {
    const result = await Promise.race([
      fetchProviderHealth("http://localhost:11434/api/tags", {}, { fetchImpl, timeoutMs: 20 }).then(() => "resolved", () => "rejected"),
      new Promise(resolve => { timer = setTimeout(() => resolve("still-pending"), 200); }),
    ]);
    assert.equal(result, "rejected");
    assert.equal(cancellations, 1);
  } finally { clearTimeout(timer); }
  const transport = createChefModelTransport({ admission: admission(), fetchImpl });
  const answer = { answer: "Cook the rice.", recommendations: [], sourceFacts: [], chefChanges: [], citations: [], warnings: [] };
  const result = await transport.verify(answer, [{ recipeId: "rice", evidenceId: "S1", text: "Cook the rice." }], { baseUrl: "http://localhost:11434", model: "test-model", metadata: {} });
  assert.equal(result.verification.status, "unavailable");
  assert.equal(cancellations, 2);
  assert.equal(active(), 0);
});
