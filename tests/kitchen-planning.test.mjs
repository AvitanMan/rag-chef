import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const dir = await mkdtemp(join(tmpdir(), "jff-kitchen-planning-"));
after(() => rm(dir, { recursive: true, force: true }));
for (const name of ["kitchen-types", "kitchen-state", "quantities", "kitchen-stock", "kitchen-validation", "kitchen-backup", "kitchen-planning", "recipe-browser"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"');
  await writeFile(join(dir, `${name}.mjs`), code);
}
const load = (name) => import(pathToFileURL(join(dir, `${name}.mjs`)).href);
const { allocateMealStock, allocateStockForMeals, buildShoppingList, consumptionPreview, completeMeal, undoMeal, resolvedMealIngredients, mealReadiness } = await load("quantities");
const { recipePantryDetails } = await load("recipe-browser");
const { createPlannedMeal } = await load("kitchen-state");
const { fillEmptyDays, planningRandom } = await load("kitchen-planning");
const { availablePantryNames } = await load("kitchen-stock");
const { validateKitchenState } = await load("kitchen-validation");
const { parseKitchenBackup, serializeKitchenBackup } = await load("kitchen-backup");

const recipe = (id, ingredients = [{ name: "rice", measure: "400 g" }]) => ({ id, title: `Dinner ${id}`, servings: 2, ingredients, instructions: ["Follow the original source instructions."], tags: [], image: null, category: "Dinner", cuisine: "Home cooking", source: { name: "Test", url: "https://example.com/recipe" }, sourceUrl: "https://example.com/recipe" });
const meal = (date = "2026-10-22", value = recipe("rice")) => createPlannedMeal(date, value);
const stock = (id, name, measure, useBy) => ({ id, name, measure, ...(useBy ? { useBy } : {}) });
const kitchen = (pantry = [], meals = {}) => ({ schemaVersion: 2, pantry, meals, shoppingChecked: {}, migratedLegacy: true });

test("source descriptions use the same pantry coverage, shopping and completion identity", () => {
  const source = recipe("pasta-bake", [{ name: "any small pasta", measure: "400 g" }, { name: "medium zucchini, grated", measure: "3" }, { name: "cheese, grated", measure: "250 g" }]);
  const original = structuredClone(source);
  const dinner = meal("2026-10-26", source);
  const pantry = [stock("pasta", "pasta", "500 g"), stock("zucchini", "zucchini", "3"), stock("cheese", "cheese", "500 g"), stock("cooked", "cooked pasta", "200 g")];
  assert.equal(recipePantryDetails(source, pantry.map(row => row.name)).coverage, 1);
  assert.equal(mealReadiness(dinner, pantry, dinner.date).coveredCount, 3);
  assert.deepEqual(buildShoppingList([dinner], pantry, dinner.date), []);
  const before = kitchen(pantry, { [dinner.date]: dinner });
  const cooked = completeMeal(before, dinner.date, true, "2026-10-26T12:00:00Z");
  assert.deepEqual(cooked.pantry.map(row => row.measure), ["100 g", "0", "250 g", "200 g"]);
  assert.deepEqual(undoMeal(cooked, dinner.date).pantry, pantry);
  assert.deepEqual(source, original, "attributed source wording stays unchanged");
});

test("optional pantry and deduction dates round-trip while old kitchens remain unchanged", () => {
  const original = kitchen([stock("old", "rice", "1 kg")]);
  const before = structuredClone(original);
  validateKitchenState(original);
  assert.deepEqual(original, before);
  const dated = kitchen([stock("dated", "rice", "1 kg", "2028-02-29")]);
  assert.deepEqual(parseKitchenBackup(serializeKitchenBackup(dated)).state, dated);
  for (const useBy of ["2026-02-29", "2026-13-01", "", null, "tomorrow"]) {
    const invalid = kitchen([{ ...stock("invalid", "rice", "1 kg"), useBy }]);
    assert.throws(() => validateKitchenState(invalid), /useBy/);
  }
});

test("availability dates are inclusive and never count known zero or past stock", () => {
  const pantry = [stock("today", "rice", "2 kg", "2026-10-22"), stock("past", "beans", "2 kg", "2026-10-21"), stock("zero", "pasta", "0 g"), stock("unknown", "garlic", "some")];
  assert.deepEqual(availablePantryNames(pantry, "2026-10-22"), ["rice", "garlic"]);
  assert.deepEqual(availablePantryNames(pantry, "2026-10-23"), ["garlic"]);
});

test("one virtual inventory respects meal dates and shopping agrees with consumption", () => {
  const first = meal(), second = meal("2026-10-23");
  const pantry = [stock("early", "rice", "500 g", "2026-10-22"), stock("undated", "rice", "200 g")];
  const before = structuredClone({ first, second, pantry });
  const allocation = allocateStockForMeals([second, first], pantry, "2026-10-22");
  assert.equal(allocation.allocations[0].deductions[0].pantryId, "early");
  assert.equal(allocation.pantry.find((item) => item.id === "early").measure, "100 g");
  assert.equal(allocation.pantry.find((item) => item.id === "undated").measure, "0 g");
  assert.equal(allocation.allocations[1].coverage, 0.5);
  assert.ok(allocation.allocations[1].notes.some((note) => note.includes("past its entered use-by date")));
  const [shopping] = buildShoppingList([first, second], pantry, "2026-10-22");
  assert.equal(shopping.requiredMeasure, "800 g");
  assert.equal(shopping.pantryMeasure, "600 g");
  assert.equal(shopping.measure, "200 g");
  assert.ok(shopping.notes.some((note) => note.includes("excluded")));
  assert.deepEqual(completeMeal(kitchen(pantry, { [first.date]: first }), first.date, true, "2026-10-22T12:00:00.000Z").pantry, allocation.allocations[0].pantry);
  assert.deepEqual({ first, second, pantry }, before);
});

test("unknown and incompatible amounts cannot create quantified coverage or deductions", () => {
  const value = meal();
  const result = allocateMealStock(value, [stock("unknown", "rice", "some"), stock("cups", "rice", "2 cups"), stock("zero", "rice", "0 g")]);
  assert.equal(result.coverage, 0);
  assert.equal(result.useSoonCoverage, 0);
  assert.deepEqual(result.deductions, []);
  assert.equal(buildShoppingList([value], result.pantry)[0].needsReview, true);
});

test("historical unfinished dinners cannot make past-dated stock available again", () => {
  const dinner = meal("2030-01-10");
  const pantry = [stock("past", "rice", "400 g", "2030-01-10")];
  const today = "2030-01-12";
  assert.equal(allocateMealStock(dinner, pantry, today).coverage, 0);
  assert.deepEqual(allocateStockForMeals([dinner], pantry, today).allocations[0].deductions, []);
  const [shopping] = buildShoppingList([dinner], pantry, today);
  assert.equal(shopping.measure, "400 g");
  assert.equal(shopping.pantryMeasure, "0 g");
  assert.ok(shopping.notes.some((note) => note.includes("excluded")));
  assert.deepEqual(consumptionPreview(dinner, pantry, today).deductions, []);
  const state = kitchen(pantry, { [dinner.date]: dinner });
  const cooked = completeMeal(state, dinner.date, true, "2030-01-12T12:00:00.000Z");
  assert.deepEqual(cooked.pantry, pantry);
  assert.deepEqual(cooked.meals[dinner.date].completion.deductions, []);
});

test("cooking a future dinner early checks stock against the actual cooking date", () => {
  const dinner = meal("2030-01-14");
  const pantry = [stock("today", "rice", "400 g", "2030-01-12")];
  assert.equal(buildShoppingList([dinner], pantry, "2030-01-12")[0].measure, "400 g", "forecast respects the planned date");
  assert.equal(consumptionPreview(dinner, pantry, "2030-01-12").deductions[0].after, "0 g");
  const cooked = completeMeal(kitchen(pantry, { [dinner.date]: dinner }), dinner.date, true, "2030-01-12T12:00:00.000Z");
  assert.equal(cooked.pantry[0].measure, "0 g");
  assert.equal(cooked.meals[dinner.date].completion.deductions[0].useBy, "2030-01-12");
});

test("undo retains edited dates and recreates deleted stock with its captured date", () => {
  const dinner = meal();
  const initial = kitchen([stock("rice", "rice", "1 kg", "2026-10-22")], { [dinner.date]: dinner });
  const cooked = completeMeal(initial, dinner.date, true, "2026-10-22T12:00:00.000Z");
  assert.equal(cooked.meals[dinner.date].completion.deductions[0].useBy, "2026-10-22");
  validateKitchenState(cooked);
  const deleted = undoMeal({ ...cooked, pantry: [] }, dinner.date);
  assert.deepEqual(deleted.pantry, [stock("rice", "rice", "400 g", "2026-10-22")]);
  const edited = undoMeal({ ...cooked, pantry: [{ ...cooked.pantry[0], useBy: "2026-10-28" }] }, dinner.date);
  assert.equal(edited.pantry[0].measure, "1000 g");
  assert.equal(edited.pantry[0].useBy, "2026-10-28");
  const invalid = structuredClone(cooked);
  invalid.meals[dinner.date].completion.deductions[0].useBy = "2026-02-29";
  assert.throws(() => validateKitchenState(invalid), /useBy/);
});

test("final cooking amounts apply overrides once and preserve legacy source semantics", () => {
  const source = recipe("normal", [{ name: "rice", measure: "400 g" }, { name: "salt", measure: "to taste" }]);
  const value = meal("2026-10-22", source);
  value.servings = 4;
  assert.deepEqual(resolvedMealIngredients(value), [{ name: "rice", measure: "800 g", needsReview: false }, { name: "salt", measure: "to taste", needsReview: true }]);
  value.ingredientOverrides["0"] = "350 g";
  assert.equal(resolvedMealIngredients(value)[0].measure, "350 g");
  const raw = recipe("embedded", [{ name: "200 g flour", measure: "" }]);
  const legacy = createPlannedMeal("2026-10-22", raw, false);
  assert.equal(resolvedMealIngredients(legacy)[0].needsReview, true);
  const normalized = createPlannedMeal("2026-10-22", raw);
  assert.equal(resolvedMealIngredients(normalized)[0].measure, "200 g");
  assert.deepEqual(raw.ingredients, [{ name: "200 g flour", measure: "" }]);
});

test("saved dinners reserve stock before filling future empty days", () => {
  const saved = meal("2026-10-25", recipe("saved-rice", [{ name: "rice", measure: "300 g" }]));
  saved.locked = true;
  const meals = { [saved.date]: saved };
  const before = structuredClone(meals);
  const result = fillEmptyDays([recipe("other-rice", [{ name: "rice", measure: "300 g" }]), recipe("pasta", [{ name: "pasta", measure: "300 g" }])], [stock("rice", "rice", "300 g"), stock("pasta", "pasta", "300 g")], "2026-10-19", meals, "2026-10-22");
  assert.equal(result.additions[0].recipeId, "pasta");
  assert.ok(result.additions.every((item) => item.date >= "2026-10-22"));
  assert.strictEqual(result.meals[saved.date], saved);
  assert.deepEqual(meals, before);
});

test("suggestions cannot count the same packet for two dinners", () => {
  const recipes = [recipe("rice-a", [{ name: "rice", measure: "200 g" }]), recipe("rice-b", [{ name: "rice", measure: "200 g" }]), recipe("beans", [{ name: "beans", measure: "200 g" }])];
  const pantry = [stock("rice", "rice", "200 g"), stock("beans", "beans", "200 g")];
  const result = fillEmptyDays(recipes, pantry, "2026-10-26", {}, "2026-10-22");
  const firstNames = result.additions.slice(0, 2).map((item) => item.planningIngredients[0].name);
  assert.equal(new Set(firstNames).size, 2);
  assert.equal(buildShoppingList(result.additions, pantry)[0].measure, "200 g");
  assert.deepEqual(pantry, [stock("rice", "rice", "200 g"), stock("beans", "beans", "200 g")]);
});

test("use-soon stock leads while ingredient reuse is a preference rather than a fixed choice", () => {
  const urgent = recipe("urgent", [{ name: "rice", measure: "200 g" }, { name: "tomato", measure: "1" }]);
  const covered = recipe("covered", [{ name: "beans", measure: "200 g" }]);
  const result = fillEmptyDays([covered, urgent], [stock("rice", "rice", "200 g", "2026-10-29"), stock("beans", "beans", "200 g")], "2026-10-26", {}, "2026-10-22");
  assert.equal(result.additions[0].recipeId, "urgent");
  assert.match(result.reasons["2026-10-26"], /within three days/);
  const saved = meal("2026-10-30", recipe("saved", [{ name: "onion", measure: "1" }]));
  const choices = [recipe("carrot", [{ name: "carrot", measure: "1" }]), recipe("onion", [{ name: "onion", measure: "1" }])];
  const reuse = fillEmptyDays(choices, [], "2026-10-26", { [saved.date]: saved }, "2026-10-22", () => 0.45);
  assert.equal(reuse.additions[0].recipeId, "onion", "ingredient reuse increases a candidate's chance");
  const variety = fillEmptyDays(choices, [], "2026-10-26", { [saved.date]: saved }, "2026-10-22", () => 0);
  assert.equal(variety.additions[0].recipeId, "carrot", "a new ingredient can still be chosen");
});

test("a fill seed replays independently of catalog order, keeps cooked meals and leaves past weeks untouched", () => {
  const recipes = Array.from({ length: 9 }, (_, index) => recipe(`r${index}`));
  const saved = meal("2026-10-27", recipes[0]);
  saved.status = "cooked";
  saved.completion = { id: "cooked", at: "2026-10-22T10:00:00.000Z", deductions: [] };
  const meals = { [saved.date]: saved };
  const forward = fillEmptyDays(recipes, [], "2026-10-26", meals, "2026-10-22", planningRandom(42));
  const reversed = fillEmptyDays([...recipes].reverse(), [], "2026-10-26", meals, "2026-10-22", planningRandom(42));
  assert.deepEqual(forward.additions.map((item) => item.recipeId), reversed.additions.map((item) => item.recipeId));
  assert.equal(new Set(forward.additions.map((item) => item.recipeId)).size, 6);
  assert.strictEqual(forward.meals[saved.date], saved);
  assert.deepEqual(fillEmptyDays(recipes, [], "2026-10-12", {}, "2026-10-22").additions, []);
});


test("new fill seeds vary both the selection and order while keeping every week repeat-free", () => {
  const recipes = Array.from({ length: 12 }, (_, index) => recipe(`variety-${index}`));
  const firstDinners = new Set(), combinations = new Set(), orders = new Set();
  for (let seed = 0; seed < 32; seed++) {
    const fill = fillEmptyDays(recipes, [], "2026-10-26", {}, "2026-10-22", planningRandom(seed));
    const ids = fill.additions.map((meal) => meal.recipeId);
    assert.equal(ids.length, 7);
    assert.equal(new Set(ids).size, 7);
    firstDinners.add(ids[0]); combinations.add([...ids].sort().join(",")); orders.add(ids.join(","));
  }
  assert.ok(firstDinners.size >= 8, "variety must not be a fixed first dinner with shuffled later slots");
  assert.ok(combinations.size >= 20, "vary which dinners are chosen, not only their order");
  assert.equal(orders.size, 32);
});

test("automatic dinners prefer reviewed mains before pantry-covered sides and retain variety", () => {
  const mains = Array.from({ length: 10 }, (_, i) => recipe(`main-${i}`, [{ name: "beans", measure: "200 g" }]));
  const side = recipe("side", [{ name: "rice", measure: "200 g" }]);
  const metadataByRecipeId = Object.fromEntries([...mains.map(r => [r.id, { coreDinner: true, dinnerRole: "main" }]), [side.id, { coreDinner: false, dinnerRole: "side" }]]);
  const pantry = [stock("rice", "rice", "2 kg", "2026-10-26")];
  const firsts = new Set();
  for (let seed = 0; seed < 12; seed++) {
    const result = fillEmptyDays([side, ...mains], pantry, "2026-10-26", {}, "2026-10-26", planningRandom(seed), { metadataByRecipeId });
    assert.equal(result.additions.length, 7);
    assert.ok(result.additions.every(dinner => dinner.recipeId.startsWith("main-")));
    assert.equal(new Set(result.additions.map(dinner => dinner.recipeId)).size, 7);
    assert.match(result.reasons["2026-10-26"], /Reviewed main.*Pantry covers 0 ingredients; 1 still to buy/);
    firsts.add(result.additions[0].recipeId);
  }
  assert.ok(firsts.size > 3);
  const wider = fillEmptyDays([side, ...mains], pantry, "2026-10-26", {}, "2026-10-26", () => 0, { metadataByRecipeId, preferReviewedMains: false });
  assert.equal(wider.additions[0].recipeId, side.id);
  assert.match(wider.reasons["2026-10-26"], /Reviewed side/);
});

test("main-first fallback can use unknown recipes while known sides and desserts stay out", () => {
  const recipes = [recipe("main"), recipe("unknown"), recipe("side"), recipe("dessert")];
  const metadataByRecipeId = { main: { dinnerRole: "main" }, side: { dinnerRole: "side" }, dessert: { dinnerRole: "dessert" } };
  const result = fillEmptyDays(recipes, [], "2026-10-26", {}, "2026-10-26", () => 0, { metadataByRecipeId });
  assert.deepEqual(result.additions.map(dinner => dinner.recipeId), ["main", "unknown"]);
  assert.match(result.reasons["2026-10-27"], /Dinner role not reviewed/);
});
