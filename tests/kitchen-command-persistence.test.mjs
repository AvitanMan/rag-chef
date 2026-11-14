import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys=ON");
for (const name of (await readdir(new URL("../drizzle/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) {
  database.exec(await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8"));
}
const queries = [];
let beforeStatement;
const binding = {
  prepare(sql) {
    queries.push(sql);
    let values = [];
    const executeAll = () => {
      beforeStatement?.(sql);
      const results = database.prepare(sql).all(...values);
      return { success: true, results, meta: { changes: database.prepare("SELECT changes() AS n").get().n } };
    };
    return {
      bind(...args) { values = args; return this; }, executeAll,
      async first() { await Promise.resolve(); beforeStatement?.(sql); return database.prepare(sql).get(...values) ?? null; },
      async all() { return executeAll(); },
      async run() { return executeAll(); },
    };
  },
  async batch(statements) {
    // D1 batches execute as one atomic transaction. Keep the actual SQLite
    // statements synchronous so parallel requests cannot nest transactions.
    await Promise.resolve();
    database.exec("BEGIN");
    try { const results = statements.map(statement => statement.executeAll()); database.exec("COMMIT"); return results; }
    catch (error) { database.exec("ROLLBACK"); throw error; }
  },
  async exec(sql) { database.exec(sql); return { count: 1, duration: 0 }; },
};
const loaders = [];
async function runtime() {
  const sources = await createSourceLoader({ name: "command-persistence", externals: { "cloudflare:workers": "export const env = {};" } });
  loaders.push(sources);
  const { env } = await sources.import("cloudflare:workers"); env.DB = binding;
  const household = await sources.import("app/lib/household.ts"); household.configureHouseholdRuntime(env);
  const service = await sources.import("app/lib/kitchen-service.ts");
  const route = await sources.import("app/api/kitchen/commands/route.ts");
  return { household, service, route };
}
const app = await runtime();
const secret = "isolated-command-ledger-auth-secret-2b671369"; // gitleaks:allow -- synthetic signing key for disposable test sessions only.
const hostedSettings = { DB: binding, RAG_CHEF_HOSTED: "1", BETTER_AUTH_URL: "https://chef.test", BETTER_AUTH_SECRET: secret, GOOGLE_CLIENT_ID: "isolated-client", GOOGLE_CLIENT_SECRET: "isolated-secret" };
const baseState = () => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });
const add = (commandId = "add-rice", expectedRevision = 0, overrides = {}) => ({ type: "AddPantryBatches", commandId, expectedRevision, batches: [{ id: "rice", name: "rice", measure: "1 kg" }], ...overrides });
function request(command, { user, home = "home-a", headers = {}, raw } = {}) {
  const token = `token-${user}`, signature = createHmac("sha256", secret).update(token).digest("base64");
  return new Request(`${user ? "https://chef.test" : "http://localhost"}/api/kitchen/commands`, { method: "POST", headers: {
    "content-type": "application/json", ...(user ? { origin: "https://chef.test", cookie: `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`, "x-rag-chef-actor": user, "x-rag-chef-household": home } : {}), ...headers,
  }, body: raw ?? JSON.stringify(command) });
}
async function post(command, options, target = app) {
  const response = await target.route.POST(request(command, options));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return { status: response.status, body: await response.json() };
}
async function saved(target = app, context) { return target.service.kitchenService.read(context); }
function seedHosted() {
  const at = new Date().toISOString(), expiry = new Date(Date.now() + 86_400_000).toISOString();
  for (const user of ["owner", "member", "other"]) {
    database.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run(user, user, `${user}@example.test`, 1, at, at);
    database.prepare("INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run(`session-${user}`, user, `token-${user}`, expiry, at, at);
  }
  for (const [home, members] of [["home-a", [["owner", "owner"], ["member", "member"]]], ["home-b", [["other", "owner"]]]]) {
    database.prepare("INSERT INTO organization(id,name,slug,createdAt) VALUES(?,?,?,?)").run(home, home, home, at);
    database.prepare("INSERT INTO household_settings(organizationId,timezone) VALUES(?,?)").run(home, "UTC");
    for (const [user, role] of members) database.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)").run(`member-${user}`, home, user, role, at);
  }
  app.household.configureHouseholdRuntime(hostedSettings);
}
beforeEach(() => {
  beforeStatement = undefined;
  database.exec("DELETE FROM organization; DELETE FROM user; DELETE FROM kitchen_state; DELETE FROM verification;");
  // The ledger is a separate aggregate for local kitchens as well.
  const ledger = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kitchen_command_receipt'").get();
  if (ledger) database.exec("DELETE FROM kitchen_command_receipt");
  queries.length = 0;
  app.household.configureHouseholdRuntime({ DB: binding });
});
after(async () => { database.close(); for (const sources of loaders) await sources.dispose(); });

test("command transport rejects malformed, oversized, and unknown-field input before accessing kitchen storage", async () => {
  const invalid = [null, [], {}, { ...add(), extra: true }, { ...add(), expectedRevision: -1 }, { ...add(), expectedRevision: 1.5 },
    { ...add(), commandId: "" }, { ...add(), type: "Unknown" }, { ...add(), batches: [{ id: "rice", name: "rice", measure: "1 kg", extra: true }] }];
  for (const value of invalid) {
    const result = await post(value);
    assert.equal(result.status, 400, JSON.stringify(value)); assert.equal(result.body.error.code, "INVALID_COMMAND");
  }
  for (const raw of ["", "{invalid", new Uint8Array([0xc3, 0x28])]) assert.equal((await post(undefined, { raw })).status, 400);
  const unsupported = await post(add(), { headers: { "content-type": "text/plain" } });
  assert.equal(unsupported.status, 415); assert.equal(unsupported.body.error.code, "INVALID_CONTENT_TYPE");
  for (const options of [{ headers: { "content-length": "2000001" } }, { raw: "x".repeat(2_000_001) }, { raw: "é".repeat(1_000_001) }]) {
    const result = await post(add(), options); assert.equal(result.status, 413); assert.equal(result.body.error.code, "COMMAND_TOO_LARGE");
  }
  assert.deepEqual(queries, [], "invalid commands never read kitchen state or receipts");
});

test("exact retries replay the original result after later writes and a recreated runtime", async () => {
  const command = add();
  const first = await post(command); assert.equal(first.status, 200); assert.equal(first.body.applied, true); assert.equal(first.body.replayed, false);
  const later = await post(add("later-beans", 1, { batches: [{ id: "beans", name: "beans", measure: "2 kg" }] })); assert.equal(later.status, 200);
  const restarted = await runtime();
  const reordered = { batches: [{ measure: "1 kg", name: "rice", id: "rice" }], expectedRevision: 0, commandId: command.commandId, type: command.type };
  const retry = await post(reordered, undefined, restarted);
  assert.equal(retry.status, 200); assert.deepEqual(retry.body, { ...first.body, replayed: true });
  assert.deepEqual(await saved(restarted), later.body.document);
  assert.equal((await saved(restarted)).state.pantry.length, 2);
});

test("one command ID cannot be reused with a changed payload or expected revision", async () => {
  const first = await post(add()); assert.equal(first.status, 200);
  for (const command of [add("add-rice", 0, { batches: [{ id: "rice", name: "rice", measure: "2 kg" }] }), add("add-rice", 1)]) {
    const result = await post(command); assert.equal(result.status, 409); assert.equal(result.body.error.code, "COMMAND_ID_REUSED");
  }
  assert.deepEqual(await saved(), first.body.document);
});

test("simultaneous duplicate commands apply once while different IDs compete by revision", async () => {
  const duplicates = await Promise.all([post(add()), post(add())]);
  assert.deepEqual(duplicates.map(result => result.status), [200, 200]);
  assert.equal(duplicates.filter(result => result.body.replayed).length, 1);
  assert.equal((await saved()).revision, 1); assert.equal((await saved()).state.pantry.length, 1);
  const rivals = await Promise.all([
    post(add("beans", 1, { batches: [{ id: "beans", name: "beans", measure: "1 kg" }] })),
    post(add("onion", 1, { batches: [{ id: "onion", name: "onion", measure: "2" }] })),
  ]);
  assert.deepEqual(rivals.map(result => result.status).sort(), [200, 409]);
  assert.equal(rivals.find(result => result.status === 409).body.error.code, "REVISION_CONFLICT");
  assert.equal((await saved()).revision, 2); assert.equal((await saved()).state.pantry.length, 2);
});

test("concurrent conflicting payloads sharing an ID leave only the winning command effect", async () => {
  const results = await Promise.all([post(add()), post(add("add-rice", 0, { batches: [{ id: "beans", name: "beans", measure: "2 kg" }] }))]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(results.find(result => result.status === 409).body.error.code, "COMMAND_ID_REUSED");
  assert.deepEqual(await saved(), results.find(result => result.status === 200).body.document);
  assert.equal((await saved()).state.pantry.length, 1);
  assert.equal(database.prepare("SELECT count(*) AS n FROM kitchen_command_receipt").get().n, 1);
});

test("a no-op on an empty kitchen records its null original document without creating state", async () => {
  const command = { type: "RemovePantryBatch", commandId: "empty-noop", expectedRevision: 0, snapshot: add().batches[0] };
  const first = await post(command); assert.equal(first.status, 200); assert.equal(first.body.applied, false);
  assert.deepEqual(first.body.document, { revision: 0, state: null, updatedAt: null });
  assert.equal(database.prepare("SELECT count(*) AS n FROM kitchen_state").get().n, 0);
  const later = await post(add()); assert.equal(later.status, 200);
  assert.deepEqual((await post(command)).body, { ...first.body, replayed: true });
  assert.deepEqual(await saved(), later.body.document);
});

test("semantic no-op retries retain their original document after later stock changes", async () => {
  const seeded = await app.service.kitchenService.save(0, { ...baseState(), pantry: [{ id: "rice", name: "rice", measure: "1 kg" }] });
  const command = { type: "ReplacePantryBatch", commandId: "nothing-changed", expectedRevision: seeded.revision,
    snapshot: { id: "rice", name: "rice", measure: "1 kg" }, replacement: { id: "rice", name: "rice", measure: "1 kg" } };
  const first = await post(command); assert.equal(first.status, 200); assert.equal(first.body.applied, false);
  const changed = await app.service.kitchenService.save(seeded.revision, { ...seeded.state, pantry: [{ id: "rice", name: "rice", measure: "500 g" }] });
  const retry = await post(command); assert.equal(retry.status, 200); assert.deepEqual(retry.body, { ...first.body, replayed: true });
  assert.deepEqual(await saved(), changed);
});

test("hosted receipts are scoped to actor and household and cannot bypass membership revocation", async () => {
  seedHosted();
  const owner = await post(add("same-id"), { user: "owner" }); assert.equal(owner.status, 200);
  const other = await post(add("same-id"), { user: "other", home: "home-b" }); assert.equal(other.status, 200); assert.equal(other.body.replayed, false);
  const memberCommand = add("same-id", 1, { batches: [{ id: "beans", name: "beans", measure: "1 kg" }] });
  const member = await post(memberCommand, { user: "member" }); assert.equal(member.status, 200); assert.equal(member.body.replayed, false);
  const context = await app.household.requireHousehold(request(memberCommand, { user: "member" }));
  database.prepare("DELETE FROM member WHERE userId=?").run("member");
  assert.equal((await post(memberCommand, { user: "member" })).status, 403);
  await assert.rejects(app.service.kitchenService.execute(memberCommand, context), /access|membership|changed/i);
  const ownerContext = await app.household.requireHousehold(request(add(), { user: "owner" }));
  assert.equal((await saved(app, ownerContext)).revision, 2);
});

test("members cannot write shared profile commands or replay an owner receipt", async () => {
  seedHosted();
  const profile = { version: 1, allergies: ["peanut"], diet: "No restriction", dislikes: [], skillLevel: "Confident beginner", budget: "Medium", equipment: ["Stovetop"] };
  const command = { type: "SetCookingProfile", commandId: "requirements", expectedRevision: 0, profile };
  assert.equal((await post(command, { user: "owner" })).status, 200);
  const result = await post({ ...command, expectedRevision: 1, profile: { ...profile, allergies: [] } }, { user: "member" });
  assert.equal(result.status, 403);
  const context = await app.household.requireHousehold(request(command, { user: "owner" }));
  assert.deepEqual((await saved(app, context)).state.cookingProfile.allergies, ["peanut"]);
  database.prepare("UPDATE member SET role='member' WHERE userId='owner'").run();
  const demoted = await post(command, { user: "owner" });
  assert.equal(demoted.status, 403); assert.equal(demoted.body.error.code, "OWNER_REQUIRED");
});

test("failed receipt insertion and failed state mutation both roll back the complete command", async () => {
  for (const revision of [0, 1]) {
    for (const target of ["kitchen_command_receipt", "kitchen_state"]) {
      database.exec("DELETE FROM kitchen_command_receipt; DELETE FROM kitchen_state");
      if (revision) await app.service.kitchenService.save(0, baseState());
      const before = await saved();
      const event = target === "kitchen_state" && revision ? "UPDATE" : "INSERT";
      database.exec(`CREATE TEMP TRIGGER fail_command BEFORE ${event} ON ${target} BEGIN SELECT RAISE(ABORT,'injected storage failure'); END`);
      try {
        const result = await post(add("retry-after-rollback", revision));
        assert.equal(result.status, 503); assert.equal(result.body.error.code, "KITCHEN_UNAVAILABLE");
        assert.deepEqual(await saved(), before);
        assert.equal(database.prepare("SELECT count(*) AS n FROM kitchen_command_receipt").get().n, 0);
      } finally { database.exec("DROP TRIGGER fail_command"); }
      const retry = await post(add("retry-after-rollback", revision));
      assert.equal(retry.status, 200); assert.equal(retry.body.replayed, false);
      assert.equal(retry.body.document.revision, revision + 1);
      assert.equal(retry.body.document.state.pantry.length, 1);
    }
  }
});

test("membership revoked between preflight and receipt lookup prevents an otherwise exact replay", async () => {
  seedHosted();
  const command = add(); assert.equal((await post(command, { user: "member" })).status, 200);
  let revoked = false;
  beforeStatement = sql => {
    if (!revoked && sql.startsWith("SELECT request_hash,document_json")) {
      revoked = true; database.prepare("DELETE FROM member WHERE userId='member'").run();
    }
  };
  const retry = await post(command, { user: "member" });
  assert.equal(revoked, true); assert.equal(retry.status, 403);
  assert.equal(database.prepare("SELECT count(*) AS n FROM kitchen_command_receipt").get().n, 1);
});

test("membership revoked between state read and atomic claim prevents both receipt and mutation", async () => {
  seedHosted();
  let revoked = false;
  beforeStatement = sql => {
    if (!revoked && sql.startsWith("INSERT INTO kitchen_command_receipt")) {
      revoked = true; database.prepare("DELETE FROM member WHERE userId='member'").run();
    }
  };
  const result = await post(add(), { user: "member" });
  assert.equal(revoked, true); assert.equal(result.status, 403);
  assert.equal(database.prepare("SELECT count(*) AS n FROM kitchen_command_receipt").get().n, 0);
  assert.equal(database.prepare("SELECT count(*) AS n FROM kitchen_state").get().n, 0);
});

test("a no-op still claims its revision atomically and a conflict does not consume its ID", async () => {
  const initial = await app.service.kitchenService.save(0, baseState());
  const command = { type: "RemovePantryBatch", commandId: "noop-race", expectedRevision: initial.revision, snapshot: add().batches[0] };
  let raced = false;
  beforeStatement = sql => {
    if (!raced && sql.startsWith("INSERT INTO kitchen_command_receipt")) {
      raced = true; database.prepare("UPDATE kitchen_state SET revision=revision+1").run();
    }
  };
  const result = await post(command);
  assert.equal(result.status, 409); assert.equal(result.body.error.code, "REVISION_CONFLICT");
  assert.equal(result.body.current.revision, 2);
  assert.equal(database.prepare("SELECT count(*) AS n FROM kitchen_command_receipt").get().n, 0);
  beforeStatement = undefined;
  const retry = await post({ ...command, expectedRevision: 2 });
  assert.equal(retry.status, 200); assert.equal(retry.body.applied, false); assert.equal(retry.body.replayed, false);
  assert.equal(retry.body.document.revision, 2);
});

test("an actor moving to another household can reuse an ID without sharing the old receipt", async () => {
  seedHosted();
  const first = await post(add(), { user: "owner" }); assert.equal(first.status, 200);
  database.prepare("DELETE FROM member WHERE userId='owner'").run();
  database.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)").run("owner-second-home", "home-b", "owner", "member", new Date().toISOString());
  const second = await post(add("add-rice", 0, { batches: [{ id: "beans", name: "beans", measure: "2 kg" }] }), { user: "owner", home: "home-b" });
  assert.equal(second.status, 200); assert.equal(second.body.replayed, false);
  assert.deepEqual(second.body.document.state.pantry.map(item => item.id), ["beans"]);
  assert.equal((await post(add(), { user: "owner" })).status, 403);
  assert.equal(database.prepare("SELECT count(*) AS n FROM kitchen_command_receipt WHERE actor_id='owner'").get().n, 2);
});
