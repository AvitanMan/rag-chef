import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const sources = await createSourceLoader({ name: "pantry-location" });
after(() => sources.dispose());
const { PANTRY_LOCATIONS, SPICE_RACK_ITEMS, pantryLocationLabel, suggestPantryLocation, withPantryLocation } = await sources.import("app/lib/pantry-location.ts");
const { EMPTY_KITCHEN } = await sources.import("app/lib/kitchen-types.ts");
const { validateKitchenState } = await sources.import("app/lib/kitchen-validation.ts");
const { parseKitchenCommand } = await sources.import("app/lib/kitchen-command-validation.ts");
const { applyKitchenCommand } = await sources.import("app/lib/kitchen-commands.ts");
const { pantryInputStock, pantryInputProblem, pantryInputNeedsReview, quickPantryAdditions } = await sources.import("app/lib/pantry-input.ts");
const { samePantryBatch, pantryUsagePreview, pantryBatchUndoProblem, undoPantryBatch } = await sources.import("app/lib/pantry-browser.ts");
const { allocateMealStock, completeMeal, undoMeal } = await sources.import("app/lib/quantities.ts");
const { shoppingForWeek, applyBoughtItems, purchaseUndoProblem, purchasePreviewProblem } = await sources.import("app/lib/shopping-purchases.ts");
const { serializeKitchenBackup, parseKitchenBackup } = await sources.import("app/lib/kitchen-backup.ts");
const { parseCachedKitchen, compareKitchens } = await sources.import("app/lib/kitchen-recovery.ts");

const today = "2026-11-15", week = "2026-11-09", at = "2026-11-15T12:00:00.000Z";
const stock = (id, location, measure = "300 g", name = "rice") => ({ id, name, measure, ...(location ? { location } : {}) });
const kitchen = (pantry = []) => ({ ...structuredClone(EMPTY_KITCHEN), pantry });
const recipe = { id: "rice", title: "Rice", image: null, category: "Dinner", cuisine: "Test", tags: [],
  ingredients: [{ name: "rice", measure: "200 g" }], instructions: ["Cook rice."],
  source: { name: "Test", url: "https://example.test/rice" }, sourceUrl: "https://example.test/rice" };
const dinner = () => ({ id: "dinner", date: today, recipeId: "rice", recipe, title: "Rice",
  baseServings: null, servings: null, batches: 1, locked: false, status: "planned", ingredientOverrides: {},
  planningIngredients: [{ name: "rice", measure: "200 g" }] });
const command = input => ({ commandId: "location-intent", expectedRevision: 1, ...input });
const apply = (state, input) => applyKitchenCommand(state, parseKitchenCommand(command(input)), { revision: 1 });

test("storage choices and exact-name suggestions keep unknown foods Unsorted", () => {
  assert.deepEqual(PANTRY_LOCATIONS, [
    { value: "fridge", label: "Fridge" }, { value: "freezer", label: "Freezer" },
    { value: "cupboard", label: "Cupboard" }, { value: "spice-rack", label: "Spice rack" },
  ]);
  assert.equal(pantryLocationLabel(), "Unsorted");
  for (const item of PANTRY_LOCATIONS) assert.equal(pantryLocationLabel(item.value), item.label);
  assert.deepEqual(SPICE_RACK_ITEMS, ["salt", "black pepper", "paprika", "ground cumin", "ground cinnamon",
    "turmeric", "chili flakes", "dried oregano", "dried thyme", "garlic powder"]);
  for (const name of SPICE_RACK_ITEMS) assert.equal(suggestPantryLocation(name), "spice-rack");
  for (const [name, expected] of [["  MILK ", "fridge"], ["frozen peas", "freezer"], ["olive   oil", "cupboard"],
    ["chicken breast", "fridge"], ["mushrooms", "fridge"], ["potatoes", "cupboard"], ["cooked rice", "fridge"]]) {
    assert.equal(suggestPantryLocation(name), expected);
  }
  for (const name of ["mystery vegetable", "milk powder", "fresh oregano", "rice pudding", "constructor", "__proto__"]) {
    assert.equal(suggestPantryLocation(name), undefined, name);
  }
});

test("changing or clearing a draft location clones it and never saves present undefined", () => {
  const original = Object.freeze(stock("one", "fridge"));
  const moved = withPantryLocation(original, "freezer");
  assert.deepEqual(moved, { ...original, location: "freezer" });
  const cleared = withPantryLocation(moved, undefined);
  assert.equal(Object.hasOwn(cleared, "location"), false);
  assert.equal(original.location, "fridge");
  validateKitchenState(kitchen([cleared]));
});

test("old kitchens, backups and recovery drafts remain Unsorted without data rewriting", () => {
  const state = kitchen([stock("legacy")]);
  const before = structuredClone(state);
  validateKitchenState(state);
  assert.deepEqual(parseKitchenBackup(serializeKitchenBackup(state, at)).state.pantry, before.pantry);
  const cached = parseCachedKitchen(JSON.stringify({ revision: 1, state, dirty: true }));
  assert.deepEqual(cached.state, before);
  assert.equal(Object.hasOwn(cached.state.pantry[0], "location"), false);
  assert.deepEqual(state, before);
});

test("all chosen locations round-trip in backups and recovery detects location-only edits", () => {
  const state = kitchen(PANTRY_LOCATIONS.map(({ value }) => stock(value, value)));
  validateKitchenState(state);
  assert.deepEqual(parseKitchenBackup(serializeKitchenBackup(state, at)).state.pantry, state.pantry);
  const changed = { ...state, pantry: state.pantry.map((item, index) => index ? item : { ...item, location: "freezer" }) };
  assert.equal(compareKitchens(state, changed).pantryChanged, 1);
  assert.deepEqual(parseCachedKitchen(JSON.stringify({ revision: 1, state: changed, dirty: true })).state, changed);
});

test("strict storage validation covers stock, completion snapshots and purchase receipts", () => {
  for (const location of ["pantry", "shelf", "", null, 3, undefined]) {
    const invalid = { ...stock("bad"), location };
    assert.throws(() => validateKitchenState(kitchen([invalid])), /location/);
    const meal = { ...dinner(), status: "cooked", completion: { id: "done", at, deductions: [
      { pantryId: "used", before: "300 g", after: "100 g", name: "rice", location },
    ] } };
    assert.throws(() => validateKitchenState({ ...kitchen(), meals: { [today]: meal } }), /location/);
    assert.throws(() => validateKitchenState({ ...kitchen(), shoppingPurchases: [
      { id: "purchase", week, at, items: [{ key: `${week}:rice`, pantry: invalid }] },
    ] }), /location/);
  }
});

test("input projection keeps chosen storage and strips only preview metadata", () => {
  const row = { name: " Rice ", measure: " 300 g ", location: "cupboard", originalText: "rice: 300 g", reviewReasons: ["Check"] };
  assert.deepEqual(pantryInputStock(row, "row"), { id: "row", name: "rice", measure: "300 g", location: "cupboard" });
  assert.equal(pantryInputProblem([row], []), "");
  assert.match(pantryInputProblem([{ ...row, location: "shelf" }], []), /storage location/);
  assert.equal(pantryInputNeedsReview([{ name: "rice", measure: "", location: "fridge" }], [stock("other", "cupboard")]), false);
});

test("quick additions deduplicate canonical names within a location and keep cross-location stock separate", () => {
  const pantry = [stock("cupboard", "cupboard", "", "onions"), stock("unsorted", undefined, "", "salt")];
  const rows = [{ name: "onion", measure: "", location: "cupboard" },
    { name: "onions", measure: "", location: "fridge" }, { name: "onion", measure: "", location: "fridge" },
    { name: "salt", measure: "" }, { name: "salt", measure: "", location: "spice-rack" }];
  const before = structuredClone({ pantry, rows });
  assert.deepEqual(quickPantryAdditions(rows, pantry, today), [rows[1], rows[4]]);
  assert.deepEqual({ pantry, rows }, before);
  for (const old of [{ ...stock("finished", "freezer"), measure: "0 g" }, { ...stock("past", "freezer"), useBy: "2026-11-14" }]) {
    assert.equal(quickPantryAdditions([{ name: "rice", measure: "", location: "freezer" }], [old], today), null);
    assert.deepEqual(quickPantryAdditions([{ name: "rice", measure: "", location: "cupboard" }], [old], today),
      [{ name: "rice", measure: "", location: "cupboard" }]);
  }
});

test("moving a batch retains identity and makes stale edits, removals and old undo snapshots fail safely", () => {
  const before = stock("same-id", "fridge"), after = { ...before, location: "freezer" };
  const original = kitchen([before]);
  const moved = apply(original, { type: "ReplacePantryBatch", snapshot: before, replacement: after });
  assert.deepEqual(moved.pantry, [after]);
  assert.equal(samePantryBatch(after, before), false);
  assert.strictEqual(apply(moved, { type: "ReplacePantryBatch", snapshot: before, replacement: { ...before, measure: "1 kg" } }), moved);
  assert.strictEqual(apply(moved, { type: "RemovePantryBatch", snapshot: before }), moved);
  const change = { before, after };
  assert.equal(pantryBatchUndoProblem(moved.pantry, change), "");
  assert.deepEqual(undoPantryBatch(moved, change).pantry, [before]);
  const movedAgain = { ...moved, pantry: [{ ...after, location: "cupboard" }] };
  assert.match(pantryBatchUndoProblem(movedAgain.pantry, change), /edited/);
  assert.strictEqual(undoPantryBatch(movedAgain, change), movedAgain);
  assert.equal(pantryUsagePreview(after, "100 g").stock.location, "freezer");
});

test("add, remove and restore commands preserve locations without guessing defaults", () => {
  const rows = [stock("located", "spice-rack", "", "salt"), stock("legacy")];
  const added = apply(kitchen(), { type: "AddPantryBatches", batches: rows });
  assert.deepEqual(added.pantry, rows);
  const removed = apply(added, { type: "RemovePantryBatch", snapshot: rows[0] });
  const restored = apply(removed, { type: "RestoreRemoved", pantry: [rows[0]], meals: [] });
  assert.deepEqual(restored.pantry, [rows[1], rows[0]]);
});

test("allocation remains shared across storage locations and completion receipts retain their origins", () => {
  const pantry = [stock("cupboard", "cupboard", "100 g"), stock("freezer", "freezer", "100 g")];
  const meal = dinner(), original = { ...kitchen(pantry), meals: { [today]: meal } };
  const allocation = allocateMealStock(meal, pantry, today);
  assert.equal(allocation.coverage, 1);
  assert.deepEqual(allocation.deductions.map(item => [item.pantryId, item.location]), [["cupboard", "cupboard"], ["freezer", "freezer"]]);
  const completed = completeMeal(original, today, true, at, today);
  validateKitchenState(completed);
  assert.deepEqual(completed.pantry.map(item => item.location), ["cupboard", "freezer"]);
  const deleted = { ...completed, pantry: [] };
  const restored = undoMeal(deleted, today);
  assert.deepEqual(restored.pantry, pantry);
  validateKitchenState(restored);
});

test("cooking undo respects a later move while restoring removed or incompatible batches to their recorded storage", () => {
  const original = { ...kitchen([stock("rice", "cupboard")]), meals: { [today]: dinner() } };
  const completed = completeMeal(original, today, true, at, today);
  const moved = { ...completed, pantry: [{ ...completed.pantry[0], location: "freezer" }] };
  assert.deepEqual(undoMeal(moved, today).pantry, [stock("rice", "freezer")]);
  const renamed = { ...completed, pantry: [{ ...completed.pantry[0], name: "beans", location: "fridge" }] };
  const restored = undoMeal(renamed, today);
  assert.deepEqual(restored.pantry[0], renamed.pantry[0]);
  assert.equal(restored.pantry[1].location, "cupboard");
  assert.equal(restored.pantry[1].measure, "200 g");
  assert.notEqual(restored.pantry[1].id, "rice");
  const legacy = structuredClone(completed);
  delete legacy.meals[today].completion.deductions[0].location;
  legacy.pantry = [];
  assert.equal(Object.hasOwn(undoMeal(legacy, today).pantry[0], "location"), false);
});

test("purchase drafts preserve location in stock and receipts and later moves block purchase undo", () => {
  const original = { ...kitchen(), meals: { [today]: dinner() } };
  const item = shoppingForWeek(original, week, today)[0];
  const checked = { ...original, shoppingChecked: { [item.key]: true } };
  const drafts = [{ key: item.key, name: item.name, measure: item.measure, pantryId: "bought", location: "cupboard" }];
  const parsed = parseKitchenCommand(command({ type: "RecordPurchase", week, today, drafts, occurredAt: at }));
  assert.equal(parsed.drafts[0].location, "cupboard");
  const added = applyBoughtItems(checked, week, today, drafts, "receipt", at);
  assert.equal(added.pantry[0].location, "cupboard");
  assert.equal(added.shoppingPurchases[0].items[0].pantry.location, "cupboard");
  assert.equal(purchaseUndoProblem(added, added.shoppingPurchases[0]), "");
  const moved = { ...added, pantry: [{ ...added.pantry[0], location: "freezer" }] };
  assert.match(purchaseUndoProblem(moved, added.shoppingPurchases[0]), /edited/);
  assert.deepEqual(parseKitchenBackup(serializeKitchenBackup(added, at)).state.shoppingPurchases, added.shoppingPurchases);
  assert.match(purchasePreviewProblem(checked, week, today, [{ ...drafts[0], location: "shelf" }]), /Choose/);
  assert.throws(() => parseKitchenCommand(command({ type: "RecordPurchase", week, today,
    drafts: [{ ...drafts[0], location: "shelf" }], occurredAt: at })), /location/);
});
