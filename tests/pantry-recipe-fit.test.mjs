import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const loader = await createSourceLoader({ name: "pantry-recipe-fit" });
after(() => loader.dispose());
const { pantryRecipeFit, comparePantryRecipeFit, isBasicSeasoning } = await loader.import("app/lib/pantry-recipe-fit.ts");
const recipe = names => ({ ingredients: names.map(name => ({ name, measure: "" })) });

test("the shared basic seasoning rule normalizes exact names without inventing food substitutions", () => {
  for (const name of ["salt", "BLACK PEPPER", "  olive oil  ", "1 tsp salt", "water", "vegetable oil"]) {
    assert.equal(isBasicSeasoning(name), true, name);
  }
  for (const name of ["pepper", "bell pepper", "butter", "chicken stock", "soy sauce", "sesame oil", "fresh thyme", "rice"]) {
    assert.equal(isBasicSeasoning(name), false, name);
  }
});

test("pantry fit lists missing food and seasonings without assuming staples are owned", () => {
  const fit = pantryRecipeFit(recipe(["rice", "egg", "onion", "salt", "black pepper", "olive oil", "water"]), ["rice", "eggs", "salt"]);
  assert.deepEqual(fit, {
    matched: ["rice", "egg", "salt"], missing: ["onion", "black pepper", "olive oil", "water"],
    matchedFood: ["rice", "egg"], missingFood: ["onion"],
    matchedSeasonings: ["salt"], missingSeasonings: ["black pepper", "olive oil", "water"],
    inFreezer: [],
    total: 7, coverage: 3 / 7, foodTotal: 3, foodCoverage: 2 / 3,
  });
});

test("freezer matches are separate display evidence and never improve automatic coverage or ranking", () => {
  const dinner = recipe(["200 g rice", "chicken", "salt", "cooked rice"]);
  const ordinary = pantryRecipeFit(dinner, ["rice"]);
  const frozen = pantryRecipeFit(dinner, ["rice"], ["raw rice", "chicken", "salt", "chicken"]);
  assert.deepEqual(frozen.inFreezer, ["chicken", "salt"]);
  assert.deepEqual(frozen.matchedFood, ["200 g rice"]);
  assert.deepEqual(frozen.missingFood, ["chicken", "cooked rice"]);
  assert.equal(frozen.coverage, ordinary.coverage);
  assert.equal(frozen.foodCoverage, ordinary.foodCoverage);
  assert.equal(comparePantryRecipeFit(frozen, ordinary), 0);
  assert.deepEqual(pantryRecipeFit(dinner, ["rice", "chicken"], ["chicken", "salt"]).inFreezer, ["salt"],
    "explicitly admitted freezer names appear in Have, not also In freezer");
});

test("recipe cards display unselected frozen ingredients once and do not call them available or shopping shortages", async () => {
  const { RecipeCard } = await loader.import("app/components/RagChefApp.tsx");
  const dinner = { ...recipe(["rice", "chicken", "salt", "onion"]), id: "freezer-display", title: "Rice dinner",
    image: null, category: "Dinner", cuisine: "", sourceUrl: "https://example.test/recipe",
    source: { name: "Test", url: "https://example.test/recipe" }, instructions: ["Cook following the directions."], tags: [] };
  const html = renderToStaticMarkup(createElement(RecipeCard, { recipe: dinner,
    details: { matched: [], missing: [], total: 4, coverage: 0 },
    pantryFit: pantryRecipeFit(dinner, ["rice"], ["chicken", "salt"]), featured: false, open() {} }));
  assert.match(html, /<strong>Have:<\/strong> rice/);
  assert.match(html, /<strong>Missing:<\/strong> onion/);
  assert.match(html, /<strong>In freezer:<\/strong> chicken, salt/);
  assert.doesNotMatch(html, /<strong>Also check:/);
  assert.doesNotMatch(html, /<strong>Missing:<\/strong>[^<]*chicken|<strong>Have:<\/strong>[^<]*chicken|thawed|ready to cook/i);
});

test("a high seasoning overlap cannot outrank a dinner needing fewer food ingredients", () => {
  const pantry = ["rice", "eggs", "soy sauce", "salt", "olive oil"];
  const eggRice = pantryRecipeFit(recipe(["rice", "egg", "soy sauce", "onion", "black pepper"]), pantry);
  const chickenRice = pantryRecipeFit(recipe(["rice", "chicken", "cream", "soy sauce", "salt", "olive oil"]), pantry);
  assert.ok(chickenRice.coverage > eggRice.coverage, "The raw percentage would prefer missing chicken and cream");
  assert.ok(comparePantryRecipeFit(eggRice, chickenRice) < 0);
  assert.ok(comparePantryRecipeFit(chickenRice, eggRice) > 0);
});

test("using a saved food ingredient beats an unrelated meal even when it needs more additions", () => {
  const mushroomPasta = recipe(["pasta", "mushrooms", "garlic", "butter", "heavy cream", "Parmesan cheese"]);
  const frittata = recipe(["egg", "potatoes", "onion"]);
  const pastaFit = pantryRecipeFit(mushroomPasta, ["pasta"]);
  const unrelatedFit = pantryRecipeFit(frittata, ["pasta"]);
  assert.ok(pastaFit.missingFood.length > unrelatedFit.missingFood.length);
  assert.ok(comparePantryRecipeFit(pastaFit, unrelatedFit) < 0);
  assert.ok(comparePantryRecipeFit(unrelatedFit, pastaFit) > 0);
  assert.ok(comparePantryRecipeFit(pantryRecipeFit(frittata, []), pantryRecipeFit(mushroomPasta, [])) < 0,
    "an empty pantry still orders by missing food counts without inventing overlap");
});

test("equal missing food counts prefer food coverage, then complete name coverage", () => {
  const pantry = ["rice", "eggs", "tomato", "salt"];
  const moreFood = pantryRecipeFit(recipe(["rice", "egg", "tomato", "onion", "water", "olive oil"]), pantry);
  const lessFood = pantryRecipeFit(recipe(["rice", "onion", "salt"]), pantry);
  assert.ok(comparePantryRecipeFit(moreFood, lessFood) < 0);
  const missingSalt = pantryRecipeFit(recipe(["rice", "onion", "black pepper"]), pantry);
  assert.ok(comparePantryRecipeFit(lessFood, missingSalt) < 0);
  assert.equal(comparePantryRecipeFit(lessFood, lessFood), 0);
});

test("repeated and measured aliases do not inflate fit or duplicate missing names", () => {
  const fit = pantryRecipeFit(recipe(["200 g rice", "uncooked rice", "tomatoes", "tomato", "salt", "salt"]), ["rice", "rice"]);
  assert.deepEqual(fit.matched, ["200 g rice"]);
  assert.deepEqual(fit.missing, ["tomatoes", "salt"]);
  assert.deepEqual(fit.missingFood, ["tomatoes"]);
  assert.equal(fit.total, 3);
  assert.equal(fit.coverage, 1 / 3);
  assert.equal(fit.foodCoverage, 1 / 2);
});

test("ingredient identities and seasoning classification stay conservative", () => {
  const fit = pantryRecipeFit(recipe(["cooked rice", "rice vinegar", "red onion", "pepper", "butter", "chicken stock", "sesame oil", "olive oil"]),
    ["rice", "onion", "black pepper", "vegetable oil"]);
  assert.deepEqual(fit.matched, []);
  assert.deepEqual(fit.missingFood, ["cooked rice", "rice vinegar", "red onion", "pepper", "butter", "chicken stock", "sesame oil"]);
  assert.deepEqual(fit.missingSeasonings, ["olive oil"]);
});

test("seasoning-only and empty recipes have neutral food coverage and cannot outrank food", () => {
  const seasonings = pantryRecipeFit(recipe(["salt", "water"]), ["salt", "water"]);
  const empty = pantryRecipeFit(recipe([]), ["salt"]);
  const food = pantryRecipeFit(recipe(["egg", "onion"]), ["egg"]);
  assert.equal(seasonings.foodCoverage, 0);
  assert.equal(empty.foodCoverage, 0);
  assert.equal(empty.coverage, 0);
  assert.ok(comparePantryRecipeFit(food, seasonings) < 0);
  assert.ok(comparePantryRecipeFit(food, empty) < 0);
  assert.equal(pantryRecipeFit(recipe(["rice", "salt"]), []).foodCoverage, 0);
});

test("fit is pure and name-based even with known recipe amounts", () => {
  const dinner = { ingredients: [{ name: "rice", measure: "2 kg" }, { name: "salt", measure: "1 tsp" }] };
  const pantry = ["rice"];
  const before = structuredClone({ dinner, pantry });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Pantry fit must not call a provider"); };
  try {
    assert.deepEqual(pantryRecipeFit(dinner, pantry).matchedFood, ["rice"]);
    assert.deepEqual({ dinner, pantry }, before);
  } finally { globalThis.fetch = originalFetch; }
});
