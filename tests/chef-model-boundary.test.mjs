import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const sources = await createSourceLoader({ name: "chef-model-boundary" });
const household = await sources.import("app/lib/household.ts");
const { createChefModelTransport } = await sources.import("app/lib/chef-provider.ts");
const { checkChefHealth } = await sources.import("app/lib/chef-health.ts");
const { checkOllamaReadiness, fetchProviderHealth } = await sources.import("app/lib/provider-readiness.ts");
const local = household.localHousehold();
const hosted = { ...local, mode: "hosted" };
const settings = { OPENAI_API_KEY: "test-only-not-a-real-key", OPENAI_MODEL: "cloud-model", OPENAI_BASE_URL: "https://provider.test/v1", OLLAMA_BASE_URL: "http://127.0.0.1:11434", OLLAMA_CHAT_MODEL: "chat-model", OLLAMA_EMBED_MODEL: "embed-model" };
const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
beforeEach(() => { household.configureHouseholdRuntime({}); Object.assign(process.env, settings); });
after(async () => {
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await sources.dispose();
});

test("every default model transport operation rejects hosted access before callbacks or network", async () => {
  household.configureHouseholdRuntime({ RAG_CHEF_HOSTED: "1" });
  let calls = 0;
  const forbidden = async () => { calls++; assert.fail("Hosted model access cannot reach provider I/O"); };
  const transport = createChefModelTransport({ fetchImpl: forbidden, checkVerifier: forbidden });
  for (const operation of [
    () => transport.generate({ provider: "openai", model: "cloud-model", systemPrompt: "", userPrompt: "", schema: {} }),
    () => transport.generate({ provider: "ollama", model: "chat-model", systemPrompt: "", userPrompt: "", schema: {} }),
    () => transport.embed("rice", "embed-model"), () => transport.checkVerifier(), () => transport.verify({}, [], {}),
  ]) await assert.rejects(operation(), error => error.code === "hosted_ai_unavailable" && error.status === 503);
  assert.equal(calls, 0);
});

test("hosted health returns explicit unavailable capabilities without any probe", async () => {
  const forbidden = async () => assert.fail("Hosted health must not probe local or paid providers");
  const result = await checkChefHealth({ provider: "openai", model: "cloud-model" }, { household: hosted }, { checkOllama: forbidden, fetchImpl: forbidden });
  assert.equal(result.status, 503); assert.equal(result.body.capabilities.generation.ready, false);
  assert.equal(result.body.capabilities.verification.ready, false); assert.equal(result.body.capabilities.embeddings.ready, false);
  assert.equal(result.body.providers, undefined);
});

test("local health probes model capabilities and sends the server key only to its configured cloud provider", async () => {
  const calls = [];
  const result = await checkChefHealth({ provider: "openai", model: "requested-cloud-model" }, { household: local }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: new Headers(init.headers), signal: init.signal });
      return String(url).endsWith("/api/tags") ? Response.json({ models: [{ name: "chat-model" }, { name: "embed-model" }] }) : Response.json({ id: "requested-cloud-model" });
    },
  });
  assert.equal(result.status, 200); assert.equal(result.body.ok, true);
  assert.equal(result.body.capabilities.generation.model, "requested-cloud-model");
  assert.equal(result.body.capabilities.verification.ready, true); assert.equal(result.body.capabilities.embeddings.ready, true);
  assert.deepEqual(calls.map(call => call.url), ["http://127.0.0.1:11434/api/tags", "https://provider.test/v1/models/requested-cloud-model"]);
  assert.equal(calls[0].headers.get("authorization"), null);
  assert.equal(calls[1].headers.get("authorization"), `Bearer ${settings.OPENAI_API_KEY}`);
  assert.ok(calls.every(call => call.signal instanceof AbortSignal));
});

test("invalid health selections stop before either provider probe", async () => {
  const forbidden = async () => assert.fail("Invalid selections cannot probe providers");
  for (const [query, code] of [[{ provider: "other", model: "" }, "invalid_provider"], [{ provider: "ollama", model: "x".repeat(121) }, "invalid_model"]]) {
    const result = await checkChefHealth(query, { household: local }, { checkOllama: forbidden, fetchImpl: forbidden });
    assert.equal(result.status, 400); assert.equal(result.body.error.code, code);
  }
});

test("readiness checks the configured verifier independently of a selected generation model", async () => {
  for (const [installed, generation, verification] of [
    [["custom-generation", "embed-model"], true, false],
    [["chat-model", "embed-model"], false, true],
    [["custom-generation", "chat-model", "embed-model"], true, true],
  ]) {
    const result = await checkChefHealth({ provider: "ollama", model: "custom-generation" }, { household: local }, {
      fetchImpl: async url => String(url).endsWith("/api/tags") ? Response.json({ models: installed.map(name => ({ name })) }) : Response.json({ id: "cloud-model" }),
    });
    assert.equal(result.body.capabilities.generation.ready, generation);
    assert.equal(result.body.capabilities.generation.model, "custom-generation");
    assert.equal(result.body.capabilities.verification.ready, verification);
    assert.equal(result.body.capabilities.verification.model, "chat-model");
    assert.equal(result.status, generation && verification ? 200 : 503);
  }
});

function stalledResponse(status, onAbort = () => {}) {
  return async (_url, init) => new Response(new ReadableStream({ start(controller) {
    init.signal.addEventListener("abort", () => { onAbort(); controller.error(init.signal.reason); }, { once: true });
  } }), { status });
}
test("capability deadlines remain active through successful and failed response bodies", async () => {
  for (const status of [200, 503]) {
    let aborted = false;
    await assert.rejects(fetchProviderHealth("https://provider.test/models", {}, { timeoutMs: 20, fetchImpl: stalledResponse(status, () => { aborted = true; }) }), error => error.name === "AbortError");
    assert.equal(aborted, true);
  }
  const ollama = await checkOllamaReadiness("chat-model", undefined, { timeoutMs: 20, fetchImpl: stalledResponse(200) });
  assert.equal(ollama.ok, false); assert.equal(ollama.reachable, false);
});

test("caller cancellation aborts both health probes, including bodies received before cancellation", async () => {
  const controller = new AbortController(); let started = 0, aborted = 0, resolveStarted;
  const allStarted = new Promise(resolve => { resolveStarted = resolve; });
  const pending = checkChefHealth({ provider: "openai", model: "" }, { household: local, signal: controller.signal }, {
    fetchImpl: async (_url, init) => {
      if (++started === 2) resolveStarted();
      return new Response(new ReadableStream({ start(stream) {
        init.signal.addEventListener("abort", () => { aborted++; stream.error(init.signal.reason); }, { once: true });
      } }));
    },
  });
  await allStarted; controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError");
  assert.equal(aborted, 2);
});
