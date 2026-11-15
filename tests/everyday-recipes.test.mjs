import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const loader = await createSourceLoader({ name: "everyday-recipes" });
after(() => loader.dispose());
const { createEverydayRecipes } = await loader.import("app/lib/everyday-recipes.ts");
const { validateRecipeSnapshot } = await loader.import("app/lib/kitchen-validation.ts");
const { recipeCompleteness } = await loader.import("app/lib/recipe-browser.ts");
const { canonicalIngredient } = await loader.import("app/lib/quantities.ts");
const { findPantryDinners } = await loader.import("app/lib/pantry-dinner.ts");
const { normalizeConstraints } = await loader.import("app/lib/recipe-constraints.ts");
const common = {
  source: { name: "Original recipe test source", url: "https://example.test/source", licenseId: "MIT" },
  sourceUrl: "https://example.test/everyday-recipes",
};
const recipes = createEverydayRecipes(common);
const today = "2026-11-15";
const pantry = names => names.map((name, index) => ({ id: `stock-${index}`, name, measure: "" }));

test("everyday dinners can be saved and portioned with complete numeric ingredient amounts", () => {
  assert.equal(recipes.length, 8);
  assert.equal(new Set(recipes.map(recipe => recipe.id)).size, recipes.length);
  for (const recipe of recipes) {
    assert.doesNotThrow(() => validateRecipeSnapshot(recipe), recipe.title);
    assert.equal(recipe.servings, 2, recipe.title);
    assert.deepEqual(recipeCompleteness(recipe), { knownServings: true, amountReviewCount: 0 }, recipe.title);
    assert.ok(recipe.instructions.length >= 4, recipe.title);
  }
});

test("fresh rice, pasta, chicken, eggs and potatoes lead to concrete everyday dinners", () => {
  const cases = [
    [["pasta", "mushrooms"], "everyday-creamy-mushroom-pasta"],
    [["chicken breast", "potatoes"], "everyday-chicken-potato-tray-bake"],
    [["chicken breast", "rice"], "everyday-chicken-pepper-rice"],
    [["rice", "eggs"], "everyday-egg-fried-rice"],
    [["potatoes", "eggs"], "everyday-potato-onion-frittata"],
    [["pasta", "canned tuna, drained"], "everyday-tuna-tomato-pasta"],
    [["eggs", "bread"], "everyday-tomato-eggs-toast"],
  ];
  for (const [names, expected] of cases) {
    const result = findPantryDinners(recipes, names.map(canonicalIngredient), pantry(names), today);
    assert.ok(result.matches.some(match => match.recipe.id === expected), `${names.join(" + ")} should find ${expected}`);
  }
  assert.equal(findPantryDinners(recipes, ["cooked rice"], pantry(["cooked rice"]), today).matches.length, 0,
    "the collection must not silently treat cooked rice as the uncooked rice its methods require");
});

test("everyday suggestions retain ingredient exclusions instead of treating familiar meals as universally suitable", () => {
  const stock = pantry(["pasta", "eggs", "rice"]);
  const withoutDairy = findPantryDinners(recipes, ["pasta"], stock, today, {}, normalizeConstraints({ allergies: ["milk"] }));
  assert.ok(!withoutDairy.matches.some(match => match.recipe.id === "everyday-creamy-mushroom-pasta"));
  const withoutSoy = findPantryDinners(recipes, ["rice"], stock, today, {}, normalizeConstraints({ allergies: ["soy"] }));
  assert.ok(!withoutSoy.matches.some(match => match.recipe.id === "everyday-egg-fried-rice"));
  const withoutFish = findPantryDinners(recipes, ["pasta"], stock, today, {}, normalizeConstraints({ allergies: ["fish"] }));
  assert.ok(!withoutFish.matches.some(match => match.recipe.id === "everyday-tuna-tomato-pasta"));
});

test("original recipe notes disclose the absence of cooking trials and preserve supplied attribution", () => {
  const original = structuredClone(common);
  for (const recipe of recipes) {
    assert.deepEqual(recipe.source, common.source);
    assert.equal(recipe.sourceUrl, common.sourceUrl);
    assert.match(recipe.sourceNotes[0], /^About this dish: .+/);
    assert.ok(recipe.sourceNotes.some(note => /Not kitchen-tested; total time has not been measured/.test(note)), recipe.title);
  }
  assert.deepEqual(common, original);
});

test("chicken and egg methods include explicit doneness checks with primary-source temperature guidance", () => {
  for (const recipe of recipes) {
    const names = recipe.ingredients.map(ingredient => canonicalIngredient(ingredient.name));
    if (!names.includes("chicken breast") && !names.includes("egg")) continue;
    const method = recipe.instructions.join(" ");
    assert.ok(recipe.sourceNotes.some(note => note.includes("https://www.foodsafety.gov/food-safety-charts/safe-minimum-internal-temperatures")), recipe.title);
    if (names.includes("chicken breast")) assert.match(method, /74°C \(165°F\).*food thermometer/, recipe.title);
    if (names.includes("egg")) assert.match(method, /71°C \(160°F\)|both the egg whites and yolks are firm/, recipe.title);
  }
});
