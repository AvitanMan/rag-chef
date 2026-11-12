import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const directory = await mkdtemp(join(tmpdir(), "jff-pantry-review-"));
after(() => rm(directory, { recursive: true, force: true }));
for (const name of ["pantry-review", "quantities", "kitchen-types", "kitchen-state"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"');
  await writeFile(join(directory, `${name}.mjs`), code);
}
const load = name => import(pathToFileURL(join(directory, `${name}.mjs`)).href);
const { pantryReviewTasks } = await load("pantry-review");
const { allocateStockForMeals, applyPersonalRecipeAmounts, pantryUnitMismatches } = await load("quantities");
const TODAY = "2026-10-22";
const WEEK = "2026-10-19";
const stock = (id, name = "rice", measure = "500 g", useBy) => ({ id, name, measure, ...(useBy ? { useBy } : {}) });
const meal = (id = "Dinner", date = TODAY, measure = "200 g", name = "rice") => ({
  id, date, recipeId: id, recipe: null, title: id, baseServings: null, servings: null, batches: 1,
  ingredientOverrides: {}, locked: false, status: "planned", planningIngredients: [{ name, measure }],
});
const review = (pantry, meals = [], week = WEEK, today = TODAY) => pantryReviewTasks(pantry, meals, week, today);
const kinds = tasks => tasks.map(task => [task.pantryId, task.reasons.map(reason => reason.kind)]);
const messages = task => task.reasons.map(reason => reason.message).join("\n");
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// Review is about entered amounts and dates, not food safety or finished-batch cleanup.
test("unknown amounts are reviewed regardless of date, while past dates include unknown and known nonzero stock", () => {
  const pantry = [stock("future-note", "rice", "a handful", "2026-11-01"), stock("undated-known"),
    stock("past-blank", "salt", "  ", "2026-10-21"), stock("past-zero", "rice", "0 cans", "2026-10-21"),
    stock("past-known", "egg", "2", "2026-10-21"), stock("today-known", "rice", "1 kg", TODAY),
    stock("undated-blank", "rice", ""), stock("future-known", "rice", "2 cans", "2026-11-01"),
    stock("today-note", "rice", "some", TODAY), stock("zero-note", "rice", "0 left")];
  const tasks = review(pantry);
  assert.deepEqual(kinds(tasks), [["future-note", ["unknown"]], ["past-blank", ["unknown", "past"]],
    ["past-known", ["past"]], ["undated-blank", ["unknown"]], ["today-note", ["unknown"]], ["zero-note", ["unknown"]]]);
  for (const task of tasks) {
    assert.deepEqual(Object.keys(task).sort(), ["pantryId", "reasons"]);
    for (const reason of task.reasons) {
      assert.deepEqual(Object.keys(reason).sort(), ["kind", "message"]);
      assert.ok(reason.message.length > 0);
      assert.doesNotMatch(reason.message, /\b(?:expired|unsafe|safe|fresh|discard)\b/i);
      if (reason.kind === "past") {
        assert.match(reason.message, /entered planning date 2026-10-21/i);
        assert.match(reason.message, /2026-10-22/);
      } else assert.doesNotMatch(reason.message, /\d/);
    }
  }
});

test("known zeros are excluded even with past dates or uncovered dinners, and a missing date alone is not a problem", () => {
  const pantry = ["0", "0 g", "0 cups", "0 cans", "0 jars", "0 packets", "0 pieces"].map((amount, index) => stock(`zero-${index}`, "rice", amount, "2026-10-01"));
  assert.deepEqual(review(pantry, [meal()]), []);
  assert.deepEqual(review([stock("undated"), stock("package", "rice", "2 cans")]), []);
  assert.deepEqual(review([], [meal()]), []);
});

test("tasks retain pantry order and real IDs, deduplicating repeated IDs with the allocator's last-value policy", () => {
  const pantry = [stock("z", "rice", ""), stock("a", "salt", "some", "2026-10-21"), stock("z", "rice", ""),
    stock("finished", "rice", "some"), stock("m", "rice", "1 cup"), stock("finished", "rice", "0", "2026-10-01")];
  const tasks = review(pantry, [meal()]);
  assert.deepEqual(kinds(tasks), [["z", ["unknown"]], ["a", ["unknown", "past"]], ["m", ["incompatible"]]]);
  assert.deepEqual(review(pantry, [meal()]), tasks);
  const repeated = stock("mass", "rice", "100 g");
  assert.deepEqual(kinds(review([repeated, repeated, stock("volume", "rice", "1 cup")], [meal()])), [["volume", ["incompatible"]]], "a repeated ID must not double the available mass");
});

test("full coverage from the entire pantry suppresses unit mismatch, but never hides unknown or past batches", () => {
  const pantry = [stock("volume", "rice", "1 cup"), stock("first", "rice", "50 g"), stock("second", "raw rice", "0.15 kg")];
  assert.deepEqual(review(pantry, [meal()]), []);
  assert.deepEqual(kinds(review([...pantry, stock("unknown", "rice", "2 cans of 400 g"), stock("past", "rice", "1 jar", "2026-10-21")], [meal()])),
    [["unknown", ["unknown"]], ["past", ["past"]]]);
  assert.deepEqual(review([stock("mass", "rice", "400 g"), pantry[0]], [meal("first"), meal("second", "2026-10-23")]), []);
});

test("combined same-canonical requirements use their allocated total and produce only one unit reason per dinner", () => {
  const dinner = { ...meal(), planningIngredients: [{ name: "rice", measure: "100 g" }, { name: "raw rice", measure: "0.1 kg" }] };
  const pantry = [stock("mass", "rice", "150 g"), stock("volume", "dry rice", "1 cup")];
  const tasks = review(pantry, [dinner]);
  assert.deepEqual(kinds(tasks), [["volume", ["incompatible"]]]);
  assert.match(messages(tasks[0]), /Dinner \(2026-10-22\).*rice.*measured in g/);
  assert.deepEqual(pantryUnitMismatches([dinner], pantry, TODAY), [{ pantryId: "volume", mealId: "Dinner", date: TODAY,
    title: "Dinner", ingredient: "rice", requiredUnit: "g" }]);
  assert.deepEqual(review([{ ...pantry[0], measure: "200 g" }, pantry[1]], [dinner]), []);
});

test("shortfalls alone and compatible unit conversions are not pantry unit problems", () => {
  for (const [required, available] of [["1 kg", "500 g"], ["400 g", "1 kg"], ["2 cups", "200 ml"], ["500 ml", "1 l"], ["3 cans", "1 can"], ["3", "1 piece"]]) {
    assert.deepEqual(review([stock("batch", "rice", available)], [meal("Dinner", TODAY, required)]), [], `${required} / ${available}`);
  }
  assert.deepEqual(review([stock("unrelated", "rice vinegar", "1 cup")], [meal()]), []);
});

test("mass, volume, pieces and each typed package count stay distinct in both directions", () => {
  const amounts = [["200 g", "g"], ["1 cup", "ml"], ["2", "pieces"], ["2 cans", "can counts"], ["2 jars", "jar counts"], ["2 packets", "packet counts"]];
  for (const [required, unit] of amounts) for (const [available] of amounts) {
    const tasks = review([stock("batch", "rice", available)], [meal("Dinner", TODAY, required)]);
    assert.deepEqual(kinds(tasks), required === available ? [] : [["batch", ["incompatible"]]], `${required} / ${available}`);
    if (tasks.length) assert.ok(messages(tasks[0]).includes(`measured in ${unit}.`));
  }
});

test("blank, prose and zero requirements cannot create mismatch; unknown pantry amounts never become mismatched quantities", () => {
  const pantry = [stock("volume", "rice", "1 cup"), stock("blank", "rice", ""), stock("note", "rice", "2 cans of 400 g")];
  for (const required of ["", "to taste", "1-2 g", "0", "0 g", "0 cans"]) {
    assert.deepEqual(kinds(review(pantry, [meal("Dinner", TODAY, required)])), [["blank", ["unknown"]], ["note", ["unknown"]]], required);
  }
  assert.deepEqual(kinds(review(pantry, [meal()])), [["volume", ["incompatible"]], ["blank", ["unknown"]], ["note", ["unknown"]]]);
  assert.deepEqual(review([pantry[0]], [{ ...meal(), planningIngredients: undefined, recipe: null }]), []);
  assert.deepEqual(review([stock("choice", "rice or quinoa", "1 cup")], [meal("Choice", TODAY, "200 g", "rice or quinoa")]), []);
});

test("unresolved scaling does not invent a quantified requirement, while a final measured override is usable", () => {
  const pantry = [stock("volume", "rice", "1 cup")];
  for (const batches of [0, -1, NaN, Infinity]) {
    const dinner = { ...meal(), batches };
    assert.deepEqual(review(pantry, [dinner]), []);
    assert.deepEqual(kinds(review(pantry, [{ ...dinner, ingredientOverrides: { "0": "200 g" } }])), [["volume", ["incompatible"]]]);
  }
});

test("unit checks use inclusive dates at max(today, dinner date), while past reasons are relative only to today", () => {
  for (const [date, entered, expected] of [
    ["2026-10-19", "2026-10-20", ["past"]], ["2026-10-19", TODAY, ["incompatible"]],
    [TODAY, "2026-10-21", ["past"]], [TODAY, TODAY, ["incompatible"]],
    ["2026-10-25", "2026-10-21", ["past"]], ["2026-10-25", TODAY, []],
    ["2026-10-25", "2026-10-24", []], ["2026-10-25", "2026-10-25", ["incompatible"]],
    ["2026-10-25", "2026-10-26", ["incompatible"]], ["2026-10-25", undefined, ["incompatible"]],
  ]) {
    const tasks = review([stock("batch", "rice", "1 cup", entered)], [meal("Dinner", date)]);
    assert.deepEqual(kinds(tasks), expected.length ? [["batch", expected]] : [], `${date} / ${entered}`);
  }
});

test("compatible stock dated before dinner cannot hide an eligible mismatch, but stock dated on dinner can cover it", () => {
  const dinner = meal("Sunday", "2026-10-25");
  const pantry = [stock("mass", "rice", "500 g", "2026-10-24"), stock("volume", "rice", "1 cup", dinner.date)];
  assert.deepEqual(kinds(review(pantry, [dinner])), [["volume", ["incompatible"]]]);
  assert.deepEqual(review([{ ...pantry[0], useBy: dinner.date }, pantry[1]], [dinner]), []);
});

test("canonical aliases match, but cooked forms and distinct ingredients do not become unit problems for one another", () => {
  for (const [required, available, matches] of [
    ["rice", "raw rice", true], ["rice", "rice (uncooked)", true], ["rice", "dry rice", true],
    ["cooked rice", "rice cooked", true], ["cooked rice", "rice (cooked)", true],
    ["rice", "cooked rice", false], ["cooked rice", "rice", false], ["rice", "rice vinegar", false],
    ["Onions, chopped", "onion", true], ["onion", "red onions", false], ["onion", "onion powder", false],
  ]) {
    assert.deepEqual(kinds(review([stock("batch", available, "1 cup")], [meal("Dinner", TODAY, "200 g", required)])),
      matches ? [["batch", ["incompatible"]]] : [], `${required} / ${available}`);
  }
});

test("locked dinners are included; cooked and other-week dinners neither create reasons nor reserve stock", () => {
  const active = { ...meal("Locked", "2026-10-25"), locked: true };
  const excluded = [{ ...meal("Cooked", TODAY, "1 kg"), status: "cooked" }, meal("Previous", "2026-10-18", "1 kg"), meal("Next", "2026-10-26", "1 kg")];
  const pantry = [stock("volume", "rice", "1 cup")];
  assert.deepEqual(review(pantry, excluded), []);
  const tasks = review(pantry, [excluded[2], active, ...excluded.slice(0, 2)], "2026-10-25");
  assert.deepEqual(kinds(tasks), [["volume", ["incompatible"]]]);
  assert.match(messages(tasks[0]), /Locked \(2026-10-25\)/);
  assert.doesNotMatch(messages(tasks[0]), /Cooked|Previous|Next/);
  assert.deepEqual(review([...pantry, stock("mass", "rice", "200 g")], [...excluded, active]), []);
});

test("sequential reservations expose only later uncovered dinners, sorted by date and then meal ID", () => {
  const pantry = [stock("volume", "rice", "1 cup"), stock("mass", "rice", "250 g")];
  const meals = [meal("Third", "2026-10-25"), meal("First"), meal("Second", "2026-10-23")];
  const tasks = review(pantry, meals);
  assert.deepEqual(kinds(tasks), [["volume", ["incompatible", "incompatible"]]]);
  assert.match(tasks[0].reasons[0].message, /Second \(2026-10-23\)/);
  assert.match(tasks[0].reasons[1].message, /Third \(2026-10-25\)/);
  assert.doesNotMatch(messages(tasks[0]), /First/);
  assert.deepEqual(review(pantry, [...meals].reverse()), tasks);
  const sameDate = review([pantry[0], { ...pantry[1], measure: "200 g" }], [meal("z"), meal("a")]);
  assert.deepEqual(kinds(sameDate), [["volume", ["incompatible"]]]);
  assert.match(messages(sameDate[0]), /^z \(2026-10-22\)/);
});

test("a candidate consumed by an earlier dinner cannot create a later unit mismatch", () => {
  for (const [first, later] of [["1 cup", "200 g"], ["200 g", "1 cup"], ["2 cans", "2"]]) {
    const meals = [meal("Later", "2026-10-23", later), meal("First", TODAY, first)];
    assert.deepEqual(review([stock("batch", "rice", first)], meals), [], `${first} before ${later}`);
  }
  assert.deepEqual(kinds(review([stock("volume", "rice", "2 cups")], [meal("Later", "2026-10-23"), meal("First", TODAY, "1 cup")])), [["volume", ["incompatible"]]]);
});

test("different requirements within one dinner cannot reuse a batch already fully allocated in its own units", () => {
  const dinner = { ...meal(), planningIngredients: [{ name: "rice", measure: "200 g" }, { name: "rice", measure: "1 cup" }] };
  assert.deepEqual(review([stock("volume", "rice", "1 cup")], [dinner]), []);
  const tasks = review([stock("volume", "rice", "2 cups")], [dinner]);
  assert.deepEqual(kinds(tasks), [["volume", ["incompatible"]]]);
  assert.match(messages(tasks[0]), /measured in g/);
  assert.deepEqual(review([stock("mass", "rice", "200 g")], [{ ...dinner,
    planningIngredients: [{ name: "rice", measure: "1 can" }, { name: "rice", measure: "200 g" }] }]), []);
});

test("batch and serving scaling affect coverage, and final overrides change both units and amount without rescaling", () => {
  const pantry = [stock("mass", "rice", "200 g"), stock("volume", "rice", "1 cup")];
  const base = meal("Scaled", TODAY, "100 g");
  assert.deepEqual(review(pantry, [{ ...base, batches: 2 }]), []);
  assert.deepEqual(kinds(review(pantry, [{ ...base, batches: 3 }])), [["volume", ["incompatible"]]]);
  const portions = { ...base, baseServings: 2, servings: 4, batches: 20 };
  assert.deepEqual(review(pantry, [portions]), []);
  assert.deepEqual(kinds(review(pantry, [{ ...portions, servings: 6 }])), [["volume", ["incompatible"]]]);
  assert.deepEqual(review(pantry, [{ ...portions, servings: 6, ingredientOverrides: { "0": "200 g" } }]), []);
  assert.deepEqual(review(pantry, [{ ...portions, ingredientOverrides: { "0": "1 cup" } }]), []);
  const overridden = review([pantry[0]], [{ ...portions, ingredientOverrides: { "0": "1 cup" } }]);
  assert.deepEqual(kinds(overridden), [["mass", ["incompatible"]]]);
  assert.match(messages(overridden[0]), /measured in ml/);
  for (const amount of ["", "to taste", "0 g"]) assert.deepEqual(review(pantry, [{ ...portions, ingredientOverrides: { "0": amount } }]), []);
});

test("captured personal amounts and final overrides take precedence over source prose", () => {
  const recipe = { id: "source", title: "Source rice", servings: 2, ingredients: [{ name: "rice", measure: "to taste" }] };
  const base = { ...meal("Personal"), recipe, baseServings: 2, servings: 4, planningIngredients: recipe.ingredients };
  const personal = { contentHash: "test-hash", referenceServings: 2, amounts: [{ ingredientIndex: 0, originalName: "rice", measure: "100 g" }] };
  const dinner = applyPersonalRecipeAmounts(base, personal, "test-hash");
  const pantry = [stock("mass", "rice", "150 g"), stock("volume", "rice", "1 cup")];
  assert.deepEqual(dinner.personalAmountIndices, [0]);
  assert.deepEqual(kinds(review(pantry, [dinner])), [["volume", ["incompatible"]]]);
  assert.deepEqual(review(pantry, [{ ...dinner, servings: 2 }]), []);
  assert.deepEqual(review(pantry, [{ ...dinner, ingredientOverrides: { "0": "150 g" } }]), []);
  assert.deepEqual(review(pantry, [{ ...dinner, ingredientOverrides: { "0": "1 cup" } }]), []);
  assert.equal(recipe.ingredients[0].measure, "to taste");
  const legacy = { ...base, planningIngredients: undefined, recipe: { ...recipe, ingredients: [{ name: "rice", measure: "100 g" }] } };
  assert.deepEqual(kinds(review(pantry, [legacy])), [["volume", ["incompatible"]]]);
});

test("messages identify each dinner, date and required unit, with title fallbacks and deduplicated reasons", () => {
  const pantry = [stock("batch", "rice", "2 cans")];
  const meals = [meal("Dinner", TODAY, "100 g"), { ...meal("Duplicate", TODAY, "100 g"), title: "Dinner" },
    { ...meal("Fallback", "2026-10-23", "1 cup"), title: "", recipe: { title: "Source title" } },
    { ...meal("Untitled", "2026-10-24", "2"), title: "" }];
  const tasks = review(pantry, meals);
  assert.deepEqual(kinds(tasks), [["batch", ["incompatible", "incompatible", "incompatible"]]]);
  assert.match(tasks[0].reasons[0].message, /Dinner \(2026-10-22\).*measured in g/);
  assert.match(tasks[0].reasons[1].message, /Source title \(2026-10-23\).*measured in ml/);
  assert.match(tasks[0].reasons[2].message, /Untitled meal \(2026-10-24\).*measured in pieces/);
  assert.doesNotMatch(messages(tasks[0]), /100 g|240 ml|2 cans/, "no amount is invented or converted in unit-only review messages");
});

test("review is pure with frozen shared snapshots and does not change allocator outcomes or stored schema", () => {
  const ingredients = [{ name: "rice", measure: "100 g" }];
  const recipe = { id: "source", title: "Source", ingredients };
  const pantry = [stock("note", "rice", "some", "2026-10-21"), stock("mass", "rice", "200 g"), stock("volume", "rice", "1 cup")];
  const meals = [{ ...meal("First"), recipe, planningIngredients: ingredients, personalAmountIndices: [0], ingredientOverrides: { "0": "150 g" } },
    { ...meal("Second", "2026-10-23"), recipe, planningIngredients: ingredients }];
  const before = structuredClone({ pantry, meals, recipe });
  const allocation = allocateStockForMeals(meals, pantry, TODAY);
  deepFreeze({ pantry, meals, recipe });
  const tasks = review(pantry, meals);
  assert.deepEqual(kinds(tasks), [["note", ["unknown", "past"]], ["volume", ["incompatible"]]]);
  assert.deepEqual({ pantry, meals, recipe }, before);
  assert.deepEqual(allocateStockForMeals(meals, pantry, TODAY), allocation);
  assert.deepEqual(allocation.allocations.map(item => item.deductions), [
    [{ pantryId: "mass", name: "rice", before: "200 g", after: "50 g" }],
    [{ pantryId: "mass", name: "rice", before: "50 g", after: "0 g" }],
  ]);
  assert.equal(meals[0].planningIngredients, ingredients);
  assert.equal(recipe.ingredients, ingredients);
  const again = review(pantry, meals);
  tasks[0].reasons[0].message = "Display-only change";
  tasks[1].reasons.length = 0;
  assert.deepEqual(review(pantry, meals), again);
  assert.deepEqual({ pantry, meals, recipe }, before);
});

test("review delegates full-pantry sequential allocation once and never reads human allocation notes", async () => {
  const quantities = await readFile(join(directory, "quantities.mjs"), "utf8");
  await writeFile(join(directory, "observed-quantities.mjs"), quantities.replace("export function allocateStockForMeals(", "function originalAllocateStockForMeals(") + `
    export const calls = [];
    export function allocateStockForMeals(...args) {
      calls.push(args);
      const result = originalAllocateStockForMeals(...args);
      for (const allocation of result.allocations) Object.defineProperty(allocation, "notes", {
        get() { throw new Error("Review must not parse human allocation notes"); }
      });
      return result;
    }
  `);
  const source = await readFile(join(directory, "pantry-review.mjs"), "utf8");
  await writeFile(join(directory, "observed-pantry-review.mjs"), source.replace('"./quantities.mjs"', '"./observed-quantities.mjs"'));
  const { pantryReviewTasks: observedReview } = await load("observed-pantry-review");
  const { calls } = await load("observed-quantities");
  const pantry = [stock("volume", "rice", "1 cup"), stock("mass", "rice", "200 g"), stock("unrelated", "salt", "some")];
  const meals = [meal("Second", "2026-10-23"), { ...meal("First"), locked: true }, meal("Other week", "2026-10-26")];
  const tasks = observedReview(pantry, meals, WEEK, TODAY);
  assert.deepEqual(tasks, review(pantry, meals));
  assert.deepEqual(kinds(tasks), [["volume", ["incompatible"]], ["unrelated", ["unknown"]]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], pantry);
  assert.equal(calls[0][2], TODAY);
  assert.deepEqual(calls[0][0], meals.slice(0, 2));
});
