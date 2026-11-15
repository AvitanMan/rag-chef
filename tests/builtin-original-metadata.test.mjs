import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";
import { createSqliteD1 } from "./helpers/sqlite-d1.mjs";

const loader = await createSourceLoader({ name: "builtin-original-metadata", externals: { "cloudflare:workers": "export const env = {};" } });
const sql = await createSqliteD1();
const { env } = await loader.import("cloudflare:workers"); env.DB = sql.binding;
const household = await loader.import("app/lib/household.ts"); household.configureHouseholdRuntime(env);
const store = await loader.import("app/lib/recipe-store.ts");
const { DEMO_RECIPES, DEMO_SOURCE } = await loader.import("app/lib/demo-recipes.ts");
const { builtinOriginalMetadata } = await loader.import("app/lib/builtin-original-metadata.ts");
const { buildRecipeSearchText, sha256Hex } = await loader.import("app/lib/recipe-embeddings.ts");
const { evaluateRecipeConstraints, normalizeConstraints } = await loader.import("app/lib/recipe-constraints.ts");
const catalogRecipe = original => ({ ...original, id: `${DEMO_SOURCE.id}:${original.id}`, source: {
  name: DEMO_SOURCE.name, url: DEMO_SOURCE.url, licenseId: DEMO_SOURCE.licenseId,
  licenseUrl: DEMO_SOURCE.licenseUrl, attributionText: DEMO_SOURCE.attributionText,
} });
async function save(recipe) {
  const searchText = buildRecipeSearchText(recipe);
  return store.upsertCatalogRecipe({ sourceId: DEMO_SOURCE.id, recipe, searchText, contentHash: await sha256Hex(searchText) });
}
beforeEach(async () => {
  sql.db.exec("DELETE FROM recipes; DELETE FROM recipe_sources;");
  await store.upsertApprovedRecipeSource(DEMO_SOURCE);
});
after(async () => { sql.close(); await loader.dispose(); });

test("original metadata requires an exact catalog snapshot and valid content identity", () => {
  const original = DEMO_RECIPES.find(recipe => recipe.id === "everyday-chicken-potato-tray-bake");
  const recipe = catalogRecipe(original), hash = "a".repeat(64);
  const result = builtinOriginalMetadata(recipe, hash);
  assert.deepEqual(result.equipment, ["oven"]);
  assert.equal(result.sourceContentHash, hash);
  assert.doesNotThrow(() => store.validateRecipeMetadata(result));
  assert.equal(result.coreDinner, false);
  assert.equal(result.totalMinutes, null);
  assert.ok(Object.values(result.diets).every(value => value === "unknown"));
  assert.equal(builtinOriginalMetadata(recipe, "unknown"), undefined);
  for (const changed of [
    { ...recipe, id: original.id }, { ...recipe, sourceUrl: "https://example.test/recipe" },
    { ...recipe, ingredients: recipe.ingredients.slice(1) }, { ...recipe, instructions: ["Use a microwave."] },
    { ...recipe, sourceNotes: [] }, { ...recipe, source: { ...recipe.source, name: "Another source" } },
  ]) assert.equal(builtinOriginalMetadata(changed, hash), undefined);
});

test("catalog reads supply original appliance facts without creating review records or modifying recipes", async () => {
  for (const recipe of DEMO_RECIPES) await save(recipe);
  const before = sql.db.prepare("SELECT * FROM recipes ORDER BY id").all();
  const stored = await store.listCatalogRecipes();
  assert.equal(stored.length, DEMO_RECIPES.length);
  for (const item of stored) {
    assert.ok(item.metadata, item.recipe.title);
    assert.equal(item.metadata.sourceContentHash, item.contentHash);
    assert.equal(item.metadata.coreDinner, false);
    assert.doesNotThrow(() => store.validateRecipeMetadata(item.metadata));
    const oven = item.recipe.id.endsWith("everyday-chicken-potato-tray-bake");
    assert.deepEqual(item.metadata.equipment, oven ? ["oven"] : ["stovetop"]);
    const stovetopOnly = evaluateRecipeConstraints(item.recipe, item.metadata, normalizeConstraints({ equipment: ["Stovetop"] }));
    assert.equal(stovetopOnly.eligible, !oven, item.recipe.title);
    const noOven = evaluateRecipeConstraints(item.recipe, item.metadata, normalizeConstraints({ excludedEquipment: ["oven"] }));
    assert.equal(noOven.eligible, !oven, item.recipe.title);
  }
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM recipe_metadata").get().n, 0);
  assert.deepEqual(sql.db.prepare("SELECT * FROM recipes ORDER BY id").all(), before);
});

test("stored reviews override original facts and edited original text loses fallback metadata", async () => {
  const original = DEMO_RECIPES.find(recipe => recipe.id === "everyday-chicken-potato-tray-bake");
  await save(original);
  const item = (await store.listCatalogRecipes())[0];
  const review = { ...item.metadata, dinnerRole: "side", equipment: ["oven", "stovetop"], reviewedBy: "Explicit test review" };
  await store.reviewRecipeMetadata([{ recipeId: item.recipe.id, reviewed: true, metadata: review }]);
  assert.deepEqual((await store.listCatalogRecipes())[0].metadata, review);
  await save({ ...original, instructions: [...original.instructions, "Finish in a different appliance."] });
  assert.equal((await store.listCatalogRecipes())[0].metadata, undefined);
});
