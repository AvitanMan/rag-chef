import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Transpile these two isolated modules without changing the app's dependencies
// or relying on runtime support for extensionless TypeScript imports.
const directory = await mkdtemp(join(tmpdir(), "jff-quantities-"));
after(() => rm(directory, { recursive: true, force: true }));
for (const name of ["kitchen-types", "quantities"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  await writeFile(join(directory, `${name}.mjs`), compiled.replaceAll('"./kitchen-types"', '"./kitchen-types.mjs"'));
}
const { canonicalIngredient, parseMeasure, formatMeasure, buildShoppingList, consumptionPreview, completeMeal, undoMeal, normalizePlanningIngredient } = await import(pathToFileURL(join(directory, "quantities.mjs")).href);

test("planning normalization accepts clear quantities and comparable dual units only", () => {
  for (const [text, expected] of [
    ["200 g flour", { name: "flour", measure: "200 g" }],
    ["½ cup milk", { name: "milk", measure: "120 ml" }],
    ["1 1/2 cups milk", { name: "milk", measure: "360 ml" }],
    ["2 eggs", { name: "egg", measure: "2" }],
    ["1 cup (240 ml) milk", { name: "milk", measure: "240 ml" }],
    ["1 lb (450 g) flour", { name: "flour", measure: "450 g" }],
  ]) assert.deepEqual(normalizePlanningIngredient({ name: text, measure: "" }), expected);
  for (const text of ["1–2 cups rice", "1-2 cups rice", "1 cup (100 ml) milk", "1 cup (120 g) flour", "Salt to taste", "2 large onions", "200 unknownunits flour", "1 or 2 eggs", "1 lb (450 g) ziti or other pasta", "1 cup flour and sugar", "1 pinch of salt"]) {
    const original = { name: text, measure: "" };
    assert.deepEqual(normalizePlanningIngredient(original), original);
  }
});

test("only new meal snapshots use normalized requirements, with overrides taking precedence", () => {
  const original = meal({ recipe: { ...meal().recipe, ingredients: [{ name: "200 g flour", measure: "" }] } });
  assert.equal(buildShoppingList([original], [])[0].needsReview, true);
  const current = { ...original, planningIngredients: original.recipe.ingredients.map(normalizePlanningIngredient), servings: 8 };
  assert.equal(buildShoppingList([current, { ...current, id: "repeat" }], [{ id: "flour", name: "flour", measure: "100 g" }])[0].measure, "700 g");
  assert.equal(buildShoppingList([{ ...current, ingredientOverrides: { "0": "50 g" } }], [])[0].measure, "50 g");
  assert.equal(consumptionPreview(current, [{ id: "flour", name: "flour", measure: "500 g" }]).deductions[0].after, "100 g");
  assert.equal(original.planningIngredients, undefined);
});

test("separately stored amounts do not hide unresolved ingredient choices in new dinners", () => {
  for (const name of ["flour or sugar", "salt and pepper"]) {
    const ingredient = { name, measure: "1 cup" };
    const original = meal({ recipe: { ...meal().recipe, ingredients: [ingredient] }, servings: 8 });
    const current = { ...original, planningIngredients: [ingredient] };
    const stock = [{ id: "stock", name, measure: "1 L" }];
    assert.equal(buildShoppingList([original], stock).length, 0, "older meals retain their calculations");
    const [item] = buildShoppingList([current], stock);
    assert.equal(item.needsReview, true);
    assert.equal(item.requiredMeasure, "1 cup", "an unresolved choice is not automatically scaled");
    assert.equal(consumptionPreview(current, stock).deductions.length, 0);
    const reviewed = { ...current, ingredientOverrides: { "0": "100 ml" } };
    assert.equal(buildShoppingList([reviewed], [])[0].measure, "100 ml");
    assert.equal(buildShoppingList([reviewed], [])[0].needsReview, false);
  }
});

function meal(overrides = {}) {
  return {
    id: "meal-1", date: "2026-10-20", recipeId: "recipe-1", title: "Rice bowl",
    recipe: { id: "recipe-1", title: "Rice bowl", ingredients: [{ name: "Rice", measure: "400 g" }], instructions: [], tags: [], image: null, category: "", cuisine: "", source: { name: "", url: "" }, sourceUrl: "" },
    baseServings: 4, servings: 4, batches: 1, locked: false, status: "planned", ingredientOverrides: {},
    ...overrides,
  };
}

function pantry(measure = "300 g", name = "rice", id = "rice-stock") {
  return { id, name, measure };
}

function state(planned = meal(), stock = [pantry("1 kg")]) {
  return { schemaVersion: 2, pantry: stock, meals: { [planned.date]: planned }, shoppingChecked: {}, migratedLegacy: false };
}

test("repeated planned occurrences aggregate before pantry is subtracted once", () => {
  const items = buildShoppingList([meal(), meal({ id: "meal-2", date: "2026-10-21" })], [pantry()]);
  assert.equal(items.length, 1);
  assert.equal(items[0].requiredMeasure, "800 g");
  assert.equal(items[0].pantryMeasure, "300 g");
  assert.equal(items[0].measure, "500 g");
  assert.equal(items[0].needsReview, false);
  assert.deepEqual(items[0].mealDates, ["2026-10-20", "2026-10-21"]);
  assert.equal(buildShoppingList([meal(), meal({ status: "cooked" })], [pantry()])[0].measure, "100 g");
});

test("review rows retain every contributing date without changing shopping identity", () => {
  const first = meal({ ingredientOverrides: { "0": "as needed" } });
  const second = meal({ id: "another", date: "2026-10-22", ingredientOverrides: { "0": "as needed" } });
  const row = buildShoppingList([second, first, { ...first, status: "cooked" }], [])[0];
  assert.equal(row.needsReview, true);
  assert.deepEqual(row.mealDates, ["2026-10-20", "2026-10-22"]);
  assert.equal(row.key, buildShoppingList([first, second], [])[0].key);
});

test("mass conversions aggregate and volume never converts into mass", () => {
  const first = meal({ ingredientOverrides: { "0": "500 g" } });
  const second = meal({ id: "meal-2", ingredientOverrides: { "0": ".5 kg" } });
  assert.equal(buildShoppingList([first, second], [])[0].measure, "1000 g");
  const incompatible = buildShoppingList([first], [pantry("2 cups")])[0];
  assert.equal(incompatible.measure, "500 g");
  assert.equal(incompatible.needsReview, true);
  assert.equal(consumptionPreview(first, [pantry("2 cups")]).deductions.length, 0);
});

test("parser handles mixed and Unicode fractions, compatible units and isolated counts", () => {
  assert.deepEqual(parseMeasure("1 1/2 kg"), { quantity: 1500, unit: "g", dimension: "mass" });
  assert.deepEqual(parseMeasure("1½ kg"), { quantity: 1500, unit: "g", dimension: "mass" });
  assert.deepEqual(parseMeasure("½ cup"), { quantity: 120, unit: "ml", dimension: "volume" });
  assert.deepEqual(parseMeasure("2 tbsp"), { quantity: 30, unit: "ml", dimension: "volume" });
  assert.deepEqual(parseMeasure("3 cloves"), { quantity: 3, unit: "clove", dimension: "count:clove" });
  assert.notEqual(parseMeasure("1 can").dimension, parseMeasure("1 clove").dimension);
  assert.equal(formatMeasure(2, "can"), "2 cans");
  assert.equal(formatMeasure(1, "bunch"), "1 bunch");
  for (const value of ["to taste", "a little", "1-2 kg", "1–2 cups", "1 to 2", "about 2 g", "1/0 cup", "2 large", "", "-3 g"]) {
    assert.equal(parseMeasure(value), null, value);
  }
});

test("canonical matching is exact, with a small explicit plural alias set", () => {
  assert.equal(canonicalIngredient("  TOMATOES  "), "tomato");
  assert.notEqual(canonicalIngredient("rice"), canonicalIngredient("rice vinegar"));
  assert.notEqual(canonicalIngredient("olive oil"), canonicalIngredient("oil"));
  assert.equal(buildShoppingList([meal()], [pantry("500 g", "rice vinegar")])[0].measure, "400 g");
});

test("reviewed size and cutting descriptions match while material food differences stay separate", () => {
  for (const [description, food] of [
    ["any small pasta", "pasta"], ["medium zucchini, grated", "zucchini"],
    ["large onions, finely chopped", "onion"], ["cheese, grated", "cheese"],
    ["carrots, thinly sliced", "carrot"], ["cooked medium zucchini, grated", "cooked zucchini"],
  ]) assert.equal(canonicalIngredient(description), canonicalIngredient(food), description);
  for (const [description, food] of [
    ["cooked zucchini, grated", "zucchini"], ["dried tomato, chopped", "tomato"],
    ["canned tomatoes, chopped", "tomato"], ["cheese, melted", "cheese"],
    ["onion, chopped or cooked", "onion"], ["onion and garlic, minced", "onion"],
    ["ground beef", "beef"], ["large eggs", "egg"], ["rice flour", "rice"],
  ]) assert.notEqual(canonicalIngredient(description), canonicalIngredient(food), description);
});

test("preparation identities match equivalent wording without merging cooked and uncooked quantities", () => {
  for (const names of [
    ["rice", "raw rice", "uncooked rice", "rice, uncooked", "dry rice", "rice (raw)"],
    ["cooked rice", "rice, cooked", "rice,cooked", "rice cooked", "rice (cooked)", "rice(cooked)"],
    ["chickpea", "dried chickpeas", "uncooked chickpeas"],
    ["cooked chickpea", "chickpeas, cooked"],
    ["raw chicken", "chicken, uncooked"],
  ]) for (const name of names) assert.equal(canonicalIngredient(name), canonicalIngredient(names[0]), name);
  for (const [a, b] of [
    ["rice", "cooked rice"], ["cooked rice", "uncooked rice"], ["pasta", "cooked pasta"],
    ["dried chickpeas", "cooked chickpeas"], ["dried basil", "basil"], ["dried mushrooms", "mushroom"],
    ["dried apples", "apple"], ["canned beans", "beans"], ["rice flour", "rice"],
    ["cooked or uncooked rice", "cooked rice"], ["cooked raw rice", "cooked rice"],
  ]) assert.notEqual(canonicalIngredient(a), canonicalIngredient(b), `${a} / ${b}`);
  assert.deepEqual(normalizePlanningIngredient({ name: "200 g uncooked rice", measure: "" }), { name: "uncooked rice", measure: "200 g" });
});

test("shopping and completion allocate only the requested preparation and explain mismatches", () => {
  const cooked = meal({ recipe: { ...meal().recipe, ingredients: [{ name: "Rice, cooked", measure: "400 g" }] } });
  const stock = [pantry("1 kg"), pantry("100 g", "cooked rice", "leftovers")];
  const [item] = buildShoppingList([cooked], stock);
  assert.equal(item.measure, "300 g");
  assert.equal(item.pantryMeasure, "100 g");
  assert.equal(item.needsReview, true);
  assert.match(item.preparationNote, /Cooked and uncooked amounts are kept separate/);
  const preview = consumptionPreview(cooked, stock);
  assert.deepEqual(preview.deductions.map((d) => d.pantryId), ["leftovers"]);
  const initial = state(cooked, stock);
  const completed = completeMeal(initial, cooked.date, true);
  assert.equal(completed.pantry[0].measure, "1 kg");
  assert.equal(completed.pantry[1].measure, "0 g");
  assert.deepEqual(undoMeal(completed, cooked.date).pantry, stock);
  const uncooked = meal({ recipe: { ...meal().recipe, ingredients: [{ name: "uncooked rice", measure: "400 g" }] } });
  assert.equal(buildShoppingList([uncooked], stock).length, 0);
  assert.deepEqual(consumptionPreview(uncooked, stock).deductions.map((d) => d.pantryId), ["rice-stock"]);
  const combined = buildShoppingList([cooked, uncooked], []);
  assert.equal(combined.length, 2);
  assert.deepEqual(combined.map((row) => row.measure), ["400 g", "400 g"]);
});

test("packaging and counts are separate and a pantry record is counted only once", () => {
  const planned = meal({ ingredientOverrides: { "0": "3 cans" } });
  const items = buildShoppingList([planned], [pantry("1 can"), pantry("1 can"), pantry("4 cloves", "rice", "cloves-stock")]);
  assert.equal(items[0].requiredMeasure, "3 cans");
  assert.equal(items[0].measure, "2 cans");
  assert.equal(items[0].needsReview, true);
  const preview = consumptionPreview(planned, [pantry("1 can"), pantry("1 can")]);
  assert.equal(preview.deductions.length, 1);
  assert.equal(preview.deductions[0].after, "0 cans");
});

test("unknown pantry never eliminates requirements and unknown recipe amounts stay reviewable", () => {
  const known = buildShoppingList([meal()], [pantry("some")])[0];
  assert.equal(known.measure, "400 g");
  assert.equal(known.needsReview, true);
  const unknown = meal({ servings: 8, ingredientOverrides: {} });
  unknown.recipe.ingredients = [{ name: "Rice", measure: "to taste" }];
  const review = buildShoppingList([unknown, unknown], [pantry("10 kg")])[0];
  assert.equal(review.needsReview, true);
  assert.match(review.measure, /2 occurrences/);
  assert.ok(review.notes.some((note) => note.includes("× 2")));
  assert.equal(consumptionPreview(unknown, [pantry("10 kg")]).deductions.length, 0);
  const originalKey = buildShoppingList([unknown], [])[0].key;
  assert.equal(originalKey, buildShoppingList([{ ...unknown, date: "2026-10-25", title: "Renamed meal" }], [])[0].key);
  assert.notEqual(originalKey, buildShoppingList([{ ...unknown, servings: 4 }], [])[0].key);
});

test("portions and batches scale requirements, while manual overrides are final meal amounts", () => {
  assert.equal(buildShoppingList([meal({ servings: 8 })], [])[0].measure, "800 g");
  assert.equal(buildShoppingList([meal({ baseServings: null, servings: null, batches: 3 })], [])[0].measure, "1200 g");
  assert.equal(buildShoppingList([meal({ servings: 8, ingredientOverrides: { "0": "500 g" } })], [])[0].measure, "500 g");
});

test("check keys are stable for equivalent requirements and invalidate changed amounts", () => {
  const initial = buildShoppingList([meal()], [pantry()])[0];
  assert.equal(initial.key, buildShoppingList([meal()], [pantry(".3 kg")])[0].key);
  assert.notEqual(initial.key, buildShoppingList([meal()], [pantry("200 g")])[0].key);
  assert.notEqual(initial.key, buildShoppingList([meal({ servings: 8 })], [pantry()])[0].key);
  const a = meal();
  const b = meal({ id: "meal-2", date: "2026-10-21" });
  assert.equal(buildShoppingList([a, b], [])[0].key, buildShoppingList([b, a], [])[0].key);
});

test("completion is idempotent, records exact before/after, and excludes cooked meals", () => {
  const initial = state();
  const cooked = completeMeal(initial, "2026-10-20", true, "2026-10-20T12:00:00Z");
  assert.equal(initial.pantry[0].measure, "1 kg");
  assert.equal(cooked.pantry[0].measure, "600 g");
  assert.deepEqual(cooked.meals["2026-10-20"].completion.deductions, [{ pantryId: "rice-stock", name: "rice", before: "1 kg", after: "600 g" }]);
  assert.equal(cooked.meals["2026-10-20"].completion.id, "2026-10-20:meal-1");
  assert.strictEqual(completeMeal(cooked, "2026-10-20", true), cooked);
  assert.equal(buildShoppingList(Object.values(cooked.meals), cooked.pantry).length, 0);
  assert.equal(completeMeal(initial, "2026-10-20", false).pantry[0].measure, "1 kg");
});

test("consumption never goes negative and distributes deductions across available stock", () => {
  const result = consumptionPreview(meal(), [pantry("100 g"), pantry(".2 kg", "Rice", "rice-2"), pantry("to taste", "Rice", "rice-3")]);
  assert.equal(result.deductions.length, 2);
  assert.deepEqual(result.deductions.map((deduction) => deduction.after), ["0 g", "0 g"]);
  assert.ok(result.notes.some((note) => note.includes("100 g unavailable")));
});

test("undo restores arithmetic deltas, preserving subsequent pantry edits", () => {
  const cooked = completeMeal(state(), "2026-10-20", true);
  const restored = undoMeal(cooked, "2026-10-20");
  assert.equal(restored.pantry[0].measure, "1000 g");
  assert.equal(restored.meals["2026-10-20"].status, "planned");
  assert.equal(restored.meals["2026-10-20"].completion, undefined);
  assert.strictEqual(undoMeal(restored, "2026-10-20"), restored);
  const edited = { ...cooked, pantry: [pantry("2 kg")] };
  assert.equal(undoMeal(edited, "2026-10-20").pantry[0].measure, "2400 g");
});

test("undo restores deleted stock with the consumed delta and original identity", () => {
  const cooked = completeMeal(state(), "2026-10-20", true);
  const undone = undoMeal({ ...cooked, pantry: [] }, "2026-10-20");
  assert.deepEqual(undone.pantry, [pantry("400 g")]);
  assert.equal(undone.meals["2026-10-20"].status, "planned");
  assert.strictEqual(undoMeal(undone, "2026-10-20"), undone);
});

test("undo retains incompatible stock edits and restores consumed amount in a unique new row", () => {
  const cooked = completeMeal(state(), "2026-10-20", true);
  for (const edited of [pantry("some"), pantry("2 cups"), pantry("1 kg", "rice vinegar")]) {
    const undone = undoMeal({ ...cooked, pantry: [edited] }, "2026-10-20");
    assert.deepEqual(undone.pantry[0], edited);
    assert.equal(undone.pantry.length, 2);
    assert.notEqual(undone.pantry[1].id, edited.id);
    assert.equal(undone.pantry[1].name, "rice");
    assert.equal(undone.pantry[1].measure, "400 g");
    assert.strictEqual(undoMeal(undone, "2026-10-20"), undone);
    const collision = pantry("7 cans", "beans", undone.pantry[1].id);
    const collided = undoMeal({ ...cooked, pantry: [edited, collision] }, "2026-10-20");
    assert.deepEqual(collided.pantry.slice(0, 2), [edited, collision]);
    assert.equal(new Set(collided.pantry.map((stock) => stock.id)).size, 3);
  }
});

test("legacy deduction names are inferred only from an unambiguous recipe identity", () => {
  const cooked = completeMeal(state(), "2026-10-20", true);
  delete cooked.meals["2026-10-20"].completion.deductions[0].name;
  assert.deepEqual(undoMeal({ ...cooked, pantry: [] }, "2026-10-20").pantry, [pantry("400 g", "Rice")]);
  cooked.meals["2026-10-20"].recipe.ingredients.push({ name: "Salt", measure: "20 g" });
  assert.deepEqual(undoMeal({ ...cooked, pantry: [] }, "2026-10-20").pantry, []);
});
