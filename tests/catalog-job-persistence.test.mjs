import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";
import { createSqliteD1 } from "./helpers/sqlite-d1.mjs";
const sources = await createSourceLoader({ name: "catalog-job-persistence" });
const { createCatalogJobStore, CATALOG_JOB_LEASE_MS, CATALOG_JOB_MAX_ATTEMPTS } = await sources.import("app/lib/catalog-job-store.ts");
const sql = await createSqliteD1();
let now, serial, access;
const factory = () => createCatalogJobStore({ db: async () => sql.binding, now: () => now, uuid: () => `job-identity-${++serial}`, access: async () => access });
const store = factory();
const enqueue = (input = { kind: "demo" }, requestId = "request", actorId = "local-admin", actorMode = "local") => store.enqueue({ actorId, actorMode, requestId, input });
const lookup = id => store.get(id, "local-admin", "local");
beforeEach(() => {
  sql.intercept(undefined); sql.db.exec("DELETE FROM catalog_jobs; DELETE FROM user"); sql.queries.length = 0;
  now = 1_800_000_000_000; serial = 0; access = { mode: "local", adminEmails: [] };
});
after(async () => { sql.close(); await sources.dispose(); });
function seedAdmin(id = "admin") {
  const at = new Date(now).toISOString();
  sql.db.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run(id, id, `${id}@example.test`, 1, at, at);
  access = { mode: "hosted", adminEmails: [...access.adminEmails, `${id}@example.test`] };
}
async function permitted(fence) {
  const guard = await store.writeGuard(fence);
  return sql.db.prepare(`SELECT ${guard.sql} AS permitted`).get(...guard.bindings).permitted;
}

test("enqueue persists immutable intent before execution and canonical retries survive a recreated store", async () => {
  const input = { kind: "import", recipes: [{ title: "Rice", instructions: ["Rinse.", "Cook."] }], retryEmbeddingsOnly: false };
  const first = await enqueue(input); assert.equal(first.replayed, false); assert.equal(first.job.status, "queued");
  assert.equal(first.job.attempts, 0); assert.equal(first.job.result, null);
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM recipes").get().n, 0);
  input.recipes[0].title = "Changed in caller";
  const again = await factory().enqueue({ actorId: "local-admin", actorMode: "local", requestId: "request",
    input: { recipes: [{ instructions: ["Rinse.", "Cook."], title: "Rice" }], retryEmbeddingsOnly: false, kind: "import" } });
  assert.deepEqual(again, { job: first.job, replayed: true });
  const lease = await store.claim(first.job.id); assert.equal(lease.input.recipes[0].title, "Rice");
  const publicStatus = await lookup(first.job.id);
  for (const hidden of ["input", "payload_json", "actorId", "requestId", "leaseToken", "fence"]) assert.equal(Object.hasOwn(publicStatus, hidden), false, hidden);
});

test("concurrent enqueue retries create one job while differing payloads and actors have separate identities", async () => {
  const results = await Promise.all([enqueue(), enqueue()]);
  assert.equal(new Set(results.map(result => result.job.id)).size, 1);
  assert.equal(results.filter(result => result.replayed).length, 1);
  await assert.rejects(enqueue({ kind: "embeddings" }), error => error.code === "CATALOG_REQUEST_ID_REUSED");
  const other = await enqueue({ kind: "demo" }, "request", "another-admin");
  assert.notEqual(other.job.id, results[0].job.id);
  assert.equal(await store.get(results[0].job.id, "another-admin", "local"), null);
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM catalog_jobs").get().n, 2);
});

test("only one worker claims a live lease and an expired worker cannot heartbeat, finish, fail or write", async () => {
  const { job } = await enqueue();
  const claimed = await Promise.all([store.claim(job.id), factory().claim(job.id)]);
  assert.equal(claimed.filter(Boolean).length, 1);
  const first = claimed.find(Boolean); assert.equal(first.attempts, 1); assert.equal(first.fence.leaseVersion, 1);
  now += 10_000;
  await store.heartbeat(first.fence, { phase: "saving", completed: 1, total: 3 });
  assert.deepEqual((await lookup(job.id)).progress, { phase: "saving", completed: 1, total: 3 });
  now += CATALOG_JOB_LEASE_MS - 1;
  assert.equal(await factory().claim(job.id), null);
  now++;
  const replacement = await factory().claim(job.id);
  assert.equal(replacement.attempts, 2); assert.equal(replacement.fence.leaseVersion, 2);
  assert.notEqual(replacement.fence.leaseToken, first.fence.leaseToken);
  assert.equal(await permitted(first.fence), 0); assert.equal(await permitted(replacement.fence), 1);
  for (const operation of [() => store.heartbeat(first.fence), () => store.complete(first.fence, { wrong: true }), () => store.fail(first.fence, "late failure", true)]) {
    await assert.rejects(operation(), error => error.code === "CATALOG_JOB_LEASE_LOST");
  }
  assert.equal((await lookup(job.id)).status, "running");
  const result = { ok: true, count: 3 }; const complete = await store.complete(replacement.fence, result);
  assert.equal(complete.status, "succeeded"); assert.deepEqual(complete.result, result);
  assert.equal(complete.leaseUntil, null); assert.equal(await permitted(replacement.fence), 0);
  assert.equal(await factory().claim(job.id), null);
  assert.deepEqual((await enqueue()).job, complete);
});

test("retryable failures persist backoff across restart and stop at the attempt limit", async () => {
  const { job } = await enqueue();
  for (let attempt = 1; attempt <= CATALOG_JOB_MAX_ATTEMPTS; attempt++) {
    const lease = await factory().claim(job.id); assert.equal(lease.attempts, attempt);
    const failed = await store.fail(lease.fence, { code: "STORAGE_UNAVAILABLE", message: "Retry this saved job" }, true);
    if (attempt === CATALOG_JOB_MAX_ATTEMPTS) {
      assert.equal(failed.status, "failed"); assert.equal(failed.finishedAt, now);
      now += 1_000_000; assert.equal(await store.claim(job.id), null);
    } else {
      assert.equal(failed.status, "queued"); assert.equal(failed.finishedAt, null);
      assert.equal(failed.availableAt - now, attempt === 1 ? 5_000 : 10_000);
      assert.equal(await factory().claim(job.id), null);
      now = failed.availableAt;
    }
  }
  assert.equal((await lookup(job.id)).attempts, CATALOG_JOB_MAX_ATTEMPTS);
});

test("provider retry-after delays survive restart without shortening the normal job backoff", async () => {
  const { job } = await enqueue();
  const first = await store.claim(job.id);
  const delayed = await store.fail(first.fence, { code: "service_busy", message: "Provider capacity is occupied" }, true, 70_000);
  assert.equal(delayed.availableAt, now + 70_000);
  now += 69_999; assert.equal(await factory().claim(job.id), null);
  now++; const second = await factory().claim(job.id); assert.equal(second.attempts, 2);
  const ordinary = await store.fail(second.fence, { code: "service_busy", message: "Retry shortly" }, true, 1_000);
  assert.equal(ordinary.availableAt, now + 10_000, "A short provider delay cannot bypass the second-attempt backoff");
});

test("crashed workers can be reclaimed after expiry and exhausted leases become terminal", async () => {
  const { job } = await enqueue();
  for (let attempt = 1; attempt <= CATALOG_JOB_MAX_ATTEMPTS; attempt++) {
    const lease = await factory().claim(job.id); assert.equal(lease.attempts, attempt);
    now = lease.leaseUntil;
  }
  assert.equal(await factory().claim(job.id), null);
  const final = await lookup(job.id); assert.equal(final.status, "failed"); assert.equal(final.error.code, "ATTEMPTS_EXHAUSTED");
  assert.equal(final.attempts, CATALOG_JOB_MAX_ATTEMPTS);
});

test("administrator revocation before claim permanently stops queued work and hides its status", async () => {
  seedAdmin();
  const { job } = await enqueue({ kind: "demo" }, "request", "admin", "hosted");
  access.adminEmails = [];
  assert.equal(await store.claim(job.id), null);
  assert.equal(await store.get(job.id, "admin", "hosted"), null);
  const row = sql.db.prepare("SELECT status,error_code,attempts FROM catalog_jobs WHERE id=?").get(job.id);
  assert.deepEqual({ ...row }, { status: "failed", error_code: "ADMIN_ACCESS_CHANGED", attempts: 0 });
  await assert.rejects(enqueue({ kind: "demo" }, "request", "admin", "hosted"), error => error.code === "ADMIN_ACCESS_CHANGED");
});

test("unverified or removed administrators cannot mutate their running jobs or use their write fences", async () => {
  for (const revoke of ["UPDATE user SET emailVerified=0 WHERE id='admin'", "DELETE FROM user WHERE id='admin'"]) {
    sql.db.exec("DELETE FROM catalog_jobs; DELETE FROM user"); access.adminEmails = [];
    seedAdmin();
    const { job } = await enqueue({ kind: "demo" }, "request", "admin", "hosted");
    const lease = await store.claim(job.id); assert.equal(await permitted(lease.fence), 1);
    sql.db.exec(revoke); assert.equal(await permitted(lease.fence), 0);
    await assert.rejects(store.heartbeat(lease.fence), error => error.code === "CATALOG_JOB_LEASE_LOST");
    assert.equal(sql.db.prepare("SELECT error_code FROM catalog_jobs WHERE id=?").get(job.id).error_code, "ADMIN_ACCESS_CHANGED");
    await assert.rejects(store.complete(lease.fence, { ok: true }), error => error.code === "CATALOG_JOB_LEASE_LOST");
  }
});

test("invalid identities, excessive payloads and invalid progress fail without mutating durable state", async () => {
  for (const invalid of [{ requestId: "" }, { actorId: "\n" }, { actorMode: "unknown" }, { input: { kind: "unknown" } }, { input: { kind: "import", recipes: ["é".repeat(600_000)] } }]) {
    await assert.rejects(store.enqueue({ actorId: "local-admin", actorMode: "local", requestId: "request", input: { kind: "demo" }, ...invalid }), error => error.code === "INVALID_CATALOG_JOB");
  }
  assert.deepEqual(sql.queries, []);
  const { job } = await enqueue(); const lease = await store.claim(job.id); const before = await lookup(job.id);
  for (const progress of [{ phase: "" }, { phase: "saving", completed: -1 }, { phase: "saving", token: "private" }]) {
    await assert.rejects(store.heartbeat(lease.fence, progress), error => error.code === "INVALID_CATALOG_JOB");
  }
  await assert.rejects(store.complete(lease.fence, "é".repeat(1_000_001)), error => error.code === "INVALID_CATALOG_JOB");
  assert.deepEqual(await lookup(job.id), before);
});
