import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const directory = await mkdtemp(join(tmpdir(), "jff-pantry-semantics-"));
after(() => rm(directory, { recursive: true, force: true }));
for (const name of ["quantities", "recipe-browser", "kitchen-stock", "kitchen-state", "kitchen-types"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"');
  await writeFile(join(directory, `${name}.mjs`), compiled);
}
const load = (name) => import(pathToFileURL(join(directory, `${name}.mjs`)).href);
const { pantryAmountDetails, pantryStockEligibility, allocateMealStock, allocateStockForMeals, buildShoppingList, mealReadiness, consumptionPreview, completeMeal, undoMeal } = await load("quantities");
const { recipePantryDetails } = await load("recipe-browser");
const { availablePantryNames } = await load("kitchen-stock");
const { createPlannedMeal } = await load("kitchen-state");
const TODAY = "2030-01-10";
const NOW = "2030-01-10T12:00:00.000Z";
const recipe = (name = "rice", measure = "200 g") => ({
  id: "recipe", title: "Dinner", ingredients: [{ name, measure }], instructions: ["Follow source directions."],
  tags: [], image: null, category: "Dinner", cuisine: "", source: { name: "Test", url: "https://example.invalid/recipe" }, sourceUrl: "https://example.invalid/recipe",
});
const meal = (name = "rice", measure = "200 g", batches = 1, date = TODAY) => ({ ...createPlannedMeal(date, recipe(name, measure)), id: "dinner", batches });
const stock = (name, measure, useBy, id = "stock") => ({ id, name, measure, ...(useBy ? { useBy } : {}) });
const kitchen = (dinner, pantry) => ({ schemaVersion: 2, pantry, meals: { [dinner.date]: dinner }, shoppingChecked: {}, migratedLegacy: false });
const counts = ({ coveredCount, partialCount, missingCount, reviewCount }) => [coveredCount, partialCount, missingCount, reviewCount];

// Each identity is tested at every batch scale with the same amount, unit and date.
// Literal expectations catch identity drift instead of deriving the oracle from canonicalIngredient.
test("identity and batch scale independently agree across names, allocation, readiness, shopping and cooking", () => {
  for (const [requiredName, pantryName, matches, preparationMismatch = false] of [
    ["rice", "rice", true], ["rice, uncooked", "dry rice", true],
    ["rice, cooked", "cooked rice", true], ["rice", "cooked rice", false, true],
    ["cooked rice", "rice", false, true], ["rice vinegar", "rice", false],
    ["rice", "rice vinegar", false], ["rice flour", "rice", false],
    ["cooked rice vinegar", "cooked rice", false], ["eggplant", "egg", false],
    ["spring onion", "scallions", true], ["crème fraîche", "CREME FRAICHE", false],
    ["CRÈME FRAÎCHE", "cre\u0300me frai\u0302che", true], ["dried basil", "basil", false],
  ]) for (const batches of [0.5, 1, 2]) {
    const context = `${requiredName} / ${pantryName}, batches=${batches}`;
    const dinner = meal(requiredName, "200 g", batches);
    const pantry = [stock(pantryName, "300 g")];
    const before = structuredClone({ dinner, pantry });
    const required = 200 * batches;
    const covered = matches ? Math.min(300, required) : 0;
    const missing = required - covered;
    const names = availablePantryNames(pantry, TODAY);
    assert.deepEqual(names, [pantryName], context);
    assert.equal(recipePantryDetails(dinner.recipe, names).coverage, matches ? 1 : 0, context);
    const allocation = allocateMealStock(dinner, pantry, TODAY);
    assert.equal(allocation.coverage, covered / required, context);
    assert.equal(allocation.deductions.length, matches ? 1 : 0, context);
    const readiness = mealReadiness(dinner, pantry, TODAY);
    assert.equal(readiness.coverage, allocation.coverage, context);
    assert.deepEqual(counts(readiness), missing === 0 ? [1, 0, 0, 0] : covered ? [0, 1, 0, 0] : [0, 0, 1, 0], context);
    const shopping = buildShoppingList([dinner], pantry, TODAY);
    assert.equal(shopping.length, missing ? 1 : 0, context);
    if (missing) {
      assert.equal(shopping[0].measure, `${missing} g`, context);
      assert.equal(shopping[0].pantryMeasure, `${covered} g`, context);
      assert.equal(shopping[0].needsReview, preparationMismatch, context);
      assert.deepEqual(readiness.shopping[0].notes, shopping[0].notes, context);
      if (preparationMismatch) assert.match(shopping[0].preparationNote, /Review preparation; no automatic conversion/);
    }
    assert.deepEqual(consumptionPreview(dinner, pantry, TODAY).deductions, allocation.deductions, context);
    const completed = completeMeal(kitchen(dinner, pantry), TODAY, true, NOW);
    assert.deepEqual(completed.pantry, allocation.pantry, context);
    assert.deepEqual({ dinner, pantry }, before, context);
  }
});

test("amount certainty is independent of batch scale and never upgrades name presence to quantified coverage", () => {
  for (const [measure, kind, quantified, review] of [
    ["300 g", "known", 300, false], [".3 kg", "known", 300, false],
    ["", "unknown", 0, true], ["some", "unknown", 0, true], ["to taste", "unknown", 0, true],
    ["about 500 g", "unknown", 0, true], ["1–2 cups", "unknown", 0, true],
    ["2 cans (400 g each)", "unknown", 0, true], ["1 bag", "unknown", 0, true], ["0 bags", "unknown", 0, true],
    ["1 cup", "known", 0, true], ["2 cans", "known", 0, true], ["2", "known", 0, true],
    ["0 g", "empty", 0, false], ["0 cups", "empty", 0, false], ["0 cans", "empty", 0, false], ["0", "empty", 0, false],
  ]) for (const batches of [0.5, 1, 2]) {
    const context = `${JSON.stringify(measure)}, batches=${batches}`;
    const dinner = meal("rice", "200 g", batches);
    const pantry = [stock("rice", measure, TODAY)];
    const required = 200 * batches;
    const covered = Math.min(required, quantified);
    assert.equal(pantryAmountDetails(measure).kind, kind, context);
    assert.equal(pantryStockEligibility(pantry[0], TODAY).eligible, kind !== "empty", context);
    assert.equal(recipePantryDetails(dinner.recipe, availablePantryNames(pantry, TODAY)).coverage, kind === "empty" ? 0 : 1, context);
    const allocation = allocateMealStock(dinner, pantry, TODAY);
    assert.equal(allocation.coverage, covered / required, context);
    assert.equal(allocation.useSoonCoverage, covered / required, context);
    assert.equal(allocation.deductions.length, covered ? 1 : 0, context);
    const readiness = mealReadiness(dinner, pantry, TODAY);
    assert.deepEqual(counts(readiness), covered === required ? [1, 0, 0, 0] : review ? [0, 0, 0, 1] : covered ? [0, 1, 0, 0] : [0, 0, 1, 0], context);
    assert.equal(readiness.coverage, allocation.coverage, context);
    const shopping = buildShoppingList([dinner], pantry, TODAY);
    if (covered < required) {
      assert.equal(shopping[0].measure, `${required - covered} g`, context);
      assert.equal(shopping[0].needsReview, review, context);
      assert.deepEqual(readiness.shopping[0].notes, shopping[0].notes, context);
      if (kind === "unknown") {
        assert.match(readiness.shopping[0].notes.join(" "), /rice: Pantry amount .*enter a measured amount/);
        assert.match(allocation.notes.join(" "), /enter a measured amount/);
      } else if (review) {
        assert.match(readiness.shopping[0].notes.join(" "), /cannot be compared.*Measure pantry stock in g/);
        assert.match(allocation.notes.join(" "), /no automatic conversion/);
      }
    } else assert.deepEqual(shopping, [], context);
    assert.deepEqual(consumptionPreview(dinner, pantry, TODAY).deductions, allocation.deductions, context);
    assert.deepEqual(completeMeal(kitchen(dinner, pantry), TODAY, true, NOW).pantry, allocation.pantry, context);
  }
});

test("unit compatibility is symmetric and never converts packages, generic counts, mass or volume into one another", () => {
  for (const [required, available, coverage, missing, review] of [
    ["2 cans", "1 can", 0.5, "1 can", false], ["2 cans", "2 cans", 1, null, false],
    ["200 g", "1 can", 0, "200 g", true], ["1 can", "200 g", 0, "1 can", true],
    ["2", "2 cans", 0, "2", true], ["2 cans", "2", 0, "2 cans", true],
    ["2 cloves", "2", 0, "2 cloves", true], ["2 eggs", "2", 0, "2 eggs", true],
    ["1 jar", "1 bottle", 0, "1 jar", true], ["1 bunch", "1 bunch", 1, null, false],
    ["200 g", "1 cup", 0, "200 g", true], ["1 cup", "200 g", 0, "240 ml", true],
    ["1 cup", "120 ml", 0.5, "120 ml", false], ["200 g", ".2 kg", 1, null, false],
  ]) {
    const context = `${required} / ${available}`;
    const dinner = meal("rice", required);
    const pantry = [stock("rice", available)];
    assert.equal(recipePantryDetails(dinner.recipe, availablePantryNames(pantry, TODAY)).coverage, 1, context);
    const allocation = allocateMealStock(dinner, pantry, TODAY);
    const readiness = mealReadiness(dinner, pantry, TODAY);
    assert.equal(allocation.coverage, coverage, context);
    assert.equal(readiness.coverage, coverage, context);
    assert.deepEqual(counts(readiness), coverage === 1 ? [1, 0, 0, 0] : review ? [0, 0, 0, 1] : [0, 1, 0, 0], context);
    assert.deepEqual(consumptionPreview(dinner, pantry, TODAY).deductions, allocation.deductions, context);
    const shopping = buildShoppingList([dinner], pantry, TODAY);
    if (missing) {
      assert.equal(shopping[0].measure, missing, context);
      assert.equal(shopping[0].needsReview, review, context);
    } else assert.deepEqual(shopping, [], context);
  }
});

test("inclusive dates and zero exclusion are independent of amount certainty and dinner scheduling", () => {
  for (const [date, useBy, inDate] of [
    [TODAY, undefined, true], [TODAY, "2030-01-09", false], [TODAY, TODAY, true], [TODAY, "2030-01-11", true],
    ["2030-01-12", "2030-01-11", false], ["2030-01-12", "2030-01-12", true],
    ["2030-01-08", "2030-01-09", false], ["2030-01-08", TODAY, true],
  ]) for (const [measure, empty, uncertain] of [["300 g", false, false], ["some", false, true], ["1 can", false, true], ["0 g", true, false], ["0 cups", true, false]]) {
    const context = `${measure}, dinner=${date}, useBy=${useBy}`;
    const dinner = meal("rice", "200 g", 1, date);
    const pantry = [stock("rice", measure, useBy)];
    const stockDate = date > TODAY ? date : TODAY;
    const eligible = inDate && !empty;
    const coverage = eligible && !uncertain ? 1 : 0;
    const review = eligible && uncertain;
    assert.equal(pantryStockEligibility(pantry[0], stockDate).eligible, eligible, context);
    assert.equal(recipePantryDetails(dinner.recipe, availablePantryNames(pantry, stockDate)).coverage, eligible ? 1 : 0, context);
    const allocation = allocateMealStock(dinner, pantry, TODAY);
    const readiness = mealReadiness(dinner, pantry, TODAY);
    assert.equal(allocation.coverage, coverage, context);
    assert.equal(allocation.deductions.length, coverage, context);
    assert.equal(readiness.coverage, coverage, context);
    assert.deepEqual(counts(readiness), coverage ? [1, 0, 0, 0] : review ? [0, 0, 0, 1] : [0, 0, 1, 0], context);
    const shopping = buildShoppingList([dinner], pantry, TODAY);
    if (!coverage) {
      assert.equal(shopping[0].measure, "200 g", context);
      assert.equal(shopping[0].needsReview, review, context);
      if (!eligible) {
        assert.match(shopping[0].notes.join(" "), /excluded/);
        assert.match(readiness.shopping[0].notes.join(" "), empty ? /zero/ : /past its entered use-by date/);
      }
    } else assert.deepEqual(shopping, [], context);
  }
});

test("future planning and cooking now use the same eligibility rules with their respective dates", () => {
  const dinner = meal("rice", "200 g", 1, "2030-01-12");
  const pantry = [stock("rice", "300 g", TODAY)];
  assert.deepEqual(availablePantryNames(pantry, TODAY), ["rice"]);
  assert.deepEqual(availablePantryNames(pantry, dinner.date), []);
  assert.equal(allocateMealStock(dinner, pantry, TODAY).coverage, 0);
  assert.deepEqual(counts(mealReadiness(dinner, pantry, TODAY)), [0, 0, 1, 0]);
  assert.equal(buildShoppingList([dinner], pantry, TODAY)[0].measure, "200 g");
  assert.equal(consumptionPreview(dinner, pantry, TODAY).deductions[0].after, "100 g");
  const completed = completeMeal(kitchen(dinner, pantry), dinner.date, true, NOW);
  assert.equal(completed.pantry[0].measure, "100 g");
  assert.deepEqual(undoMeal(completed, dinner.date).pantry, pantry);
});

test("unknown requirements cannot compare equal to unknown stock or consume any known units", () => {
  for (const required of ["", "some", "to taste"]) for (const available of ["", "some", "to taste", "1 can", "300 g"]) {
    const context = `${JSON.stringify(required)} / ${JSON.stringify(available)}`;
    const dinner = meal("rice", required, 2);
    const pantry = [stock("rice", available)];
    const allocation = allocateMealStock(dinner, pantry, TODAY);
    assert.equal(allocation.coverage, 0, context);
    assert.equal(allocation.useSoonCoverage, 0, context);
    assert.deepEqual(allocation.deductions, [], context);
    assert.deepEqual(allocation.pantry, pantry, context);
    assert.deepEqual(counts(mealReadiness(dinner, pantry, TODAY)), [0, 0, 0, 1], context);
    const shopping = buildShoppingList([dinner], pantry, TODAY);
    assert.equal(shopping[0].needsReview, true, context);
    assert.match(shopping[0].notes.join(" "), /required amount is not quantified; enter a measured dinner amount/);
    assert.deepEqual(consumptionPreview(dinner, pantry, TODAY).deductions, [], context);
    assert.deepEqual(completeMeal(kitchen(dinner, pantry), TODAY, true, NOW).pantry, pantry, context);
  }
});

test("only unresolved quantities need review; surplus uncertain stock does not obscure known full coverage", () => {
  for (const known of [0, 100, 200]) for (const uncertain of ["some", "1 cup", "2 cans"]) {
    const dinner = meal();
    const pantry = [stock("rice", `${known} g`, undefined, "known"), stock("rice", uncertain, undefined, "uncertain")];
    const readiness = mealReadiness(dinner, pantry, TODAY);
    assert.equal(readiness.coverage, known / 200);
    assert.deepEqual(counts(readiness), known === 200 ? [1, 0, 0, 0] : [0, 0, 0, 1]);
    assert.equal(readiness.shopping.length, known === 200 ? 0 : 1);
    if (known < 200) {
      assert.equal(readiness.shopping[0].measure, `${200 - known} g`);
      assert.equal(readiness.shopping[0].needsReview, true);
      assert.match(readiness.shopping[0].notes.join(" "), /enter a measured amount|Measure pantry stock/);
    }
    const allocation = allocateMealStock(dinner, pantry, TODAY);
    assert.ok(allocation.deductions.every((deduction) => deduction.pantryId === "known"));
    assert.equal(allocation.pantry[1].measure, uncertain);
  }
});

test("stock batches pool only exact compatible identities, consume dated stock first and cannot be reused by later dinners", () => {
  const first = meal("rice", "200 g", 2);
  const second = { ...meal("rice", "200 g", 1, "2030-01-11"), id: "later" };
  const pantry = [
    stock("rice", "1000 g", "2030-01-09", "expired"), stock("rice (raw)", "200 g", "2030-01-12", "late"),
    stock("cooked rice", "1000 g", undefined, "cooked"), stock("rice", "some", undefined, "unknown"),
    stock("rice", "1 cup", undefined, "cups"), stock("dry rice", "100 g", TODAY, "early"),
    stock("rice", "200 g", undefined, "undated"), stock("rice vinegar", "1000 g", undefined, "compound"),
  ];
  const before = structuredClone({ first, second, pantry });
  const result = allocateStockForMeals([second, first], [...pantry, pantry[5]], TODAY);
  assert.deepEqual(result.allocations[0].deductions.map((item) => item.pantryId), ["early", "late", "undated"]);
  assert.equal(result.allocations[0].coverage, 1);
  assert.equal(result.allocations[0].useSoonCoverage, 0.75);
  assert.equal(result.allocations[1].coverage, 0.5);
  assert.deepEqual(result.allocations[1].deductions.map((item) => item.pantryId), ["undated"]);
  const remaining = result.allocations[0].pantry;
  assert.deepEqual(counts(mealReadiness(second, remaining, TODAY)), [0, 0, 0, 1]);
  const shopping = buildShoppingList([second, first], [...pantry, pantry[5]], TODAY);
  assert.equal(shopping.length, 1);
  assert.equal(shopping[0].requiredMeasure, "600 g");
  assert.equal(shopping[0].pantryMeasure, "500 g");
  assert.equal(shopping[0].measure, "100 g");
  assert.equal(shopping[0].needsReview, true);
  assert.match(shopping[0].notes.join(" "), /enter a measured amount/);
  assert.match(shopping[0].notes.join(" "), /cannot be compared/);
  assert.deepEqual(availablePantryNames(result.pantry, second.date), ["cooked rice", "rice", "rice vinegar"]);
  assert.deepEqual(consumptionPreview(first, pantry, TODAY).deductions, result.allocations[0].deductions);
  assert.deepEqual(completeMeal(kitchen(first, pantry), TODAY, true, NOW).pantry, remaining);
  assert.deepEqual({ first, second, pantry }, before);
});

test("unknown or incompatible amounts on unrelated identities cannot create coverage or review matches", () => {
  for (const [requiredName, pantryName] of [["rice", "rice vinegar"], ["rice vinegar", "rice"], ["rice flour", "rice"], ["eggplant", "egg"], ["crème fraîche", "creme fraiche"]]) {
    for (const amount of ["", "some", "1 cup", "2 cans"]) {
      const context = `${requiredName} / ${pantryName}: ${amount}`;
      const dinner = meal(requiredName);
      const pantry = [stock(pantryName, amount)];
      assert.equal(recipePantryDetails(dinner.recipe, availablePantryNames(pantry, TODAY)).coverage, 0, context);
      assert.deepEqual(allocateMealStock(dinner, pantry, TODAY).deductions, [], context);
      const readiness = mealReadiness(dinner, pantry, TODAY);
      assert.equal(readiness.coverage, 0, context);
      assert.deepEqual(counts(readiness), [0, 0, 1, 0], context);
      assert.equal(readiness.shopping[0].needsReview, false, context);
      assert.equal(readiness.shopping[0].measure, "200 g", context);
      assert.doesNotMatch(readiness.shopping[0].notes.join(" "), /Pantry amount|cannot be compared/);
    }
  }
});

test("zero and past-dated alternate preparations do not create spurious preparation review", () => {
  for (const [requiredName, pantryName] of [["rice", "cooked rice"], ["cooked rice", "rice"]]) {
    for (const [amount, useBy] of [["0 g", undefined], ["0 cups", TODAY], ["300 g", "2030-01-09"], ["some", "2030-01-09"]]) {
      const dinner = meal(requiredName);
      const pantry = [stock(pantryName, amount, useBy)];
      assert.deepEqual(availablePantryNames(pantry, TODAY), []);
      const readiness = mealReadiness(dinner, pantry, TODAY);
      assert.deepEqual(counts(readiness), [0, 0, 1, 0]);
      assert.equal(readiness.shopping[0].needsReview, false);
      assert.equal(readiness.shopping[0].preparationNote, undefined);
      assert.deepEqual(allocateMealStock(dinner, pantry, TODAY).deductions, []);
      assert.doesNotMatch(consumptionPreview(dinner, pantry, TODAY).notes.join(" "), /Review preparation/);
    }
  }
});

test("review explanations stay attached to the correct ingredient and never leak derived fields into saved state", () => {
  const dinner = meal();
  dinner.recipe.ingredients.push({ name: "salt", measure: "10 g" }, { name: "milk", measure: "100 ml" });
  dinner.planningIngredients = structuredClone(dinner.recipe.ingredients);
  const pantry = [stock("rice", "some", undefined, "rice"), stock("salt", "1 pinch", undefined, "salt"), stock("milk", "100 ml", undefined, "milk")];
  const state = kitchen(dinner, pantry);
  const before = structuredClone(state);
  const readiness = mealReadiness(dinner, pantry, TODAY);
  assert.deepEqual(counts(readiness), [1, 0, 0, 2]);
  const rice = readiness.shopping.find((item) => item.name === "rice");
  const salt = readiness.shopping.find((item) => item.name === "salt");
  assert.match(rice.notes.join(" "), /rice: Pantry amount “some”/);
  assert.doesNotMatch(rice.notes.join(" "), /pinch/);
  assert.match(salt.notes.join(" "), /salt: pantry amount “1 pinch”.*Measure pantry stock in g/);
  assert.doesNotMatch(salt.notes.join(" "), /some/);
  assert.deepEqual(state, before);
  const completed = completeMeal(state, TODAY, true, NOW);
  assert.deepEqual(Object.keys(completed).sort(), Object.keys(state).sort());
  assert.equal(completed.schemaVersion, 2);
  assert.ok(completed.pantry.every((item) => Object.keys(item).sort().join() === "id,measure,name"));
  assert.deepEqual(completed.pantry.slice(0, 2), pantry.slice(0, 2));
  assert.deepEqual(undoMeal(completed, TODAY).pantry, pantry);
});
