import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const sources = await createSourceLoader({ name: "fill-empty-days-review" });
after(sources.dispose);
const { buildFillEmptyDaysPreview } = await sources.import("app/lib/fill-empty-days-review");
const { createPlannedMeal } = await sources.import("app/lib/kitchen-state");
const { DEFAULT_COOKING_PROFILE } = await sources.import("app/lib/kitchen-types");
const { shoppingForWeek } = await sources.import("app/lib/shopping-purchases");
const { allocateStockForMeals } = await sources.import("app/lib/quantities");

const week = "2026-11-23";
const recipe = (id, ingredients, servings = 2) => ({ id, title: id, ...(servings === null ? {} : { servings }), ingredients,
  instructions: ["Prepare as directed."], category: "Dinner", cuisine: "Test kitchen", tags: [], image: null,
  source: { name: "Test", url: "https://example.com/test" }, sourceUrl: "https://example.com/test" });
const ingredient = (name, measure) => ({ name, measure });
const stock = (id, name, measure, useBy) => ({ id, name, measure, ...(useBy ? { useBy } : {}) });
const kitchen = (meals = [], pantry = []) => ({ schemaVersion: 2, migratedLegacy: true, shoppingChecked: {},
  meals: Object.fromEntries(meals.map(meal => [meal.date, meal])), pantry });
const review = (state, recipes, options = {}) => buildFillEmptyDaysPreview({ state, recipes, metadataByRecipeId: {},
  contentHashesByRecipeId: {}, week, today: week, seed: 24, preferReviewedMains: true, ...options });
const withPlan = (state, plan) => ({ ...state, meals: { ...state.meals, ...Object.fromEntries(plan.additions.map(meal => [meal.date, meal])) } });

test("repeat review returns exact snapshots and unique meal IDs, with occupied and past dates untouched", () => {
  const recipes = Array.from({ length: 8 }, (_, i) => recipe("dinner-" + i, [ingredient("beans", "1 can")], i % 2 ? null : 3));
  const first = createPlannedMeal("2026-11-25", recipes[0]);
  const cooked = { ...createPlannedMeal("2026-11-27", recipes[1]), status: "cooked" };
  const locked = { ...createPlannedMeal("2026-11-28", recipes[2]), locked: true };
  const state = kitchen([first, cooked, locked]);
  const initial = structuredClone({ state, recipes });
  const options = { today: "2026-11-25" };
  const preview = review(state, recipes, options);
  assert.deepEqual(preview.additions.map(meal => meal.date), ["2026-11-26", "2026-11-29"]);
  assert.deepEqual(preview, review(structuredClone(state), recipes.toReversed(), options));
  assert.deepEqual({ state, recipes }, initial);
  assert.equal(new Set(preview.additions.map(meal => meal.recipeId)).size, 2);
  for (const meal of preview.additions) {
    assert.ok(![first, cooked, locked].some(saved => saved.recipeId === meal.recipeId));
    assert.equal(meal.servings, meal.recipe.servings ?? null);
    assert.equal(meal.batches, 1);
  }
  const colliding = kitchen([{ ...first, id: preview.additions[0].id }, cooked, locked]);
  const ids = Object.values(withPlan(colliding, review(colliding, recipes, options)).meals).map(meal => meal.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(review(state, recipes, { today: "2026-11-30" }).additions, []);
});

test("each saved requirement retains its covered quantity, including an earlier proposal competing for partially covered stock", () => {
  const saved = createPlannedMeal("2026-11-26", recipe("rice with beans", [ingredient("rice", "300 g"), ingredient("beans", "200 g")]));
  const state = kitchen([saved], [stock("rice", "rice", "100 g"), stock("beans", "beans", "300 g")]);
  const guarded = recipe("more rice", [ingredient("rice", "20 g")]);
  const safe = recipe("some beans", [ingredient("beans", "100 g")]);
  const plan = review(state, [guarded, safe]);
  assert.deepEqual(plan.additions.map(meal => [meal.date, meal.recipeId]), [[week, safe.id], ["2026-11-27", guarded.id]]);
  const before = allocateStockForMeals([saved], state.pantry, week).allocations[0];
  const after = allocateStockForMeals(Object.values(withPlan(state, plan).meals), state.pantry, week).allocations.find(row => row.mealId === saved.id);
  assert.deepEqual([...after.coveredByGroup], [...before.coveredByGroup]);
  assert.deepEqual(plan.readinessByDate[week].shopping, []);
  assert.equal(plan.readinessByDate["2026-11-27"].shopping[0].measure, "20 g");
});

test("future-week dinners keep their stock while an earlier batch expiring this week stays available", () => {
  const saved = createPlannedMeal("2026-11-30", recipe("future rice", [ingredient("rice", "300 g")]));
  const state = kitchen([saved], [stock("long", "rice", "300 g"), stock("early", "rice", "80 g", week)]);
  const enough = recipe("short-lived rice", [ingredient("rice", "80 g")]);
  const tooMuch = recipe("takes next week’s rice", [ingredient("rice", "81 g")]);
  const plan = review(state, [enough, tooMuch]);
  assert.deepEqual(plan.additions.map(meal => [meal.date, meal.recipeId]), [[week, enough.id]]);
  assert.equal(plan.readinessByDate[week].coveredCount, 1);
  assert.deepEqual(plan.shoppingDelta, []);
  assert.deepEqual(review(state, [tooMuch]).additions, []);
});

test("weekly delta matches Shopping, distinguishes count from weight, and preserves uncertain quantities", () => {
  const saved = createPlannedMeal(week, recipe("saved", [ingredient("potatoes", "300 g"), ingredient("salt", "to taste"), ingredient("lemon", "1")]));
  const added = recipe("added", [ingredient("potato", "200 g"), ingredient("potatoes", "2"), ingredient("salt", "to taste"), ingredient("milk", "50 ml")]);
  const state = kitchen([saved], [stock("potato", "potato", "100 g"), stock("milk", "milk", "some")]);
  const plan = review(state, [added]);
  const after = shoppingForWeek(withPlan(state, plan), week, week);
  const before = shoppingForWeek(state, week, week);
  const rows = plan.shoppingDelta;
  assert.equal(rows.length, 4);
  const weight = rows.find(row => row.before === "200 g");
  assert.deepEqual([weight.after, weight.added, weight.needsReview], ["400 g", "200 g", false]);
  const count = rows.find(row => row.after === "2");
  assert.deepEqual([count.before, count.added, count.needsReview], [null, null, true]); // Measured pantry weight cannot confirm the count.
  const salt = rows.find(row => row.name === "salt");
  assert.deepEqual([salt.before, salt.after, salt.added, salt.needsReview], ["to taste", "to taste · 2 occurrences", null, true]);
  const milk = rows.find(row => row.name === "milk");
  assert.deepEqual([milk.before, milk.after, milk.added, milk.needsReview], [null, "50 ml", null, true]);
  assert.equal(rows.some(row => row.name === "lemon"), false);
  for (const row of rows) {
    if (row.before !== null) assert.ok(before.some(item => item.name === row.name && item.measure === row.before));
    assert.ok(after.some(item => item.name === row.name && item.measure === row.after));
  }
  assert.deepEqual(plan.readinessByDate["2026-11-24"].shopping.filter(item => item.needsReview).map(item => item.name), ["milk", "salt"]);
});

test("saved allergy, equipment, dinner-role preference and versioned personal amounts govern deterministic replay", () => {
  const beans = recipe("beans", [ingredient("beans", "some")], null);
  const egg = recipe("eggs", [ingredient("egg", "2")]);
  const grill = recipe("grill", [ingredient("pepper", "1")]);
  const side = recipe("side", [ingredient("peas", "100 g")]);
  const recipes = [egg, beans, grill, side];
  const state = { ...kitchen(), cookingProfile: { ...DEFAULT_COOKING_PROFILE, allergies: ["egg"] },
    personalRecipeAmounts: { beans: { contentHash: "version1", referenceServings: null, amounts: [
      { ingredientIndex: 0, originalName: "beans", measure: "180 g" }] } } };
  const options = { contentHashesByRecipeId: { beans: "version1" }, metadataByRecipeId: {
    grill: { dinnerRole: "main", equipment: ["grill"] }, beans: { dinnerRole: "main" }, side: { dinnerRole: "side" } } };
  const plan = review(state, recipes, options);
  assert.deepEqual(plan.additions.map(meal => meal.recipeId), ["beans"]);
  assert.deepEqual([plan.additions[0].servings, plan.additions[0].batches], [null, 1]);
  assert.equal(plan.additions[0].recipe.ingredients[0].measure, "some");
  assert.equal(plan.readinessByDate[week].personalAmountsApplied, true);
  assert.equal(plan.shoppingDelta[0].added, "180 g");
  const changed = review(state, recipes, { ...options, contentHashesByRecipeId: { beans: "version2" } });
  assert.equal(changed.shoppingDelta[0].needsReview, true);
  assert.equal(changed.shoppingDelta[0].added, null);
  assert.equal(changed.readinessByDate[week].reviewCount, 1);
  assert.deepEqual(review(state, recipes, { ...options, preferReviewedMains: false }).additions.map(meal => meal.recipeId).sort(), ["beans", "side"]);
});

test("reservation screening agrees with full chronological allocation across expiry, preparation, units and partial quantities", () => {
  const days = [week, "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"];
  const prior = createPlannedMeal("2026-11-22", recipe("prior", [ingredient("rice", "25 g")]));
  const middle = createPlannedMeal(days[2], recipe("in week", [
    ingredient("rice", "60 g"), ingredient("potato", "1"), ingredient("potato", "120 g")]));
  const nextWeek = createPlannedMeal("2026-11-30", recipe("next week", [
    ingredient("uncooked rice", "50 g"), ingredient("potatoes", "2"), ingredient("oil", "2 tbsp")]));
  let comparisons = 0, fitFirst = 0, fitLater = 0, noFit = 0;
  for (const expiry of [week, days[2], "2026-11-30"]) {
    for (const earlyAmount of ["15 g", "100 g"]) {
      const pantry = [stock("short", "rice", earlyAmount, expiry), stock("long", "uncooked rice", "55 g"),
        stock("prepared", "cooked rice", "65 g"), stock("count", "potatoes", "2"),
        stock("weight", "potato", "150 g"), stock("oil", "oil", "50 ml"), stock("oil-unknown", "oil", "some")];
      const state = kitchen([prior, middle, nextWeek], pantry);
      const saved = Object.values(state.meals);
      const baseline = allocateStockForMeals(saved, pantry, week).allocations;
      for (const rice of ["11.4999996 g", "25 g", "50 g", "some"]) {
        for (const potatoes of ["1", "30 g", "50 g"]) {
          for (const preparation of ["cooked rice", "rice"]) {
            const candidate = recipe("one possible dinner", [ingredient(preparation, rice), ingredient("potato", potatoes), ingredient("oil", "1 tsp")]);
            const expected = days.filter(day => !state.meals[day]).find(day => {
              const meal = createPlannedMeal(day, candidate);
              const chronological = allocateStockForMeals([...saved, meal], pantry, week).allocations;
              return baseline.every(original => {
                const current = chronological.find(allocation => allocation.mealId === original.mealId);
                return [...original.coveredByGroup].every(([key, amount]) => current.coveredByGroup.get(key) >= amount);
              });
            });
            assert.deepEqual(review(state, [candidate]).additions.map(meal => meal.date), expected ? [expected] : [],
              JSON.stringify({ expiry, earlyAmount, rice, potatoes, preparation }));
            comparisons++;
            if (!expected) noFit++;
            else if (expected === week) fitFirst++;
            else fitLater++;
          }
        }
      }
    }
  }
  assert.equal(comparisons, 144);
  assert.ok(fitFirst && fitLater && noFit, "fixtures include accepted, deferred and fully blocked meals");
});

test("using an earlier expiring batch leaves the weekly shortage unchanged even when Shopping's purchase key changes", () => {
  const saved = createPlannedMeal("2026-11-25", recipe("saved rice", [ingredient("rice", "200 g")]));
  const state = kitchen([saved], [stock("early", "rice", "100 g", week)]);
  const plan = review(state, [recipe("today’s rice", [ingredient("rice", "50 g")])]);
  assert.equal(plan.additions.length, 1);
  const [before] = shoppingForWeek(state, week, week);
  const [after] = shoppingForWeek(withPlan(state, plan), week, week);
  assert.notEqual(before.key, after.key);
  assert.equal(before.measure, "200 g");
  assert.equal(after.measure, before.measure);
  assert.deepEqual(plan.shoppingDelta, []);
});

test("new dinners cannot cumulatively use stock already promised to a saved dinner", () => {
  const saved = createPlannedMeal("2026-11-26", recipe("saved", [ingredient("rice", "100 g")]));
  const state = kitchen([saved], [stock("rice", "rice", "200 g")]);
  const choices = ["first recipe", "second recipe"].map(id => recipe(id, [ingredient("rice", "70 g")]));
  for (const choice of choices) assert.equal(review(state, [choice]).additions[0].date, week);
  const plan = review(state, choices);
  assert.deepEqual(plan.additions.map(meal => meal.date), [week, "2026-11-27"]);
  assert.deepEqual(plan.readinessByDate[week].shopping, []);
  assert.equal(plan.readinessByDate["2026-11-27"].shopping[0].measure, "40 g");
  assert.deepEqual(plan.shoppingDelta.map(item => item.added), ["40 g"]);
});
