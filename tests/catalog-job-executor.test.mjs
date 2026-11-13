import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";
const sources = await createSourceLoader({ name: "catalog-job-executor", externals: { "cloudflare:workers": "export const env = {};" } });
after(() => sources.dispose());
const { createCatalogJobExecutor } = await sources.import("app/lib/catalog-job-executor.ts");
const { sha256Hex } = await sources.import("app/lib/recipe-embeddings.ts");
const permitted = () => ({ approval_status: "approved", allow_display: 1, allow_cache: 1, allow_index_text: 1, allow_embed: 1 });
const emptyEmbedding = { model: "test-model", embeddings: [], failures: [], checkedCount: 0, skippedCount: 0, requestedCount: 0, completedCount: 0, dimension: null };
function fixture() {
  const policies = new Map(), recipes = new Map(), calls = [];
  const catalog = {
    async ensureReady() { calls.push("ensureReady"); }, async sourceEnabled() { return true; },
    async sourcePolicy(id) { return policies.get(id) ?? null; },
    async upsertSource(source) { calls.push("upsertSource"); if (!policies.has(source.id)) policies.set(source.id, permitted()); },
    async upsertRecipe(input) {
      calls.push("upsertRecipe"); const catalogId = `${input.sourceId}:${input.recipe.id}`;
      const prior = recipes.get(catalogId); const changed = prior?.contentHash !== input.contentHash;
      const version = (prior?.version ?? 0) + Number(changed);
      recipes.set(catalogId, { ...input, catalogId, version });
      return { catalogId, version, contentChanged: changed };
    },
    async list() { return [...recipes.values()]; }, async embeddings() { calls.push("embeddings"); return []; },
    async saveEmbeddings() { calls.push("saveEmbeddings"); }, async status() { return { recipeCount: recipes.size }; },
    async startSync() { calls.push("startSync"); return "sync"; }, async finishSync() { calls.push("finishSync"); },
  };
  const forbidden = async () => { assert.fail("This operation must not call a provider"); };
  return { catalog, policies, recipes, calls, providers: { searchRecipes: forbidden, precomputeRecipeEmbeddings: forbidden, precomputeRecipeStepEmbeddings: forbidden } };
}
async function reviewedDraft() {
  const value = { sourceUrl: "https://en.wikibooks.org/wiki/Cookbook:Test_Rice", title: "Test rice",
    ingredients: [{ name: "rice", measure: "200 g" }], instructions: ["Cook the rice."], servings: 2 };
  return { ...value, reviewed: true, reviewHash: await sha256Hex(JSON.stringify(value)) };
}

test("starter execution uses injected ports and can safely repeat without recipe versions changing", async () => {
  const h = fixture(), progress = [];
  const executor = createCatalogJobExecutor({ catalog: h.catalog, providers: h.providers, hosted: () => false });
  const first = await executor.execute({ kind: "demo" }, { checkpoint: async value => { if (value) progress.push(value); } });
  assert.deepEqual(first, { ok: true, count: 3 }); assert.equal(h.recipes.size, 3);
  const before = structuredClone([...h.recipes.values()]);
  assert.deepEqual(await executor.execute({ kind: "demo" }), first);
  assert.deepEqual([...h.recipes.values()], before);
  assert.ok(progress.some(value => value.phase === "saving" && value.completed === 3 && value.total === 3));
});

test("source permission revocation stops a running starter job before its next recipe", async () => {
  const h = fixture(), save = h.catalog.upsertRecipe;
  h.catalog.upsertRecipe = async input => {
    const result = await save(input); h.policies.set(input.sourceId, { ...permitted(), allow_cache: 0 }); return result;
  };
  const executor = createCatalogJobExecutor({ catalog: h.catalog, providers: h.providers, hosted: () => false });
  await assert.rejects(executor.execute({ kind: "demo" }), error => error.code === "SOURCE_DISABLED");
  assert.equal(h.recipes.size, 1); assert.equal(h.calls.filter(call => call === "upsertSource").length, 1);
  await assert.rejects(executor.execute({ kind: "demo" }), error => error.code === "SOURCE_DISABLED");
  assert.equal(h.recipes.size, 1); assert.equal(h.calls.filter(call => call === "upsertSource").length, 1, "retry cannot overwrite an operator's restriction");
});

test("loss of a lease after a provider returns prevents any embedding write", async () => {
  const h = fixture(); let expired = false, batches = 0;
  h.policies.set("fixture", permitted());
  h.catalog.list = async () => [{ sourceId: "fixture", recipe: { id: "rice", title: "Rice" }, contentHash: "a".repeat(64) }];
  const signal = new AbortController().signal;
  const executor = createCatalogJobExecutor({ catalog: h.catalog, hosted: () => false, embeddingModel: () => "test-model",
    providers: { ...h.providers, precomputeRecipeEmbeddings: async (_recipes, _existing, options) => {
      assert.strictEqual(options.signal, signal); assert.equal(options.batchSize, 8);
      await options.beforeBatch(); batches++; expired = true; return emptyEmbedding;
    } } });
  await assert.rejects(executor.execute({ kind: "embeddings" }, { signal, checkpoint: async () => { if (expired) throw new Error("lease lost"); } }), /lease lost/);
  assert.equal(batches, 1); assert.ok(!h.calls.includes("saveEmbeddings"));
});

test("hosted reviewed imports save text without embedding or source-provider access", async () => {
  const h = fixture();
  h.catalog.embeddings = async () => { assert.fail("Hosted imports never inspect local provider embeddings"); };
  const executor = createCatalogJobExecutor({ catalog: h.catalog, providers: h.providers, hosted: () => true });
  const result = await executor.execute({ kind: "import", recipes: [await reviewedDraft()], retryEmbeddingsOnly: false });
  assert.equal(result.ok, true); assert.equal(result.results[0].status, "saved"); assert.equal(result.results[0].embedding, "not_required");
  assert.equal(h.recipes.size, 1); assert.ok(!h.calls.includes("saveEmbeddings"));
});

test("hosted local-source/index jobs and already aborted work stop before catalog or provider access", async () => {
  const h = fixture();
  const hosted = createCatalogJobExecutor({ catalog: h.catalog, providers: h.providers, hosted: () => true });
  for (const input of [{ kind: "sync" }, { kind: "embeddings" }, { kind: "import", recipes: [await reviewedDraft()], retryEmbeddingsOnly: true }]) {
    await assert.rejects(hosted.execute(input), error => error.code === "HOSTED_CATALOG_SYNC_DISABLED");
  }
  const local = createCatalogJobExecutor({ catalog: h.catalog, providers: h.providers, hosted: () => false });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(local.execute({ kind: "demo" }, { signal: controller.signal }), error => error.name === "AbortError");
  assert.deepEqual(h.calls, []);
});

test("recipe replay conflicts and source write guards stop imports instead of becoming a partial success report", async () => {
  for (const code of ["CATALOG_JOB_RECIPE_CHANGED", "CATALOG_WRITE_GUARD_CHANGED"]) {
    const h = fixture();
    const failure = Object.assign(new Error("Current recipe or permissions changed"), { code });
    h.catalog.upsertRecipe = async () => { throw failure; };
    const executor = createCatalogJobExecutor({ catalog: h.catalog, providers: h.providers, hosted: () => false });
    await assert.rejects(executor.execute({ kind: "import", recipes: [await reviewedDraft()] }), error => error === failure);
    assert.ok(!h.calls.includes("saveEmbeddings"));
  }
});

test("embedding write guards after import save cannot be hidden as an optional pending embedding", async () => {
  const h = fixture();
  const failure = Object.assign(new Error("Source or job access was revoked during embedding"), { code: "CATALOG_WRITE_GUARD_CHANGED" });
  const executor = createCatalogJobExecutor({ catalog: h.catalog, hosted: () => false,
    providers: { ...h.providers, precomputeRecipeEmbeddings: async () => { throw failure; } } });
  await assert.rejects(executor.execute({ kind: "import", recipes: [await reviewedDraft()] }), error => error === failure);
  assert.equal(h.recipes.size, 1, "Already saved text remains; the failure must stop the job");
});

test("revoked source permission stops later embedding batches before their text reaches a provider", async () => {
  const h = fixture(); let providerCalls = 0;
  h.policies.set("fixture", permitted());
  h.catalog.list = async () => [{ sourceId: "fixture", recipe: { id: "fixture:rice", title: "Rice" }, contentHash: "a".repeat(64) }];
  const executor = createCatalogJobExecutor({ catalog: h.catalog, hosted: () => false, providers: {
    ...h.providers,
    precomputeRecipeEmbeddings: async (_recipes, _existing, options) => {
      await options.beforeBatch(); providerCalls++;
      h.policies.set("fixture", { ...permitted(), allow_embed: 0 });
      await options.beforeBatch(); providerCalls++;
      return emptyEmbedding;
    },
  } });
  await assert.rejects(executor.execute({ kind: "embeddings" }), error => error.code === "SOURCE_DISABLED");
  assert.equal(providerCalls, 1);
});

test("permission changes after imported text is saved prevent optional provider processing", async () => {
  const h = fixture(), save = h.catalog.upsertRecipe;
  h.catalog.upsertRecipe = async input => {
    const result = await save(input);
    h.policies.set(input.sourceId, { ...permitted(), allow_embed: 0 });
    return result;
  };
  const executor = createCatalogJobExecutor({ catalog: h.catalog, providers: h.providers, hosted: () => false });
  await assert.rejects(executor.execute({ kind: "import", recipes: [await reviewedDraft()] }), error => error.code === "SOURCE_DISABLED");
  assert.equal(h.recipes.size, 1);
});
