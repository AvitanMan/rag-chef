import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const dir = await mkdtemp(join(tmpdir(), "jff-recipe-import-"));
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys=ON");
for (const file of (await readdir(new URL("../drizzle/", import.meta.url))).filter((name) => name.endsWith(".sql")).sort()) {
  db.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
}
await writeFile(join(dir, "cloudflare.mjs"), "export const env = {DB: undefined};");
const modules = ["recipe-store", "recipe-embeddings", "recipe-import", "catalog-auth", "catalog-search", "recipe-browser", "recipe-safety", "recipe-constraints", "chef-schema", "kitchen-store", "kitchen-validation", "kitchen-state", "kitchen-types", "quantities"];
const files = modules.map((name) => [name, `../app/lib/${name}.ts`]);
files.push(["route", "../app/api/admin/recipes/import/route.ts"]);
files.push(["catalog-route", "../app/api/recipes/catalog/route.ts"]);
files.push(["chef-route", "../app/api/chef/route.ts"]);
files.push(["admin-route", "../app/api/admin/catalog/route.ts"]);
files.push(["metadata-route", "../app/api/admin/recipes/metadata/route.ts"]);
files.push(["search-route", "../app/api/recipes/route.ts"]);
files.push(["recipe-source", "../app/lib/recipe-source.ts"]);
for (const [name, path] of files) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replaceAll('"cloudflare:workers"', '"./cloudflare.mjs"')
    .replace(/"(?:@\/app\/lib\/|\.\/)([\w-]+)"/g, '"./$1.mjs"');
  await writeFile(join(dir, `${name}.mjs`), compiled);
}
const load = (name) => import(pathToFileURL(join(dir, name + ".mjs")).href);
const { env } = await load("cloudflare");
function statement(sql, values = []) {
  return {
    bind(...args) {
      assert.ok(args.length <= 100, "D1 allows at most 100 bound parameters");
      return statement(sql, args);
    },
    async first() { return db.prepare(sql).get(...values) ?? null; },
    async all() { return { results: db.prepare(sql).all(...values) }; },
    async run() { return db.prepare(sql).run(...values); },
    sql, values,
  };
}
env.DB = { prepare: statement, async batch(statements) {
  db.exec("BEGIN");
  try { const results = statements.map((s) => db.prepare(s.sql).run(...s.values)); db.exec("COMMIT"); return results; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
} };
const route = await load("route");
const importer = await load("recipe-import");
const store = await load("recipe-store");
const embeddings = await load("recipe-embeddings");
const kitchen = await load("kitchen-store");
const state = await load("kitchen-state");
const quantities = await load("quantities");
const search = await load("catalog-search");
const catalogRoute = await load("catalog-route");
const chefRoute = await load("chef-route");
const adminRoute = await load("admin-route");
const chefSchema = await load("chef-schema");
const constraintRules = await load("recipe-constraints");
const metadataRoute = await load("metadata-route");
const searchRoute = await load("search-route");
const originalFetch = globalThis.fetch;
let modelCalls = 0;
beforeEach(() => {
  db.exec("DELETE FROM recipe_embeddings; DELETE FROM recipes; DELETE FROM recipe_sync_runs; DELETE FROM recipe_sources; DELETE FROM kitchen_state;");
  delete process.env.CATALOG_ADMIN_TOKEN;
  modelCalls = 0;
  globalThis.fetch = async () => { modelCalls++; return Response.json({ embeddings: [[1, 2, 3]] }); };
});
after(async () => { globalThis.fetch = originalFetch; db.close(); await rm(dir, { recursive: true, force: true }); });

async function draft(index = 0, overrides = {}) {
  const data = {
    sourceUrl: `https://en.wikibooks.org/wiki/Cookbook:Test_Rice_${index}`,
    title: `Test rice ${index}`, ingredients: [{ name: "rice", measure: "1 ½ cups" }],
    instructions: ["Rinse rice. Use cold water. Drain.", "Cook rice until tender."], servings: 4, ...overrides,
  };
  return { ...data, reviewed: true, reviewHash: await embeddings.sha256Hex(JSON.stringify({ ...data, servings: data.servings ?? null })) };
}
function req(recipes, options = {}) {
  return new Request(options.url || "http://localhost:3000/api/admin/recipes/import", { method: "POST", headers: { "content-type": "application/json", ...options.headers }, body: JSON.stringify({ recipes, ...(options.retry ? { retryEmbeddingsOnly: true } : {}) }) });
}
async function importOne(value) {
  const response = await route.POST(req([value]));
  assert.equal(response.status, 200);
  return (await response.json()).results[0];
}

test("full catalog reports unavailable storage instead of a starter fallback", async () => {
  const binding = env.DB;
  env.DB = { prepare() { throw new Error("storage unavailable"); } };
  try {
    assert.equal((await catalogRoute.GET()).status, 503);
  } finally { env.DB = binding; }
});

test("ten reviewed recipes round-trip through real SQL without changing kitchen state", async () => {
  db.exec(`INSERT INTO kitchen_state VALUES ('local-household', '{"untouched":true}', 7, 'today')`);
  const drafts = await Promise.all(Array.from({ length: 10 }, (_, index) => draft(index)));
  const response = await route.POST(req(drafts));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.results.length, 10);
  assert.ok(result.results.every((row) => row.status === "saved" && row.embedding === "ready"));
  assert.equal(modelCalls, 10);
  const recipes = await store.listCatalogRecipes();
  assert.equal(recipes.length, 10);
  const saved = recipes.find((r) => r.recipe.title === "Test rice 0").recipe;
  assert.equal(saved.servings, 4);
  assert.deepEqual(saved.instructions, drafts[0].instructions);
  assert.equal(saved.source.licenseId, "CC-BY-SA-4.0");
  assert.ok(saved.source.attributionText.includes("formatting normalized"));
  assert.deepEqual({ ...db.prepare("SELECT state_json, revision FROM kitchen_state").get() }, { state_json: '{"untouched":true}', revision: 7 });
});

test("catalog reads preserve ingredients and step order beyond 100 recipes", async () => {
  for (let index = 0; index < 102; index++) {
    await importOne(await draft(index));
  }
  const recipes = await store.listCatalogRecipes();
  assert.equal(recipes.length, 102);
  const fullCatalog = await catalogRoute.GET();
  assert.equal(fullCatalog.status, 200);
  assert.equal((await fullCatalog.json()).recipes.length, 102);
  for (const item of recipes) {
    assert.deepEqual(item.recipe.ingredients, [{ name: "rice", measure: "1 ½ cups" }]);
    assert.deepEqual(item.recipe.instructions, ["Rinse rice. Use cold water. Drain.", "Cook rice until tender."]);
    assert.equal(item.recipe.servings, 4);
  }
  const result = await search.searchRecipeCatalog({ query: "Test rice 101" }, "nomic-embed-text");
  assert.equal(result.catalogCount, 102);
  assert.ok(result.recipes.some((recipe) => recipe.title === "Test rice 101"));
});

test("unchanged imports deduplicate, and changed drafts require renewed approval", async () => {
  const item = await draft();
  const first = await importOne(item);
  const same = await importOne(item);
  assert.equal(same.catalogId, first.catalogId);
  assert.equal(same.version, 1);
  assert.equal(same.contentChanged, false);
  assert.equal(modelCalls, 1);
  const changed = { ...item, instructions: ["Changed source instructions."] };
  assert.equal((await importOne(changed)).status, "failed");
  assert.equal(modelCalls, 1);
  const approved = await draft(0, { instructions: changed.instructions });
  const second = await importOne(approved);
  assert.equal(second.version, 2);
  assert.equal(modelCalls, 2);
  assert.equal(db.prepare("SELECT count(*) n FROM recipes").get().n, 1);
});

test("Ollama failure preserves recipes, and retry only embeds matching saved content", async () => {
  globalThis.fetch = async () => { throw new Error("offline"); };
  const value = await draft();
  const saved = await importOne(value);
  assert.equal(saved.status, "saved");
  assert.equal(saved.embedding, "pending");
  assert.equal((await store.listCatalogRecipes()).length, 1);
  globalThis.fetch = async () => { modelCalls++; return Response.json({ embeddings: [[1, 2, 3]] }); };
  let result = await (await route.POST(req([value], { retry: true }))).json();
  assert.equal(result.results[0].embedding, "ready");
  result = await (await route.POST(req([await draft(0, { servings: 8 })], { retry: true }))).json();
  assert.equal(result.results[0].status, "failed");
  assert.equal((await store.listCatalogRecipes())[0].recipe.servings, 4);
});

test("all ten imported titles remain findable with ordinary search when embeddings are missing", async () => {
  globalThis.fetch = async () => { throw new Error("offline"); };
  for (let i = 0; i < 10; i++) await importOne(await draft(i));
  for (let i = 0; i < 10; i++) {
    const result = await search.searchRecipeCatalog({ query: `Test rice ${i}` }, "nomic-embed-text");
    assert.equal(result.recipes[0].title, `Test rice ${i}`);
    assert.equal(result.method, "lexical_pantry");
  }
});

test("changed recipes never serve an old embedding while the replacement is pending", async () => {
  await importOne(await draft());
  assert.equal((await store.listStoredRecipeEmbeddings("nomic-embed-text")).length, 1);
  globalThis.fetch = async () => { throw new Error("offline"); };
  const changed = await importOne(await draft(0, { servings: 8 }));
  assert.equal(changed.embedding, "pending");
  assert.equal((await store.listStoredRecipeEmbeddings("nomic-embed-text")).length, 0);
  assert.equal((await search.searchRecipeCatalog({ query: "Test rice" }, "nomic-embed-text")).method, "lexical_pantry");
});

test("imports cannot accept measures that would break saved weekly plans", async () => {
  for (const measure of ["-2 g", "1/0 cup", "Infinity g", "x".repeat(161)]) {
    const result = await importOne(await draft(0, { ingredients: [{ name: "rice", measure }] }));
    assert.equal(result.status, "failed");
  }
  assert.equal((await store.listCatalogRecipes()).length, 0);
});

test("source metadata and servings survive planning snapshots and compatible shopping totals", async () => {
  await importOne(await draft());
  const recipe = (await store.listCatalogRecipes())[0].recipe;
  const meal = state.createPlannedMeal("2026-10-20", recipe);
  const value = { schemaVersion: 2, pantry: [], meals: { "2026-10-20": meal }, shoppingChecked: {}, migratedLegacy: true };
  kitchen.validateKitchenWrite({ revision: 0, state: value });
  await kitchen.saveKitchenDocument(0, value);
  const restored = (await kitchen.getKitchenDocument()).state;
  assert.equal(restored.meals["2026-10-20"].recipe.source.licenseId, "CC-BY-SA-4.0");
  assert.equal(restored.meals["2026-10-20"].baseServings, 4);
  assert.equal(quantities.buildShoppingList(Object.values(restored.meals), [])[0].measure, "360 ml");
});

test("normalized planning copies persist independently and reject malformed snapshots", async () => {
  await importOne(await draft(0, { ingredients: [{ name: "1 cup (240 ml) milk", measure: "" }] }));
  const recipe = (await store.listCatalogRecipes())[0].recipe;
  const meal = state.createPlannedMeal("2026-10-20", recipe);
  const value = { schemaVersion: 2, pantry: [], meals: { [meal.date]: meal }, shoppingChecked: {}, migratedLegacy: true };
  kitchen.validateKitchenWrite({ revision: 0, state: value });
  await kitchen.saveKitchenDocument(0, value);
  const restored = (await kitchen.getKitchenDocument()).state.meals[meal.date];
  assert.deepEqual(restored.planningIngredients, [{ name: "milk", measure: "240 ml" }]);
  assert.deepEqual(restored.recipe.ingredients, recipe.ingredients);
  assert.equal(restored.recipe.source.licenseId, "CC-BY-SA-4.0");
  assert.equal(quantities.buildShoppingList([restored], [])[0].measure, "240 ml");
  for (const planningIngredients of [[], [{ name: "milk", measure: "-2 g" }], [{ name: "milk", measure: "240 ml", invented: true }]]) {
    const invalid = structuredClone(value);
    invalid.meals[meal.date].planningIngredients = planningIngredients;
    assert.throws(() => kitchen.validateKitchenWrite({ revision: 0, state: invalid }));
  }
});

test("invalid, unreviewed and duplicate items fail individually; source permissions cannot be supplied", async () => {
  const good = await draft();
  const response = await route.POST(req([good, good, { ...good, sourceUrl: "http://127.0.0.1/" }, { ...good, reviewed: false }, { ...good, allowEmbed: true }]));
  const rows = (await response.json()).results;
  assert.equal(rows[0].status, "saved");
  assert.ok(rows.slice(1).every((row) => row.status === "failed"));
  assert.equal(db.prepare("SELECT count(*) n FROM recipes").get().n, 1);
});

test("suspended/restricted sources cannot be reactivated by the importer", async () => {
  await importOne(await draft());
  db.exec("UPDATE recipe_sources SET approval_status='suspended'");
  assert.equal((await route.POST(req([await draft(1)]))).status, 403);
  db.exec("UPDATE recipe_sources SET approval_status='approved', allow_embed=0");
  assert.equal((await route.POST(req([await draft(1)]))).status, 403);
});

test("cross-origin writes, remote unconfigured admin and oversized batches are rejected", async () => {
  const value = await draft();
  for (const headers of [{ origin: "https://evil.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }]) {
    assert.equal((await route.POST(req([value], { headers }))).status, 403);
  }
  assert.equal((await route.POST(req([value], { url: "https://example.com/api/admin/recipes/import" }))).status, 503);
  process.env.CATALOG_ADMIN_TOKEN = "test-token";
  assert.equal((await route.POST(req([value], { url: "https://example.com/api/admin/recipes/import" }))).status, 401);
  assert.equal((await route.POST(req(Array(21).fill(value)))).status, 400);
  assert.equal((await route.POST(new Request("http://localhost/api/admin/recipes/import", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(1_000_001) }))).status, 413);
});

function chefRequest(overrides = {}) {
  return new Request("http://localhost:3000/api/chef", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "Test rice", pantry: ["rice"], provider: "ollama", ...overrides }) });
}
function assertChefEvidence(record, recipe) {
  assert.equal(Object.hasOwn(record, "ingredients"), false);
  assert.equal(Object.hasOwn(record, "instructions"), false);
  assert.equal(record.title, recipe.title);
  assert.equal(record.servings, recipe.servings ?? null);
  assert.equal(record.sourceName, recipe.source.name);
  assert.deepEqual(record.evidence, [
    ...recipe.ingredients.map((ingredient, index) => ({ evidenceId: `I${index + 1}`, text: [ingredient.measure, ingredient.name].filter(Boolean).join(" ") })),
    ...recipe.instructions.map((text, index) => ({ evidenceId: `S${index + 1}`, text })),
  ]);
}
function mockChef(contexts, transform = (answer) => answer, prompts = []) {
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).endsWith("/api/embed")) {
      assert.match(body.input[0], /^search_query:/);
      assert.equal(body.truncate, false);
      return Response.json({ embeddings: [[1, 2, 3]] });
    }
    const prompt = body.messages[1].content;
    assert.equal(body.options.num_ctx, 16384);
    assert.equal(body.options.num_predict, 1600);
    assert.equal(body.format.properties.citations, undefined);
    assert.deepEqual(body.format.properties.recommendations.items.required, ["recipeId", "reason"]);
    assert.match(body.messages[0].content, /Required JSON schema:/);
    assert.match(prompt, /at most two short sentences/);
    assert.match(prompt, /complete original ingredients.*complete original directions/);
    prompts.push(prompt);
    const context = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2));
    contexts.push(context);
    const recipe = context.retrievedRecipes[0];
    return Response.json({ message: { content: JSON.stringify(transform({ answer: "This recipe matches your request.", sourceFacts: [], chefChanges: [], warnings: [], recommendations: [{ recipeId: recipe.recipeId, reason: "Matches your request" }] })) } });
  };
}

test("Chef searches all 102 approved recipes rather than a client shortlist and preserves complete source records", async () => {
  for (let offset = 0; offset < 102; offset += 20) {
    const drafts = await Promise.all(Array.from({ length: Math.min(20, 102 - offset) }, (_, i) => draft(offset + i, { instructions: Array.from({ length: 25 }, (_, step) => `Instruction ${step + 1}: cook carefully.`) })));
    assert.equal((await route.POST(req(drafts))).status, 200);
  }
  const catalog = await store.listCatalogRecipes(1000);
  const expected = catalog.find((item) => item.recipe.title === "Test rice 101").recipe;
  const contexts = []; mockChef(contexts);
  const response = await chefRoute.POST(chefRequest({ query: expected.title, candidates: [catalog.find((item) => item.recipe.title === "Test rice 0").recipe] }));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.retrieval.catalogCount, 102);
  assert.equal(result.generation, "ai");
  assert.equal(result.recommendations[0].recipeId, expected.id);
  assert.deepEqual(result.recipes.find((recipe) => recipe.id === expected.id), expected);
  assert.equal(result.citations[0].sourceUrl, expected.sourceUrl);
  assert.match(result.recipes[0].source.licenseUrl, /creativecommons/);
  assert.equal(contexts[0].retrievedRecipes.length, 1);
  assertChefEvidence(contexts[0].retrievedRecipes[0], expected);
  assert.equal(contexts[0].retrievedRecipes[0].recipeId, "R1");
  assert.equal(contexts[0].retrievedRecipes[0].sourceUrl, undefined);
  assert.deepEqual(result.recommendations[0].pantryMatch, ["rice"]);
  assert.ok(Object.values(result.timings).every((value) => Number.isInteger(value) && value >= 0));
  const before = JSON.stringify(db.prepare("SELECT * FROM recipes ORDER BY id").all());
  db.exec("UPDATE recipe_embeddings SET kind = 'old-format'");
  globalThis.fetch = async (_url, options) => Response.json({ embeddings: JSON.parse(options.body).input.map(() => [1, 2, 3]) });
  const refreshed = await (await adminRoute.POST(new Request("http://localhost:3000/api/admin/catalog", { method: "POST", body: JSON.stringify({ embeddingsOnly: true }) }))).json();
  assert.equal(refreshed.embeddings.completedCount, 102);
  assert.equal(refreshed.catalog.embeddingCount, 102);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM recipes ORDER BY id").all()), before);
});

test("a 25-step Chef context keeps all quantities, source evidence and metadata with less serialized input", async (t) => {
  await importOne(await draft(0, {
    ingredients: [{ name: "rice", measure: "1 ½ cups" }, { name: "water", measure: "500 ml" }, { name: "fresh coriander", measure: "" }],
    instructions: Array.from({ length: 25 }, (_, index) => `Instruction ${index + 1}: stir the rice gently, keeping the original source direction intact.`),
  }));
  const review = await metadataReview();
  assert.equal((await metadataRoute.POST(metadataRequest([review]))).status, 200);
  const before = (await store.listCatalogRecipes())[0];
  const contexts = [];
  mockChef(contexts, (answer) => ({ ...answer, sourceFacts: [{ recipeId: "R1", evidenceId: "I1" }, { recipeId: "R1", evidenceId: "S25" }] }));
  const result = await (await chefRoute.POST(chefRequest({ query: before.recipe.title, pantry: [{ name: "rice", quantity: "100 g" }], profile: { diet: "Vegan", dislikes: ["onion"], equipment: ["Stovetop"] } }))).json();
  assert.equal(result.generation, "ai");
  const context = contexts[0];
  assertChefEvidence(context.retrievedRecipes[0], before.recipe);
  assert.deepEqual(context.retrievedRecipes[0].reviewedMetadata, before.metadata);
  assert.deepEqual(context.pantry, [{ name: "rice", quantity: "100 g" }]);
  assert.deepEqual(context.profile, chefSchema.parseChefRequest({ query: before.recipe.title, profile: { diet: "Vegan", dislikes: ["onion"], equipment: ["Stovetop"] } }).profile);
  assert.deepEqual(result.sourceFacts.map((item) => item.fact), ["1 ½ cups rice", before.recipe.instructions[24]]);
  assert.deepEqual(result.recipes, [before.recipe]);
  assert.deepEqual((await store.listCatalogRecipes())[0], before);

  // The prior context supplied both source arrays in addition to this same evidence.
  const legacy = { ...context, retrievedRecipes: context.retrievedRecipes.map((record) => ({ ...record, ingredients: before.recipe.ingredients, instructions: before.recipe.instructions })) };
  const oldBytes = Buffer.byteLength(JSON.stringify(legacy));
  const newBytes = Buffer.byteLength(JSON.stringify(context));
  assert.ok(newBytes < oldBytes, "Complete evidence must use less input than the duplicated source representation");
  t.diagnostic(`25-step serialized JSON context: ${oldBytes} -> ${newBytes} UTF-8 bytes (${((oldBytes - newBytes) / oldBytes * 100).toFixed(1)}% smaller); includes unchanged reviewed metadata and profile.`);
});

test("allergy exclusions apply before top-K selection and generation context", async () => {
  await route.POST(req([await draft(0, { title: "Peanut noodles", ingredients: [{ name: "peanuts", measure: "1 cup" }] }), await draft(1, { title: "Rice bowl" })]));
  const contexts = []; mockChef(contexts);
  const blocked = await (await chefRoute.POST(chefRequest({ query: "Peanut noodles", profile: { allergies: ["peanut"] } }))).json();
  assert.equal(contexts.length, 0, "An excluded named dish cannot trigger unrelated alternatives or generation");
  assert.deepEqual(blocked.recommendations, []);
  assert.ok(blocked.warnings.some((warning) => warning.includes("conflicts with your requirements")));
  const result = await (await chefRoute.POST(chefRequest({ query: "Suggest dinner", profile: { allergies: ["peanut"] } }))).json();
  assert.equal(result.retrieval.allergyExcludedCount, 1);
  assert.ok(result.recipes.every((recipe) => recipe.title !== "Peanut noodles"));
  assert.ok(contexts[0].retrievedRecipes.every((recipe) => recipe.title !== "Peanut noodles"));
  assert.ok(result.warnings.some((warning) => warning.includes("cross-contact")));
});

test("diet constraints filter before generation and fallback, allow labeled unknowns, and retain amount context", async () => {
  await route.POST(req([await draft(0, { title: "Chicken rice", ingredients: [{ name: "chicken stock", measure: "1 cup" }] }), await draft(1, { title: "Rice bowl" })]));
  const contexts = []; mockChef(contexts);
  const result = await (await chefRoute.POST(chefRequest({ query: "Suggest dinner", profile: { diet: "Vegetarian" }, pantry: [{ name: "rice", quantity: "0 g" }, { name: "chicken stock", quantity: 0 }] }))).json();
  assert.equal(result.recipes.length, 1);
  assert.equal(result.recipes[0].title, "Rice bowl");
  assert.deepEqual(result.recommendations[0].pantryMatch, []);
  assert.equal(contexts[0].pantry[0].quantity, "0 g");
  assert.ok(result.warnings.some((x) => x.includes("Diet suitability is not verified")));
  globalThis.fetch = async () => { throw new Error("offline"); };
  const fallback = await (await chefRoute.POST(chefRequest({ query: "Suggest dinner", profile: { diet: "Vegetarian" } }))).json();
  assert.equal(fallback.generation, "catalog_fallback");
  assert.equal(fallback.recipes.length, 1); assert.equal(fallback.recipes[0].title, "Rice bowl");
});

test("compact recipe references hydrate facts, changes, citations and pantry data without changing source recipes", async () => {
  await importOne(await draft());
  const before = (await store.listCatalogRecipes())[0].recipe;
  const contexts = [];
  mockChef(contexts, (answer) => ({ ...answer, answer: "Try Test rice 0 (R1).", sourceFacts: [{ recipeId: "R1", evidenceId: "I1" }, { recipeId: "R1", evidenceId: "S2" }], chefChanges: [{ recipeId: "R1", change: "Use vegetable stock instead of water.", reason: "A proposed savory adaptation, not part of the source." }] }));
  const result = await (await chefRoute.POST(chefRequest({ query: "Could I use stock instead of water in Test rice 0?" }))).json();
  assert.equal(result.generation, "ai");
  assert.equal(result.answer, "Try Test rice 0.");
  assert.equal(result.sourceFacts[0].recipeId, before.id);
  assert.equal(result.sourceFacts[0].evidenceId, "I1");
  assert.equal(result.sourceFacts[0].fact, "1 ½ cups rice");
  assert.equal(result.sourceFacts[1].fact, before.instructions[1]);
  assertChefEvidence(contexts[0].retrievedRecipes[0], before);
  assert.deepEqual(contexts[0].retrievedRecipes[0].evidence[0], { evidenceId: "I1", text: "1 ½ cups rice" });
  assert.equal(result.chefChanges[0].recipeId, before.id);
  assert.deepEqual(result.citations, [{ recipeId: before.id, title: before.title, sourceName: before.source.name, sourceUrl: before.sourceUrl }]);
  assert.deepEqual(result.recommendations[0].missingIngredients, []);
  assert.deepEqual(result.recipes[0], before);
  assert.deepEqual((await store.listCatalogRecipes())[0].recipe, before);
});

test("invalid or oversized model output safely falls back instead of leaking invented references or model-owned metadata", async () => {
  await importOne(await draft());
  for (const mutate of [
    (a) => ({ ...a, recommendations: [{ recipeId: "R8", reason: "Not in this request" }] }),
    (a) => ({ ...a, recommendations: [{ recipeId: "https://wrong.example", reason: "Fake" }] }),
    (a) => ({ ...a, sourceFacts: [{ recipeId: "R8", evidenceId: "I1" }] }),
    (a) => ({ ...a, sourceFacts: [{ recipeId: "R1", evidenceId: "S999" }] }),
    (a) => ({ ...a, sourceFacts: [{ recipeId: "R1", fact: "Invented 99 g protein." }] }),
    (a) => ({ ...a, citations: [{ sourceUrl: "https://wrong.example" }] }),
    (a) => ({ ...a, recommendations: [{ recipeId: "R1", reason: "Fine", pantryMatch: ["invented"] }] }),
    (a) => ({ ...a, recommendations: [{ recipeId: "R1", reason: "Fine", matchReason: "Invented model-owned match explanation" }] }),
    (a) => ({ ...a, answer: "x".repeat(641) }),
    (a) => ({ ...a, sourceFacts: Array.from({ length: 4 }, () => ({ recipeId: "R1", evidenceId: "I1" })) }),
  ]) {
    mockChef([], mutate);
    const result = await (await chefRoute.POST(chefRequest())).json();
    assert.equal(result.generation, "catalog_fallback");
    assert.deepEqual(result.chefChanges, []);
    assert.ok(result.citations.every((citation) => citation.sourceUrl.startsWith("https://en.wikibooks.org/")));
  }
});

test("unrelated requests abstain even with complete pantry coverage, and broad requests still browse", async () => {
  await route.POST(req([await draft()]));
  globalThis.fetch = async () => { throw new Error("offline"); };
  for (const query of ["qwerty flibbertigibbet", "lobster thermidor", "quantum spaceship repair"]) {
    const result = await (await chefRoute.POST(chefRequest({ query, pantry: ["rice"] }))).json();
    assert.equal(result.outcome, "no_match", query); assert.deepEqual(result.recommendations, []); assert.deepEqual(result.recipes, []);
  }
  const broad = await (await chefRoute.POST(chefRequest({ query: "What can I make with my ingredients?" }))).json();
  assert.equal(broad.outcome, "matches"); assert.equal(broad.recipes.length, 1);
});

test("missing compound dishes abstain before generation even when their shared ingredient fills the pantry", async () => {
  await route.POST(req([
    await draft(0, { title: "Beef Stew", ingredients: [{ name: "beef", measure: "200 g" }, { name: "onion", measure: "1" }] }),
    await draft(1, { title: "Beef Fajitas", ingredients: [{ name: "beef", measure: "200 g" }] }),
  ]));
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error("offline"); };
  const response = await chefRoute.POST(chefRequest({ query: "Beef Wellington", pantry: ["beef", "onion"] }));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.outcome, "no_match");
  assert.deepEqual(result.recipes, []);
  assert.deepEqual(result.recommendations, []);
  assert.ok(calls.every((url) => url.endsWith("/api/embed")), "No generation provider is called for a terminal no-match");
  const searchResult = await (await searchRoute.GET(new Request("http://localhost/api/recipes?q=Beef%20Wellington&pantry=beef,onion"))).json();
  assert.equal(searchResult.outcome, "no_match");
  assert.deepEqual(searchResult.recipes, []);
  assert.deepEqual(searchResult.matchReasonsByRecipeId, {});
  const broad = await (await searchRoute.GET(new Request("http://localhost/api/recipes?q=beef%20dinner"))).json();
  assert.equal(broad.outcome, "matches");
  assert.equal(broad.recipes.length, 2);
});

test("the public search and Chef share a focused shortlist and prune incomplete secondary matches", async () => {
  await route.POST(req([
    await draft(0, { title: "Creamy Mushroom Pasta", ingredients: [{ name: "pasta", measure: "200 g" }, { name: "mushrooms", measure: "100 g" }, { name: "cream", measure: "100 ml" }] }),
    await draft(1, { title: "Cheese Pasta", ingredients: [{ name: "pasta", measure: "200 g" }, { name: "cheese", measure: "100 g" }] }),
    await draft(2, { title: "Mushroom Soup", ingredients: [{ name: "mushrooms", measure: "100 g" }, { name: "water", measure: "100 ml" }] }),
  ]));
  const contexts = []; mockChef(contexts);
  for (const query of ["Creamy Mushroom Pasta", "pasta with mushrooms"]) {
    const found = await (await searchRoute.GET(new Request(`http://localhost/api/recipes?q=${encodeURIComponent(query)}`))).json();
    assert.deepEqual(found.recipes.map((recipe) => recipe.title), ["Creamy Mushroom Pasta"]);
    const answer = await (await chefRoute.POST(chefRequest({ query, pantry: ["pasta", "cheese"] }))).json();
    assert.deepEqual(answer.recipes.map((recipe) => recipe.title), ["Creamy Mushroom Pasta"]);
    assert.equal(answer.recommendations[0].matchReason, found.matchReasonsByRecipeId[answer.recipes[0].id]);
    assert.equal(answer.recommendations[0].matchReason, query === "Creamy Mushroom Pasta" ? "Matches the recipe you named." : "Matches your search words: pasta, mushroom.");
    assert.equal(answer.recommendations[0].reason, "Matches your request", "The model's advice remains separate from the retrieval explanation");
    assert.deepEqual(contexts.at(-1).retrievedRecipes.map((recipe) => recipe.title), ["Creamy Mushroom Pasta"]);
  }
});

test("match explanations survive provider failure and invalid evidence while diet unknowns remain explicit", async () => {
  await importOne(await draft());
  const query = "Test rice 0";
  const results = [];
  for (const failure of ["none", "offline", "invalid_evidence"]) {
    mockChef([], (answer) => failure === "invalid_evidence" ? { ...answer, sourceFacts: [{ recipeId: "R1", evidenceId: "S999" }] } : answer);
    if (failure === "offline") globalThis.fetch = async () => { throw new Error("offline"); };
    const result = await (await chefRoute.POST(chefRequest({ query, profile: { diet: "Vegetarian" } }))).json();
    assert.equal(result.generation, failure === "none" ? "ai" : "catalog_fallback");
    assert.equal(result.recommendations[0].matchReason, "Matches the recipe you named.");
    if (failure !== "none") assert.equal(result.recommendations[0].reason, result.recommendations[0].matchReason);
    assert.ok(result.warnings.some((warning) => warning.includes("Diet suitability is not verified")));
    results.push(result.recipes);
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], results[2]);
});

test("unknown questions may return no recommendations without manufacturing a recipe card", async () => {
  await route.POST(req([await draft()]));
  mockChef([], (answer) => ({ ...answer, answer: "Nutrition is not provided by the source.", recommendations: [] }));
  const result = await (await chefRoute.POST(chefRequest({ query: "For Test rice 0, how much protein is there?" }))).json();
  assert.equal(result.generation, "ai"); assert.deepEqual(result.recommendations, []);
  assert.equal(result.citations.length, 0);
});

test("adaptation recognition includes scaling and explicit reductions without expanding source permissions", () => {
  for (const query of ["Make Test rice vegan", "Scale Test rice for 8 people", "For Test rice, halve the salt", "Double Test rice"]) assert.equal(chefRoute.adaptationRequested(query, true), true, query);
  assert.equal(chefRoute.adaptationRequested("Recommend rice"), false);
  assert.equal(chefRoute.adaptationRequested("Dinner without tomatoes"), false);
  assert.equal(chefRoute.adaptationRequested("Make a vegan dinner"), false);
});

test("natural-language ingredient exclusions apply to retrieval, provider context and fallback without changing saved preferences", async () => {
  await route.POST(req([
    await draft(0, { title: "Cheese Pasta", ingredients: [{ name: "penne", measure: "200 g" }, { name: "mozzarella", measure: "100 g" }] }),
    await draft(1, { title: "Tomato Rice", ingredients: [{ name: "chopped tomatoes", measure: "2" }, { name: "rice", measure: "100 g" }] }),
    await draft(2, { title: "Garlic Rice", ingredients: [{ name: "rice", measure: "200 g" }, { name: "garlic", measure: "1 clove" }] }),
  ]));
  const before = JSON.stringify((await store.listCatalogRecipes()).map((row) => row.recipe));
  for (const [query, forbidden] of [["Dinner but no pasta", ["Cheese Pasta"]], ["Rice without tomatoes", ["Tomato Rice"]]]) {
    const contexts = []; mockChef(contexts);
    const response = await chefRoute.POST(chefRequest({ query }));
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.generation, "ai");
    assert.ok(result.recipes.length > 0);
    assert.ok(result.recipes.every((recipe) => !forbidden.includes(recipe.title)));
    assert.ok(contexts[0].retrievedRecipes.every((recipe) => !forbidden.includes(recipe.title)));
    assert.equal(contexts[0].adaptationRequested, false);
    assert.ok(contexts[0].requestIntent.excludedIngredients.length > 0);
    const searchResult = await (await searchRoute.GET(new Request(`http://localhost/api/recipes?q=${encodeURIComponent(query)}`))).json();
    assert.ok(searchResult.recipes.length > 0);
    assert.ok(searchResult.recipes.every((recipe) => !forbidden.includes(recipe.title)));
    globalThis.fetch = async () => { throw new Error("offline"); };
    const fallback = await (await chefRoute.POST(chefRequest({ query }))).json();
    assert.equal(fallback.generation, "catalog_fallback");
    assert.ok(fallback.recipes.length > 0);
    assert.ok(fallback.recipes.every((recipe) => !forbidden.includes(recipe.title)));
  }
  assert.equal(JSON.stringify((await store.listCatalogRecipes()).map((row) => row.recipe)), before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kitchen_state").get().n, 0);
});

test("a named vegan adaptation preserves its original source but cannot bypass saved diet or allergy exclusions", async () => {
  await importOne(await draft(0, { title: "Cheese Pasta", ingredients: [{ name: "penne", measure: "200 g" }, { name: "mozzarella", measure: "100 g" }] }));
  const before = (await store.listCatalogRecipes())[0].recipe;
  const contexts = []; mockChef(contexts, (answer) => ({ ...answer, chefChanges: [{ recipeId: "R1", change: "Consider a plant-based cheese substitute.", reason: "Advisory vegan adaptation; source directions are unchanged." }] }));
  const adapted = await (await chefRoute.POST(chefRequest({ query: "Make Cheese Pasta vegan" }))).json();
  assert.equal(adapted.outcome, "matches");
  assert.equal(adapted.generation, "ai");
  assert.deepEqual(adapted.recipes, [before]);
  assert.equal(adapted.chefChanges.length, 1);
  assert.deepEqual(contexts[0].requestIntent.adaptationDiets, ["vegan"]);
  assert.ok(adapted.warnings.some((warning) => warning.includes("original recipe is unchanged")));
  for (const profile of [{ diet: "Vegan" }, { allergies: ["dairy"] }]) {
    const count = contexts.length;
    const blocked = await (await chefRoute.POST(chefRequest({ query: "Make Cheese Pasta vegan", profile }))).json();
    assert.equal(blocked.outcome, "constraints_unsatisfied");
    assert.deepEqual(blocked.recipes, []);
    assert.equal(contexts.length, count, "A saved exclusion must block generation");
  }
  assert.deepEqual((await store.listCatalogRecipes())[0].recipe, before);
});

test("OpenAI receives the same complete evidence as Ollama and rejects incomplete or invalid responses without paid calls", async () => {
  await importOne(await draft(0, { instructions: Array.from({ length: 25 }, (_, step) => `Instruction ${step + 1}: cook carefully.`) }));
  const before = (await store.listCatalogRecipes())[0].recipe;
  const contexts = []; const prompts = [];
  mockChef(contexts, (answer) => answer, prompts);
  assert.equal((await (await chefRoute.POST(chefRequest())).json()).generation, "ai");
  assertChefEvidence(contexts[0].retrievedRecipes[0], before);
  process.env.OPENAI_API_KEY = "test-only-not-a-real-key";
  try {
    for (const status of ["completed", "incomplete", "invalid_evidence"]) {
      globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        if (String(url).endsWith("/api/embed")) return Response.json({ embeddings: [[1, 2, 3]] });
        assert.equal(body.text.format.strict, true);
        assert.deepEqual(body.text.format.schema.properties.recommendations, chefSchema.CHEF_RESPONSE_JSON_SCHEMA.properties.recommendations);
        assert.equal(body.text.format.schema.properties.chefChanges.maxItems, 0);
        assert.equal(body.store, false);
        assert.equal(body.input[1].content, prompts[0]);
        const context = JSON.parse(body.input[1].content.split("\n\n")[1]);
        assert.equal(context.retrievedRecipes[0].recipeId, "R1");
        assertChefEvidence(context.retrievedRecipes[0], before);
        return Response.json({ status: status === "invalid_evidence" ? "completed" : status, output_text: JSON.stringify({ answer: "Use this source recipe.", recommendations: [{ recipeId: "R1", reason: "Fits the request." }], sourceFacts: [{ recipeId: "R1", evidenceId: "I1" }, { recipeId: "R1", evidenceId: status === "invalid_evidence" ? "S26" : "S25" }], chefChanges: [], warnings: [] }) });
      };
      const result = await (await chefRoute.POST(chefRequest({ provider: "openai" }))).json();
      assert.equal(result.generation, status === "completed" ? "ai" : "catalog_fallback");
      assert.equal(result.recommendations[0].recipeId, (await store.listCatalogRecipes())[0].recipe.id);
      assert.equal(result.recommendations[0].matchReason, "Matches your search words: test, rice.");
      assert.deepEqual(result.sourceFacts.map((item) => item.fact), status === "completed" ? ["1 ½ cups rice", before.instructions[24]] : []);
      assert.deepEqual(result.recipes, [before]);
    }
  } finally { delete process.env.OPENAI_API_KEY; }
});

test("explicit named-dish questions keep the right card and complete context; ordinary recommendations do not generate changes", async () => {
  await route.POST(req([await draft(0, { title: "Zucchini Pasta Bake" }), await draft(1, { title: "Other Pasta" })]));
  const contexts = [];mockChef(contexts, (answer) => ({ ...answer, answer: "Try R1.", chefChanges: [{ recipeId: "R1", change: "Use oil instead of butter.", reason: "Proposed flavor change." }] }));
  const adapted = await (await chefRoute.POST(chefRequest({ query: "For Zucchini Pasta Bake, can I use oil instead of butter?" }))).json();
  assert.equal(adapted.generation, "ai");
  assert.equal(adapted.recipes[0].title, "Zucchini Pasta Bake");
  assert.equal(adapted.answer, "Try Zucchini Pasta Bake.");
  assert.equal(contexts[0].retrievedRecipes.length, 1);
  assert.equal(contexts[0].adaptationRequested, true);
  const unsolicited = await (await chefRoute.POST(chefRequest({ query: "Recommend Zucchini Pasta Bake" }))).json();
  assert.equal(unsolicited.generation, "catalog_fallback");
  assert.deepEqual(unsolicited.chefChanges, []);
  assert.equal(contexts[1].adaptationRequested, false);
  const recipes = (await store.listCatalogRecipes()).map((item) => item.recipe);
  assert.equal(search.focusedRecipeId("Avoid Zucchini Pasta Bake", recipes), null);
  assert.equal(search.focusedRecipeId("A mushroom dinner", recipes), null);
  assert.equal(search.focusedRecipeId("For ZUCCHINI Pasta Bake, help me cook", recipes), adapted.recipes[0].id);
});

test("client source names cannot approve recipes and storage failures never trust client records", async () => {
  const forged = { id: "forged", title: "Fake", source: { name: "TheMealDB", url: "https://www.themealdb.com/" }, sourceUrl: "https://www.themealdb.com/", ingredients: [{ name: "rice", measure: "1 cup" }], instructions: ["Cook rice"], tags: [] };
  const empty = await (await chefRoute.POST(chefRequest({ candidates: [forged] }))).json();
  assert.deepEqual(empty.recipes, []); assert.deepEqual(empty.recommendations, []); assert.equal(modelCalls, 0);
  const old = env.DB; env.DB = undefined;
  try { assert.equal((await chefRoute.POST(chefRequest({ candidates: [forged] }))).status, 503); }
  finally { env.DB = old; }
  await route.POST(req([await draft()]));
  db.exec("UPDATE recipe_sources SET approval_status = 'suspended'");
  assert.deepEqual((await (await chefRoute.POST(chefRequest())).json()).recipes, []);
});

test("Ollama failure produces labeled server-ranked suggestions without rewriting recipes", async () => {
  await route.POST(req([await draft()]));
  const before = db.prepare("SELECT * FROM recipes").all();
  globalThis.fetch = async () => { throw new TypeError("Ollama stopped"); };
  const result = await (await chefRoute.POST(chefRequest())).json();
  assert.equal(result.generation, "catalog_fallback"); assert.equal(result.retrieval.method, "lexical_pantry");
  assert.equal(result.recommendations.length, 1); assert.equal(result.sourceFacts.length, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("not an AI answer")));
  assert.deepEqual(db.prepare("SELECT * FROM recipes").all(), before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kitchen_state").get().n, 0);
});

test("embedding format is versioned separately and vector-only refresh is safe to repeat", async () => {
  await route.POST(req([await draft()]));
  const before = JSON.stringify(db.prepare("SELECT * FROM recipes").all());
  db.exec("UPDATE recipe_embeddings SET kind = 'recipe'");
  assert.equal((await store.getCatalogStatus("nomic-embed-text")).embeddingCount, 0);
  assert.equal((await store.getCatalogStatus("nomic-embed-text")).staleEmbeddingCount, 1);
  const seen = [];
  globalThis.fetch = async (_url, options) => { const body = JSON.parse(options.body); seen.push(body); return Response.json({ embeddings: body.input.map(() => [1, 2, 3]) }); };
  const refresh = () => adminRoute.POST(new Request("http://localhost:3000/api/admin/catalog", { method: "POST", body: JSON.stringify({ embeddingsOnly: true }) }));
  const refreshed = await (await refresh()).json();
  assert.equal(refreshed.embeddings.completedCount, 1);
  assert.equal(refreshed.catalog.embeddingKind, "recipe-search-v2");
  assert.match(seen[0].input[0], /^search_document: Title:/);
  assert.doesNotMatch(seen[0].input[0], /Instructions:|Cook rice until/);
  assert.equal(seen[0].truncate, false);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM recipes").all()), before);
  assert.equal((await (await refresh()).json()).embeddings.completedCount, 0);
  assert.equal(seen.length, 1);
  db.exec("UPDATE recipe_sources SET allow_embed = 0");
  assert.equal((await (await refresh()).json()).embeddings.checkedCount, 0);
  assert.equal(seen.length, 1, "refresh cannot override a disabled embedding permission");
  assert.equal(db.prepare("SELECT allow_embed FROM recipe_sources").get().allow_embed, 0);
  assert.equal((await adminRoute.POST(new Request("http://localhost:3000/api/admin/catalog", { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ embeddingsOnly: true }) }))).status, 403);
});

test("oversized inputs stay pending rather than being silently truncated", async () => {
  const seen = [];
  globalThis.fetch = async (_url, options) => { seen.push(JSON.parse(options.body)); return Response.json({ error: "input length exceeds context length" }, { status: 400 }); };
  const result = await (await route.POST(req([await draft()]))).json();
  assert.equal(result.results[0].status, "saved"); assert.equal(result.results[0].embedding, "pending");
  assert.equal(seen[0].truncate, false);
  assert.equal((await store.getCatalogStatus("nomic-embed-text")).embeddingCount, 0);
});

test("a length-limited model response is never presented as a complete AI answer", async () => {
  await route.POST(req([await draft()]));
  globalThis.fetch = async (url) => String(url).endsWith("/api/embed") ? Response.json({ embeddings: [[1, 2, 3]] }) : Response.json({ done_reason: "length", message: { content: "{\"answer\":\"Incomplete" } });
  const result = await (await chefRoute.POST(chefRequest())).json();
  assert.equal(result.generation, "catalog_fallback");
  assert.equal(result.recommendations.length, 1);
});

test("dimension mismatch and partial indexes use the same lexical/pantry fallback", async () => {
  await route.POST(req([await draft(0), await draft(1)]));
  globalThis.fetch = async () => Response.json({ embeddings: [[1, 2]] });
  const mismatch = await search.searchRecipeCatalog({ query: "Test rice 1" }, "nomic-embed-text");
  assert.equal(mismatch.method, "lexical_pantry"); assert.equal(mismatch.recipes[0].title, "Test rice 1");
  assert.ok(mismatch.ranked.every((item) => item.semanticScore === null));
  db.exec("DELETE FROM recipe_embeddings WHERE id = (SELECT MIN(id) FROM recipe_embeddings)");
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("Do not query an incomplete index"); };
  const partial = await search.searchRecipeCatalog({ query: "Test rice 1" }, "nomic-embed-text");
  assert.equal(partial.method, "lexical_pantry"); assert.equal(calls, 0);
  assert.deepEqual(partial.recipes.map((recipe) => recipe.id), mismatch.recipes.map((recipe) => recipe.id));
  assert.deepEqual(chefSchema.parseChefRequest({ query: "Dinner" }).candidates, []);
});

test("canonical URLs reject unsafe targets and preserve Unicode recipe identity", () => {
  assert.equal(importer.canonicalRecipeUrl("https://en.wikibooks.org/wiki/Cookbook:Cr%C3%A8me_br%C3%BBl%C3%A9e#Notes"), "https://en.wikibooks.org/wiki/Cookbook:Cr%C3%A8me_br%C3%BBl%C3%A9e");
  assert.equal(importer.canonicalRecipeUrl("https://en.wikibooks.org/wiki/Cookbook:Bob's_(Rice)"), "https://en.wikibooks.org/wiki/Cookbook:Bob%27s_%28Rice%29");
  for (const url of ["http://en.wikibooks.org/wiki/Cookbook:Foo", "https://evil.example/wiki/Cookbook:Foo", "https://en.wikibooks.org/wiki/Special:Foo", "https://en.wikibooks.org/wiki/Cookbook:Foo?x=1"]) assert.throws(() => importer.canonicalRecipeUrl(url));
});

async function metadataReview(overrides = {}) {
  const item = (await store.listCatalogRecipes(1000))[0];
  const evidence = { basis: "curator_assessment", evidence: "Reviewed the complete ingredient list and source directions; unknowns remain explicit." };
  return { recipeId: item.recipe.id, reviewed: true, metadata: {
    revision: 1, sourceContentHash: item.contentHash, coreDinner: true, dinnerRole: "main",
    diets: { vegan: "fits", vegetarian: "fits", gluten_free: "fits", low_carb: "unknown" },
    totalMinutes: null, equipment: ["Stovetop"],
    provenance: Object.fromEntries(["coreDinner", "dinnerRole", "diets.vegan", "diets.vegetarian", "diets.gluten_free", "diets.low_carb", "totalMinutes", "equipment", "servings", "ingredients"].map((key) => [key, { ...evidence }])),
    reviewedBy: "test reviewer", reviewedAt: "2026-10-22T00:00:00.000Z", ...overrides,
  } };
}
function metadataRequest(entries, extra = {}) {
  return new Request("http://localhost:3000/api/admin/recipes/metadata", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries, ...extra }) });
}

test("metadata preview is read-only; imports are idempotent, hash-bound, and preserve recipes, embeddings and saved meals", async () => {
  await importOne(await draft());
  const rawBefore = JSON.stringify(db.prepare("SELECT * FROM recipes").all());
  const embeddingsBefore = JSON.stringify(db.prepare("SELECT * FROM recipe_embeddings").all());
  const source = (await store.listCatalogRecipes())[0].recipe;
  const planned = state.createPlannedMeal("2026-10-22", source);
  const plannedBefore = JSON.stringify(planned);
  const entry = await metadataReview();
  const preview = await metadataRoute.POST(metadataRequest([entry], { preview: true }));
  assert.equal(preview.status, 200); assert.equal(db.prepare("SELECT COUNT(*) n FROM recipe_metadata").get().n, 0);
  assert.equal((await metadataRoute.POST(metadataRequest([entry]))).status, 200);
  const catalog = await (await catalogRoute.GET()).json();
  assert.equal(catalog.metadataByRecipeId[source.id].coreDinner, true);
  const repeated = await (await metadataRoute.POST(metadataRequest([entry]))).json();
  assert.equal(repeated.results[0].changed, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM recipe_metadata").get().n, 1);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM recipes").all()), rawBefore);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM recipe_embeddings").all()), embeddingsBefore);
  assert.equal(JSON.stringify(planned), plannedBefore);
  await importOne(await draft(0, { servings: 8 }));
  assert.equal((await store.listCatalogRecipes())[0].metadata, undefined);
  assert.equal((await metadataRoute.POST(metadataRequest([entry]))).status, 400);
});

test("metadata validates all reviews before writes and enforces field provenance and admin boundaries", async () => {
  await importOne(await draft());
  const entry = await metadataReview();
  for (const bad of [
    { ...entry, reviewed: false },
    { ...entry, metadata: { ...entry.metadata, equipment: ["knife"] } },
    { ...entry, metadata: { ...entry.metadata, diets: { ...entry.metadata.diets, low_carb: "fits?" } } },
    { ...entry, metadata: { ...entry.metadata, provenance: {} } },
    { ...entry, metadata: { ...entry.metadata, provenance: { ...entry.metadata.provenance, totalMinutes: { basis: "source", evidence: "Invented total time 7 minutes." } } } },
  ]) assert.equal((await metadataRoute.POST(metadataRequest([bad]))).status, 400);
  assert.equal((await metadataRoute.POST(metadataRequest([entry, { ...entry, recipeId: "unknown" }]))).status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM recipe_metadata").get().n, 0);
  assert.equal((await metadataRoute.POST(new Request("http://localhost:3000/api/admin/recipes/metadata", { method: "POST", headers: { origin: "https://other.example", "content-type": "application/json" }, body: JSON.stringify({ entries: [entry] }) }))).status, 403);
  const exported = await (await metadataRoute.GET(new Request("http://localhost:3000/api/admin/recipes/metadata"))).json();
  assert.equal(exported.entries[0].contentHash, entry.metadata.sourceContentHash);
});

test("equipment omission survives Chef parsing and query normalization; explicit none remains restrictive", async () => {
  await importOne(await draft());
  const entry = await metadataReview();
  await metadataRoute.POST(metadataRequest([entry]));
  const omitted = chefSchema.parseChefRequest({ query: "Suggest dinner", profile: { diet: "Vegan" } }).profile;
  assert.equal(omitted.equipmentSpecified, false);
  const unspecified = search.constraintsForRecipeQuery("Suggest dinner", constraintRules.normalizeConstraints(omitted));
  assert.equal(unspecified.equipmentSpecified, false);
  assert.equal((await search.searchRecipeCatalog({ query: "Suggest dinner", constraints: unspecified }, "nomic-embed-text")).recipes.length, 1);
  const explicit = chefSchema.parseChefRequest({ query: "Suggest dinner", profile: { equipment: [] } }).profile;
  assert.equal(explicit.equipmentSpecified, true);
  const result = await search.searchRecipeCatalog({ query: "Suggest dinner", constraints: constraintRules.normalizeConstraints(explicit) }, "nomic-embed-text");
  assert.equal(result.outcome, "constraints_unsatisfied"); assert.deepEqual(result.recipes, []);
  const request = (suffix = "") => new Request(`http://localhost:3000/api/recipes?q=Suggest%20dinner${suffix}`);
  assert.equal((await (await searchRoute.GET(request())).json()).recipes.length, 1, "Omitted GET equipment is unspecified");
  const none = await (await searchRoute.GET(request("&equipment="))).json();
  assert.equal(none.outcome, "constraints_unsatisfied"); assert.deepEqual(none.recipes, []);
  assert.equal((await (await searchRoute.GET(request("&equipment=Stovetop"))).json()).recipes.length, 1);
});

test("the curated manifest has exactly 30 reviewed main dinners, source attribution and explicit unknowns", async () => {
  const manifest = JSON.parse(await readFile(new URL("../tools/recipes/core-dinners.v1.json", import.meta.url), "utf8"));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.coreDinnerCount, 30); assert.equal(manifest.entries.length, 30);
  assert.equal(new Set(manifest.entries.map((x) => x.recipeId)).size, 30);
  for (const entry of manifest.entries) {
    assert.equal(entry.reviewed, true);
    const metadata = store.validateRecipeMetadata(entry.metadata);
    assert.equal(metadata.coreDinner, true); assert.equal(metadata.dinnerRole, "main");
    assert.equal(metadata.totalMinutes, null, "Step durations must not be promoted to total times");
    assert.equal(metadata.diets.low_carb, "unknown", "No guessed macro threshold");
    assert.equal(metadata.provenance.servings.basis, "source");
    assert.match(entry.sourceUrl, /^https:\/\/en\.wikibooks\.org\/wiki\/Cookbook:/);
    assert.equal(entry.source.licenseId, "CC-BY-SA-4.0"); assert.ok(entry.source.attributionText);
  }
});
