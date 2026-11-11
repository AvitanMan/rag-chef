import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const dir = await mkdtemp(join(tmpdir(), "jff-use-soon-"));
after(() => rm(dir, { recursive: true, force: true }));
for (const name of ["use-soon", "kitchen-types", "kitchen-state", "quantities", "recipe-constraints", "recipe-safety"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"');
  await writeFile(join(dir, `${name}.mjs`), code);
}
const load = name => import(pathToFileURL(join(dir, `${name}.mjs`)).href);
const { pantryDateGroups, rankUseSoonDinners } = await load("use-soon");
const { createPlannedMeal } = await load("kitchen-state");
const { normalizeConstraints } = await load("recipe-constraints");
const TODAY = "2026-10-22";
const stock = (id, measure = "500 g", useBy = TODAY, name = "rice") => ({ id, name, measure, useBy });
const recipe = (id, ingredients = [{ name: "rice", measure: "200 g" }]) => ({ id, title: id, ingredients, servings: 2, instructions: ["Cook."], tags: [], source: { name: "Test", url: "#test" }, sourceUrl: "#test" });
const kitchen = (pantry, meals = {}) => ({ schemaVersion: 2, pantry, meals, shoppingChecked: {}, migratedLegacy: true });
const input = (overrides = {}) => ({ kitchen: kitchen([stock("rice")]), selectedId: "rice", today: TODAY, date: TODAY, portions: null, recipes: [recipe("Rice")], metadata: {}, constraints: normalizeConstraints({}), ...overrides });

test("use soon includes today through day three, orders dates, and excludes zero stock", () => {
  const pantry = [stock("later", "1 g", "2026-10-26"), stock("third", "", "2026-10-25"), stock("today"), stock("past", "1 g", "2026-10-21"), stock("zero", "0 g"), { id: "none", name: "rice", measure: "" }];
  const groups = pantryDateGroups(pantry, TODAY);
  assert.deepEqual(groups.soon.map(x => x.id), ["today", "third"]);
  assert.deepEqual(groups.past.map(x => x.id), ["past"]);
  assert.equal(groups.all.length, 6);
  assert.deepEqual(pantryDateGroups(pantry, "2026-10-23").past.map(x => x.id), ["past", "today"]);
  assert.equal(pantryDateGroups([stock("leap", "1 g", "2028-03-01")], "2028-02-27").soon.length, 1);
});

test("amount filters distinguish unknown notes from zero mass, volume and count stock", () => {
  const unknown = ["", " \t ", "some", "half a bag", "2 cans (opened)", "0 ml left", "0 bags"]
    .map((measure, index) => stock(`unknown-${index}`, measure));
  const empty = ["0", "0 g", "0 kg", "0 ml", "0 l", "0 cups", "0 cans", "0 pieces"]
    .map((measure, index) => stock(`empty-${index}`, measure));
  const known = ["2", "200 g", "0.5 kg", "500 ml", "2 cups", "2 cans", "2 pieces"]
    .map((measure, index) => stock(`known-${index}`, measure));
  const pantry = [...known, ...empty, ...unknown];
  const groups = pantryDateGroups(pantry, TODAY);
  assert.deepEqual(groups.unknown, unknown);
  assert.deepEqual(groups.empty, empty);
  assert.equal(groups.all, pantry);
});

test("amount filters span all dates and preserve overlapping date groups without mutations", () => {
  const dates = [["later", "2026-10-26"], ["undated", undefined], ["third", "2026-10-25"], ["past", "2026-10-21"], ["today", TODAY], ["blank-date", ""]];
  const pantry = dates.flatMap(([id, useBy]) => [
    { ...stock(`${id}-unknown`, "half a bag"), useBy },
    { ...stock(`${id}-empty`, "0 cans"), useBy },
    { ...stock(`${id}-known`, "2 cups"), useBy },
  ]);
  const before = structuredClone(pantry);
  pantry.forEach(Object.freeze);
  Object.freeze(pantry);
  const groups = pantryDateGroups(pantry, TODAY);
  assert.equal(groups.all, pantry);
  assert.deepEqual(groups.unknown.map(x => x.id), dates.map(([id]) => `${id}-unknown`));
  assert.deepEqual(groups.empty.map(x => x.id), dates.map(([id]) => `${id}-empty`));
  assert.deepEqual(groups.soon.map(x => x.id), ["today-known", "today-unknown", "third-known", "third-unknown"]);
  assert.deepEqual(groups.past.map(x => x.id), ["past-known", "past-unknown"]);
  assert.deepEqual(groups.undated.map(x => x.id), ["undated-unknown", "undated-known", "blank-date-unknown", "blank-date-known"]);
  assert.deepEqual(pantryDateGroups(pantry, TODAY), groups);
  assert.deepEqual(pantry, before);
});

test("estimates reserve same-week dinners, exclude the replaced day, and leave inputs unchanged", () => {
  const meals = Object.fromEntries([TODAY, "2026-10-23", "2026-10-29"].map(date => [date, createPlannedMeal(date, recipe(date))]));
  const args = input({ kitchen: kitchen([stock("rice", "500 g", "2026-10-25")], meals), portions: 4 });
  const before = structuredClone(args);
  const result = rankUseSoonDinners(args);
  assert.equal(result.stock.measure, "300 g");
  assert.equal(result.candidates[0].usedMeasure, "300 g");
  assert.equal(result.candidates[0].readiness.shopping[0].measure, "100 g");
  assert.deepEqual(args, before);
  assert.deepEqual(rankUseSoonDinners(args), result);
});

test("fully reserved and out-of-date dinner stock return explicit outcomes", () => {
  const other = createPlannedMeal("2026-10-23", recipe("Other"));
  assert.equal(rankUseSoonDinners(input({ kitchen: kitchen([stock("rice", "200 g", "2026-10-25")], { [other.date]: other }) })).status, "reserved");
  const result = rankUseSoonDinners(input({ date: "2026-10-23" }));
  assert.equal(result.status, "past_dinner");
  assert.equal(result.candidates.length, 0);
  assert.equal(rankUseSoonDinners(input({ today: "2026-10-23" })).status, "missing");
});

test("unknown amounts and incompatible units match by identity without claiming usage", () => {
  for (const measure of ["", "some", "2 cups"]) {
    const candidate = rankUseSoonDinners(input({ kitchen: kitchen([stock("rice", measure)]) })).candidates[0];
    assert.equal(candidate.usedMeasure, null);
    assert.equal(candidate.usesSelected, false);
    assert.equal(candidate.readiness.coverage, 0);
    assert.equal(candidate.readiness.shopping[0].needsReview, true);
  }
});

test("matching respects normalized ingredients and cooked versus uncooked stock", () => {
  const candidates = rankUseSoonDinners(input({ recipes: [recipe("Cooked", [{ name: "cooked rice", measure: "200 g" }]), recipe("Rice noodles", [{ name: "rice noodles", measure: "200 g" }]), recipe("Raw", [{ name: "raw rice", measure: "200 g" }])] })).candidates;
  assert.deepEqual(candidates.map(x => x.recipe.id), ["Raw"]);
});

test("duplicate ingredient batches attribute usage only to the selected pantry row", () => {
  const args = input({ selectedId: "second", kitchen: kitchen([stock("first", "100 g"), stock("second", "500 g", "2026-10-23")]) });
  assert.equal(rankUseSoonDinners(args).candidates[0].usedMeasure, "100 g");
  args.kitchen.pantry[0].measure = "500 g";
  assert.equal(rankUseSoonDinners(args).candidates[0].usedMeasure, null);
});

test("eligibility precedes ranking and does not relax allergy, diet or equipment exclusions", () => {
  const recipes = [recipe("Nuts", [{ name: "rice", measure: "200 g" }, { name: "groundnuts", measure: "20 g" }]), recipe("Beef", [{ name: "rice", measure: "200 g" }, { name: "beef", measure: "20 g" }]), recipe("Oven"), recipe("Plain")];
  const metadata = { Oven: { diets: {}, equipment: ["oven"], totalMinutes: null, provenance: {} } };
  const result = rankUseSoonDinners(input({ recipes, metadata, constraints: normalizeConstraints({ allergies: ["nuts"], diet: "vegetarian", equipment: ["stovetop"] }) }));
  assert.deepEqual(result.candidates.map(x => x.recipe.id), ["Plain"]);
  assert.deepEqual(result.candidates[0].eligibility.dietUnknowns, ["vegetarian"]);
});

test("ranking prioritizes confirmed use then reviewed mains, coverage and stable title", () => {
  const recipes = [recipe("Unknown main", [{ name: "rice", measure: "some" }]), recipe("Z main"), recipe("A main"), recipe("Side")];
  const main = { coreDinner: true, dinnerRole: "main", diets: {}, equipment: null, totalMinutes: null, provenance: {} };
  const metadata = { "Unknown main": main, "Z main": main, "A main": main };
  assert.deepEqual(rankUseSoonDinners(input({ recipes, metadata })).candidates.map(x => x.recipe.id), ["A main", "Z main", "Side", "Unknown main"]);
  assert.deepEqual(rankUseSoonDinners(input({ recipes: recipes.reverse(), metadata })).candidates.map(x => x.recipe.id), ["A main", "Z main", "Side", "Unknown main"]);
});

test("cooked dinners do not reserve stock and unknown recipe yields retain one batch", () => {
  const other = { ...createPlannedMeal("2026-10-23", recipe("Other")), status: "cooked" };
  const candidate = rankUseSoonDinners(input({ kitchen: kitchen([stock("rice", "500 g", "2026-10-25")], { [other.date]: other }), portions: 8, recipes: [{ ...recipe("Unknown yield"), servings: null }] })).candidates[0];
  assert.equal(candidate.usedMeasure, "200 g");
});
