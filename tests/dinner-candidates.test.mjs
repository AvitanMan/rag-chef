import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const loader = await createSourceLoader({ name: "dinner-candidates" });
after(() => loader.dispose());
const { evaluateDinnerCandidates, compareDinnerCandidates } = await loader.import("app/lib/dinner-candidates.ts");
const { findPantryDinners } = await loader.import("app/lib/pantry-dinner.ts");
const { normalizeConstraints } = await loader.import("app/lib/recipe-constraints.ts");
const { mealReadiness, allocateStockForMeals, resolvedMealIngredients, createPantryIngredientSelector } = await loader.import("app/lib/quantities.ts");
const TODAY = "2026-11-16";
const stock = (id, name, measure = "300 g", extra = {}) => ({ id, name, measure, ...extra });
const recipe = (id, ingredients = [["rice", "100 g"]], extra = {}) => ({
  id, title: id, image: null, category: "Dinner", cuisine: "", servings: 2,
  ingredients: ingredients.map(([name, measure]) => ({ name, measure })), instructions: ["Cook the ingredients."],
  tags: [], source: { name: "Synthetic recipes", url: "#test" }, sourceUrl: "#test", ...extra,
});
const kitchen = (pantry = [], meals = {}, extra = {}) => ({ schemaVersion: 2, pantry, meals, shoppingChecked: {}, migratedLegacy: true, ...extra });
const args = (overrides = {}) => ({ recipes: [recipe("Rice")], kitchen: kitchen(), today: TODAY, date: TODAY,
  portions: null, metadata: {}, constraints: normalizeConstraints(), ...overrides });
const evaluate = overrides => evaluateDinnerCandidates(args(overrides));
const ids = candidates => candidates.map(candidate => candidate.recipe.id);
const review = (dinnerRole, extra = {}) => ({ revision: 1, sourceContentHash: "a".repeat(64), coreDinner: dinnerRole === "main", dinnerRole,
  diets: { vegan: "unknown", vegetarian: "unknown", gluten_free: "unknown", low_carb: "unknown" },
  totalMinutes: null, equipment: null, provenance: {}, reviewedBy: "Test", reviewedAt: `${TODAY}T12:00:00Z`, ...extra });

test("confirmed food due soon comes before fewer unresolved foods; seasoning dates confer no urgency", () => {
  const recipes = [recipe("A covered", [["pasta", "100 g"]]), recipe("Z urgent", [["rice", "100 g"], ["tomato", "100 g"]]),
    recipe("B seasoning", [["pasta", "100 g"], ["salt", "1 g"]])];
  const result = evaluate({ recipes, kitchen: kitchen([stock("rice", "rice", "100 g", { useBy: TODAY }),
    stock("pasta", "pasta"), stock("salt", "salt", "10 g", { useBy: TODAY })]) });
  assert.deepEqual(ids(result), ["Z urgent", "A covered", "B seasoning"]);
  assert.equal(result[0].rank.usesSoon, true);
  assert.equal(result[0].reason, "Uses rice due soon.");
  assert.ok(result.slice(1).every(candidate => !candidate.rank.usesSoon));
});

test("other same-week dinners reserve stock first; replacement, cooked and other-week meals do not", () => {
  const reserved = { ...evaluate({ date: "2026-11-17" })[0].meal, id: "saved" };
  const replacement = { ...reserved, id: "replacement", date: TODAY };
  const cooked = { ...reserved, id: "cooked", date: "2026-11-18", status: "cooked" };
  const otherWeek = { ...reserved, id: "other-week", date: "2026-11-23" };
  const state = kitchen([stock("rice", "rice", "100 g", { useBy: "2026-11-19" })],
    Object.fromEntries([reserved, replacement, cooked, otherWeek].map(meal => [meal.date, meal])));
  const candidate = evaluate({ kitchen: state })[0];
  assert.equal(candidate.rank.usesSoon, false);
  assert.equal(candidate.readiness.shopping[0].measure, "100 g");
  delete state.meals[reserved.date];
  assert.equal(evaluate({ kitchen: state })[0].rank.usesSoon, true);
});

test("unknown and incompatible stock remain unresolved and never earn measured urgency", () => {
  for (const amount of ["", "some", "2 cups", "0 g"]) {
    const candidate = evaluate({ kitchen: kitchen([stock("rice", "rice", amount, { useBy: TODAY })]) })[0];
    assert.equal(candidate.rank.usesSoon, false, amount);
    assert.equal(candidate.rank.coverage, 0, amount);
    assert.equal(candidate.rank.unresolvedFood, 1, amount);
    assert.equal(candidate.readiness.shopping.length, 1, amount);
  }
  const candidates = evaluate({ recipes: [recipe("A unknown", [["chicken", "100 g"]]), recipe("Z missing")],
    kitchen: kitchen([stock("chicken", "chicken", "some")]) });
  assert.deepEqual(ids(candidates), ["Z missing", "A unknown"]);
  assert.equal(candidates[1].rank.uncertainFood, 1);
});

test("unresolved identities include review amounts but duplicate lines and seasoning do not inflate food count", () => {
  const candidate = evaluate({ recipes: [recipe("Mixed", [["rice", "100 g"], ["raw rice", "some"], ["rice", "1 cup"],
    ["salt", "some"], ["oil", "1 tbsp"]])] })[0];
  assert.equal(candidate.rank.unresolvedFood, 1);
  assert.equal(candidate.rank.uncertainFood, 1);
  assert.equal(candidate.readiness.shopping.length, 5);
});

test("freezer stock changes actual shopping but improves discovery only when explicitly picked", () => {
  const recipes = [recipe("A frozen", [["rice", "100 g"], ["chicken", "100 g"]]),
    recipe("Z ready", [["rice", "100 g"], ["onion", "100 g"]])];
  const state = kitchen([stock("rice", "rice"), stock("onion", "onion"),
    stock("chicken", "chicken", "200 g", { location: "freezer", useBy: TODAY })]);
  const unselected = evaluate({ recipes, kitchen: state, selectedKeys: ["rice"] });
  assert.deepEqual(ids(unselected), ["Z ready", "A frozen"]);
  assert.deepEqual(unselected[1].frozenCoverage, ["chicken: 100 g"]);
  assert.equal(unselected[1].readiness.shopping.length, 0);
  assert.equal(unselected[1].rank.unresolvedFood, 1);
  assert.equal(unselected[1].rank.usesSoon, false);
  const selected = evaluate({ recipes, kitchen: state, selectedKeys: ["rice", "chicken"] });
  assert.deepEqual(ids(selected), ["A frozen", "Z ready"]);
  assert.equal(selected[0].rank.usesSoon, true);
});

test("saved dinners reserve full pantry before discovery excludes freezer stock", () => {
  const saved = { ...evaluate({ date: "2026-11-17" })[0].meal, id: "saved" };
  const state = kitchen([stock("frozen", "rice", "100 g", { location: "freezer", useBy: "2026-11-17" }),
    stock("fridge", "rice", "100 g", { location: "fridge", useBy: "2026-11-18" })], { [saved.date]: saved });
  const candidate = evaluate({ kitchen: state })[0];
  assert.equal(candidate.rank.coverage, 1);
  assert.equal(candidate.rank.usesSoon, true);
  assert.deepEqual(candidate.frozenCoverage, []);
});

test("frozen coverage reports only actual compatible allocations and aggregates batches", () => {
  const candidate = evaluate({ recipes: [recipe("Rice", [["rice", "150 g"]])], kitchen: kitchen([
    stock("a", "rice", "50 g", { location: "freezer" }), stock("b", "rice", "150 g", { location: "freezer" }),
    stock("c", "rice", "some", { location: "freezer" }), stock("d", "rice", "1 cup", { location: "freezer" })]) })[0];
  assert.deepEqual(candidate.frozenCoverage, ["rice: 150 g"]);
  assert.equal(candidate.readiness.shopping.length, 0);
});

test("future dinner dates exclude expired food and do not move today's use-soon window", () => {
  const pantry = [stock("rice", "rice", "100 g", { useBy: "2026-11-20" })];
  assert.equal(evaluate({ kitchen: kitchen(pantry), date: "2026-11-19" })[0].rank.usesSoon, false);
  assert.equal(evaluate({ kitchen: kitchen(pantry), date: "2026-11-20" })[0].rank.coverage, 1);
  assert.equal(evaluate({ kitchen: kitchen(pantry), date: "2026-11-21" })[0].rank.coverage, 0);
  const result = findPantryDinners([recipe("Rice")], ["rice"], pantry, TODAY, {}, normalizeConstraints(), { date: "2026-11-21" });
  assert.equal(result.picks[0].available, false);
  assert.deepEqual(result.matches, []);
  assert.equal(evaluate({ kitchen: kitchen([stock("rice", "rice", "100 g", { useBy: "2026-11-15" })]), date: "2026-11-14" })[0].rank.coverage, 0);
});

test("personal amounts match source version and reference yield before portion scaling", () => {
  const source = recipe("Rice"), hash = "a".repeat(64);
  const personal = { contentHash: hash, referenceServings: 2, amounts: [{ ingredientIndex: 0, originalName: "rice", measure: "150 g" }] };
  const state = kitchen([stock("rice", "rice", "200 g")], {}, { personalRecipeAmounts: { Rice: personal } });
  const candidate = evaluate({ recipes: [source], kitchen: state, portions: 4, contentHashesByRecipeId: { Rice: hash } })[0];
  assert.equal(candidate.meal.servings, 4);
  assert.equal(candidate.meal.planningIngredients[0].measure, "150 g");
  assert.equal(resolvedMealIngredients(candidate.meal)[0].measure, "300 g");
  assert.equal(candidate.readiness.shopping[0].measure, "100 g");
  assert.equal(candidate.readiness.personalAmountsApplied, true);
  for (const wrong of [{ ...personal, referenceServings: 4 }, { ...personal, contentHash: "b".repeat(64) }]) {
    const current = evaluate({ recipes: [source], kitchen: { ...state, personalRecipeAmounts: { Rice: wrong } }, portions: 4,
      contentHashesByRecipeId: { Rice: hash } })[0];
    assert.equal(current.readiness.personalAmountsApplied, undefined);
    assert.equal(current.readiness.shopping.length, 0);
  }
  assert.equal(source.ingredients[0].measure, "100 g");
});

test("unknown source yield stays one batch and invalid serving requests do not change quantities", () => {
  for (const portions of [4, 0, -1, 101, 1.5, NaN]) {
    const candidate = evaluate({ recipes: [recipe("Unknown", undefined, { servings: undefined })], portions })[0];
    assert.equal(candidate.meal.servings, null);
    assert.equal(candidate.meal.batches, 1);
    assert.equal(candidate.readiness.shopping[0].measure, "100 g");
  }
  for (const portions of [0, -1, 101, 1.5, NaN]) assert.equal(evaluate({ portions })[0].meal.servings, 2);
});

test("selection needs available nonseasoning food and retains strict cooked/raw and product identities", () => {
  const state = kitchen([stock("rice", "rice", "some"), stock("salt", "salt"), stock("empty", "onion", "0")]);
  const recipes = [recipe("Rice"), recipe("Cooked", [["cooked rice", "100 g"]]), recipe("Noodles", [["rice noodles", "100 g"]])];
  assert.deepEqual(ids(evaluate({ recipes, kitchen: state, selectedKeys: ["raw rice", "rice", "salt"] })), ["Rice"]);
  assert.equal(evaluate({ recipes, kitchen: state, selectedKeys: ["rice", "raw rice"] })[0].rank.pickedFood, 1);
  for (const selectedKeys of [[], ["salt"], ["onion"], ["unknown", "salt"]]) assert.deepEqual(evaluate({ recipes, kitchen: state, selectedKeys }), []);
});

test("eligibility and existing dinner-role/dislike priorities precede stock ranking", () => {
  const recipes = [recipe("Main", [["pasta", "100 g"]]), recipe("Urgent unknown"), recipe("Urgent side"),
    recipe("Disliked", [["rice", "100 g"], ["egg", "1"]]), recipe("Allergy", [["peanut", "1 g"]]), recipe("Oven")];
  const metadata = { Main: review("main"), "Urgent side": review("side"), Disliked: review("main"), Oven: review("main", { equipment: ["oven"] }) };
  const candidates = evaluate({ recipes, metadata, kitchen: kitchen([stock("rice", "rice", "100 g", { useBy: TODAY })]),
    constraints: normalizeConstraints({ allergies: ["peanut"], dislikes: ["egg"], equipment: ["Stovetop"] }) });
  assert.deepEqual(ids(candidates), ["Main", "Disliked", "Urgent unknown", "Urgent side"]);
});

test("displayed readiness exactly matches the preview meal after the same reservations", () => {
  const saved = { ...evaluate({ date: "2026-11-17" })[0].meal, id: "saved" };
  const state = kitchen([stock("rice", "rice", "250 g", { location: "freezer" })], { [saved.date]: saved });
  const candidate = evaluate({ kitchen: state, portions: 4 })[0];
  const remaining = allocateStockForMeals([saved], state.pantry, TODAY).pantry;
  assert.deepEqual(candidate.readiness, mealReadiness(candidate.meal, remaining, TODAY));
  assert.equal(candidate.readiness.shopping[0].measure, "50 g");
  assert.equal(candidate.meal.id, `candidate:${TODAY}:Rice`);
});

test("indexed candidate stock preserves full-pantry readiness across aliases, preparations, amounts and row order", () => {
  const names = ["rice", "cooked rice", "raw rice", "2 onions", "red onion", "chicken", "cooked chicken", "rice noodles", "rice or pasta"];
  const recipes = names.map((name, index) => recipe(`Food ${index}`, [[name, index === 3 ? "" : index === 8 ? "some" : "100 g"], ["salt", "1 g"]]));
  const pantry = [stock("unrelated", "lentils"), stock("onions", "small onions", "some"),
    stock("rice-cooked", "rice, cooked", "100 g", { location: "freezer" }), stock("rice-raw", "uncooked rice", "2 cups"),
    stock("rice-finished", "rice", "0 g"), stock("rice-past", "rice", "100 g", { useBy: "2026-11-15" }),
    stock("chicken-cooked", "chicken (cooked)", "200 g"), stock("rice", "raw rice", "50 g"),
    stock("chicken", "chicken", "100 g", { location: "freezer" }), stock("onion-red", "red onions", "1"),
    stock("salt", "salt", "some"), stock("unknown-preparation", "rice or pasta", "100 g"),
    ...Array.from({ length: 100 }, (_, index) => stock(`noise-${index}`, `unrelated food ${index}`))];
  const before = structuredClone(pantry);
  const select = createPantryIngredientSelector(pantry);
  assert.deepEqual(select(["cooked rice", "raw rice", "rice"]).map(item => item.id),
    ["rice-cooked", "rice-raw", "rice-finished", "rice-past", "rice"]);
  const saved = { ...evaluate({ date: "2026-11-17" })[0].meal, id: "saved" };
  for (const date of [TODAY, "2026-11-18"]) for (const portions of [null, 4]) {
    const state = kitchen(pantry, { [saved.date]: saved });
    const remaining = allocateStockForMeals([saved], pantry, TODAY).pantry;
    for (const candidate of evaluate({ recipes, kitchen: state, date, portions })) {
      assert.deepEqual(candidate.readiness, mealReadiness(candidate.meal, remaining, TODAY), `${candidate.recipe.title}, ${date}, ${portions}`);
    }
  }
  assert.deepEqual(pantry, before);
});

test("candidate evaluation is repeatable, order-stable and pure with no network calls", () => {
  const input = args({ recipes: [recipe("b", undefined, { title: "Same" }), recipe("a", undefined, { title: "Same" })], kitchen: kitchen([stock("rice", "rice")]) });
  const before = structuredClone(input), fetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Dinner comparisons must stay local."); };
  try {
    const result = evaluateDinnerCandidates(input);
    assert.deepEqual(ids(result), ["a", "b"]);
    assert.deepEqual(evaluateDinnerCandidates({ ...input, recipes: [...input.recipes].reverse() }), result);
    assert.deepEqual(result.toSorted(compareDinnerCandidates), result);
    assert.deepEqual(input, before);
    assert.equal(result[0].recipe, input.recipes[1]);
    assert.notEqual(result[0].meal.recipe, result[0].recipe);
  } finally { globalThis.fetch = fetch; }
});
