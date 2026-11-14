import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";
import { createSqliteD1 } from "./helpers/sqlite-d1.mjs";
const sources = await createSourceLoader({ name: "catalog-write-fencing", externals: { "cloudflare:workers": "export const env = {};" } });
const sql = await createSqliteD1();
const { env } = await sources.import("cloudflare:workers"); env.DB = sql.binding;
const household = await sources.import("app/lib/household.ts"); household.configureHouseholdRuntime(env);
const store = await sources.import("app/lib/recipe-store.ts");
const jobs = await sources.import("app/lib/catalog-job-store.ts");
const { buildRecipeSearchText, sha256Hex, precomputeRecipeEmbeddings } = await sources.import("app/lib/recipe-embeddings.ts");
const source = { id: "fence-fixture", name: "Synthetic fixture", url: "https://example.test", licenseId: "CC0-1.0", permissionBasis: "Original synthetic test recipe", approvalStatus: "approved", approvedBy: "test", allowDisplay: true, allowCache: true, allowIndexText: true, allowEmbed: true };
const recipe = { id: "rice", title: "Rice", image: null, category: "Dinner", cuisine: "Test", tags: [], servings: 2,
  ingredients: [{ name: "rice", measure: "200 g" }], instructions: ["Rinse rice.", "Cook rice."], source: { name: source.name, url: source.url }, sourceUrl: `${source.url}/rice` };
async function input(value = recipe, jobFence) {
  const searchText = buildRecipeSearchText(value);
  return { sourceId: source.id, recipe: value, searchText, contentHash: await sha256Hex(searchText), ...(jobFence ? { jobFence } : {}) };
}
async function claimed() {
  const { job } = await jobs.enqueueCatalogJob({ actorId: "test-admin", actorMode: "local", requestId: crypto.randomUUID(), input: { kind: "demo" } });
  return jobs.claimCatalogJob(job.id);
}
async function vectors() {
  const saved = (await store.listCatalogRecipes())[0];
  return (await precomputeRecipeEmbeddings([saved.recipe], [], { model: "test-model", fetchImpl: async () => Response.json({ embeddings: [[1, 2, 3]] }) })).embeddings;
}
function snapshot() {
  return Object.fromEntries(["recipes", "recipe_ingredients", "recipe_instruction_sections", "recipe_instruction_steps", "recipe_embeddings"].map(table => [table, sql.db.prepare(`SELECT * FROM ${table}`).all()]));
}
beforeEach(async () => {
  sql.intercept(undefined); sql.interceptBatch(undefined);
  household.configureHouseholdRuntime(env);
  sql.db.exec("DELETE FROM catalog_jobs; DELETE FROM recipe_embeddings; DELETE FROM recipes; DELETE FROM recipe_sync_runs; DELETE FROM recipe_sources; DELETE FROM user;");
  await store.upsertApprovedRecipeSource(source);
  await store.upsertCatalogRecipe(await input());
});
after(async () => { sql.close(); await sources.dispose(); });

test("source initialization never reactivates or rewrites an existing operator restriction", async () => {
  sql.db.exec("UPDATE recipe_sources SET approval_status='revoked',allow_cache=0,allow_embed=0,approval_notes='Operator revoked source'");
  const before = sql.db.prepare("SELECT * FROM recipe_sources").get();
  await store.upsertApprovedRecipeSource(source);
  assert.deepEqual(sql.db.prepare("SELECT * FROM recipe_sources").get(), before);
});

test("permission revoked after preparation aborts the entire recipe replacement before child rows change", async () => {
  const before = snapshot();
  sql.interceptBatch(() => {
    sql.interceptBatch(undefined); sql.db.prepare("UPDATE recipe_sources SET approval_status='revoked' WHERE id=?").run(source.id);
  });
  await assert.rejects(store.upsertCatalogRecipe(await input({ ...recipe, title: "Changed", ingredients: [{ name: "beans", measure: "500 g" }], instructions: ["Different instructions."] })), error => error.code === "CATALOG_WRITE_GUARD_CHANGED");
  assert.deepEqual(snapshot(), before);
  assert.equal(sql.db.prepare("SELECT approval_status FROM recipe_sources").get().approval_status, "revoked");
});

test("reclaimed leases fence source initialization, recipe, embedding and sync mutations", async () => {
  const old = await claimed();
  sql.db.prepare("UPDATE catalog_jobs SET lease_until=? WHERE id=?").run(Date.now() - 1, old.id);
  const fresh = await jobs.claimCatalogJob(old.id); assert.ok(fresh); assert.notEqual(old.fence.leaseToken, fresh.fence.leaseToken);
  const before = snapshot(), embedding = await vectors();
  for (const operation of [
    () => store.upsertApprovedRecipeSource({ ...source, id: "stale-source" }, old.fence),
    async () => store.upsertCatalogRecipe(await input({ ...recipe, title: "Stale worker" }, old.fence)),
    () => store.saveRecipeEmbeddings(embedding, old.fence),
    () => store.startCatalogSync(source.id, old.fence),
  ]) await assert.rejects(operation(), error => error.code === "CATALOG_WRITE_GUARD_CHANGED");
  assert.deepEqual(snapshot(), before);
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM recipe_sources WHERE id='stale-source'").get().n, 0);
  const run = await store.startCatalogSync(source.id, fresh.fence);
  await assert.rejects(store.finishCatalogSync(run, "succeeded", { recordsSeen: 1, recordsUpserted: 1 }, old.fence), error => error.code === "CATALOG_WRITE_GUARD_CHANGED");
  assert.equal(sql.db.prepare("SELECT status FROM recipe_sync_runs WHERE id=?").get(run).status, "running");
  await store.saveRecipeEmbeddings(embedding, fresh.fence);
  await store.finishCatalogSync(run, "succeeded", { recordsSeen: 1, recordsUpserted: 1 }, fresh.fence);
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM recipe_embeddings").get().n, 1);
});

test("embedding commits recheck the source and recipe version inside their transaction", async () => {
  const embedding = await vectors();
  for (const mutation of ["UPDATE recipes SET version=version+1", "UPDATE recipe_sources SET allow_embed=0"]) {
    sql.interceptBatch(() => { sql.interceptBatch(undefined); sql.db.exec(mutation); });
    await assert.rejects(store.saveRecipeEmbeddings(embedding), error => error.code === "CATALOG_WRITE_GUARD_CHANGED");
    assert.equal(sql.db.prepare("SELECT count(*) AS n FROM recipe_embeddings").get().n, 0);
  }
});

test("a lease expiring after guard preparation still blocks the database mutation", async () => {
  const lease = await claimed(), before = snapshot();
  sql.interceptBatch(() => {
    sql.interceptBatch(undefined); sql.db.prepare("UPDATE catalog_jobs SET lease_until=? WHERE id=?").run(Date.now() - 1, lease.id);
  });
  await assert.rejects(store.upsertCatalogRecipe(await input({ ...recipe, title: "Expired worker" }, lease.fence)), error => error.code === "CATALOG_WRITE_GUARD_CHANGED");
  assert.deepEqual(snapshot(), before);
});

test("administrator verification revoked after preparation blocks a hosted worker's recipe mutation", async () => {
  const at = new Date().toISOString();
  sql.db.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run("admin", "Admin", "admin@example.test", 1, at, at);
  household.configureHouseholdRuntime({ ...env, RAG_CHEF_HOSTED: "1", PLATFORM_ADMIN_EMAILS: "admin@example.test", HOSTED_RECIPE_SOURCE_IDS: source.id });
  const { job } = await jobs.enqueueCatalogJob({ actorId: "admin", actorMode: "hosted", requestId: "hosted-write", input: { kind: "demo" } });
  const lease = await jobs.claimCatalogJob(job.id), before = snapshot(); assert.ok(lease);
  sql.interceptBatch(() => { sql.interceptBatch(undefined); sql.db.exec("UPDATE user SET emailVerified=0 WHERE id='admin'"); });
  await assert.rejects(store.upsertCatalogRecipe(await input({ ...recipe, title: "Revoked admin" }, lease.fence)), error => error.code === "CATALOG_WRITE_GUARD_CHANGED");
  assert.deepEqual(snapshot(), before);
});

test("a failed child insert rolls back recipe content, version and all replaced children", async () => {
  const before = snapshot();
  sql.db.exec("CREATE TEMP TRIGGER fail_recipe_child BEFORE INSERT ON recipe_ingredients BEGIN SELECT RAISE(ABORT,'injected child write failure'); END");
  try {
    await assert.rejects(store.upsertCatalogRecipe(await input({ ...recipe, title: "Changed", ingredients: [{ name: "beans", measure: "400 g" }] })), /injected child write failure/);
    assert.deepEqual(snapshot(), before);
  } finally { sql.db.exec("DROP TRIGGER fail_recipe_child"); }
});

test("a partially completed job cannot overwrite a newer reviewed recipe when its lease is retried", async () => {
  const first = await claimed();
  const original = await input({ ...recipe, title: "First reviewed version" }, first.fence);
  const saved = await store.upsertCatalogRecipe(original);
  assert.equal(saved.version, 2);
  await store.upsertCatalogRecipe(await input({ ...recipe, title: "Newer reviewed version", ingredients: [{ name: "beans", measure: "500 g" }] }));
  sql.db.prepare("UPDATE catalog_jobs SET lease_until=? WHERE id=?").run(Date.now() - 1, first.id);
  const retry = await jobs.claimCatalogJob(first.id);
  const before = snapshot();
  await assert.rejects(store.upsertCatalogRecipe({ ...original, jobFence: retry.fence }), error => error.code === "CATALOG_JOB_RECIPE_CHANGED");
  assert.deepEqual(snapshot(), before);
});

test("concurrent duplicate recipe writes replay the original result without replacing rows or attempt metadata", async () => {
  const lease = await claimed();
  const firstSync = await store.startCatalogSync(source.id, lease.fence);
  const write = { ...await input({ ...recipe, title: "Changed once" }, lease.fence), syncRunId: firstSync };
  const results = await Promise.all([store.upsertCatalogRecipe(write), store.upsertCatalogRecipe(write)]);
  assert.deepEqual(results[0], results[1]); assert.equal(results[0].version, 2); assert.equal(results[0].contentChanged, true);
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM catalog_job_recipe_receipts").get().n, 1);
  const before = snapshot();
  const nextSync = await store.startCatalogSync(source.id, lease.fence);
  assert.deepEqual(await store.upsertCatalogRecipe({ ...write, syncRunId: nextSync }), results[0]);
  assert.deepEqual(snapshot(), before, "Attempt-specific sync ID and timestamps are not replayed into the recipe");
});

test("recipe-write receipt replay rejects changed intent, deleted recipes and revoked source permission", async () => {
  const lease = await claimed();
  const write = await input(recipe, lease.fence);
  await store.upsertCatalogRecipe(write);
  await assert.rejects(store.upsertCatalogRecipe(await input({ ...recipe, image: "https://example.test/new-image" }, lease.fence)), error => error.code === "CATALOG_JOB_RECIPE_CHANGED");
  sql.db.exec("UPDATE recipe_sources SET allow_cache=0");
  await assert.rejects(store.upsertCatalogRecipe(write), error => error.code === "CATALOG_WRITE_GUARD_CHANGED");
  sql.db.exec("UPDATE recipe_sources SET allow_cache=1; DELETE FROM recipes");
  await assert.rejects(store.upsertCatalogRecipe(write), error => error.code === "CATALOG_JOB_RECIPE_CHANGED");
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM recipes").get().n, 0);
});

test("failed job recipe writes roll back their receipts and ordinary database failures are not mistaken for replay", async () => {
  const lease = await claimed();
  const before = snapshot();
  sql.db.exec("CREATE TEMP TRIGGER fail_job_recipe_child BEFORE INSERT ON recipe_ingredients BEGIN SELECT RAISE(ABORT,'injected receipt child failure'); END");
  try {
    await assert.rejects(store.upsertCatalogRecipe(await input({ ...recipe, title: "Changed" }, lease.fence)), /injected receipt child failure/);
    assert.deepEqual(snapshot(), before);
    assert.equal(sql.db.prepare("SELECT count(*) AS n FROM catalog_job_recipe_receipts").get().n, 0);
  } finally { sql.db.exec("DROP TRIGGER fail_job_recipe_child"); }
});

test("catalog snapshots keep parent versions and recipe children from the same database read", async () => {
  let changed = false;
  const replace = () => {
    if (changed) return; changed = true;
    sql.db.exec("UPDATE recipes SET title='New reviewed title',version=2; UPDATE recipe_ingredients SET original_measure='900 g'; UPDATE recipe_instruction_steps SET text='New reviewed step.'");
  };
  // A true read batch sees the replacement before all its queries. Separate
  // parent/child reads instead interleave it after selecting the old parent.
  sql.interceptBatch(replace);
  sql.intercept(query => { if (/FROM recipe_ingredients WHERE/.test(query.sql)) replace(); });
  const [record] = await store.listCatalogRecipes();
  assert.equal(record.recipe.title, "New reviewed title");
  assert.equal(record.version, 2);
  assert.equal(record.recipe.ingredients[0].measure, "900 g");
  assert.ok(record.recipe.instructions.every(step => step === "New reviewed step."));
});
