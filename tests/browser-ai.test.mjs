import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
const dir = await mkdtemp(join(tmpdir(), "browser-ai-"));
const priorWindow = globalThis.window;
globalThis.window = { location: { origin: "https://kitchen.example" } };
after(async () => { if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow; await rm(dir, { recursive: true, force: true }); });
const source = await readFile(new URL("../app/lib/browser-ai.ts", import.meta.url), "utf8");
await writeFile(join(dir, "browser-ai.mjs"), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace('"./app-session"', '"./app-session.mjs"'));
await writeFile(join(dir, "app-session.mjs"), "export const kitchenFetch = (...args) => globalThis.fetch(...args);");
const { assistantFetch, listLocalModels, localOllamaEndpoint, readLocalAI, LOCAL_AI_KEY } = await import(pathToFileURL(join(dir, "browser-ai.mjs")));
class MemoryStorage { values = new Map(); get length() { return this.values.size; } key(index) { return [...this.values.keys()][index] ?? null; } getItem(key) { return this.values.get(key) ?? null; } setItem(key,value) { this.values.set(key,String(value)); } removeItem(key) { this.values.delete(key); } clear() { this.values.clear(); } }
const selection = { provider: "ollama", ollamaModel: "test-model", openaiModel: "test-openai" };
const configured = () => { const storage = new MemoryStorage(); storage.setItem(LOCAL_AI_KEY, JSON.stringify({ endpoint: "http://127.0.0.1:11434", model: selection.ollamaModel, origin: window.location.origin, testedAt: new Date().toISOString() })); return storage; };
const task = (index = 1) => ({ taskId: `task-${index}`, token: "token-abcdefghijklmnopqrstuvwxyz", operation: "assistant_intent", model: "test-model", expiresAt: new Date(Date.now()+60_000).toISOString(), ollamaRequest: { model: "test-model", stream: false, think: false, format: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } }, messages: [{ role: "user", content: "Private kitchen request" }], options: { temperature: 0, num_predict: 100 } } });
const taskResponse = value => Response.json({ status: "requires_model", task: value }, { status: 202 });
const output = () => Response.json({ done_reason: "stop", message: { content: '{"ok":true}' } });

test("local endpoints reject remote hosts, embedded credentials, paths and origin-mismatched setup", async () => {
  for (const value of ["https://remote.example", "http://user:password@localhost:11434", "http://127.0.0.1:11434/api/chat", "http://localhost:11434?forward=evil", "file:///tmp/model"]) assert.throws(() => localOllamaEndpoint(value));
  assert.equal(localOllamaEndpoint("http://[::1]:11434"), "http://[::1]:11434");
  const storage = configured(); const saved = JSON.parse(storage.getItem(LOCAL_AI_KEY)); saved.origin = "https://another.example"; storage.setItem(LOCAL_AI_KEY, JSON.stringify(saved));
  let calls = 0;
  await assert.rejects(assistantFetch("/api/assistant", { query: "Plan dinner" }, { selection, hosted: true, storage, fetcher: async () => { calls++; return output(); } }), /Connect and test/);
  assert.equal(calls, 0);
  saved.testedAt = "invalid-date"; storage.setItem(LOCAL_AI_KEY, JSON.stringify(saved)); assert.equal(readLocalAI(storage), null);
});

test("manual previews need no model connection and standalone requests preserve legacy provider settings", async () => {
  const storage = new MemoryStorage(), requests = [];
  const fetcher = async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return Response.json({ draft: { reviewed: true } }); };
  assert.equal((await assistantFetch("/api/assistant", { intent: { pantry: [] } }, { selection, hosted: true, storage, fetcher })).status, 200);
  await assistantFetch("/api/assistant", { query: "Plan dinner" }, { selection: { ...selection, provider: "openai" }, hosted: false, storage, fetcher });
  assert.equal(requests[1].body.provider, "openai"); assert.equal(requests[1].body.model, "test-openai"); assert.equal(requests[1].body.ai, undefined);
  await assistantFetch("/api/chef", { provider: "ollama", model: "existing-model" }, { selection, hosted: false, storage, fetcher });
  assert.equal(requests[2].body.model, "existing-model");
});

test("browser phases use the injected account fetcher for server traffic and omit credentials locally", async () => {
  const original = globalThis.fetch, calls = [], storage = configured();
  globalThis.fetch = async (url, options) => { assert.equal(url, "http://127.0.0.1:11434/api/chat"); assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error"); assert.deepEqual(Object.keys(options.headers), ["Content-Type"]); return output(); };
  const fetcher = async (url, options) => { calls.push({url,body:JSON.parse(options.body)}); return url === "/api/assistant" ? taskResponse(task()) : Response.json({ draft: { ready: true } }); };
  try { const response = await assistantFetch("/api/assistant", { query: "Plan dinner" }, { selection, hosted: true, storage, fetcher }); assert.deepEqual(await response.json(), { draft: { ready: true } }); assert.equal(calls.length, 2); assert.equal(calls[0].body.ai.provider, "browser_ollama"); assert.deepEqual(calls[1].body, { token: task().token, rawOutput: '{"ok":true}' }); }
  finally { globalThis.fetch = original; }
});

test("malformed or expired task envelopes never reach a local model", async () => {
  const original = globalThis.fetch; let localCalls = 0;
  globalThis.fetch = async () => { localCalls++; return output(); };
  const mutations = [value => { value.expiresAt="not-a-date"; }, value => { value.expiresAt="2000-01-01T00:00:00Z"; }, value => { value.operation="delete_kitchen"; }, value => { value.ollamaRequest.model="different-model"; }, value => { value.ollamaRequest.stream=true; }, value => { value.ollamaRequest.messages=[]; }, value => { value.ollamaRequest.format="json"; }, value => { value.ollamaRequest.options.num_predict=1000000; }, value => { value.taskId="../../secrets"; }];
  try { for (const mutate of mutations) { const value=task(); mutate(value); await assert.rejects(assistantFetch("/api/assistant", {query:"Plan dinner"}, {selection,hosted:true,storage:configured(),fetcher:async (_url,options)=>options.method==="DELETE"?Response.json({cancelled:true}):taskResponse(value)}), /expired or is invalid/); } assert.equal(localCalls,0); }
  finally { globalThis.fetch=original; }
});

test("forgetting or changing a scoped connection cancels before execution or result submission", async () => {
  const original=globalThis.fetch;
  try { for (const stage of ["prepare","model"]) {
    const storage=configured(), calls=[]; let localCalls=0;
    globalThis.fetch=async()=>{localCalls++; if(stage==="model")storage.removeItem(LOCAL_AI_KEY); return output();};
    const fetcher=async(url,options)=>{calls.push({url,method:options.method}); if(options.method==="DELETE")return Response.json({cancelled:true}); if(stage==="prepare")storage.removeItem(LOCAL_AI_KEY); return taskResponse(task());};
    await assert.rejects(assistantFetch("/api/assistant",{query:"Plan dinner"},{selection,hosted:true,storage,fetcher}),/connection changed/);
    assert.equal(localCalls,stage==="prepare"?0:1); assert.ok(calls.some(call=>call.method==="DELETE")); assert.ok(!calls.some(call=>call.url.endsWith("/result")));
  } } finally {globalThis.fetch=original;}
});

test("cancelling a local request sends a scoped task cancellation and submits no late output",async()=>{
  const original=globalThis.fetch,controller=new AbortController(),calls=[];
  globalThis.fetch=async(_url,options)=>new Promise((_resolve,reject)=>{options.signal.addEventListener("abort",()=>reject(new DOMException("Cancelled","AbortError")),{once:true}); controller.abort();});
  const fetcher=async(url,options)=>{calls.push({url,options});return options.method==="DELETE"?Response.json({cancelled:true}):taskResponse(task());};
  try {await assert.rejects(assistantFetch("/api/assistant",{query:"Plan dinner"},{selection,hosted:true,storage:configured(),fetcher,signal:controller.signal}),/Cancelled|aborted/);assert.ok(calls.some(call=>call.options.method==="DELETE"&&call.options.keepalive===true&&!call.options.signal));assert.ok(!calls.some(call=>call.url.endsWith("/result")));}
  finally {globalThis.fetch=original;}
});

test("the bounded phase loop cancels the next issued task instead of leaving it live",async()=>{
  const original=globalThis.fetch,calls=[];let phase=0,localCalls=0;
  globalThis.fetch=async()=>{localCalls++;return output();};
  const fetcher=async(url,options)=>{calls.push({url,method:options.method});return options.method==="DELETE"?Response.json({cancelled:true}):taskResponse(task(++phase));};
  try {await assert.rejects(assistantFetch("/api/assistant",{query:"Plan dinner"},{selection,hosted:true,storage:configured(),fetcher}),/request limit/);assert.equal(localCalls,6);assert.ok(calls.some(call=>call.method==="DELETE"&&call.url==="/api/ai/tasks/task-7"));}
  finally {globalThis.fetch=original;}
});

test("denied loopback or legacy local-network permission prevents local requests", async () => {
  const originalFetch = globalThis.fetch, navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let localCalls = 0;
  globalThis.fetch = async () => { localCalls++; return output(); };
  try {
    for (const supportedName of ["loopback-network", "local-network-access"]) {
      const queried = [];
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { permissions: { query: async ({ name }) => {
        queried.push(name);
        if (name !== supportedName) throw new TypeError("Unsupported permission name");
        return { state: "denied" };
      } } } });
      await assert.rejects(listLocalModels("http://127.0.0.1:11434"), /Local-network access is blocked.*browser site settings/);
      assert.deepEqual(queried, supportedName === "loopback-network" ? ["loopback-network"] : ["loopback-network", "local-network-access"]);
    }
    assert.equal(localCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor); else delete globalThis.navigator;
  }
});

test("unsupported permission queries preserve normal connections without account headers", async () => {
  const originalFetch = globalThis.fetch, navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator"), queried = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { permissions: { query: async ({ name }) => { queried.push(name); throw new TypeError("Unsupported permission name"); } } } });
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, "http://127.0.0.1:11434/api/tags");
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers, undefined);
    return Response.json({ models: [{ name: "test-model" }] });
  };
  try {
    assert.deepEqual(await listLocalModels("http://127.0.0.1:11434"), ["test-model"]);
    assert.deepEqual(queried, ["loopback-network", "local-network-access"]);
    assert.equal(calls, 1);
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    await assert.rejects(listLocalModels("http://127.0.0.1:11434"), /Cannot reach Ollama.*OLLAMA_ORIGINS.*local-network access/);
  } finally {
    globalThis.fetch = originalFetch;
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor); else delete globalThis.navigator;
  }
});
