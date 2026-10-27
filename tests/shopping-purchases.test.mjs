import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const directory = await mkdtemp(join(tmpdir(), "jff-shopping-purchases-"));
after(() => rm(directory, { recursive: true, force: true }));
for (const name of ["shopping-purchases", "quantities", "kitchen-types", "kitchen-state", "kitchen-validation", "kitchen-backup"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(directory, `${name}.mjs`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"'));
}
const { shoppingForWeek, unappliedBoughtItems, purchasePreviewProblem, applyBoughtItems, purchaseUndoProblem, undoPurchase, setShoppingItemBought } = await import(pathToFileURL(join(directory, "shopping-purchases.mjs")));
const { completeMeal } = await import(pathToFileURL(join(directory, "quantities.mjs")));
const { createPlannedMeal } = await import(pathToFileURL(join(directory, "kitchen-state.mjs")));
const { validateKitchenState } = await import(pathToFileURL(join(directory, "kitchen-validation.mjs")));
const { serializeKitchenBackup, parseKitchenBackup } = await import(pathToFileURL(join(directory, "kitchen-backup.mjs")));
const week = "2026-10-26", today = "2026-10-27", at = "2026-10-27T12:00:00.000Z";
const recipe = { id: "test:rice", title: "Rice", image: null, category: "", cuisine: "", tags: [], ingredients: [{ name: "rice", measure: "200 g" }], instructions: ["Cook the rice."], source: { name: "Test", url: "https://example.com/rice" }, sourceUrl: "https://example.com/rice" };
function kitchen(ingredients = recipe.ingredients) {
  const meal = createPlannedMeal(today, { ...recipe, ingredients });
  return { schemaVersion: 2, pantry: [{ id: "raw", name: "rice", measure: "100 g" }, { id: "cooked", name: "cooked rice", measure: "400 g" }], meals: { [today]: meal }, shoppingChecked: {}, migratedLegacy: true };
}
function preview(state) {
  const items = shoppingForWeek(state, week, today);
  const checked = { ...state, shoppingChecked: Object.fromEntries(items.map((item) => [item.key, true])) };
  const drafts = items.map((item, index) => ({ key: item.key, name: item.name, measure: item.measure, pantryId: `purchase-stock-${index}` }));
  return { checked, drafts };
}

test("shopping checks alone do not alter stock; reviewed purchases add separate raw batches once", () => {
  const original = kitchen(), { checked, drafts } = preview(original);
  assert.deepEqual(checked.pantry, original.pantry);
  assert.equal(unappliedBoughtItems(checked, shoppingForWeek(checked, week, today)).length, 1);
  const added = applyBoughtItems(checked, week, today, drafts, "purchase", at);
  assert.deepEqual(added.pantry.slice(0, 2), original.pantry);
  assert.deepEqual(added.pantry[2], { id: "purchase-stock-0", name: "rice", measure: "100 g" });
  assert.deepEqual(shoppingForWeek(added, week, today), []);
  assert.equal(applyBoughtItems(added, week, today, drafts, "purchase", at), added);
  assert.equal(applyBoughtItems(added, week, today, drafts, "different-id", at), added);
  validateKitchenState(added);
});

test("replaying a checked key after stock is consumed cannot add the purchase again", () => {
  const { checked, drafts } = preview(kitchen());
  const added = applyBoughtItems(checked, week, today, drafts, "purchase", at);
  const used = { ...added, pantry: added.pantry.map((stock) => stock.id === "purchase-stock-0" ? { ...stock, measure: "0 g" } : stock) };
  assert.equal(shoppingForWeek(used, week, today)[0].key, drafts[0].key);
  assert.deepEqual(unappliedBoughtItems(used, shoppingForWeek(used, week, today)), []);
  assert.equal(applyBoughtItems(used, week, today, drafts, "replay", at), used);
  const restored = parseKitchenBackup(serializeKitchenBackup(used, at)).state;
  assert.equal(applyBoughtItems(restored, week, today, drafts, "replay", at), restored);
});

test("preview rejects stale totals, unchecks, duplicate rows, invalid quantities and pantry limits", () => {
  const { checked, drafts } = preview(kitchen());
  for (const state of [
    { ...checked, shoppingChecked: {} },
    { ...checked, pantry: checked.pantry.map((stock) => stock.id === "raw" ? { ...stock, measure: "150 g" } : stock) },
    { ...checked, meals: {} },
    { ...checked, pantry: Array.from({ length: 500 }, (_, i) => ({ id: `stock-${i}`, name: "salt", measure: "1 g" })) },
  ]) assert.equal(applyBoughtItems(state, week, today, drafts, "purchase", at), state);
  assert.notEqual(purchasePreviewProblem(checked, week, today, [...drafts, ...drafts]), "");
  for (const measure of ["-5 g", "1/0 cup", "0 g", "Infinity"]) assert.notEqual(purchasePreviewProblem(checked, week, today, [{ ...drafts[0], measure }]), "");
});

test("unknown amounts and incompatible units remain reviewable separate stock", () => {
  for (const measure of ["", "1 cup", "one bag"]) {
    const { checked, drafts } = preview(kitchen());
    const added = applyBoughtItems(checked, week, today, [{ ...drafts[0], measure }], "purchase", at);
    validateKitchenState(added);
    assert.equal(added.pantry[2].measure, measure);
    assert.equal(shoppingForWeek(added, week, today)[0].measure, "100 g");
    assert.equal(shoppingForWeek(added, week, today)[0].needsReview, true);
  }
});

test("undo removes only unchanged purchased rows and allows a corrected purchase", () => {
  const { checked, drafts } = preview(kitchen());
  const added = applyBoughtItems(checked, week, today, drafts, "purchase", at);
  const unrelatedEdit = { ...added, pantry: added.pantry.map((stock) => stock.id === "cooked" ? { ...stock, measure: "350 g" } : stock) };
  const undone = undoPurchase(unrelatedEdit, "purchase");
  assert.equal(undone.pantry.length, 2);
  assert.equal(undone.pantry[1].measure, "350 g");
  assert.deepEqual(undone.shoppingPurchases, []);
  assert.equal(undoPurchase(undone, "purchase"), undone);
  assert.notEqual(applyBoughtItems(undone, week, today, drafts, "corrected", at), undone);
  for (const field of [{ measure: "50 g" }, { name: "cooked rice" }, { useBy: "2026-10-30" }]) {
    const edited = { ...added, pantry: added.pantry.map((stock) => stock.id === "purchase-stock-0" ? { ...stock, ...field } : stock) };
    assert.notEqual(purchaseUndoProblem(edited, edited.shoppingPurchases[0]), "");
    assert.equal(undoPurchase(edited, "purchase"), edited);
  }
  const removed = { ...added, pantry: added.pantry.slice(0, 2) };
  assert.equal(undoPurchase(removed, "purchase"), removed);
});

test("purchase history is optional in old backups and validates duplicate identities and malformed entries", () => {
  validateKitchenState(kitchen());
  assert.equal(parseKitchenBackup(serializeKitchenBackup(kitchen(), at)).state.shoppingPurchases, undefined);
  const { checked, drafts } = preview(kitchen());
  const added = applyBoughtItems(checked, week, today, drafts, "purchase", at);
  for (const patch of [
    { at: "2026-02-30T12:00:00.000Z" }, { week: "invalid" }, { items: [] },
    { items: [added.shoppingPurchases[0].items[0], added.shoppingPurchases[0].items[0]] },
  ]) assert.throws(() => validateKitchenState({ ...added, shoppingPurchases: [{ ...added.shoppingPurchases[0], ...patch }] }));
  assert.throws(() => validateKitchenState({ ...added, shoppingPurchases: [added.shoppingPurchases[0], added.shoppingPurchases[0]] }));
});

test("a fresh shopping cycle allows the same shortage again after the earlier dinner is cooked", () => {
  const monday = week, tuesday = today;
  let state = { ...kitchen(), pantry: [], meals: { [monday]: createPlannedMeal(monday, recipe) } };
  const first = shoppingForWeek(state, week, monday)[0];
  state = setShoppingItemBought(state, first.key, true, "cycle-one");
  const firstDraft = { key: first.key, cycleId: "cycle-one", name: first.name, measure: first.measure, pantryId: "first-purchase" };
  state = applyBoughtItems(state, week, monday, [firstDraft], "receipt-one", "2026-10-26T12:00:00.000Z");
  state = completeMeal(state, monday, true, "2026-10-26T12:30:00.000Z");
  state = { ...state, meals: { ...state.meals, [tuesday]: createPlannedMeal(tuesday, recipe) } };
  const second = shoppingForWeek(state, week, tuesday)[0];
  assert.equal(second.key, first.key);
  assert.equal(state.pantry[0].measure, "0 g");
  assert.equal(applyBoughtItems(state, week, tuesday, [firstDraft], "replayed-receipt", at), state);
  state = setShoppingItemBought(state, second.key, false, "ignored");
  state = setShoppingItemBought(state, second.key, true, "cycle-two");
  assert.equal(setShoppingItemBought(state, second.key, true, "duplicate-event"), state);
  assert.equal(unappliedBoughtItems(state, [second]).length, 1);
  assert.equal(applyBoughtItems(state, week, tuesday, [firstDraft], "stale-preview", at), state);
  const secondDraft = { ...firstDraft, cycleId: "cycle-two", pantryId: "second-purchase" };
  const added = applyBoughtItems(state, week, tuesday, [secondDraft], "receipt-two", at);
  assert.deepEqual(added.pantry.map(p => p.measure), ["0 g", "200 g"]);
  assert.equal(added.shoppingPurchases.length, 2);
  assert.deepEqual(added.shoppingPurchases.map(p => p.items[0].key), [first.key, first.key]);
  validateKitchenState(added);
  const restored = parseKitchenBackup(serializeKitchenBackup(added, at)).state;
  assert.equal(applyBoughtItems(restored, week, tuesday, [secondDraft], "replayed-second", at), restored);
  const undone = undoPurchase(restored, "receipt-two");
  assert.deepEqual(undone.pantry.map(p => p.measure), ["0 g"]);
  assert.equal(undone.shoppingPurchases[0].id, "receipt-one");
});

test("an unchecked and rechecked item invalidates an open purchase preview", () => {
  const { checked, drafts } = preview(kitchen());
  const first = { ...checked, shoppingCycles: { [drafts[0].key]: "old-cycle" } };
  const staleDraft = { ...drafts[0], cycleId: "old-cycle" };
  assert.equal(purchasePreviewProblem(first, week, today, [staleDraft]), "");
  const unchecked = setShoppingItemBought(first, staleDraft.key, false, "ignored");
  const rechecked = setShoppingItemBought(unchecked, staleDraft.key, true, "new-cycle");
  assert.notEqual(purchasePreviewProblem(rechecked, week, today, [staleDraft]), "");
  assert.equal(purchasePreviewProblem(rechecked, week, today, [{ ...staleDraft, cycleId: "new-cycle" }]), "");
});

test("legacy receipts and cycle-aware receipts round-trip without weakening cycle uniqueness", () => {
  const { checked, drafts } = preview(kitchen());
  const legacy = applyBoughtItems(checked, week, today, drafts, "legacy", at);
  const used = { ...legacy, pantry: legacy.pantry.map(p => p.id === drafts[0].pantryId ? { ...p, measure: "0 g" } : p) };
  const rechecked = setShoppingItemBought(setShoppingItemBought(used, drafts[0].key, false, "ignored"), drafts[0].key, true, "new-cycle");
  const added = applyBoughtItems(rechecked, week, today, [{ ...drafts[0], cycleId: "new-cycle", pantryId: "new-batch" }], "new-receipt", at);
  assert.equal(added.shoppingPurchases.length, 2);
  validateKitchenState(added);
  assert.deepEqual(parseKitchenBackup(serializeKitchenBackup(added, at)).state, added);
  assert.throws(() => validateKitchenState({ ...added, shoppingCycles: { key: "" } }));
  assert.throws(() => validateKitchenState({ ...added, shoppingCycles: { key: 12 } }));
  const duplicate = { ...added.shoppingPurchases[1], id: "duplicate", items: [{ ...added.shoppingPurchases[1].items[0], pantry: { id: "another-stock", name: "rice", measure: "100 g" } }] };
  assert.throws(() => validateKitchenState({ ...added, shoppingPurchases: [...added.shoppingPurchases, duplicate] }));
});
