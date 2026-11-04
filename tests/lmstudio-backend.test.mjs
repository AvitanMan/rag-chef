import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const dir = await mkdtemp(join(tmpdir(), "lmstudio-backend-"));
after(() => rm(dir, { recursive: true, force: true }));
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"(?:@\/app\/lib|\.)\/([\w-]+)"/g, '"./$1.mjs"');
for (const file of await readdir(new URL("../app/lib/", import.meta.url))) if (file.endsWith(".ts")) await writeFile(join(dir, file.replace(/\.ts$/, ".mjs")), compile(await readFile(new URL(`../app/lib/${file}`, import.meta.url), "utf8")));
await writeFile(join(dir, "health.mjs"), compile(await readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8")));
const load = name => import(pathToFileURL(join(dir, `${name}.mjs`)));
const household = await load("household"), ai = await load("ai-inference"), lm = await load("lmstudio"), health = await load("health"), verifier = await load("chef-verification");
const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const inference = { operation: "assistant_intent", schema, messages: [{ role: "user", content: "Plan dinner" }] };
const response = value => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] });
const request = () => new Request("http://localhost/api/assistant", { method: "POST" });
const configure = extra => household.configureHouseholdRuntime({ RAG_CHEF_HOSTED: "0", LMSTUDIO_MODEL: "studio-model", LMSTUDIO_API_KEY: "", ...extra });

test("LM Studio standalone generation and source verification use the selected model without Ollama", async () => {
  configure({ LMSTUDIO_API_KEY: "local-only-token" });
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "http://127.0.0.1:1234/v1/chat/completions");
    assert.equal(options.redirect, "error"); assert.equal(options.headers.authorization, "Bearer local-only-token");
    const body = JSON.parse(options.body); calls.push(body);
    assert.equal(body.model, "studio-model"); assert.equal(body.response_format.json_schema.strict, true); assert.equal(body.stream, false);
    if (body.messages[0].content.startsWith("Verify each")) {
      const prompt = JSON.parse(body.messages[1].content);
      return response({ sentences: prompt.sentences.map(sentence => ({ id: sentence.id, verdict: "supported", supportRefs: [prompt.evidence[0].ref] })) });
    }
    return response({ ok: true });
  };
  try {
    const workflow = await ai.createAiWorkflow(request(), household.localHousehold(), { operation: "assistant", input: { provider: "lmstudio" }, kitchenRevision: 0 });
    assert.equal(workflow.provider, "server_lmstudio"); assert.deepEqual(await workflow.infer(inference), { ok: true });
    const checked = await verifier.verifyChefAnswer({ answer: "Boil the rice.", sourceFacts: [], recommendations: [], chefChanges: [], citations: [], warnings: [] }, [{ recipeId: "rice", evidenceId: "S1", text: "Boil the rice." }], { model: "studio-model", baseUrl: "http://unavailable.invalid", metadata: {}, infer: workflow.infer });
    assert.equal(checked.verification.status, "checked"); assert.equal(calls.length, 2);
  } finally { globalThis.fetch = original; }
});

test("LM Studio rejects truncated, refused, malformed, oversized and schema-invalid output", async () => {
  configure(); const original = globalThis.fetch;
  try {
    for (const payload of [
      { choices: [{ finish_reason: "length", message: { content: '{"ok":true}' } }] },
      { choices: [{ finish_reason: "stop", message: { content: '{"ok":true}', refusal: "refused" } }] },
      { choices: [{ finish_reason: "stop", message: { content: "not json" } }] },
      { choices: [{ finish_reason: "stop", message: { content: '{"ok":"yes"}' } }] },
      { choices: [{ finish_reason: "stop", message: { content: "x".repeat(256_001) } }] },
    ]) {
      globalThis.fetch = async () => Response.json(payload);
      const workflow = await ai.createAiWorkflow(request(), household.localHousehold(), { operation: "assistant", input: { provider: "lmstudio" }, kitchenRevision: 0 });
      await assert.rejects(workflow.infer(inference), /invalid|unavailable/i);
    }
  } finally { globalThis.fetch = original; }
});

test("LM Studio requires an explicit model and rejects remote or credential-bearing endpoints before a request", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Must not fetch"); };
  try {
    configure({ LMSTUDIO_MODEL: "" });
    await assert.rejects(ai.createAiWorkflow(request(), household.localHousehold(), { operation: "assistant", input: { provider: "lmstudio" }, kitchenRevision: 0 }), /model identifier/);
    for (const endpoint of ["https://example.com/v1", "http://127.0.0.1:1234/v1?token=secret", "http://user:pass@localhost:1234/v1", "http://localhost:1234/other"]) {
      configure({ LMSTUDIO_BASE_URL: endpoint });
      await assert.rejects(lm.runLMStudioInference("studio-model", inference), /loopback LM Studio/);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("LM Studio health remains ready with Ollama unavailable and reports missing selected models", async () => {
  configure(); const original = globalThis.fetch;
  globalThis.fetch = async url => {
    if (url === "http://127.0.0.1:1234/v1/models") return Response.json({ data: [{ id: "studio-model" }] });
    throw new Error("Other providers are unavailable");
  };
  try {
    const ready = await health.GET(new Request("http://localhost/api/health?provider=lmstudio&model=studio-model"));
    assert.equal(ready.status, 200); const body = await ready.json(); assert.equal(body.ok, true); assert.equal(body.capabilities.verification.ready, true); assert.equal(body.providers.ollama.ok, false);
    const missing = await health.GET(new Request("http://localhost/api/health?provider=lmstudio&model=missing"));
    assert.equal(missing.status, 503); assert.equal((await missing.json()).capabilities.verification.ready, false);
  } finally { globalThis.fetch = original; }
});

test("LM Studio browser tasks preserve schema, bind provider, and never contact the server's local model", async () => {
  const db = new DatabaseSync(":memory:");
  const migration = await readFile(new URL("../drizzle/0007_ai_connections.sql", import.meta.url), "utf8");
  db.exec("CREATE TABLE organization(id TEXT PRIMARY KEY); CREATE TABLE user(id TEXT PRIMARY KEY);" + migration);
  const binding = { prepare(sql) { let args = []; return { bind(...values) { args = values; return this; }, async first() { return db.prepare(sql).get(...args) ?? null; }, async run() { return db.prepare(sql).run(...args); } }; } };
  configure({ DB: binding });
  const original = globalThis.fetch; globalThis.fetch = async () => { throw new Error("No server model call allowed"); };
  try {
    const input = { ai: { provider: "browser_lmstudio", model: "studio-model" } };
    const context = { ...household.localHousehold(), mode: "hosted" };
    const flow = await ai.createAiWorkflow(request(), context, { operation: "chef", input, kitchenRevision: 0 });
    let task;
    await assert.rejects(flow.infer(inference), error => { assert.ok(error instanceof ai.AiTaskRequired); task = error.task; return true; });
    assert.equal(task.provider, "browser_lmstudio"); assert.deepEqual(task.ollamaRequest.format, schema);
    const row = db.prepare("SELECT * FROM ai_model_tasks WHERE id = ?").get(task.taskId);
    const resume = { workflowId: row.workflow_id, transcript: [{ requestHash: row.request_hash, rawOutput: '{"ok":true}' }] };
    const resumed = await ai.createAiWorkflow(request(), context, { operation: "chef", input, kitchenRevision: 0 }, resume);
    assert.deepEqual(await resumed.infer(inference), { ok: true });
    const swapped = await ai.createAiWorkflow(request(), context, { operation: "chef", input: { ai: { ...input.ai, provider: "browser_ollama" } }, kitchenRevision: 0 }, resume);
    await assert.rejects(swapped.infer(inference), /context changed/);
  } finally { globalThis.fetch = original; db.close(); configure(); }
});
