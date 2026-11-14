import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const sources = await createSourceLoader({ name: "personal-amounts" });
after(() => sources.dispose());
const load = name => sources.import(`app/lib/${name}.ts`);
const { personalAmountInputProblem, personalAmountsMatch, resolvedMealIngredients, buildShoppingList, mealReadiness, consumptionPreview } = await load("quantities");
const { createPlannedMeal, placePlannedDinner } = await load("kitchen-state");
const { validateKitchenState } = await load("kitchen-validation");
const { parseKitchenBackup, serializeKitchenBackup } = await load("kitchen-backup");
const { compareKitchens, parseCachedKitchen } = await load("kitchen-recovery");
const { fillEmptyDays } = await load("kitchen-planning");
const { rankUseSoonDinners } = await load("use-soon");
const { normalizeConstraints } = await load("recipe-constraints");
const { recipeEmbeddingContentHash } = await load("recipe-embeddings");
const { chefMealHash } = await load("chef-context");
const { planningQuantityAnswer, originalIngredientAnswer } = await load("chef-planning-answer");
const { plannedDinnerFingerprint } = await load("cooking-session");
const date = "2026-10-22";
const recipe = { id: "test:rice", title: "Rice", image: null, category: "Dinner", cuisine: "", tags: [], servings: 4,
  ingredients: [{ name: "rice", measure: "to taste" }, { name: "water", measure: "800 ml" }],
  instructions: ["Simmer the rice in water."], sourceNotes: ["Use a covered pan."],
  source: { name: "Test", url: "https://example.com" }, sourceUrl: "https://example.com/rice" };
const contentHash = await recipeEmbeddingContentHash(recipe);
const personal = { contentHash, referenceServings: 4, amounts: [{ ingredientIndex: 0, originalName: "rice", measure: "300 g" }] };
const kitchen = () => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true, personalRecipeAmounts: { [recipe.id]: structuredClone(personal) } });
const dinner = () => ({ ...createPlannedMeal(date, recipe, true, { amounts: personal, contentHash }), servings: 2 });

test("personal drafts accept only positive parsed measures, with blanks inheriting source", () => {
  for (const amount of ["", "  ", "300 g", "1½ cups", "1/2 tsp", "2", ".5 kg"]) assert.equal(personalAmountInputProblem(amount), "", amount);
  for (const amount of ["0", "0 g", "-1 g", "1/0 cup", "to taste", "a handful", "1-2 g", "NaN g", "Infinity", "1e400 g", "1000000001 g"]) assert.ok(personalAmountInputProblem(amount), amount);
  const meal = dinner();
  assert.deepEqual(resolvedMealIngredients(meal).map(row => row.measure), ["150 g", "400 ml"]);
  assert.deepEqual(meal.personalAmountIndices, [0]);
  assert.equal(meal.recipe.ingredients[0].measure, "to taste");
  meal.ingredientOverrides["0"] = "175 g";
  assert.equal(resolvedMealIngredients(meal)[0].measure, "175 g");
});

test("unknown source yield uses a personal reference batch without inventing servings", async () => {
  const batchRecipe = { ...recipe }; delete batchRecipe.servings;
  const hash = await recipeEmbeddingContentHash(batchRecipe);
  const amounts = { ...personal, contentHash: hash, referenceServings: null };
  const meal = createPlannedMeal(date, batchRecipe, true, { amounts, contentHash: hash }); meal.batches = 3;
  assert.equal(meal.baseServings, null); assert.equal(meal.servings, null);
  assert.equal(resolvedMealIngredients(meal)[0].measure, "900 g");
  assert.equal(planningQuantityAnswer(meal, "How much rice do I need?").planningFacts[0].basis, "personal_scaled");
});

test("ingredient, order, yield, direction and note changes suspend saved amounts", async () => {
  for (const patch of [
    { ingredients: [{ name: "rice", measure: "200 g" }, recipe.ingredients[1]] },
    { ingredients: [...recipe.ingredients].reverse() }, { servings: 6 },
    { instructions: ["Boil the rice in water."] }, { sourceNotes: ["Use an uncovered pan."] },
  ]) {
    const changed = { ...recipe, ...patch }, hash = await recipeEmbeddingContentHash(changed);
    assert.notEqual(hash, contentHash);
    assert.equal(personalAmountsMatch(changed, personal, hash), false);
    const meal = createPlannedMeal(date, changed, true, { amounts: personal, contentHash: hash });
    assert.equal(meal.personalAmountIndices, undefined);
    assert.deepEqual(meal.recipe, changed);
  }
  assert.equal(personalAmountsMatch(recipe, personal, undefined), false);
  assert.equal(personalAmountsMatch({ ...recipe, ingredients: [...recipe.ingredients].reverse() }, personal, contentHash), false, "row labels also guard against a mismatched caller");
});

test("saving, editing and resetting defaults only affects new dinners; copies keep their capture", () => {
  const state = kitchen();
  const first = placePlannedDinner(state, date, recipe, null, undefined, contentHash);
  const captured = structuredClone(first.meals[date]);
  const edited = { ...first, personalRecipeAmounts: { [recipe.id]: { ...personal, amounts: [{ ...personal.amounts[0], measure: "500 g" }] } } };
  const next = placePlannedDinner(edited, "2026-10-23", recipe, null, undefined, contentHash);
  assert.equal(next.meals["2026-10-23"].planningIngredients[0].measure, "500 g");
  const reset = { ...next, personalRecipeAmounts: {} };
  const source = placePlannedDinner(reset, "2026-10-24", recipe, null, undefined, contentHash);
  assert.equal(source.meals["2026-10-24"].planningIngredients[0].measure, "to taste");
  const copy = placePlannedDinner(edited, "2026-10-25", recipe, null, captured, contentHash).meals["2026-10-25"];
  assert.equal(copy.planningIngredients[0].measure, "300 g"); assert.deepEqual(copy.personalAmountIndices, [0]);
  assert.deepEqual(first.meals[date], captured);
  assert.deepEqual(source.meals[date], captured);
  const legacy = createPlannedMeal(date, recipe, false);
  assert.equal(placePlannedDinner(edited, "2026-10-25", recipe, null, legacy, contentHash).meals["2026-10-25"].planningIngredients, undefined);
});

test("planning, stock previews, shopping, cooking and Chef share captured amounts", async () => {
  const state = kitchen(); state.pantry = [{ id: "rice", name: "rice", measure: "200 g", useBy: date }];
  const hashes = { [recipe.id]: contentHash };
  const plan = fillEmptyDays([recipe], state.pantry, "2026-10-19", {}, date, () => 0, { personalRecipeAmounts: state.personalRecipeAmounts, contentHashesByRecipeId: hashes });
  const meal = plan.meals[date];
  assert.equal(meal.planningIngredients[0].measure, "300 g");
  assert.equal(mealReadiness(meal, state.pantry, date).personalAmountsApplied, true);
  const preview = rankUseSoonDinners({ kitchen: state, selectedId: "rice", today: date, date, portions: 4, recipes: [recipe], metadata: {}, constraints: normalizeConstraints({}), contentHashesByRecipeId: hashes });
  assert.deepEqual(preview.candidates[0].readiness, mealReadiness(meal, state.pantry, date));
  const shopping = buildShoppingList([meal], state.pantry, date);
  assert.equal(shopping.find(row => row.name === "rice").measure, "100 g");
  assert.match(shopping.find(row => row.name === "rice").notes.join(" "), /personal amount/);
  assert.equal(consumptionPreview(meal, state.pantry, date).deductions[0].after, "0 g");
  const facts = planningQuantityAnswer(meal, "What are the ingredient amounts?").planningFacts;
  assert.deepEqual(facts.map(fact => [fact.measure, fact.basis]), [["300 g", "personal_scaled"], ["800 ml", "source_scaled"]]);
  const original = originalIngredientAnswer(recipe, "How much rice does the source recipe use?");
  assert.match(original.answer, /to taste/); assert.doesNotMatch(original.answer, /300/);
  const sameAmounts = { ...meal, personalAmountIndices: [] };
  assert.notEqual(await chefMealHash(sameAmounts), await chefMealHash(meal));
  assert.notEqual(plannedDinnerFingerprint(sameAmounts), plannedDinnerFingerprint(meal));
});

test("personal records and captured provenance round-trip through backups and draft recovery", () => {
  const state = kitchen(); state.meals[date] = dinner();
  validateKitchenState(state);
  const restored = parseKitchenBackup(serializeKitchenBackup(state)).state;
  assert.deepEqual(restored.personalRecipeAmounts, state.personalRecipeAmounts);
  assert.deepEqual(restored.meals, state.meals);
  assert.deepEqual(parseCachedKitchen(JSON.stringify({ revision: 4, state, dirty: true })).state, state);
  const older = kitchen(); delete older.personalRecipeAmounts;
  validateKitchenState(older);
  assert.equal(compareKitchens(older, state).personalAmountsChanged, 1);
  assert.equal(compareKitchens(state, older).personalAmountsChanged, 1);
  assert.equal(compareKitchens(older, { ...older, personalRecipeAmounts: {} }).personalAmountsChanged, 0);
  for (const patch of [
    { contentHash: "wrong" }, { referenceServings: 0 }, { amounts: [] },
    { amounts: [{ ...personal.amounts[0], measure: "" }] }, { amounts: [{ ...personal.amounts[0], measure: "to taste" }] },
    { amounts: [...personal.amounts, ...personal.amounts] }, { amounts: [{ ...personal.amounts[0], ingredientIndex: 200 }] },
  ]) assert.throws(() => validateKitchenState({ ...state, personalRecipeAmounts: { [recipe.id]: { ...personal, ...patch } } }));
  for (const personalAmountIndices of [[2], [0, 0], [-1]]) assert.throws(() => validateKitchenState({ ...state, meals: { [date]: { ...state.meals[date], personalAmountIndices } } }));
});
