import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";
import { createSqliteD1 } from "./helpers/sqlite-d1.mjs";

const sources = await createSourceLoader({ name: "runtime-admission-persistence" });
const { createRuntimeAdmissionStore, MODEL_PERMIT_LEASE_MS } = await sources.import("app/lib/runtime-admission.ts");
const sql = await createSqliteD1();
let now, serial, settings;
const factory = () => createRuntimeAdmissionStore({ db: async () => sql.binding, now: () => now, uuid: () => `permit-${++serial}`, setting: name => settings[name] });
const household = (householdId = "kitchen-one", mode = "hosted") => ({ mode, householdId });
const usage = (id = "kitchen-one", mode = "hosted") => sql.db.prepare("SELECT window_kind,used FROM runtime_chef_usage WHERE mode=? AND household_id=? ORDER BY window_kind").all(mode, id).map(row => ({ ...row }));
const busy = error => error.status === 429 && error.code === "service_busy" && error.retryAfterSec >= 1;
const exhausted = error => error.status === 429 && error.code === "usage_limit_exceeded" && error.retryAfterSec >= 1;

beforeEach(() => {
  sql.intercept(undefined); sql.interceptBatch(undefined);
  sql.db.exec("DROP TRIGGER IF EXISTS fail_day_counter; DELETE FROM runtime_model_permits; DELETE FROM runtime_chef_usage");
  sql.queries.length = 0; now = 1_800_000_000_000; serial = 0; settings = {};
});
after(async () => { sql.close(); await sources.dispose(); });

test("independent workers admit only the provider capacity and retain permits across recreation", async () => {
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => factory().acquireModelPermit("ollama", { requestId: "request-one" })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 2);
  for (const result of results.filter(result => result.status === "rejected")) assert.ok(busy(result.reason));
  await assert.rejects(factory().acquireModelPermit("ollama"), busy);
  const openai = await Promise.all(Array.from({ length: 4 }, () => factory().acquireModelPermit("openai")));
  await assert.rejects(factory().acquireModelPermit("openai"), busy);
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM runtime_model_permits").get().n, 6);
  assert.equal(new Set([...openai, ...results.filter(result => result.status === "fulfilled").map(result => result.value)].map(permit => permit.id)).size, 6);
});

test("release is idempotent and expired handles cannot release replacements", async () => {
  const first = await factory().acquireModelPermit("ollama", {}, { concurrency: 1 });
  assert.equal(first.expiresAt, now + MODEL_PERMIT_LEASE_MS);
  now = first.expiresAt - 1;
  await assert.rejects(factory().acquireModelPermit("ollama", {}, { concurrency: 1 }), error => busy(error) && error.retryAfterSec === 1);
  now++;
  const replacement = await factory().acquireModelPermit("ollama", {}, { concurrency: 1 });
  assert.notEqual(replacement.id, first.id);
  await factory().releaseModelPermit(first);
  await assert.rejects(factory().acquireModelPermit("ollama", {}, { concurrency: 1 }), busy);
  await factory().releaseModelPermit(replacement);
  await factory().releaseModelPermit(replacement);
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM runtime_model_permits").get().n, 0);
  await factory().acquireModelPermit("ollama", {}, { concurrency: 1 });
});

test("same-household races reserve both windows exactly once", async () => {
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => factory().authorizeChefUsage(household(), { minute: 1, day: 10 })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  for (const result of results.filter(result => result.status === "rejected")) assert.ok(exhausted(result.reason));
  assert.deepEqual(usage(), [{ window_kind: "day", used: 1 }, { window_kind: "minute", used: 1 }]);
});

test("minute and day rejections consume neither quota and UTC expiry restores capacity", async () => {
  const limits = { minute: 2, day: 3 };
  await factory().authorizeChefUsage(household(), limits);
  await factory().authorizeChefUsage(household(), limits);
  await assert.rejects(factory().authorizeChefUsage(household(), limits), error => exhausted(error) && error.retryAfterSec === 60);
  assert.deepEqual(usage(), [{ window_kind: "day", used: 2 }, { window_kind: "minute", used: 2 }]);
  now += 60_000;
  await factory().authorizeChefUsage(household(), limits);
  await assert.rejects(factory().authorizeChefUsage(household(), limits), exhausted);
  assert.deepEqual(usage(), [{ window_kind: "day", used: 3 }, { window_kind: "minute", used: 1 }]);
  now += 60_000;
  await assert.rejects(factory().authorizeChefUsage(household(), limits), exhausted);
  assert.deepEqual(usage(), [{ window_kind: "day", used: 3 }]);
  now = (Math.floor(now / 86_400_000) + 1) * 86_400_000;
  await factory().authorizeChefUsage(household(), limits);
  assert.deepEqual(usage(), [{ window_kind: "day", used: 1 }, { window_kind: "minute", used: 1 }]);
});

test("usage scope separates households and modes; default local usage makes no storage request", async () => {
  await factory().authorizeChefUsage(household("local-household", "local"));
  assert.deepEqual(sql.queries, []);
  const limits = { minute: 1, day: 1 };
  for (const context of [household(), household("kitchen-two"), household("kitchen-one", "local")]) await factory().authorizeChefUsage(context, limits);
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM runtime_chef_usage").get().n, 6);
  for (const context of [household(), household("kitchen-two"), household("kitchen-one", "local")]) await assert.rejects(factory().authorizeChefUsage(context, limits), exhausted);
});

test("a failure updating the second quota rolls back the first counter", async () => {
  const limits = { minute: 5, day: 10 };
  await factory().authorizeChefUsage(household(), limits);
  sql.db.exec("CREATE TRIGGER fail_day_counter BEFORE UPDATE ON runtime_chef_usage WHEN NEW.window_kind='day' BEGIN SELECT RAISE(ABORT,'quota_write_failure'); END");
  await assert.rejects(factory().authorizeChefUsage(household(), limits), /quota_write_failure/);
  assert.deepEqual(usage(), [{ window_kind: "day", used: 1 }, { window_kind: "minute", used: 1 }]);
  sql.db.exec("DROP TRIGGER fail_day_counter");
  await factory().authorizeChefUsage(household(), limits);
  assert.deepEqual(usage(), [{ window_kind: "day", used: 2 }, { window_kind: "minute", used: 2 }]);
});

test("validated runtime settings preserve hosted defaults and allow explicit local limits", async () => {
  for (let i = 0; i < 60; i++) await factory().authorizeChefUsage(household());
  await assert.rejects(factory().authorizeChefUsage(household()), exhausted);
  assert.deepEqual(usage(), [{ window_kind: "day", used: 60 }, { window_kind: "minute", used: 60 }]);
  settings = { CHEF_LOCAL_REQUESTS_PER_MINUTE: "1", CHEF_HOSTED_REQUESTS_PER_MINUTE: "1000", CHEF_HOSTED_REQUESTS_PER_DAY: "61", MODEL_OLLAMA_CONCURRENCY: "1" };
  await factory().authorizeChefUsage(household());
  await assert.rejects(factory().authorizeChefUsage(household()), exhausted);
  await factory().authorizeChefUsage(household("local-household", "local"));
  await assert.rejects(factory().authorizeChefUsage(household("local-household", "local")), exhausted);
  await factory().acquireModelPermit("ollama");
  await assert.rejects(factory().acquireModelPermit("ollama"), busy);
});

test("invalid runtime policies and internal identities fail closed before storage", async () => {
  for (const value of ["0", "-1", "1.5", "2e1", " 2", " ", "NaN", "1000000000"]) {
    settings = { MODEL_OLLAMA_CONCURRENCY: value };
    await assert.rejects(factory().acquireModelPermit("ollama"), error => error.code === "runtime_policy_invalid" && error.status === 503);
    settings = { CHEF_HOSTED_REQUESTS_PER_MINUTE: value };
    await assert.rejects(factory().authorizeChefUsage(household()), error => error.code === "runtime_policy_invalid" && error.status === 503);
    settings = { CHEF_LOCAL_REQUESTS_PER_DAY: value };
    await assert.rejects(factory().authorizeChefUsage(household("local-household", "local")), error => error.code === "runtime_policy_invalid" && error.status === 503);
  }
  settings = {};
  for (const task of [() => factory().acquireModelPermit("other"), () => factory().acquireModelPermit("ollama", { requestId: "private\nvalue" }), () => factory().authorizeChefUsage(household("", "hosted")), () => factory().authorizeChefUsage(household("id", "other"))]) {
    await assert.rejects(task(), error => error.code === "runtime_policy_invalid");
  }
  assert.deepEqual(sql.queries, []);
});

test("production stores derive lease and window timestamps from the database clock", async () => {
  const store = createRuntimeAdmissionStore({ db: async () => sql.binding, setting: () => undefined });
  const before = Date.now();
  const permit = await store.acquireModelPermit("ollama");
  const after = Date.now();
  assert.ok(permit.expiresAt >= before + MODEL_PERMIT_LEASE_MS - 1 && permit.expiresAt <= after + MODEL_PERMIT_LEASE_MS + 1);
  await store.authorizeChefUsage(household(), { minute: 1, day: 1 });
  const minute = sql.db.prepare("SELECT window_start,expires_at FROM runtime_chef_usage WHERE window_kind='minute'").get();
  assert.equal(minute.expires_at - minute.window_start, 60_000);
  assert.ok(minute.window_start <= Date.now() && minute.expires_at > before);
  assert.deepEqual(sql.db.prepare("PRAGMA foreign_key_check").all(), []);
});
