import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";
const sources = await createSourceLoader({ name: "command-validation" });
after(() => sources.dispose());
const { parseKitchenCommand, kitchenCommandHash, KitchenCommandValidationError } = await sources.import("app/lib/kitchen-command-validation.ts");
const { createPlannedMeal } = await sources.import("app/lib/kitchen-state.ts");
const { DEFAULT_COOKING_PROFILE } = await sources.import("app/lib/kitchen-types.ts");
const date = "2026-11-12", week = "2026-11-09", occurredAt = "2026-11-12T12:00:00.000Z";
const stock = { id: "rice", name: "rice", measure: "1 kg" };
const recipe = { id: "fixture:rice", title: "Rice", image: null, category: "Dinner", cuisine: "Test", tags: [], servings: 2,
  ingredients: [{ name: "rice", measure: "200 g" }], instructions: ["Cook rice."], source: { name: "Synthetic", url: "https://example.test/rice" }, sourceUrl: "https://example.test/rice" };
const meal = { ...createPlannedMeal(date, recipe), id: "dinner" };
const variants = [
  { type: "ChangeDinnerAmounts", date, expectedMealId: meal.id, patch: { servings: 4 } },
  { type: "SetDinnerLocked", date, expectedMealId: meal.id, locked: true },
  { type: "PlaceDinner", meal, expectedMealId: null },
  { type: "CompleteDinner", date, expectedMealId: meal.id, expectedFingerprint: "fingerprint", deductStock: true, occurredAt, today: date },
  { type: "UndoDinner", date, expectedMealId: meal.id, expectedCompletionId: "completion" },
  { type: "RecordPurchase", week, today: date, drafts: [{ key: `${week}:rice`, name: "rice", measure: "200 g", pantryId: "bought" }], occurredAt },
  { type: "UndoPurchase", purchaseId: "purchase" },
  { type: "ReplacePantryBatch", snapshot: stock, replacement: { ...stock, measure: "500 g" } },
  { type: "UndoPantryBatch", change: { before: stock, after: { ...stock, measure: "500 g" } } },
  { type: "AddPantryBatches", batches: [stock] },
  { type: "RemovePantryBatch", snapshot: stock },
  { type: "RemoveDinners", dinners: [{ date, expectedMealId: meal.id }] },
  { type: "RestoreRemoved", pantry: [stock], meals: [meal] },
  { type: "SetFavorite", recipeId: recipe.id, favorite: true },
  { type: "SetCookingProfile", profile: DEFAULT_COOKING_PROFILE },
  { type: "SetPersonalRecipeAmounts", recipeId: recipe.id },
  { type: "SetShoppingBought", key: `${week}:rice`, bought: true },
  { type: "BeginPurchaseCycle", previous: { purchaseId: "purchase", key: `${week}:rice`, pantryId: "bought" }, bought: true },
  { type: "UncheckShoppingWeek", week },
];
const command = input => ({ commandId: "intent", expectedRevision: 0, ...input });

test("every public command validates its exact shape and returns a detached snapshot", () => {
  for (const variant of variants) {
    const input = command(variant), before = structuredClone(input);
    const parsed = parseKitchenCommand(input);
    assert.deepEqual(parsed, input, variant.type); assert.notStrictEqual(parsed, input); assert.deepEqual(input, before);
    assert.throws(() => parseKitchenCommand({ ...input, state: {} }), KitchenCommandValidationError, variant.type);
    for (const key of Object.keys(input)) {
      const missing = { ...input }; delete missing[key];
      assert.throws(() => parseKitchenCommand(missing), KitchenCommandValidationError, `${variant.type} requires ${key}`);
    }
  }
});

test("nested unknown fields, duplicate identities and impossible dates are rejected before execution", () => {
  const examples = [
    { ...variants[0], patch: { servings: 4, status: "cooked" } },
    { ...variants[0], patch: { servings: -1 } },
    { ...variants[1], locked: "true" },
    { ...variants[2], meal: { ...meal, admin: true } },
    { ...variants[3], occurredAt: "2026-02-30T12:00:00.000Z" },
    { ...variants[3], occurredAt: "2026-11-12T12:00:00Z" },
    { ...variants[3], today: "2026-02-30" },
    { ...variants[5], drafts: [{ ...variants[5].drafts[0], extra: true }] },
    { ...variants[5], drafts: [variants[5].drafts[0], variants[5].drafts[0]] },
    { ...variants[5], drafts: [{ ...variants[5].drafts[0], key: "2026-11-02:rice" }] },
    { ...variants[7], replacement: { ...stock, id: "different" } },
    { ...variants[8], change: { ...variants[8].change, extra: true } },
    { ...variants[9], batches: [stock, stock] },
    { ...variants[10], snapshot: { ...stock, extra: true } },
    { ...variants[11], dinners: [{ date, expectedMealId: meal.id, extra: true }] },
    { ...variants[11], dinners: [variants[11].dinners[0], variants[11].dinners[0]] },
    { ...variants[12], meals: [meal, meal] },
    { ...variants[14], profile: { ...DEFAULT_COOKING_PROFILE, admin: true } },
    { ...variants[16], bought: 1 },
    { ...variants[17], previous: { ...variants[17].previous, extra: true } },
  ];
  for (const example of examples) assert.throws(() => parseKitchenCommand(command(example)), KitchenCommandValidationError, JSON.stringify(example));
  for (const id of ["__proto__", "constructor", "prototype"]) assert.throws(() => parseKitchenCommand({ ...command(variants[9]), commandId: id }), KitchenCommandValidationError);
  assert.throws(() => parseKitchenCommand(JSON.parse('{"type":"SetFavorite","commandId":"id","expectedRevision":0,"recipeId":"rice","favorite":true,"__proto__":{}}')), KitchenCommandValidationError);
  assert.throws(() => parseKitchenCommand(Object.assign(Object.create({ inherited: true }), command(variants[0]))), KitchenCommandValidationError);
});

test("normal blank purchase dates are allowed and the serialized command remains byte bounded", () => {
  const purchase = command({ ...variants[5], drafts: [{ ...variants[5].drafts[0], useBy: "" }] });
  assert.deepEqual(parseKitchenCommand(purchase), purchase);
  assert.throws(() => parseKitchenCommand(command({ ...variants[3], expectedFingerprint: "é".repeat(1_000_000) })), KitchenCommandValidationError);
});

test("retry identity ignores object key order while retaining preconditions and ordered arrays", async () => {
  const first = command({ type: "AddPantryBatches", batches: [stock, { id: "beans", name: "beans", measure: "2 kg" }] });
  const reordered = { batches: [{ measure: "1 kg", name: "rice", id: "rice" }, { measure: "2 kg", id: "beans", name: "beans" }], type: first.type, expectedRevision: 0, commandId: "intent" };
  assert.equal(await kitchenCommandHash(first), await kitchenCommandHash(reordered));
  assert.notEqual(await kitchenCommandHash(first), await kitchenCommandHash({ ...first, expectedRevision: 1 }));
  assert.notEqual(await kitchenCommandHash(first), await kitchenCommandHash({ ...first, batches: [...first.batches].reverse() }));
  assert.notEqual(await kitchenCommandHash(first), await kitchenCommandHash({ ...first, commandId: "other" }));
  const completion = command({ ...variants[3], expectedFingerprint: '{"meal":"rice","version":1}' });
  assert.notEqual(await kitchenCommandHash(completion), await kitchenCommandHash({ ...completion, expectedFingerprint: '{"version":1,"meal":"rice"}' }), "a serialized fingerprint is an exact string precondition, not a nested command object");
});
