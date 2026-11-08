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
const { browsePantry, compatiblePantryTotals, groupPantryBatches, pantryWeekReservations, pantryDateInputProblem, pantryBatchProblem, pantryUsagePreview, replacePantryBatch, samePantryBatch } = await load("pantry-browser");
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

test("reservations use the full pantry and only uncooked meals in the selected week", () => {
  const pantry = [stock("past", "rice", "50 g", "2026-10-21"), stock("first", "rice", "100 g", TODAY),
    stock("second", "raw rice", "500 g", "2026-10-25"), stock("unknown", "rice", ""), stock("volume", "rice", "1 l")];
  const meals = [meal("later", "2026-10-23"), meal("today"), meal("cooked", "2026-10-24", "200 g", "cooked"), meal("other-week", "2026-10-29", "500 g")];
  const before = structuredClone({ pantry, meals });
  const result = pantryWeekReservations(pantry, meals, WEEK, TODAY);
  assert.equal(result.mealCount, 2);
  assert.equal(result.byId.get("first").reserved.quantity, 100);
  assert.equal(result.byId.get("first").available.quantity, 0);
  assert.equal(result.byId.get("second").reserved.quantity, 300);
  assert.equal(result.byId.get("second").available.quantity, 200);
  assert.equal(result.byId.get("past").available.quantity, 0);
  assert.equal(result.byId.get("past").reserved.quantity, 0);
  assert.deepEqual(result.byId.get("unknown"), { reserved: null, available: null });
  assert.equal(result.byId.get("volume").available.quantity, 1000);
  assert.equal(groupPantryBatches(pantry)[0].onHand.find(amount => amount.dimension === "mass").quantity, 650);
  assert.deepEqual(pantryWeekReservations(pantry, [...meals].reverse(), TODAY, TODAY), result);
  assert.deepEqual({ pantry, meals }, before);
});

test("filtered and searched batches do not steal reservations from hidden batches", () => {
  const pantry = [stock("hidden-first", "rice", "100 g", TODAY), stock("searched", "raw rice", "500 g", "2026-10-25")];
  const result = pantryWeekReservations(pantry, [meal("dinner")], WEEK, TODAY);
  const visible = browsePantry(pantryDateGroups(pantry, TODAY).soon, "raw", "name");
  assert.deepEqual(visible.map(item => item.id), ["searched"]);
  assert.equal(result.byId.get(visible[0].id).reserved.quantity, 100);
  assert.equal(result.byId.get(visible[0].id).available.quantity, 400);
  assert.equal(groupPantryBatches(pantry)[0].onHand[0].quantity, 600);
});

test("dinner dates constrain reservations without erasing physical or currently available food", () => {
  const pantry = [stock("early", "rice", "100 g", "2026-10-23"), stock("later", "rice", "400 g", "2026-10-25")];
  const result = pantryWeekReservations(pantry, [meal("saturday", "2026-10-24", "300 g")], WEEK, TODAY);
  assert.equal(result.byId.get("early").reserved.quantity, 0);
  assert.equal(result.byId.get("early").available.quantity, 100);
  assert.equal(result.byId.get("later").reserved.quantity, 300);
  assert.equal(result.byId.get("later").available.quantity, 100);
  const expired = pantryWeekReservations(pantry, [], WEEK, "2026-10-26");
  assert.equal(expired.byId.get("early").available.quantity, 0);
  assert.equal(expired.byId.get("later").available.quantity, 0);
  assert.equal(groupPantryBatches(pantry)[0].onHand[0].quantity, 500);
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
