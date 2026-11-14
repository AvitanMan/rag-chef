import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const sources = await createSourceLoader({ name: "kitchen-commands" });
after(() => sources.dispose());
const { applyKitchenCommand } = await sources.import("app/lib/kitchen-commands.ts");
const { plannedDinnerFingerprint } = await sources.import("app/lib/cooking-session.ts");
const { createPlannedMeal } = await sources.import("app/lib/kitchen-state.ts");
const { shoppingForWeek } = await sources.import("app/lib/shopping-purchases.ts");
const { DEFAULT_COOKING_PROFILE } = await sources.import("app/lib/kitchen-types.ts");
const today = "2026-11-12", week = "2026-11-09", occurredAt = "2026-11-12T12:00:00.000Z";
const recipe = { id: "fixture:rice", title: "Rice and beans", image: null, category: "Dinner", cuisine: "Test", tags: [], servings: 2,
  ingredients: [{ name: "rice", measure: "200 g" }, { name: "beans", measure: "200 g" }], instructions: ["Cook until tender."],
  source: { name: "Synthetic", url: "https://example.test/rice" }, sourceUrl: "https://example.test/rice" };
function kitchen() {
  const meal = { ...createPlannedMeal(today, recipe), id: "original-dinner" };
  return { schemaVersion: 2, pantry: [{ id: "rice", name: "rice", measure: "1 kg" }, { id: "beans", name: "beans", measure: "1 kg" }], meals: { [today]: meal }, shoppingChecked: {}, migratedLegacy: true };
}
const command = (input, expectedRevision = 7) => ({ commandId: "intent-1", expectedRevision, ...input });
const apply = (state, input, context = {}) => applyKitchenCommand(state, command(input), { revision: 7, ...context });
function completion(state, overrides = {}) {
  return { type: "CompleteDinner", date: today, expectedMealId: state.meals[today].id, expectedFingerprint: plannedDinnerFingerprint(state.meals[today]), deductStock: true, occurredAt, today, ...overrides };
}

test("commands reject stale revisions and stale meal identities without changing any aggregate", () => {
  const state = kitchen(), before = structuredClone(state);
  const intent = { type: "ChangeDinnerAmounts", date: today, expectedMealId: "original-dinner", patch: { servings: 4 } };
  assert.strictEqual(applyKitchenCommand(state, command(intent, 6), { revision: 7 }), state);
  for (const expectedMealId of ["replaced-dinner", "", undefined]) assert.strictEqual(apply(state, { ...intent, expectedMealId }), state);
  assert.deepEqual(state, before);
  const changed = apply(state, intent);
  assert.equal(changed.meals[today].servings, 4);
  assert.deepEqual(changed.pantry, before.pantry);
  assert.deepEqual(state, before);
});

test("locked and cooked dinners cannot be replaced, removed, or have amounts changed", () => {
  for (const protection of [{ locked: true }, { status: "cooked", completion: { id: "finished", at: occurredAt, deductions: [] } }]) {
    const state = kitchen(); state.meals[today] = { ...state.meals[today], ...protection };
    const replacement = { ...state.meals[today], id: "replacement" };
    for (const intent of [
      { type: "ChangeDinnerAmounts", date: today, expectedMealId: "original-dinner", patch: { servings: 4 } },
      { type: "PlaceDinner", meal: replacement, expectedMealId: "original-dinner" },
      { type: "RemoveDinners", dinners: [{ date: today, expectedMealId: "original-dinner" }] },
    ]) assert.strictEqual(apply(state, intent), state);
  }
});

test("placing dinner requires the reviewed destination and preserves a detached recipe snapshot", () => {
  const state = kitchen(), replacement = { ...createPlannedMeal(today, recipe), id: "replacement" };
  assert.strictEqual(apply(state, { type: "PlaceDinner", meal: replacement, expectedMealId: null }), state);
  const placed = apply(state, { type: "PlaceDinner", meal: replacement, expectedMealId: "original-dinner" });
  assert.equal(placed.meals[today].id, "replacement");
  replacement.recipe.ingredients[0].measure = "999 kg";
  assert.equal(placed.meals[today].recipe.ingredients[0].measure, "200 g");
  assert.equal(state.meals[today].id, "original-dinner");
});

test("invalid amount payloads cannot partially update a dinner or its stock", () => {
  const state = kitchen(), before = structuredClone(state);
  for (const patch of [{ servings: -1 }, { servings: 4, batches: 0 }, { servings: 4, status: "cooked" }, { ingredientOverrides: { 0: "-2 g" } }]) {
    assert.strictEqual(apply(state, { type: "ChangeDinnerAmounts", date: today, expectedMealId: "original-dinner", patch }), state);
    assert.deepEqual(state, before);
  }
});

test("completion is fingerprint-bound, updates dinner and stock together, and cannot deduct twice", () => {
  const state = kitchen(), before = structuredClone(state), intent = completion(state);
  const changedAmounts = { ...state, meals: { [today]: { ...state.meals[today], servings: 4 } } };
  assert.strictEqual(apply(changedAmounts, intent), changedAmounts);
  assert.strictEqual(apply(state, { ...intent, occurredAt: "invalid-time" }), state);
  assert.deepEqual(state, before);
  const completed = apply(state, intent);
  assert.equal(completed.meals[today].status, "cooked");
  assert.deepEqual(completed.pantry.map(row => row.measure), ["800 g", "800 g"]);
  assert.equal(completed.meals[today].completion.deductions.length, 2);
  assert.strictEqual(apply(completed, intent), completed);
  assert.deepEqual(state, before);
});

test("undo requires the exact completion and cannot partially restore a full pantry", () => {
  const completed = apply(kitchen(), completion(kitchen()));
  const intent = { type: "UndoDinner", date: today, expectedMealId: "original-dinner", expectedCompletionId: completed.meals[today].completion.id };
  assert.strictEqual(apply(completed, { ...intent, expectedCompletionId: "old-completion" }), completed);
  const full = { ...completed, pantry: Array.from({ length: 499 }, (_, index) => ({ id: `unrelated-${index}`, name: `Unrelated ${index}`, measure: "1 g" })) };
  const before = structuredClone(full);
  assert.strictEqual(apply(full, intent), full);
  assert.deepEqual(full, before);
  const restored = apply(completed, intent);
  assert.deepEqual(restored.pantry.map(row => row.measure), ["1000 g", "1000 g"]);
  assert.equal(restored.meals[today].status, "planned");
  assert.strictEqual(apply(restored, intent), restored);
});

test("an old Undo command cannot undo a newer cooking of the same dinner before autosave", () => {
  const initial = kitchen();
  const first = applyKitchenCommand(initial, { ...command(completion(initial)), commandId: "first-cooking" }, { revision: 7 });
  const undo = command({ type: "UndoDinner", date: today, expectedMealId: "original-dinner", expectedCompletionId: first.meals[today].completion.id });
  const restored = applyKitchenCommand(first, undo, { revision: 7 });
  const second = applyKitchenCommand(restored, { ...command(completion(restored)), commandId: "second-cooking" }, { revision: 7 });
  assert.equal(first.meals[today].completion.id, "first-cooking");
  assert.equal(second.meals[today].completion.id, "second-cooking");
  assert.strictEqual(applyKitchenCommand(second, undo, { revision: 7 }), second);
  assert.equal(second.meals[today].status, "cooked");
  assert.deepEqual(second.pantry.map(row => row.measure), ["800 g", "800 g"]);
});

test("reviewed purchases add all batches once and reject a partially invalid draft", () => {
  const state = { ...kitchen(), pantry: [] };
  const items = shoppingForWeek(state, week, today);
  state.shoppingChecked = Object.fromEntries(items.map(item => [item.key, true]));
  const drafts = items.map((item, index) => ({ key: item.key, name: item.name, measure: item.measure, pantryId: `bought-${index}` }));
  const intent = { type: "RecordPurchase", week, today, drafts, occurredAt };
  const before = structuredClone(state);
  assert.strictEqual(apply(state, { ...intent, drafts: [drafts[0], { ...drafts[1], measure: "-1 g" }] }), state);
  assert.deepEqual(state, before);
  const purchased = apply(state, intent);
  assert.equal(purchased.pantry.length, 2);
  assert.equal(purchased.shoppingPurchases.length, 1);
  assert.equal(purchased.shoppingPurchases[0].id, "intent-1");
  assert.strictEqual(apply(purchased, intent), purchased);
  assert.deepEqual(state, before);
});

test("stocktake commands preserve concurrent batch changes and reject invalid replacements atomically", () => {
  const state = kitchen(), snapshot = structuredClone(state.pantry[0]);
  const intent = { type: "ReplacePantryBatch", snapshot, replacement: { ...snapshot, measure: "500 g" } };
  const changed = { ...state, pantry: [{ ...snapshot, measure: "900 g" }, state.pantry[1]] };
  assert.strictEqual(apply(changed, intent), changed);
  assert.strictEqual(apply(state, { ...intent, replacement: { ...snapshot, measure: "-1 g" } }), state);
  const corrected = apply(state, intent);
  assert.equal(corrected.pantry[0].measure, "500 g");
  assert.deepEqual(corrected.pantry[1], state.pantry[1]);
  assert.deepEqual(corrected.meals, state.meals);
});

test("member commands cannot replace the household cooking profile", () => {
  const state = { ...kitchen(), cookingProfile: { ...DEFAULT_COOKING_PROFILE, allergies: ["peanut"] } };
  assert.strictEqual(apply(state, { type: "SetCookingProfile", profile: DEFAULT_COOKING_PROFILE }, { canEditProfile: false }), state);
  assert.deepEqual(apply(state, { type: "SetCookingProfile", profile: DEFAULT_COOKING_PROFILE }, { canEditProfile: true }).cookingProfile.allergies, []);
});
