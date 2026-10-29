import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const directory = await mkdtemp(join(tmpdir(), "jff-kitchen-state-"));
after(() => rm(directory, { recursive: true, force: true }));
for (const name of ["kitchen-state", "kitchen-types", "quantities"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"');
  await writeFile(join(directory, `${name}.mjs`), compiled);
}
const { addDateDays, weekStart, createPlannedMeal, migrateLegacyKitchen, dinnerSelectionStatus, placePlannedDinner } = await import(pathToFileURL(join(directory, "kitchen-state.mjs")).href);

const recipe = { id: "themealdb:123", title: "Test dinner", image: null, category: "", cuisine: "", ingredients: [{ name: "Rice", measure: "400 g" }], instructions: ["Cook rice."], tags: [], source: { name: "Test", url: "https://example.com" }, sourceUrl: "https://example.com" };

test("placing a dinner requires the current identity and protects cooked or locked days", () => {
  const date = "2026-10-20";
  const original = { schemaVersion: 2, pantry: [{ id: "rice", name: "rice", measure: "1 kg" }], meals: {}, shoppingChecked: { checked: true }, migratedLegacy: true };
  const added = placePlannedDinner(original, date, recipe, null);
  assert.equal(original.meals[date], undefined);
  assert.equal(added.meals[date].recipeId, recipe.id);
  assert.equal(added.pantry, original.pantry);
  assert.equal(added.shoppingChecked, original.shoppingChecked);
  assert.equal(placePlannedDinner(added, date, recipe, null), added, "a newly occupied day is not silently replaced");
  assert.equal(dinnerSelectionStatus(added.meals, date, null), "changed");
  const expected = added.meals[date].id;
  const replacement = placePlannedDinner(added, date, { ...recipe, title: "Replacement" }, expected);
  assert.equal(replacement.meals[date].title, "Replacement");
  assert.equal(added.meals[date].title, recipe.title);
  assert.equal(placePlannedDinner(replacement, date, recipe, expected), replacement);
  for (const patch of [{ locked: true }, { status: "cooked" }]) {
    const protectedState = { ...added, meals: { [date]: { ...added.meals[date], ...patch } } };
    assert.equal(dinnerSelectionStatus(protectedState.meals, date, expected), "protected");
    assert.equal(placePlannedDinner(protectedState, date, recipe, expected), protectedState);
  }
});

test("copied dinners retain amounts but get independent planned snapshots", () => {
  const template = createPlannedMeal("2026-10-19", recipe);
  template.ingredientOverrides = { "0": "700 g" };
  template.locked = true;
  template.completion = { id: "done", at: "today", deductions: [] };
  const state = { schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true };
  const copy = placePlannedDinner(state, "2026-10-20", recipe, null, template).meals["2026-10-20"];
  assert.equal(copy.ingredientOverrides["0"], "700 g");
  assert.notEqual(copy.id, template.id);
  assert.equal(copy.locked, false);
  assert.equal(copy.status, "planned");
  assert.equal(copy.completion, undefined);
  copy.recipe.ingredients[0].measure = "1 g";
  assert.equal(template.recipe.ingredients[0].measure, "400 g");
});

test("dated weeks cross month and year boundaries without UTC date shifts", () => {
  assert.equal(weekStart("2026-10-25"), "2026-10-19");
  assert.equal(weekStart("2026-10-26"), "2026-10-26");
  assert.equal(addDateDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDateDays("2028-02-28", 1), "2028-02-29");
});

test("migration retains every saved date, including an unavailable legacy recipe", () => {
  const state = migrateLegacyKitchen({ pantry: ["rice"], plan: { Mon: "123", Wed: "missing" }, shoppingDone: { rice: true } }, [recipe], "2026-10-19");
  assert.equal(state.meals["2026-10-19"].recipeId, "themealdb:123");
  assert.equal(state.meals["2026-10-21"].recipeId, "missing");
  assert.equal(state.meals["2026-10-21"].recipe, null);
  assert.equal(state.pantry[0].measure, "");
  assert.deepEqual(state.shoppingChecked, {});
  assert.equal(state.migratedLegacy, true);
});

test("planned recipes are independent snapshots, including ingredients", () => {
  const original = structuredClone(recipe);
  const meal = createPlannedMeal("2026-10-20", original);
  original.ingredients[0].measure = "900 g";
  original.title = "Different result";
  assert.equal(meal.recipe.ingredients[0].measure, "400 g");
  assert.equal(meal.title, "Test dinner");
  const reloaded = JSON.parse(JSON.stringify({ meals: { [meal.date]: meal } }));
  assert.equal(reloaded.meals[meal.date].recipe.title, "Test dinner");
});

test("servings are taken only from an explicitly supplied recipe yield", () => {
  const unknown = createPlannedMeal("2026-10-20", recipe);
  assert.equal(unknown.baseServings, null);
  assert.equal(unknown.servings, null);
  assert.equal(unknown.batches, 1);
  const known = createPlannedMeal("2026-10-20", { ...recipe, servings: 4 });
  assert.equal(known.baseServings, 4);
  assert.equal(known.servings, 4);
});

test("new planning ingredients keep source wording; legacy migration does not change calculations", () => {
  const source = { ...recipe, ingredients: [{ name: "200 g flour", measure: "" }] };
  const meal = createPlannedMeal("2026-10-20", source);
  assert.deepEqual(meal.planningIngredients, [{ name: "flour", measure: "200 g" }]);
  assert.deepEqual(meal.recipe.ingredients, source.ingredients);
  const legacy = migrateLegacyKitchen({ plan: { Mon: "123" } }, [source], "2026-10-19");
  assert.equal(legacy.meals["2026-10-19"].planningIngredients, undefined);
});
