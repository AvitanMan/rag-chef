import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const directory = await mkdtemp(join(tmpdir(), "jff-pantry-browser-"));
after(() => rm(directory, { recursive: true, force: true }));
for (const name of ["pantry-browser", "recipe-browser", "quantities", "kitchen-types", "kitchen-state", "kitchen-validation", "use-soon", "recipe-constraints", "recipe-safety"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"');
  await writeFile(join(directory, `${name}.mjs`), code);
}
const load = name => import(pathToFileURL(join(directory, `${name}.mjs`)).href);
const { browsePantry, compatiblePantryTotals, groupPantryBatches, pantryWeekReservations, pantryDateInputProblem, pantryBatchProblem,
  pantryUsagePreview, replacePantryBatch, samePantryBatch, pantryBatchUndoProblem, undoPantryBatch } = await load("pantry-browser");
const { pantryDateGroups } = await load("use-soon");
const { EMPTY_KITCHEN } = await load("kitchen-types");
const TODAY = "2026-10-22";
const WEEK = "2026-10-19";
const stock = (id, name = "rice", measure = "500 g", useBy) => ({ id, name, measure, ...(useBy ? { useBy } : {}) });
const kitchen = pantry => ({ ...EMPTY_KITCHEN, pantry });
const meal = (id, date = TODAY, measure = "200 g", status = "planned", name = "rice") => ({
  id, date, recipeId: id, recipe: null, title: id, baseServings: null, servings: null, batches: 1,
  ingredientOverrides: {}, locked: false, status, planningIngredients: [{ name, measure }],
});
const quantities = amounts => Object.fromEntries(amounts.map(amount => [amount.dimension, amount.quantity]));

test("search and sorting are display-only and retain original batch values", () => {
  const pantry = [stock("a", "Red onions", "2", "2026-10-25"), stock("b", "rice", "500 g"), stock("c", "red onion", "1", TODAY)];
  const before = structuredClone(pantry);
  assert.deepEqual(browsePantry(pantry, "RED, ONION", "current").map(item => item.id), ["a", "c"]);
  assert.deepEqual(browsePantry(pantry, "", "name").map(item => item.id), ["c", "a", "b"]);
  assert.deepEqual(browsePantry(pantry, "", "useBy").map(item => item.id), ["c", "a", "b"]);
  assert.equal(browsePantry([stock("accent", "Crème fraîche")], "creme fraiche", "current").length, 1);
  assert.deepEqual(pantry, before);
  assert.equal(browsePantry(pantry, "rice", "current")[0], pantry[1]);
});

test("canonical visual groups keep separate batch IDs, names, raw amounts and dates", () => {
  const pantry = [stock("first", "rice", "500 g", "2026-10-21"), stock("second", "raw rice", "1 kg", "2026-10-25"),
    stock("leftover", "cooked rice", "100 g", TODAY), stock("noodles", "rice noodles", "200 g"), stock("note", "uncooked rice", "some")];
  const before = structuredClone(pantry);
  const groups = groupPantryBatches(pantry);
  assert.deepEqual(groups.map(group => group.key), ["rice", "cooked rice", "rice noodles"]);
  assert.deepEqual(groups[0].batches, [pantry[0], pantry[1], pantry[4]]);
  assert.equal(groups[0].batches[0], pantry[0]);
  assert.deepEqual(quantities(groups[0].onHand), { mass: 1500 });
  assert.equal(groups[0].unknownCount, 1);
  assert.deepEqual(pantry, before);
});

test("only compatible dimensions total together, including distinct package and piece counts", () => {
  const pantry = ["1 kg", "250 g", "2 cups", "500 ml", "2", "1 can", "2 cans", "2 jars"].map((measure, index) => stock(String(index), "tomatoes", measure));
  const [group] = groupPantryBatches(pantry);
  assert.equal(group.key, "tomato");
  assert.deepEqual(quantities(group.onHand), { mass: 1250, volume: 980, count: 2, "count:can": 3, "count:jar": 2 });
  assert.equal(group.batches.length, 8);
  assert.equal(group.unknownCount, 0);
  assert.equal(group.emptyCount, 0);
});

test("unknown amounts are neither zeros nor unlimited stock, while empty batches remain visible", () => {
  const pantry = ["", "a little", "0 g", "0 cans"].map((measure, index) => stock(String(index), "rice", measure));
  const [group] = groupPantryBatches(pantry);
  assert.equal(group.batches.length, 4);
  assert.equal(group.unknownCount, 2);
  assert.equal(group.emptyCount, 2);
  assert.deepEqual(quantities(group.onHand), { mass: 0, "count:can": 0 });
  assert.deepEqual(compatiblePantryTotals([null, null]), []);
});

test("reservations explain a shared batch by date, including locked meals but not cooked or other weeks", () => {
  const pantry = [stock("past", "rice", "50 g", "2026-10-21"), stock("first", "rice", "100 g", TODAY),
    stock("second", "raw rice", "500 g", "2026-10-25"), stock("unknown", "rice", ""), stock("volume", "rice", "1 l")];
  const meals = [{ ...meal("later", "2026-10-23"), title: "Rice bowl" }, { ...meal("today"), title: "Rice bowl", locked: true },
    { ...meal("cooked", "2026-10-24", "200 g", "cooked"), locked: true,
      completion: { id: "done", at: `${TODAY}T18:00:00Z`, deductions: [{ pantryId: "second", before: "700 g", after: "500 g" }] } },
    meal("other-week", "2026-10-29", "500 g"), meal("previous-week", "2026-10-18", "500 g")];
  const before = structuredClone({ pantry, meals });
  const result = pantryWeekReservations(pantry, meals, WEEK, TODAY);
  assert.equal(result.mealCount, 2);
  assert.equal(result.byId.get("first").reserved.quantity, 100);
  assert.equal(result.byId.get("first").available.quantity, 0);
  assert.equal(result.byId.get("second").reserved.quantity, 300);
  assert.equal(result.byId.get("second").available.quantity, 200);
  assert.equal(result.byId.get("past").available.quantity, 0);
  assert.equal(result.byId.get("past").reserved.quantity, 0);
  assert.deepEqual(result.byId.get("unknown"), { reserved: null, available: null, reservations: [] });
  assert.equal(result.byId.get("volume").available.quantity, 1000);
  assert.deepEqual(result.byId.get("first").reservations, [{ mealId: "today", date: TODAY, title: "Rice bowl", measure: "100 g" }]);
  assert.deepEqual(result.byId.get("second").reservations, [
    { mealId: "today", date: TODAY, title: "Rice bowl", measure: "100 g" },
    { mealId: "later", date: "2026-10-23", title: "Rice bowl", measure: "200 g" },
  ]);
  for (const id of ["past", "volume"]) assert.deepEqual(result.byId.get(id).reservations, []);
  assert.equal(groupPantryBatches(pantry)[0].onHand.find(amount => amount.dimension === "mass").quantity, 650);
  assert.deepEqual(pantryWeekReservations(pantry, [...meals].reverse(), TODAY, TODAY), result);
  assert.deepEqual({ pantry, meals }, before);
});

test("earliest eligible dated batches supply explanations by ID even when all names match", () => {
  const pantry = [stock("undated"), stock("later", "rice", "500 g", "2026-10-25"),
    stock("first", "rice", "150 g", TODAY), stock("past", "rice", "50 g", "2026-10-21")];
  const meals = [{ ...meal("dinner"), title: "Dinner rice" }];
  const result = pantryWeekReservations(pantry, meals, WEEK, TODAY);
  assert.deepEqual(result.byId.get("first").reservations, [{ mealId: "dinner", date: TODAY, title: "Dinner rice", measure: "150 g" }]);
  assert.deepEqual(result.byId.get("later").reservations, [{ mealId: "dinner", date: TODAY, title: "Dinner rice", measure: "50 g" }]);
  for (const id of ["undated", "past"]) {
    assert.deepEqual(result.byId.get(id).reservations, []);
    assert.equal(result.byId.get(id).reserved.quantity, 0);
  }
  assert.equal(result.byId.get("later").available.quantity, 450);
  assert.deepEqual(pantryWeekReservations([...pantry].reverse(), meals, WEEK, TODAY), result);
});

test("filtered and searched batches do not steal reservations from hidden batches", () => {
  const pantry = [stock("hidden-first", "rice", "100 g", TODAY), stock("searched", "raw rice", "500 g", "2026-10-25")];
  const result = pantryWeekReservations(pantry, [meal("dinner")], WEEK, TODAY);
  const visible = browsePantry(pantryDateGroups(pantry, TODAY).soon, "raw", "name");
  assert.deepEqual(visible.map(item => item.id), ["searched"]);
  assert.equal(result.byId.get(visible[0].id).reserved.quantity, 100);
  assert.equal(result.byId.get(visible[0].id).available.quantity, 400);
  assert.deepEqual(result.byId.get(visible[0].id).reservations, [{ mealId: "dinner", date: TODAY, title: "dinner", measure: "100 g" }]);
  assert.deepEqual(result.byId.get("hidden-first").reservations, [{ mealId: "dinner", date: TODAY, title: "dinner", measure: "100 g" }]);
  assert.equal(groupPantryBatches(pantry)[0].onHand[0].quantity, 600);
});

test("dinner dates constrain reservations without erasing physical or currently available food", () => {
  const pantry = [stock("early", "rice", "100 g", "2026-10-23"), stock("later", "rice", "400 g", "2026-10-25")];
  const result = pantryWeekReservations(pantry, [meal("saturday", "2026-10-24", "300 g")], WEEK, TODAY);
  assert.equal(result.byId.get("early").reserved.quantity, 0);
  assert.equal(result.byId.get("early").available.quantity, 100);
  assert.equal(result.byId.get("later").reserved.quantity, 300);
  assert.equal(result.byId.get("later").available.quantity, 100);
  assert.deepEqual(result.byId.get("early").reservations, []);
  assert.deepEqual(result.byId.get("later").reservations, [{ mealId: "saturday", date: "2026-10-24", title: "saturday", measure: "300 g" }]);
  const expired = pantryWeekReservations(pantry, [meal("past-dinner", TODAY, "300 g")], WEEK, "2026-10-26");
  assert.equal(expired.byId.get("early").available.quantity, 0);
  assert.equal(expired.byId.get("later").available.quantity, 0);
  for (const batch of expired.byId.values()) {
    assert.equal(batch.reserved.quantity, 0);
    assert.deepEqual(batch.reservations, []);
  }
  assert.equal(groupPantryBatches(pantry)[0].onHand[0].quantity, 500);
});

test("reservation measures combine compatible ingredients and respect scaling, overrides and distinct units", () => {
  const pantry = [stock("mass", "rice", "1 kg"), stock("volume", "rice", "2 l"), stock("pieces", "rice", "6"),
    stock("cans", "rice", "3 cans"), stock("jars", "rice", "3 jars")];
  const dinner = { ...meal("dinner"), baseServings: 2, servings: 4, ingredientOverrides: { "1": "75 g" },
    planningIngredients: [{ name: "rice", measure: "0.1 kg" }, { name: "raw rice", measure: "50 g" },
      { name: "rice", measure: "2 cups" }, { name: "rice", measure: "1" }, { name: "rice", measure: "1 can" }] };
  const before = structuredClone({ pantry, dinner });
  const result = pantryWeekReservations(pantry, [dinner], WEEK, TODAY);
  for (const [id, measure, reserved, available] of [["mass", "275 g", 275, 725], ["volume", "960 ml", 960, 1040],
    ["pieces", "2", 2, 4], ["cans", "2 cans", 2, 1]]) {
    assert.deepEqual(result.byId.get(id).reservations, [{ mealId: "dinner", date: TODAY, title: "dinner", measure }]);
    assert.equal(result.byId.get(id).reserved.quantity, reserved);
    assert.equal(result.byId.get(id).available.quantity, available);
  }
  assert.deepEqual(result.byId.get("jars").reservations, []);
  assert.deepEqual({ pantry, dinner }, before);
});

test("multiple deductions aggregate per meal and batch using a single allocation result", async () => {
  const source = await readFile(join(directory, "pantry-browser.mjs"), "utf8");
  await writeFile(join(directory, "split-pantry-browser.mjs"), source.replace('"./quantities.mjs"', '"./split-quantities.mjs"'));
  // Exercise repeated deduction records even though the current allocator groups ingredient requirements first.
  await writeFile(join(directory, "split-quantities.mjs"), `
    export * from "./quantities.mjs";
    import { allocateStockForMeals as allocate, parseMeasure, formatMeasure } from "./quantities.mjs";
    export let calls = 0;
    export function allocateStockForMeals(...args) {
      calls++;
      const result = allocate(...args);
      for (const allocation of result.allocations) {
        allocation.deductions = allocation.deductions.flatMap(deduction => {
          const before = parseMeasure(deduction.before);
          const after = parseMeasure(deduction.after);
          const middle = formatMeasure((before.quantity + after.quantity) / 2, before.unit);
          return [{ ...deduction, after: middle }, { ...deduction, before: middle },
            { ...deduction, before: deduction.after }];
        });
      }
      return result;
    }
  `);
  const { pantryWeekReservations: splitReservations } = await load("split-pantry-browser");
  const counter = await load("split-quantities");
  const pantry = [stock("later", "rice", "1 kg", "2026-10-25"), stock("first", "rice", "0.3 kg", TODAY)];
  const meals = [meal("tomorrow", "2026-10-23"), meal("today", TODAY, "500 g")];
  const result = splitReservations(pantry, meals, WEEK, TODAY);
  assert.equal(counter.calls, 1);
  assert.deepEqual(result, pantryWeekReservations(pantry, meals, WEEK, TODAY));
  assert.deepEqual(result.byId.get("later").reservations, [
    { mealId: "today", date: TODAY, title: "today", measure: "200 g" },
    { mealId: "tomorrow", date: "2026-10-23", title: "tomorrow", measure: "200 g" },
  ]);
});

test("unknown amounts and unmatched units do not invent confirmed reservations or cover shortfalls", () => {
  const pantry = [stock("blank", "rice", ""), stock("note", "rice", "some"), stock("empty", "rice", "0 g"),
    stock("known"), stock("volume", "rice", "1 l")];
  for (const measure of ["", "to taste", "0 g"]) {
    const result = pantryWeekReservations(pantry, [meal("unmeasured", TODAY, measure)], WEEK, TODAY);
    assert.equal(result.mealCount, 1);
    for (const batch of result.byId.values()) assert.deepEqual(batch.reservations, []);
    assert.equal(result.byId.get("known").reserved.quantity, 0);
    assert.equal(result.byId.get("known").available.quantity, 500);
  }
  const result = pantryWeekReservations(pantry, [meal("shortfall", TODAY, "800 g")], WEEK, TODAY);
  assert.deepEqual(result.byId.get("known").reservations, [{ mealId: "shortfall", date: TODAY, title: "shortfall", measure: "500 g" }]);
  assert.equal(result.byId.get("known").available.quantity, 0);
  for (const id of ["blank", "note"]) assert.deepEqual(result.byId.get(id), { reserved: null, available: null, reservations: [] });
  for (const id of ["empty", "volume"]) {
    assert.deepEqual(result.byId.get(id).reservations, []);
    assert.equal(result.byId.get(id).reserved.quantity, 0);
  }
});

test("reservation explanations leave source recipes, planning ingredients, overrides and stock untouched", () => {
  const ingredients = [{ name: "rice", measure: "100 g" }];
  const recipe = { id: "source", title: "Source rice", ingredients };
  const pantry = [stock("batch")];
  const meals = [{ ...meal("snapshot"), title: "Saved dinner", recipe, planningIngredients: ingredients, ingredientOverrides: { "0": "150 g" } },
    { ...meal("fallback", "2026-10-23"), title: "", recipe, planningIngredients: ingredients },
    { ...meal("untitled", "2026-10-24", "50 g"), title: "" }];
  const before = structuredClone({ pantry, meals, recipe });
  const result = pantryWeekReservations(pantry, meals, WEEK, TODAY);
  assert.deepEqual(result.byId.get("batch").reservations, [
    { mealId: "snapshot", date: TODAY, title: "Saved dinner", measure: "150 g" },
    { mealId: "fallback", date: "2026-10-23", title: "Source rice", measure: "100 g" },
    { mealId: "untitled", date: "2026-10-24", title: "Untitled meal", measure: "50 g" },
  ]);
  result.byId.get("batch").reservations[0].title = "Display-only change";
  result.byId.get("batch").reservations[0].measure = "0 g";
  assert.deepEqual({ pantry, meals, recipe }, before);
  assert.equal(meals[0].planningIngredients, ingredients);
  assert.equal(recipe.ingredients, ingredients);
});

test("undated review includes unknown amounts but not finished batches", () => {
  const pantry = [stock("missing", "rice", ""), stock("note", "salt", "to taste"), stock("measured"),
    stock("zero", "rice", "0 g"), stock("today", "rice", "500 g", TODAY), stock("past", "rice", "1 g", "2026-10-21")];
  const groups = pantryDateGroups(pantry, TODAY);
  assert.deepEqual(groups.undated.map(item => item.id), ["missing", "note", "measured"]);
  assert.deepEqual(groups.soon.map(item => item.id), ["today"]);
  assert.deepEqual(groups.past.map(item => item.id), ["past"]);
  assert.equal(groups.all, pantry);
});

test("date drafts validate actual calendar days and accept an explicitly unknown date", () => {
  for (const value of ["", "2028-02-29", TODAY, "0001-01-01", "9999-12-31"]) assert.equal(pantryDateInputProblem(value), "", value);
  for (const value of ["2026-02-29", "2026-13-01", "2026-04-31", "0000-01-01", "2026-1-01", "2026-10", "2026-10-22T00:00:00Z"]) assert.ok(pantryDateInputProblem(value), value);
});

test("batch corrections preserve IDs and unrelated kitchen data without merging aliases", () => {
  const original = stock("first", "rice", "500 g", TODAY);
  const other = stock("other", "cooked rice", "200 g");
  const state = { ...kitchen([original, other]), shoppingChecked: { bought: true }, meals: { [TODAY]: meal("saved") } };
  const before = structuredClone(state);
  const next = replacePantryBatch(state, { ...original }, { id: original.id, name: "cooked rice", measure: "450 g" });
  assert.deepEqual(next.pantry, [{ id: "first", name: "cooked rice", measure: "450 g" }, other]);
  assert.equal(next.pantry[1], other);
  assert.equal(next.meals, state.meals);
  assert.equal(next.shoppingChecked, state.shoppingChecked);
  assert.deepEqual(state, before);
  assert.equal(groupPantryBatches(next.pantry).length, 1);
  assert.equal(next.pantry.length, 2);
});

test("the functional update refuses a stale name, amount, date, removed batch or changed ID", () => {
  const snapshot = stock("first", "rice", "500 g", TODAY);
  const correction = { ...snapshot, measure: "200 g" };
  for (const current of [{ ...snapshot, name: "cooked rice" }, { ...snapshot, measure: "499 g" }, { ...snapshot, useBy: "2026-10-23" }, { id: "first", name: "rice", measure: "500 g" }]) {
    const state = kitchen([current]);
    assert.equal(samePantryBatch(current, snapshot), false);
    assert.equal(replacePantryBatch(state, snapshot, correction), state);
  }
  const removed = kitchen([]);
  assert.equal(replacePantryBatch(removed, snapshot, correction), removed);
  const state = kitchen([snapshot]);
  assert.equal(replacePantryBatch(state, snapshot, { ...correction, id: "new-id" }), state);
  assert.equal(replacePantryBatch(state, snapshot, { ...snapshot }), state);
  assert.equal(samePantryBatch(undefined, snapshot), false);
});

test("corrections apply persistence validation and never save malformed drafts", () => {
  const snapshot = stock("first");
  const state = kitchen([snapshot]);
  for (const change of [{ name: "" }, { name: "x".repeat(201) }, { measure: "-2 g" }, { measure: "1/0 cup" }, { measure: "Infinity" }, { measure: "1000000001 g" }, { useBy: "2026-02-29" }]) {
    const replacement = { ...snapshot, ...change };
    assert.ok(pantryBatchProblem(replacement));
    assert.equal(replacePantryBatch(state, snapshot, replacement), state);
  }
  assert.equal(pantryBatchProblem({ ...snapshot, measure: "some" }), "");
  assert.equal(pantryBatchProblem({ ...snapshot, measure: "" }), "");
});

test("usage subtracts compatible physical stock rather than already-reserved availability", () => {
  const snapshot = stock("first", "rice", "500 g", TODAY);
  const state = { ...kitchen([snapshot]), meals: { [TODAY]: meal("dinner", TODAY, "450 g") } };
  assert.equal(pantryWeekReservations(state.pantry, Object.values(state.meals), WEEK, TODAY).byId.get(snapshot.id).available.quantity, 50);
  const preview = pantryUsagePreview(snapshot, "0.1 kg");
  assert.equal(preview.problem, "");
  assert.deepEqual(preview.stock, { ...snapshot, measure: "400 g" });
  const next = replacePantryBatch(state, snapshot, preview.stock);
  assert.equal(next.meals, state.meals);
  assert.equal(snapshot.measure, "500 g");
  assert.equal(pantryUsagePreview(snapshot, "500 g").stock.measure, "0 g");
  assert.equal(pantryUsagePreview(stock("cans", "tomato", "2 cans"), "1 can").stock.measure, "1 can");
});

test("usage refuses unknown, incompatible, invalid or excessive deductions", () => {
  for (const onHand of ["", "some"]) assert.match(pantryUsagePreview(stock("first", "rice", onHand), "10 g").problem, /unknown/);
  for (const used of ["", "some", "0 g", "-1 g", "1/0 g", "Infinity", "501 g", "1 cup", "2 cans", "2"]) {
    const result = pantryUsagePreview(stock("first"), used);
    assert.equal(result.stock, null, used);
    assert.ok(result.problem, used);
  }
  assert.match(pantryUsagePreview(stock("can", "tomato", "2 cans"), "1 jar").problem, /compatible/);
});

test("marking a batch finished keeps its identity and date, and is snapshot-guarded", () => {
  const snapshot = stock("first", "rice", "some", TODAY);
  const state = kitchen([snapshot]);
  const finished = { ...snapshot, measure: "0" };
  const next = replacePantryBatch(state, snapshot, finished);
  assert.deepEqual(next.pantry, [finished]);
  assert.equal(groupPantryBatches(next.pantry)[0].emptyCount, 1);
  assert.equal(pantryDateGroups(next.pantry, TODAY).soon.length, 0);
  assert.equal(pantryDateGroups(next.pantry, TODAY).all.length, 1);
  const changed = kitchen([{ ...snapshot, measure: "200 g" }]);
  assert.equal(replacePantryBatch(changed, snapshot, finished), changed);
});

test("correction undo restores exact names, dates and unknown amounts without mutating snapshots", () => {
  const changes = [
    { before: stock("batch", "raw rice", "some", TODAY), after: stock("batch", "cooked rice", "250 g", "2026-10-25") },
    { before: stock("batch", "Rice", "", TODAY), after: stock("batch", "rice", "500 g") },
    { before: stock("batch", "rice", "a little"), after: stock("batch", "rice", "250 g", TODAY) },
  ];
  for (const change of changes) {
    const original = kitchen([change.before]);
    const state = replacePantryBatch(original, change.before, change.after);
    const snapshot = structuredClone({ state, change });
    assert.notEqual(state, original);
    assert.equal(pantryBatchUndoProblem(state.pantry, change), "");
    const restored = undoPantryBatch(state, change);
    assert.deepEqual(restored, original);
    assert.notEqual(restored.pantry[0], change.before);
    assert.deepEqual({ state, change }, snapshot);
  }
});

test("usage and finished undo restore original raw amounts once without recreating IDs", () => {
  const measured = stock("batch", "rice", "0.5 kg", TODAY);
  const usage = pantryUsagePreview(measured, "100 g");
  assert.equal(usage.problem, "");
  const changes = [{ before: measured, after: usage.stock }, ...["500 g", "some", ""].map(measure => ({
    before: stock("batch", "rice", measure, TODAY), after: stock("batch", "rice", "0", TODAY),
  }))];
  for (const change of changes) {
    const original = kitchen([change.before]);
    const state = replacePantryBatch(original, change.before, change.after);
    assert.equal(pantryBatchUndoProblem(state.pantry, change), "");
    const restored = undoPantryBatch(state, change);
    assert.deepEqual(restored, original);
    assert.equal(restored.pantry.length, 1);
    assert.equal(restored.pantry[0].id, "batch");
    assert.ok(pantryBatchUndoProblem(restored.pantry, change));
    assert.equal(undoPantryBatch(restored, change), restored);
  }
});

test("undo validates both snapshots and refuses invalid, mismatched-ID or no-op changes", () => {
  const before = stock("batch", "rice", "500 g", TODAY);
  const after = { ...before, measure: "400 g" };
  const state = kitchen([after]);
  const snapshot = structuredClone(state);
  const invalid = [undefined, null, {}, { ...before, id: "" }, { ...before, id: "x".repeat(201) },
    { ...before, name: "" }, { ...before, measure: "-1 g" }, { ...before, measure: "1/0 cup" },
    { ...before, measure: "Infinity" }, { ...before, measure: "1000000001 g" },
    { ...before, useBy: "2026-02-29" }, { ...before, useBy: undefined }, { ...before, extra: true }];
  for (const field of ["before", "after"]) {
    for (const value of invalid) {
      const change = { before, after, [field]: value };
      assert.match(pantryBatchUndoProblem(state.pantry, change), /invalid/i);
      assert.equal(undoPantryBatch(state, change), state);
    }
  }
  for (const change of [{ before: { ...before, id: "other" }, after }, { before, after: { ...after, id: "other" } }]) {
    assert.match(pantryBatchUndoProblem(state.pantry, change), /same batch/);
    assert.equal(undoPantryBatch(state, change), state);
  }
  const unchanged = { before: { ...after }, after: { ...after } };
  assert.match(pantryBatchUndoProblem(state.pantry, unchanged), /no batch change/);
  assert.equal(undoPantryBatch(state, unchanged), state);
  assert.deepEqual(state, snapshot);
});

test("undo rechecks exact current values and refuses stale renames, dates, usage and removal", () => {
  const before = stock("batch", "rice", "500 g", TODAY);
  const after = { ...before, measure: "400 g" };
  const change = { before, after };
  assert.equal(pantryBatchUndoProblem([after], change), "");
  const other = stock("same-name-other-id", "rice", "400 g", TODAY);
  const changed = [{ ...after, name: "raw rice" }, { ...after, name: "Rice" },
    { ...after, measure: "399 g" }, { ...after, measure: "400.000000001 g" }, { ...after, measure: "0.4 kg" },
    { ...after, measure: "some" }, { ...after, useBy: "2026-10-23" }, stock("batch", "rice", "400 g"),
    { ...after, id: "replacement-id" }, undefined];
  for (const current of changed) {
    const state = kitchen(current ? [other, current] : [other]);
    const snapshot = structuredClone({ state, change });
    assert.match(pantryBatchUndoProblem(state.pantry, change), /edited|used|removed/);
    assert.equal(undoPantryBatch(state, change), state);
    assert.deepEqual({ state, change }, snapshot);
  }
});

test("undo replaces only the matching batch and preserves receipts, meals and unrelated state", () => {
  const before = stock("batch", "rice", "500 g", TODAY);
  const after = { ...before, measure: "400 g" };
  const change = { before, after };
  const left = stock("left", "rice", "75 g", TODAY);
  const right = stock("right", "raw rice", "some");
  const key = `${WEEK}:rice`;
  const state = { ...kitchen([left, { ...after }, right]),
    shoppingChecked: { [key]: true }, shoppingCycles: { [key]: "cycle" },
    shoppingPurchases: [{ id: "receipt", week: WEEK, at: `${TODAY}T12:00:00Z`,
      items: [{ key, cycleId: "cycle", pantry: { ...before, measure: "600 g" } }] }],
    meals: { [TODAY]: { ...meal("cooked", TODAY, "100 g", "cooked"),
      completion: { id: "completion", at: `${TODAY}T18:00:00Z`, deductions: [{ pantryId: before.id, before: "600 g", after: "500 g" }] } },
      "2026-10-23": meal("planned", "2026-10-23") }, favoriteRecipeIds: ["saved"] };
  const snapshot = structuredClone({ state, change });
  const restored = undoPantryBatch(state, change);
  assert.deepEqual(restored, { ...state, pantry: [left, before, right] });
  for (const [key, value] of Object.entries(state)) if (key !== "pantry") assert.equal(restored[key], value);
  assert.equal(restored.pantry[0], left);
  assert.equal(restored.pantry[2], right);
  assert.notEqual(restored.pantry[1], before);
  restored.pantry[1].measure = "1 g";
  assert.deepEqual({ state, change }, snapshot);
});
