import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createHmac } from "node:crypto";
import { createSourceLoader } from "../tools/testing/load-source.mjs";
import { createSqliteD1 } from "./helpers/sqlite-d1.mjs";

const sources = await createSourceLoader({ name: "service-readiness", externals: { "cloudflare:workers": "export const env = {};" } });
const sql = await createSqliteD1();
const { env } = await sources.import("cloudflare:workers");
const household = await sources.import("app/lib/household.ts");
const { serviceReadiness } = await sources.import("app/lib/service-readiness.ts");
const { serviceResponseHeaders } = await sources.import("app/lib/service-observability.ts");
const { default: chef } = await sources.import("worker/chef.ts");
const { default: catalog } = await sources.import("worker/catalog.ts");
const admin = await sources.import("app/api/admin/services/route.ts");
const request = () => new Request("http://localhost/api/admin/services");
beforeEach(t => {
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, { DB: sql.binding, SERVICE_RELEASE: "test-release", CATALOG_TASKS: { send: async () => assert.fail("Readiness cannot publish jobs") } });
  env.CHEF = { fetch: (url, init) => chef.fetch(new Request(url, init), env) };
  env.CATALOG = { fetch: (url, init) => catalog.fetch(new Request(url, init), env) };
  household.configureHouseholdRuntime(env); sql.queries.length = 0;
  t.mock.method(globalThis, "fetch", async () => assert.fail("Readiness cannot contact model providers or public networks"));
  t.mock.method(console, "info", () => {});
});
after(async () => { sql.close(); await sources.dispose(); });

test("private readiness and operator aggregation inspect actual migrated schema without providers or writes", async () => {
  for (const [name, worker] of [["chef", chef], ["catalog", catalog]]) {
    const response = await worker.fetch(new Request("https://service.internal/ready"), env);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-rag-chef-protocol"), "1"); assert.equal(response.headers.get("x-rag-chef-controls"), "1");
    const report = await response.json();
    assert.deepEqual(report, { ok: true, service: name, protocol: 1, controls: 1, schema: 9, release: "test-release", scope: { hosted: false, sourceIds: [] }, limits: { ollama: 2, openai: 4, chef: { minute: null, day: null } } });
  }
  const response = await admin.GET(request()); assert.equal(response.status, 200);
  const report = await response.json(); assert.equal(report.ok, true);
  assert.deepEqual(Object.keys(report.services).sort(), ["catalog", "chef", "gateway"]);
  assert.ok(sql.queries.length > 0); assert.ok(sql.queries.every(({ sql }) => /^\s*SELECT\b/i.test(sql)));
});

test("missing operational migration fails readiness with a generic response and recovers after repair", async () => {
  for (const table of ["runtime_model_permits", "catalog_job_recipe_receipts"]) {
    sql.db.exec(`ALTER TABLE ${table} RENAME TO unavailable_${table}`);
    try {
      for (const name of ["gateway", "chef", "catalog"]) {
        const response = await serviceReadiness(name); assert.equal(response.status, 503);
        const body = await response.json(); assert.equal(body.error.code, "service_not_ready");
        assert.ok(!JSON.stringify(body).includes("no such table"));
      }
    } finally { sql.db.exec(`ALTER TABLE unavailable_${table} RENAME TO ${table}`); }
    assert.equal((await serviceReadiness("chef")).status, 200);
  }
});

test("invalid admission policy or release labels cannot report readiness", async () => {
  for (const [key, value] of [["MODEL_OLLAMA_CONCURRENCY", "0"], ["CHEF_LOCAL_REQUESTS_PER_MINUTE", "invalid"], ["SERVICE_RELEASE", "private release\nsecret"]]) {
    const original = env[key]; env[key] = value;
    const response = await serviceReadiness("gateway"); assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "service_not_ready");
    if (original === undefined) delete env[key]; else env[key] = original;
  }
});

test("operator readiness rejects mismatched protocol, policy, schema and release across private services", async () => {
  const valid = await (await serviceReadiness("chef")).json();
  for (const change of [
    { protocol: 2 }, { controls: 2 }, { schema: 8 }, { release: "previous-release" }, { service: "catalog" },
    { scope: { hosted: true, sourceIds: ["rag-chef-starters"] } }, { limits: { ...valid.limits, ollama: 99 } },
  ]) {
    env.CHEF = { fetch: async () => Response.json({ ...valid, ...change }, { headers: serviceResponseHeaders() }) };
    const response = await admin.GET(request()); assert.equal(response.status, 503);
    const body = await response.json(); assert.equal(body.services.chef.error.code, "service_not_ready");
  }
  env.CHEF = { fetch: async () => Response.json(valid) };
  assert.equal((await admin.GET(request())).status, 503, "A legacy worker cannot claim current admission controls without its compatibility headers");
  delete env.CHEF;
  assert.equal((await admin.GET(request())).status, 503);
});

test("unsupported runtime controls stop private readiness before database access", async () => {
  for (const worker of [chef, catalog]) assert.equal((await worker.fetch(new Request("https://service.internal/ready", { headers: { "x-rag-chef-required-controls": "2" } }), env)).status, 503);
  assert.deepEqual(sql.queries, []);
});

test("each role requires its own service and queue bindings before claiming readiness", async () => {
  for (const [service, name] of [["gateway", "CHEF"], ["gateway", "CATALOG"], ["gateway", "CATALOG_TASKS"], ["chef", "CATALOG"], ["catalog", "CATALOG_TASKS"]]) {
    const incomplete = { ...env }; delete incomplete[name];
    const response = await serviceReadiness(service, incomplete);
    assert.equal(response.status, 503, `${service} requires ${name}`);
    assert.equal((await response.json()).error.code, "service_not_ready");
  }
  assert.deepEqual(sql.queries, []);
});

test("operator readiness bounds a stalled private response and actively cancels its producer", async t => {
  const timeout = AbortSignal.timeout.bind(AbortSignal); let cancelled = false;
  t.mock.method(AbortSignal, "timeout", milliseconds => timeout(Math.min(milliseconds, 20)));
  env.CHEF = { fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: serviceResponseHeaders() }) };
  let timer;
  try {
    const response = await Promise.race([admin.GET(request()), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Readiness body deadline did not settle")), 500); })]);
    assert.equal(response.status, 503); assert.equal((await response.json()).services.chef.error.code, "service_not_ready");
    assert.equal(cancelled, true);
  } finally { clearTimeout(timer); }
});

test("hosted service diagnostics require the current platform administrator and never expose configuration secrets", async () => {
  const secret = "isolated-service-readiness-session-key-7245"; // gitleaks:allow -- synthetic signing key for disposable test sessions only.
  const at = new Date().toISOString();
  Object.assign(env, { RAG_CHEF_HOSTED: "1", BETTER_AUTH_URL: "https://chef.test", BETTER_AUTH_SECRET: secret, GOOGLE_CLIENT_ID: "isolated-client", GOOGLE_CLIENT_SECRET: "isolated-client-secret", PLATFORM_ADMIN_EMAILS: "readiness-admin@example.test" });
  const ids = ["readiness-admin", "readiness-member"];
  for (const id of ids) {
    sql.db.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run(id, id, `${id}@example.test`, 1, at, at);
    sql.db.prepare("INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run(`${id}-session`, id, `${id}-token`, new Date(Date.now() + 86_400_000).toISOString(), at, at);
  }
  const authenticated = id => {
    const token = `${id}-token`, signature = createHmac("sha256", secret).update(token).digest("base64");
    return new Request("https://chef.test/api/admin/services", { headers: { cookie: `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}` } });
  };
  try {
    assert.equal((await admin.GET(new Request("https://chef.test/api/admin/services"))).status, 401);
    assert.equal((await admin.GET(authenticated("readiness-member"))).status, 403);
    const response = await admin.GET(authenticated("readiness-admin")); assert.equal(response.status, 200);
    const body = await response.text(); assert.ok(!body.includes(secret)); assert.ok(!body.includes("isolated-client-secret")); assert.ok(!body.includes("session"));
    delete env.SERVICE_RELEASE;
    const unlabelled = await admin.GET(authenticated("readiness-admin")); assert.equal(unlabelled.status, 503);
    assert.equal((await unlabelled.json()).services.gateway.error.code, "service_not_ready");
    env.SERVICE_RELEASE = "test-release";
    env.PLATFORM_ADMIN_EMAILS = "readiness-member@example.test";
    assert.equal((await admin.GET(authenticated("readiness-admin"))).status, 403);
  } finally { for (const id of ids) sql.db.prepare("DELETE FROM user WHERE id=?").run(id); }
});
