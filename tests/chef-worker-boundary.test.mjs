import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";
import { createSqliteD1 } from "./helpers/sqlite-d1.mjs";

const sources = await createSourceLoader({ name: "chef-worker-boundary", externals: { "cloudflare:workers": "export const env = {};" } });
const sql = await createSqliteD1();
const { env } = await sources.import("cloudflare:workers");
const household = await sources.import("app/lib/household.ts");
const { createChefWorker } = await sources.import("worker/chef.ts");
const { createChefClient } = await sources.import("app/lib/chef-client.ts");
const { ChefServiceError } = await sources.import("app/lib/chef-errors.ts");
const { readChefBody } = await sources.import("app/lib/chef-protocol.ts");
const { serviceResponseHeaders } = await sources.import("app/lib/service-observability.ts");
const chefRoute = await sources.import("app/api/chef/route.ts");
const healthRoute = await sources.import("app/api/health/route.ts");
const local = household.localHousehold();
const hosted = { mode: "hosted", userId: "reader", householdId: "family", role: "member", timezone: "UTC", assistantEnabled: false, sessionId: "reader-session" };
const hostedEnv = { DB: sql.binding, RAG_CHEF_HOSTED: "1", HOSTED_RECIPE_SOURCE_IDS: "wikibooks" };
const emptyAnswer = { answer: "No matching approved recipe.", recipes: [], generation: "catalog" };
const envelope = (extra = {}) => ({ version: 1, scope: { hosted: false, sourceIds: [] }, household: local, input: { query: "Suggest rice" }, ...extra });
const rpc = (body = envelope(), path = "answer", options = {}) => new Request(`https://chef.internal/${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...options,
});
const hostedEnvelope = () => envelope({ scope: { hosted: true, sourceIds: ["rag-chef-starters", "wikibooks"] }, household: hosted });
function seedIdentity() {
  const at = new Date().toISOString();
  sql.db.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run("reader", "Reader", "reader@example.test", 1, at, at);
  sql.db.prepare("INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run("reader-session", "reader", "reader-token", new Date(Date.now() + 86_400_000).toISOString(), at, at);
  sql.db.prepare("INSERT INTO organization(id,name,slug,createdAt) VALUES(?,?,?,?)").run("family", "Family", "family", at);
  sql.db.prepare("INSERT INTO household_settings(organizationId,timezone) VALUES(?,?)").run("family", "UTC");
  sql.db.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)").run("reader-membership", "family", "reader", "member", at);
}
beforeEach(() => {
  for (const key of Object.keys(env)) delete env[key];
  household.configureHouseholdRuntime(env);
  sql.db.exec("DELETE FROM organization; DELETE FROM user; DELETE FROM runtime_chef_usage; DELETE FROM runtime_model_permits");
  sql.queries.length = 0;
});
after(async () => { sql.close(); await sources.dispose(); });

test("public Chef forwards only raw input and authenticated context, preserving optional equipment", async () => {
  const received = [], inputs = [];
  const worker = createChefWorker({ chef: { async answer(input, context) { inputs.push(input); assert.deepEqual(context.household, local); return emptyAnswer; } } });
  env.CHEF = { async fetch(url, init) {
    received.push({ url, headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return worker.fetch(new Request(url, init), env);
  } };
  for (const profile of [undefined, { equipment: [] }, { equipment: ["Stovetop"] }]) {
    const input = { query: "Suggest rice", household: hosted, ...(profile ? { profile } : {}) };
    const response = await chefRoute.POST(new Request("http://localhost/api/chef", { method: "POST", headers: {
      "content-type": "application/json", cookie: "private-browser-cookie", authorization: "Bearer private-browser-token", "x-openai-api-key": "browser-key-must-not-travel",
    }, body: JSON.stringify(input) }));
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const forwarded = received.at(-1);
    assert.equal(forwarded.url, "https://chef.internal/answer");
    assert.deepEqual([...forwarded.headers.keys()].sort(), ["content-type", "x-rag-chef-request-id", "x-rag-chef-required-controls"]);
    assert.equal(forwarded.headers.get("x-rag-chef-required-controls"), "1");
    assert.equal(forwarded.headers.get("x-rag-chef-request-id"), response.headers.get("x-request-id"));
    assert.deepEqual(forwarded.body, envelope({ input }));
  }
  assert.equal(inputs[0].profile.equipmentSpecified, false);
  assert.equal(inputs[1].profile.equipmentSpecified, true);
  assert.equal(inputs[2].profile.equipmentSpecified, true);
  assert.deepEqual(inputs[2].profile.equipment, ["Stovetop"]);
});

test("public validation rejects malformed and oversized input before contacting the private service", async () => {
  let calls = 0;
  env.CHEF = { fetch: async () => { calls++; assert.fail("Rejected public input cannot contact Chef"); } };
  for (const [body, expected] of [["{", 400], [JSON.stringify({ query: 42 }), 400], [JSON.stringify({ query: "x".repeat(1_500_001) }), 413]]) {
    const response = await chefRoute.POST(new Request("http://localhost/api/chef", { method: "POST", body }));
    assert.equal(response.status, expected); assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(calls, 0);
});

async function promptly(pending) {
  let timer;
  try {
    return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Body handling did not settle promptly")), 500); })]);
  } finally { clearTimeout(timer); }
}
test("oversized streamed bodies reject even when the underlying stream never finishes cancellation", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([65, 66])); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  });
  await assert.rejects(promptly(readChefBody({ headers: new Headers(), signal: new AbortController().signal, body }, 1)),
    error => error instanceof ChefServiceError && error.status === 413 && error.code === "request_too_large");
  assert.equal(cancelled, true); assert.equal(body.locked, false);
});

test("body rejection closes declared oversized, invalid UTF-8, and already cancelled streams", async () => {
  for (const kind of ["declared oversized", "invalid UTF-8", "already cancelled"]) {
    let cancelled = false;
    const controller = new AbortController();
    const body = new ReadableStream({
      start(stream) { if (kind === "invalid UTF-8") stream.enqueue(new Uint8Array([255])); },
      cancel() { cancelled = true; return new Promise(() => {}); },
    });
    const headers = new Headers(kind === "declared oversized" ? { "content-length": "2" } : {});
    if (kind === "already cancelled") controller.abort("no longer needed");
    await assert.rejects(promptly(readChefBody({ headers, signal: controller.signal, body }, 1)), error =>
      kind === "declared oversized" ? error.status === 413 : kind === "invalid UTF-8" ? error instanceof TypeError : error === "no longer needed");
    assert.equal(cancelled, true, kind); assert.equal(body.locked, false, kind);
  }
});

test("cancelling a stalled request actively cancels its body without cooperation from its producer", async () => {
  const controller = new AbortController(); let reason;
  const body = new ReadableStream({ cancel(value) { reason = value; } });
  const pending = readChefBody({ headers: new Headers(), signal: controller.signal, body });
  controller.abort();
  await assert.rejects(promptly(pending), error => error.name === "AbortError");
  assert.strictEqual(reason, controller.signal.reason); assert.equal(body.locked, false);
});

test("private Chef rejects unknown operations and malformed envelopes before calling an application port", async () => {
  let calls = 0;
  const forbidden = async () => { calls++; assert.fail("Rejected private requests must not reach application ports"); };
  const worker = createChefWorker({ chef: { answer: forbidden }, health: forbidden, validateContext: forbidden });
  for (const path of ["write", "commands", "generate", "answer/extra"]) assert.equal((await worker.fetch(rpc(envelope(), path), env)).status, 404);
  assert.equal((await worker.fetch(new Request("https://chef.internal/answer"), env)).status, 404);
  for (const body of [
    envelope({ version: 2 }), envelope({ extra: true }), envelope({ query: { provider: null, model: "" } }),
    envelope({ household: { ...local, userId: "someone-else" } }), envelope({ household: { ...local, sessionId: "forged" } }),
    envelope({ household: { ...local, timezone: "UTC\u0000" } }), envelope({ household: { ...local, db: "other" } }),
  ]) assert.equal((await worker.fetch(rpc(body), env)).status, 400);
  assert.equal((await worker.fetch(rpc({ ...envelope(), input: "x".repeat(1_600_001) }), env)).status, 413);
  assert.equal(calls, 0);
});

test("hosted mode and effective source allowlists must match before authorization or model access", async () => {
  let calls = 0;
  const worker = createChefWorker({ chef: { answer: async () => { calls++; return emptyAnswer; } }, validateContext: async () => { calls++; return hosted; } });
  for (const [body, settings] of [
    [hostedEnvelope(), env], [envelope(), hostedEnv],
    [hostedEnvelope(), { ...hostedEnv, HOSTED_RECIPE_SOURCE_IDS: "other" }],
    [hostedEnvelope(), { ...hostedEnv, HOSTED_RECIPE_SOURCE_IDS: "" }],
  ]) {
    const response = await worker.fetch(rpc(body), settings);
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "chef_configuration_mismatch");
  }
  assert.equal(calls, 0);
});

test("private Chef validates live session and membership before even an empty answer", async () => {
  seedIdentity(); let calls = 0;
  const worker = createChefWorker({ chef: { answer: async () => { calls++; return emptyAnswer; } } });
  for (const context of [
    { ...hosted, householdId: "other-family" }, { ...hosted, userId: "other-user" }, { ...hosted, sessionId: "unknown-session" }, { ...hosted, role: "owner" }, { ...hosted, timezone: "Asia/Jerusalem" },
  ]) assert.equal((await worker.fetch(rpc({ ...hostedEnvelope(), household: context }), hostedEnv)).status, 403);
  sql.db.prepare("UPDATE session SET expiresAt=?").run("2020-01-01T00:00:00.000Z");
  assert.equal((await worker.fetch(rpc(hostedEnvelope()), hostedEnv)).status, 403);
  assert.equal(calls, 0);
});

test("revocation while an empty-catalog answer is running prevents its release, including error paths", async () => {
  for (const fail of [false, true]) {
    sql.db.exec("DELETE FROM organization; DELETE FROM user"); seedIdentity();
    const worker = createChefWorker({ chef: { answer: async () => {
      sql.db.exec("DELETE FROM member WHERE id='reader-membership'");
      if (fail) throw new ChefServiceError(409, "context_changed", "Source changed");
      return emptyAnswer;
    } } });
    const response = await worker.fetch(rpc(hostedEnvelope()), hostedEnv);
    assert.equal(response.status, 403); const body = await response.json();
    assert.equal(body.error.code, "MEMBERSHIP_CHANGED"); assert.equal(body.recipes, undefined);
  }
});

test("successful hosted operations recheck access independently of operational usage counters", async () => {
  seedIdentity(); sql.queries.length = 0;
  const worker = createChefWorker({ chef: { answer: async () => emptyAnswer }, authorizeUsage: async () => {} });
  const response = await worker.fetch(rpc(hostedEnvelope()), hostedEnv);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), emptyAnswer);
  assert.equal(sql.queries.length, 2, "authorization is checked before and after the answer");
  assert.ok(sql.queries.every(({ sql }) => /^\s*SELECT\b/i.test(sql)));
});

test("session revocation during a capability probe prevents its result from being released", async () => {
  seedIdentity();
  const worker = createChefWorker({ health: async () => {
    sql.db.exec("DELETE FROM session WHERE id='reader-session'");
    return { status: 200, body: { ok: true } };
  } });
  const body = hostedEnvelope(); delete body.input; body.query = { provider: null, model: "" };
  const response = await worker.fetch(rpc(body, "health"), hostedEnv);
  assert.equal(response.status, 403); assert.equal((await response.json()).error.code, "MEMBERSHIP_CHANGED");
});

test("concurrent household members share one usage budget while health and other households stay available", async () => {
  seedIdentity(); const at = new Date().toISOString();
  for (const userId of ["second-reader", "other-reader"]) {
    sql.db.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run(userId, userId, `${userId}@example.test`, 1, at, at);
    sql.db.prepare("INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run(`${userId}-session`, userId, `${userId}-token`, new Date(Date.now() + 86_400_000).toISOString(), at, at);
  }
  sql.db.prepare("INSERT INTO organization(id,name,slug,createdAt) VALUES(?,?,?,?)").run("other-family", "Other", "other-family", at);
  sql.db.prepare("INSERT INTO household_settings(organizationId,timezone) VALUES(?,?)").run("other-family", "UTC");
  for (const [user, family] of [["second-reader", "family"], ["other-reader", "other-family"]]) sql.db.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)").run(`${user}-membership`, family, user, "member", at);
  const settings = { ...hostedEnv, CHEF_HOSTED_REQUESTS_PER_MINUTE: "1", CHEF_HOSTED_REQUESTS_PER_DAY: "100" };
  let answers = 0, healthChecks = 0;
  const worker = createChefWorker({ chef: { answer: async () => { answers++; return emptyAnswer; } }, health: async () => { healthChecks++; return { status: 200, body: { ok: true } }; } });
  const second = { ...hosted, userId: "second-reader", sessionId: "second-reader-session" };
  const responses = await Promise.all([hosted, second].map(context => worker.fetch(rpc({ ...hostedEnvelope(), household: context }), settings)));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 429]); assert.equal(answers, 1);
  const rejected = responses.find(response => response.status === 429);
  assert.equal((await rejected.json()).error.code, "usage_limit_exceeded"); assert.ok(Number(rejected.headers.get("retry-after")) >= 1);
  const counters = () => sql.db.prepare("SELECT window_kind,used FROM runtime_chef_usage WHERE household_id='family' ORDER BY window_kind").all().map(row => ({ ...row }));
  assert.deepEqual(counters(), [{ window_kind: "day", used: 1 }, { window_kind: "minute", used: 1 }]);
  const health = hostedEnvelope(); delete health.input; health.query = { provider: null, model: "" };
  assert.equal((await worker.fetch(rpc(health, "health"), settings)).status, 200); assert.equal(healthChecks, 1);
  assert.deepEqual(counters(), [{ window_kind: "day", used: 1 }, { window_kind: "minute", used: 1 }]);
  const other = { ...hosted, userId: "other-reader", sessionId: "other-reader-session", householdId: "other-family" };
  assert.equal((await worker.fetch(rpc({ ...hostedEnvelope(), household: other }), settings)).status, 200); assert.equal(answers, 2);
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM kitchen_state").get().n, 0);
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM kitchen_command_receipt").get().n, 0);
});

test("private service errors preserve their status, code and context details through the client", async () => {
  const worker = createChefWorker({ chef: { answer: async () => { throw new ChefServiceError(409, "context_changed", "Recipe changed", { currentRevision: 8 }); } } });
  const client = createChefClient({ binding: async () => ({ fetch: (url, init) => worker.fetch(new Request(url, init), env) }) });
  const response = await client.request("answer", { household: local, input: { query: "Rice" } });
  assert.equal(response.status, 409); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: { code: "context_changed", message: "Recipe changed" }, currentRevision: 8 });
});

test("missing and broken private bindings fail closed without any provider or storage fallback", async t => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("Gateway cannot call model providers"));
  Object.defineProperty(env, "DB", { configurable: true, get() { assert.fail("Gateway cannot read kitchen state as a Chef fallback"); } });
  const missing = await chefRoute.POST(new Request("http://localhost/api/chef", { method: "POST", body: JSON.stringify({ query: "Rice" }) }));
  assert.equal(missing.status, 503); assert.equal((await missing.json()).error.code, "chef_unavailable");
  for (const fetch of [async () => { throw new Error("Worker unavailable"); }, async () => new Response("not json", { status: 502, headers: serviceResponseHeaders() }), async () => Response.json([], { headers: serviceResponseHeaders() })]) {
    const client = createChefClient({ binding: async () => ({ fetch }) });
    assert.equal((await client.request("answer", { household: local, input: { query: "Rice" } })).status, 503);
  }
});

test("incompatible Chef responses cancel their producer without awaiting cancellation cleanup", async () => {
  let cancelled = false;
  const client = createChefClient({ binding: async () => ({ fetch: async () => new Response(new ReadableStream({
    cancel() { cancelled = true; return new Promise(() => {}); },
  })) }) });
  const response = await promptly(client.request("answer", { household: local, input: { query: "Rice" } }));
  assert.equal(response.status, 503); assert.equal(cancelled, true);
});

test("caller cancellation reaches the private operation and cannot return an answer", async () => {
  const controller = new AbortController(); let started;
  const entered = new Promise(resolve => { started = resolve; });
  let aborted = false;
  const worker = createChefWorker({ chef: { answer: async (_input, { signal }) => {
    started(); await new Promise(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    return emptyAnswer;
  } } });
  const client = createChefClient({ binding: async () => ({ fetch: (url, init) => worker.fetch(new Request(url, init), env) }) });
  const pending = client.request("answer", { household: local, input: { query: "Rice" } }, controller.signal);
  await entered; controller.abort();
  const response = await pending; assert.equal(response.status, 499); assert.equal((await response.json()).error.code, "cancelled");
  assert.equal(aborted, true);
});

test("custom string and Error cancellation reasons remain cancellations across client and worker", async () => {
  for (const reason of ["user stopped", new Error("user stopped")]) {
    const controller = new AbortController(); let start, workerReason, workerStatus;
    const started = new Promise(resolve => { start = resolve; });
    const worker = createChefWorker({ chef: { answer: async (_input, { signal }) => {
      start();
      await new Promise(resolve => signal.addEventListener("abort", () => { workerReason = signal.reason; resolve(); }, { once: true }));
      throw signal.reason;
    } } });
    const client = createChefClient({ binding: async () => ({ fetch: async (url, init) => {
      const response = await worker.fetch(new Request(url, init), env); workerStatus = response.status; return response;
    } }) });
    const pending = client.request("answer", { household: local, input: { query: "Rice" } }, controller.signal);
    await started; controller.abort(reason);
    const response = await pending;
    assert.equal(workerStatus, 499); assert.equal(response.status, 499);
    assert.equal((await response.json()).error.code, "cancelled");
    assert.strictEqual(workerReason, reason);
  }
});

test("custom cancellation during a stalled private response body returns 499 instead of an outage", async () => {
  const controller = new AbortController(); const reason = new Error("user stopped"); let start, observed;
  const started = new Promise(resolve => { start = resolve; });
  const client = createChefClient({ binding: async () => ({ fetch: async (_url, init) => new Response(new ReadableStream({
    start(stream) {
      init.signal.addEventListener("abort", () => { observed = init.signal.reason; stream.error(init.signal.reason); }, { once: true });
      start();
    },
  }), { headers: serviceResponseHeaders() }) }) });
  const pending = client.request("answer", { household: local, input: { query: "Rice" } }, controller.signal);
  await started; controller.abort(reason);
  const response = await pending;
  assert.equal(response.status, 499); assert.equal((await response.json()).error.code, "cancelled");
  assert.strictEqual(observed, reason);
});

test("the private-client deadline covers a stalled successful or error response body", async () => {
  for (const status of [200, 503]) {
    let aborted = false;
    const client = createChefClient({ timeoutMs: 20, binding: async () => ({ fetch: async (_url, init) => new Response(new ReadableStream({
      start(controller) { init.signal.addEventListener("abort", () => { aborted = true; controller.error(init.signal.reason); }, { once: true }); },
    }), { status, headers: serviceResponseHeaders() }) }) });
    const response = await client.request("answer", { household: local, input: { query: "Rice" } });
    assert.equal(response.status, 504); assert.equal((await response.json()).error.code, "chef_timeout"); assert.equal(aborted, true);
  }
});

test("the private worker enforces its own deadline independently of the caller", async () => {
  let aborted = false;
  const worker = createChefWorker({ operationTimeoutMs: () => 20, chef: { answer: async (_input, { signal }) => {
    await new Promise(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    return emptyAnswer;
  } } });
  // Node's AbortSignal.timeout is unref'ed; keep this isolated operation alive.
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    const response = await worker.fetch(rpc(), env);
    assert.equal(response.status, 504); assert.equal((await response.json()).error.code, "chef_timeout");
    assert.equal(aborted, true);
  } finally { clearTimeout(keepAlive); }
});

test("public health uses the private worker and keeps provider probes out of the gateway", async () => {
  const calls = [];
  const worker = createChefWorker({ chef: { answer: async () => assert.fail("Health cannot generate an answer") }, health: async (query, context) => {
    calls.push({ query, household: context.household }); return { status: 503, body: { ok: false, capabilities: { generation: { ready: false } } } };
  } });
  env.CHEF = { fetch: (url, init) => worker.fetch(new Request(url, init), env) };
  const response = await healthRoute.GET(new Request("http://localhost/api/health?provider=openai&model=%20test-model%20"));
  assert.equal(response.status, 503); assert.equal((await response.json()).capabilities.generation.ready, false);
  assert.deepEqual(calls, [{ query: { provider: "openai", model: "test-model" }, household: local }]);
});
