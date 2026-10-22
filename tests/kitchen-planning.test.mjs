import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const dir = await mkdtemp(join(tmpdir(), "jff-kitchen-planning-"));
after(() => rm(dir, { recursive: true, force: true }));
for (const name of ["kitchen-types", "kitchen-state", "quantities", "kitchen-stock", "kitchen-validation", "kitchen-backup", "kitchen-planning"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"');
  await writeFile(join(dir, `${name}.mjs`), code);
}
const load = (name) => import(pathToFileURL(join(dir, `${name}.mjs`)).href);
const { allocateMealStock, allocateStockForMeals, buildShoppingList, completeMeal, undoMeal, resolvedMealIngredients } = await load("quantities");
const { createPlannedMeal } = await load("kitchen-state");
const { fillEmptyDays } = await load("kitchen-planning");
const { availablePantryNames } = await load("kitchen-stock");
const { validateKitchenState } = await load("kitchen-validation");
const { parseKitchenBackup, serializeKitchenBackup } = await load("kitchen-backup");

const recipe = (id, ingredients = [{ name: "rice", measure: "400 g" }]) => ({ id, title: `Dinner ${id}`, servings: 2, ingredients, instructions: ["Follow the original source instructions."], tags: [], image: null, category: "Dinner", cuisine: "Home cooking", source: { name: "Test", url: "https://example.com/recipe" }, sourceUrl: "https://example.com/recipe" });
const meal = (date = "2026-10-22", value = recipe("rice")) => createPlannedMeal(date, value);
const stock = (id, name, measure, useBy) => ({ id, name, measure, ...(useBy ? { useBy } : {}) });
const kitchen = (pantry = [], meals = {}) => ({ schemaVersion: 2, pantry, meals, shoppingChecked: {}, migratedLegacy: true });

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
  const allocation = allocateStockForMeals([second, first], pantry);
  assert.equal(allocation.allocations[0].deductions[0].pantryId, "early");
  assert.equal(allocation.pantry.find((item) => item.id === "early").measure, "100 g");
  assert.equal(allocation.pantry.find((item) => item.id === "undated").measure, "0 g");
  assert.equal(allocation.allocations[1].coverage, 0.5);
  assert.ok(allocation.allocations[1].notes.some((note) => note.includes("past its entered use-by date")));
  const [shopping] = buildShoppingList([first, second], pantry);
  assert.equal(shopping.requiredMeasure, "800 g");
  assert.equal(shopping.pantryMeasure, "600 g");
  assert.equal(shopping.measure, "200 g");
  assert.ok(shopping.notes.some((note) => note.includes("excluded")));
  assert.deepEqual(completeMeal(kitchen(pantry, { [first.date]: first }), first.date, true).pantry, allocation.allocations[0].pantry);
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

test("undo retains edited dates and recreates deleted stock with its captured date", () => {
  const dinner = meal();
  const initial = kitchen([stock("rice", "rice", "1 kg", "2026-10-22")], { [dinner.date]: dinner });
  const cooked = completeMeal(initial, dinner.date, true);
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

test("use-soon stock leads, then quantity coverage and existing ingredient reuse", () => {
  const urgent = recipe("urgent", [{ name: "rice", measure: "200 g" }, { name: "tomato", measure: "1" }]);
  const covered = recipe("covered", [{ name: "beans", measure: "200 g" }]);
  const result = fillEmptyDays([covered, urgent], [stock("rice", "rice", "200 g", "2026-10-29"), stock("beans", "beans", "200 g")], "2026-10-26", {}, "2026-10-22");
  assert.equal(result.additions[0].recipeId, "urgent");
  assert.match(result.reasons["2026-10-26"], /within three days/);
  const saved = meal("2026-10-30", recipe("saved", [{ name: "onion", measure: "1" }]));
  const reuse = fillEmptyDays([recipe("carrot", [{ name: "carrot", measure: "1" }]), recipe("onion", [{ name: "onion", measure: "1" }])], [], "2026-10-26", { [saved.date]: saved }, "2026-10-22");
  assert.equal(reuse.additions[0].recipeId, "onion");
});

test("weekly fill is deterministic, keeps cooked meals and leaves past weeks untouched", () => {
  const recipes = Array.from({ length: 9 }, (_, index) => recipe(`r${index}`));
  const saved = meal("2026-10-27", recipes[0]);
  saved.status = "cooked";
  saved.completion = { id: "cooked", at: "2026-10-22T10:00:00.000Z", deductions: [] };
  const meals = { [saved.date]: saved };
  const forward = fillEmptyDays(recipes, [], "2026-10-26", meals, "2026-10-22");
  const reversed = fillEmptyDays([...recipes].reverse(), [], "2026-10-26", meals, "2026-10-22");
  assert.deepEqual(forward.additions.map((item) => item.recipeId), reversed.additions.map((item) => item.recipeId));
  assert.equal(new Set(forward.additions.map((item) => item.recipeId)).size, 6);
  assert.strictEqual(forward.meals[saved.date], saved);
  assert.deepEqual(fillEmptyDays(recipes, [], "2026-10-12", {}, "2026-10-22").additions, []);
});
