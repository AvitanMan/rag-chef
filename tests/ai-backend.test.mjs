import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
const dir = await mkdtemp(join(tmpdir(), "ai-backend-"));
after(() => rm(dir, { recursive: true, force: true }));
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"(?:@\/app\/lib|\.)\/([\w-]+)"/g, '"./$1.mjs"').replaceAll('"@/app/api/assistant/route"', '"./fake-assistant.mjs"');
for (const file of await readdir(new URL("../app/lib/", import.meta.url))) if (file.endsWith(".ts")) await writeFile(join(dir, file.replace(/\.ts$/, ".mjs")), compile(await readFile(new URL(`../app/lib/${file}`, import.meta.url), "utf8")));
for (const [name, path] of [["result", "tasks/[id]/result"], ["cancel", "tasks/[id]"]]) await writeFile(join(dir, `${name}.mjs`), compile(await readFile(new URL(`../app/api/ai/${path}/route.ts`, import.meta.url), "utf8")));
await writeFile(join(dir, "fake-assistant.mjs"), `import {createAiWorkflow,aiWorkflowResponse} from './ai-inference.mjs';import {localHousehold} from './household.mjs';export async function executeAssistant(request,resume){try{const input=await request.json();const {infer}=await createAiWorkflow(request,localHousehold(),{operation:'assistant',input,kitchenRevision:0},resume);const schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};const answer=await infer({operation:'assistant_intent',schema,messages:[{role:'user',content:input.query}]});if(input.verify)await infer({operation:'verify_claims',schema,messages:[{role:'user',content:JSON.stringify({answer,evidence:'authoritative source'})}]});return Response.json({answer});}catch(error){const response=aiWorkflowResponse(error);if(response)return response;throw error;}}`);
const loadModule = async name => import(pathToFileURL(join(dir, `${name}.mjs`)));
const household = await loadModule("household"), ai = await loadModule("ai-inference"), connections = await loadModule("ai-connections");
const { POST: submit } = await loadModule("result"), { DELETE: cancel } = await loadModule("cancel");
const migration = await readFile(new URL("../drizzle/0007_ai_connections.sql", import.meta.url), "utf8");
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE organization(id TEXT PRIMARY KEY); CREATE TABLE user(id TEXT PRIMARY KEY);" + migration + "CREATE TABLE kitchen_state(id TEXT PRIMARY KEY,state_json TEXT,revision INTEGER,updated_at TEXT);");
  const wrapper = { prepare(sql) { let args = []; return { bind(...values) { args = values; return this; }, async first() { return db.prepare(sql).get(...args) ?? null; }, async run() { return db.prepare(sql).run(...args); }, async all() { return { results: db.prepare(sql).all(...args) }; } }; } };
  household.configureHouseholdRuntime({ DB: wrapper, AI_CREDENTIALS_ENCRYPTION_KEY_V1: Buffer.alloc(32, 7).toString("base64"), AI_CREDENTIALS_KEY_VERSION: "v1", RAG_CHEF_HOSTED: "0" });
  return db;
}
const context = () => household.localHousehold();
const schema = { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] };
const input = () => ({ ai: { provider: "browser_ollama", model: "test-model" }, query: "Plan dinner" });
const request = body => new Request("http://localhost/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const inference = () => ({ operation: "assistant_intent", schema, messages: [{ role: "user", content: "Plan dinner" }] });
async function prepare(body = input()) { const flow = await ai.createAiWorkflow(request(body), context(), { operation: "assistant", input: body, kitchenRevision: 0 }); try { await flow.infer(inference()); } catch (error) { assert.ok(error instanceof ai.AiTaskRequired); return error.task; } assert.fail("Expected browser task"); }

test("personal credentials are encrypted, actor-bound, redacted, replaceable and removable", async () => {
  const db = setup(), key = "sk-test-personal-credential-abcdefghijklmnopqrstuvwxyz";
  const saved = await connections.saveOpenAIConnection(context(), key, "gpt-4.1-mini");
  assert.equal(saved.openai.configured, true); assert.equal(saved.openai.lastFour, "wxyz"); assert.ok(!JSON.stringify(saved).includes(key));
  const row = db.prepare("SELECT * FROM ai_connections").get(); assert.notEqual(row.cipher_text, key); assert.ok(!row.cipher_text.includes(key));
  assert.equal((await connections.readOpenAIConnection(context())).apiKey, key);
  assert.equal(await connections.readOpenAIConnection({ ...context(), userId: "other-user" }), undefined);
  await assert.rejects(connections.decryptAiCredential(row.cipher_text, row.iv, "other-user", row.key_version));
  await assert.rejects(connections.decryptAiCredential(row.cipher_text, row.iv, context().userId, "v2"));
  assert.equal((await connections.deleteOpenAIConnection(context())).openai.configured, false); assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_connections").get().n, 0);
  db.close();
});

test("browser tasks bind actor, household, revision, exact prompt and schema without kitchen writes", async () => {
  const db = setup(), task = await prepare();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM kitchen_state").get().n, 0);
  const row = await ai.loadAiTask(context(), task.taskId, task.token);
  assert.notEqual(row.token_hash, task.token);
  await assert.rejects(ai.loadAiTask({ ...context(), userId: "other" }, task.taskId, task.token), /unavailable/);
  await assert.rejects(ai.loadAiTask({ ...context(), householdId: "other" }, task.taskId, task.token), /unavailable/);
  await assert.rejects(ai.loadAiTask(context(), task.taskId, "wrong"), /unavailable/);
  const resume = { workflowId: row.workflow_id, transcript: [{ requestHash: row.request_hash, rawOutput: '{"ok":true}' }] };
  const flow = await ai.createAiWorkflow(request(input()), context(), { operation: "assistant", input: input(), kitchenRevision: 0 }, resume);
  assert.deepEqual(await flow.infer(inference()), { ok: true });
  const changed = await ai.createAiWorkflow(request(input()), context(), { operation: "assistant", input: input(), kitchenRevision: 0 }, resume);
  await assert.rejects(changed.infer({ ...inference(), messages: [{ role: "user", content: "Changed recipe" }] }), /context changed/);
  const invalid = await ai.createAiWorkflow(request(input()), context(), { operation: "assistant", input: input(), kitchenRevision: 0 }, { ...resume, transcript: [{ requestHash: row.request_hash, rawOutput: '{}' }] });
  await assert.rejects(invalid.infer(inference()), /invalid structured/);
  db.prepare("UPDATE ai_model_tasks SET kitchen_revision=1 WHERE id=?").run(task.taskId);
  await assert.rejects(ai.loadAiTask(context(), task.taskId, task.token), /kitchen changed/);
  db.close();
});

test("task completion replays identically, rejects different output, and cancellation invalidates workflow", async () => {
  const db = setup(), task = await prepare(), route = { params: Promise.resolve({ id: task.taskId }) };
  const submitted = await submit(request({ token: task.token, rawOutput: '{"ok":true}' }), route);
  assert.equal(submitted.status, 200); const body = await submitted.json(); assert.deepEqual(body, { answer: { ok: true } });
  const replay = await submit(request({ token: task.token, rawOutput: '{"ok":true}' }), route); assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), body);
  assert.equal((await submit(request({ token: task.token, rawOutput: '{"ok":false}' }), route)).status, 409);
  assert.equal((await cancel(request({ token: task.token }), route)).status, 200);
  assert.equal((await submit(request({ token: task.token, rawOutput: '{"ok":true}' }), route)).status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM kitchen_state").get().n, 0);
  db.close();
});

test("expired tasks and malformed structured output cannot resume; hosted feature flag fails closed", async () => {
  const db = setup(), task = await prepare();
  db.prepare("UPDATE ai_model_tasks SET expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(task.taskId);
  await assert.rejects(ai.loadAiTask(context(), task.taskId, task.token), /expired/);
  await assert.rejects(ai.createAiWorkflow(request(input()), { ...context(), mode: "hosted", assistantEnabled: false }, { operation: "assistant", input: input(), kitchenRevision: 0 }), /not enabled/);
  for (const bad of [{}, { ok: "true" }, { ok: true, injected: "save" }, []]) assert.throws(() => ai.validateAiSchema(bad, schema), /invalid structured/);
  db.close();
});

test("verification is a separate bound phase and cancelling an earlier task invalidates its continuation", async () => {
  const db = setup(), first = await prepare({ ...input(), verify: true });
  const firstRoute = { params: Promise.resolve({ id: first.taskId }) };
  const next = await submit(request({ token: first.token, rawOutput: '{"ok":true}' }), firstRoute);
  assert.equal(next.status, 202); const { task: second } = await next.json(); assert.equal(second.operation, "verify_claims");
  assert.match(second.ollamaRequest.messages[0].content, /authoritative source/);
  assert.match(second.ollamaRequest.messages[0].content, /"ok":true/);
  assert.equal((await submit(request({ token: first.token, rawOutput: '{"ok":false}' }), firstRoute)).status, 409);
  const replay = await (await submit(request({ token: first.token, rawOutput: '{"ok":true}' }), firstRoute)).json(); assert.deepEqual(replay.task, second);
  assert.equal((await cancel(request({ token: first.token }), firstRoute)).status, 200);
  assert.equal((await submit(request({ token: second.token, rawOutput: '{"ok":true}' }), { params: Promise.resolve({ id: second.taskId }) })).status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM kitchen_state").get().n, 0); db.close();
});

test("OpenAI structured inference uses only the supplied personal key and has no Ollama dependency", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push(url); assert.equal(url, "https://api.openai.com/v1/responses"); assert.equal(options.headers.authorization, "Bearer personal-test-key"); const body = JSON.parse(options.body); assert.equal(body.store, false); assert.equal(body.text.format.strict, true); return Response.json({ status: "completed", output: [{ content: [{ type: "output_text", text: '{"ok":true}' }] }] }); };
  try { assert.deepEqual(await connections.runOpenAIInference({ apiKey: "personal-test-key", model: "test" }, "test", inference()), { ok: true }); assert.equal(calls.length, 1); }
  finally { globalThis.fetch = original; }
});

test("deleting or replacing a personal OpenAI connection stops later inference phases", async () => {
  const db = setup(), original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ status: "completed", output: [{ content: [{ type: "output_text", text: '{"ok":true}' }] }] }); };
  try {
    for (const change of ["delete", "replace"]) {
      await connections.saveOpenAIConnection(context(), "sk-test-original-credential-abcdefghijklmnopqrstuvwxyz", "test-model");
      const body = { ai: { provider: "openai", model: "test-model" }, query: "Plan dinner" };
      const flow = await ai.createAiWorkflow(request(body), context(), { operation: "assistant", input: body, kitchenRevision: 0 });
      assert.deepEqual(await flow.infer(inference()), { ok: true });
      const before = calls;
      if (change === "delete") await connections.deleteOpenAIConnection(context());
      else await connections.saveOpenAIConnection(context(), "sk-test-replacement-credential-abcdefghijklmnopqrstuvwxyz", "test-model");
      await assert.rejects(flow.infer(inference()), /connection changed/);
      assert.equal(calls, before, "No further provider request may use the superseded key");
    }
  } finally { globalThis.fetch = original; db.close(); }
});

test("standalone assistant retains server Ollama and environment OpenAI without saved connections", async () => {
  const db = setup(), original = globalThis.fetch, originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "standalone-test-key";
  try {
    for (const provider of ["ollama", "openai"]) {
      globalThis.fetch = async (url, options) => {
        if (provider === "ollama") { assert.equal(url, "http://127.0.0.1:11434/api/chat"); return Response.json({ message: { content: '{"ok":true}' } }); }
        assert.equal(url, "https://api.openai.com/v1/responses"); assert.equal(options.headers.authorization, "Bearer standalone-test-key");
        return Response.json({ output: [{ content: [{ type: "output_text", text: '{"ok":true}' }] }] });
      };
      const body = { query: "Plan dinner", provider, model: "test" };
      const flow = await ai.createAiWorkflow(request(body), context(), { operation: "assistant", input: body, kitchenRevision: 0 });
      assert.deepEqual(await flow.infer(inference()), { ok: true });
    }
    assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_connections").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_model_tasks").get().n, 0);
    await assert.rejects(ai.createAiWorkflow(request({ query: "Plan dinner" }), { ...context(), mode: "hosted" }, { operation: "assistant", input: { query: "Plan dinner" }, kitchenRevision: 0 }), /personal OpenAI/);
  } finally { globalThis.fetch = original; if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey; db.close(); }
});

test("deleting an account or household removes its private model task context",async()=>{
  const db=setup();
  db.prepare("INSERT INTO user VALUES (?)").run(context().userId);db.prepare("INSERT INTO organization VALUES (?)").run(context().householdId);
  await connections.saveOpenAIConnection(context(),"sk-test-personal-credential-abcdefghijklmnopqrstuvwxyz","test");await prepare();
  db.prepare("DELETE FROM organization WHERE id=?").run(context().householdId);assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_model_tasks").get().n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_connections").get().n,1);
  await prepare();db.prepare("DELETE FROM user WHERE id=?").run(context().userId);assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_model_tasks").get().n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_connections").get().n,0);db.close();
});
