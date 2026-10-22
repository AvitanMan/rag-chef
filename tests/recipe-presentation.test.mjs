import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// Render the real components, without mounting the kitchen hook or touching data.
const directory = await mkdtemp(join(tmpdir(), "jff-recipe-presentation-"));
after(() => rm(directory, { recursive: true, force: true }));
const require = createRequire(import.meta.url);
for (const [folder, name, extension] of [
  ["components", "RagChefApp", "tsx"], ["components", "WeeklyKitchenViews", "tsx"],
  ...["use-kitchen", "kitchen-state", "kitchen-types", "quantities", "recipe-browser"].map((name) => ["lib", name, "ts"]),
]) {
  const source = await readFile(new URL(`../app/${folder}/${name}.${extension}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/"(react(?:\/jsx-runtime)?)"/g, (_, module) => JSON.stringify(pathToFileURL(require.resolve(module)).href))
    .replace(/"\.{1,2}\/(?:lib\/)?([\w-]+)"/g, '"./$1.mjs"');
  await writeFile(join(directory, `${name}.mjs`), compiled);
}
const { RecipeCard, RecipeDrawer } = await import(pathToFileURL(join(directory, "RagChefApp.mjs")).href);
const { DurablePlanView, DurableShoppingView } = await import(pathToFileURL(join(directory, "WeeklyKitchenViews.mjs")).href);
const { recipePantryDetails } = await import(pathToFileURL(join(directory, "recipe-browser.mjs")).href);
const { createPlannedMeal } = await import(pathToFileURL(join(directory, "kitchen-state.mjs")).href);
const noop = () => {};
const recipe = {
  id: "wikibooks:test", title: "Test Rice", image: null, category: "Dinner", cuisine: "Home cooking",
  ingredients: [{ name: "rice", measure: "100 g" }, { name: "salt", measure: "to taste" }],
  instructions: ["First rinse the rice.", "Then simmer until cooked."], tags: [], servings: 2,
  sourceUrl: "https://en.wikibooks.org/wiki/Cookbook:Test_Rice",
  source: { name: "Wikibooks Cookbook", url: "https://en.wikibooks.org/wiki/Cookbook:Test_Rice", licenseId: "CC-BY-SA-4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/", attributionText: "Wikibooks contributors. Formatting normalized; source wording retained." },
};
const drawer = (props = {}) => renderToStaticMarkup(createElement(RecipeDrawer, { recipe, pantry: ["rice"], metric: false, setMetric: noop, chefResult: null, close: noop, addToPlan: noop, addLabel: "Add to Monday", start: noop, ...props }));

test("text-first recipe cards show real counts and explicit view/add actions without fake imagery", () => {
  const html = renderToStaticMarkup(createElement(RecipeCard, { recipe, details: recipePantryDetails(recipe, []), featured: false, open: noop, add: noop, addLabel: "Add to Monday" }));
  assert.match(html, /0 of 2 ingredients in pantry/);
  assert.match(html, /Names only · amounts not checked/);
  assert.match(html, /View recipe/);
  assert.match(html, /Add to Monday/);
  assert.match(html, /href="https:\/\/en.wikibooks.org\/wiki\/Cookbook:Test_Rice"/);
  assert.doesNotMatch(html, /recipe-image|food-placeholder|pantry match|42%|<img/);
});

test("real photos remain optional and coverage uses the same counts in cards and details", () => {
  const photographed = { ...recipe, image: "https://example.com/rice.jpg" };
  const html = renderToStaticMarkup(createElement(RecipeCard, { recipe: photographed, details: recipePantryDetails(recipe, ["rice", "salt"]), featured: true, open: noop }));
  assert.match(html, /<img[^>]+src="https:\/\/example.com\/rice.jpg"/);
  assert.match(html, /2 of 2 ingredients in pantry/);
  const details = drawer();
  assert.match(details, /1 of 2 ingredients in pantry/);
  assert.doesNotMatch(details, /drawer-hero|No changes suggested yet|changes-panel/);
});

test("planned dinner amounts are primary, overrides are final, and originals start collapsed", () => {
  const meal = createPlannedMeal("2026-10-19", recipe);
  meal.servings = 4;
  meal.ingredientOverrides = { "0": "350 g" };
  const before = structuredClone({ recipe, meal });
  const html = drawer({ plannedMeal: meal });
  assert.match(html, /Ingredients for your dinner/);
  assert.match(html, /4 servings/);
  const main = html.slice(html.indexOf('aria-label="Planned dinner ingredients"'), html.indexOf('<details class="original-ingredients"'));
  assert.match(main, /350 g/);
  assert.doesNotMatch(main, /700 g|100 g/);
  assert.match(main, /to taste · review for 2 batches/);
  assert.match(html, /<details class="original-ingredients"><summary>Original recipe quantities<\/summary>/);
  assert.match(html, /<small>100 g<\/small>/);
  assert.doesNotMatch(html, /<details[^>]*original-ingredients[^>]*open/);
  assert.deepEqual({ recipe, meal }, before);
});

test("planned quantities scale once, and recipes with unknown servings stay in batches", () => {
  const meal = createPlannedMeal("2026-10-19", { ...recipe, servings: undefined });
  meal.batches = 2;
  const html = drawer({ plannedMeal: meal });
  assert.match(html, /2 recipe batches/);
  assert.match(html, /<small>200 g<\/small>/);
  assert.match(html, /<small>100 g<\/small>/);
});

test("missing planned amounts remain explicitly unresolved instead of inventing a quantity", () => {
  const unclear = { ...recipe, ingredients: [{ name: "Any topping", measure: "" }] };
  const meal = createPlannedMeal("2026-10-19", unclear);
  const html = drawer({ recipe: unclear, plannedMeal: meal });
  assert.match(html, /Amount needs review/);
  assert.doesNotMatch(html, /As needed/);
});

test("recipe details retain visible attribution, license, original wording and step order", () => {
  const html = drawer();
  assert.match(html, /Wikibooks contributors\. Formatting normalized; source wording retained\./);
  assert.match(html, /href="https:\/\/creativecommons.org\/licenses\/by-sa\/4.0\/"/);
  assert.match(html, /CC-BY-SA-4\.0/);
  assert.ok(html.indexOf("First rinse the rice.") < html.indexOf("Then simmer until cooked."));
  assert.match(html, /Start cooking/);
  assert.match(html, /Add to Monday/);
  assert.doesNotMatch(html, /Original recipe quantities/);
});

test("the changes panel appears only for actual changes to the selected recipe", () => {
  const chefResult = { chefChanges: [{ recipeId: recipe.id, change: "Use less salt", reason: "To your taste" }], sourceFacts: [] };
  assert.match(drawer({ chefResult }), /Use less salt/);
  assert.match(drawer({ chefResult }), /Adapted for your kitchen/);
  assert.doesNotMatch(drawer({ chefResult: { ...chefResult, chefChanges: [{ ...chefResult.chefChanges[0], recipeId: "other" }] } }), /changes-panel|Use less salt/);
});

const planProps = { week: "2026-10-19", today: "2026-10-21", setWeek: noop, meals: {}, update: noop, chooseMeal: noop, chooseDay: noop, cookMeal: noop, reviewDate: null, setReviewDate: noop, generatePlan: noop, openMeal: noop, markCooked: noop, undoCooked: noop, goShopping: noop, catalogState: "ready", retryCatalog: noop, planningNotice: "" };
const plan = (props = {}) => renderToStaticMarkup(createElement(DurablePlanView, { ...planProps, ...props }));

test("compact weekly plan marks only today and provides a current-week shortcut", () => {
  const html = plan();
  assert.equal((html.match(/aria-current="date"/g) ?? []).length, 1);
  assert.match(html, /aria-label="Wed, Oct 21" aria-current="date"/);
  assert.match(html, /class="today-badge">Today/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>This week<\/button>/);
  assert.match(html, /0 of 7 dinners planned/);
  assert.doesNotMatch(html, /Make the week easier|empty-day|day-image/);
  const otherWeek = plan({ week: "2026-10-26" });
  assert.doesNotMatch(otherWeek, /aria-current="date"|today-badge/);
  assert.match(otherWeek, /<button class="secondary-button">This week<\/button>/);
});

test("known servings stay prominent without duplicate batches or invented dinner photos", () => {
  const meal = createPlannedMeal("2026-10-21", recipe);
  meal.servings = 4;
  const before = structuredClone(meal);
  const html = plan({ meals: { [meal.date]: meal } });
  assert.match(html, /Cook for/);
  assert.match(html, /aria-label="Servings Wed, Oct 21"[^>]*value="4"/);
  assert.match(html, /<span>servings<\/span>/);
  assert.match(html, /aria-label="Open Test Rice on Wed, Oct 21"/);
  assert.match(html, /aria-label="Cook Test Rice Wed, Oct 21"/);
  assert.doesNotMatch(html, /recipe batches|day-image/);
  assert.deepEqual(meal, before);
  const unknown = createPlannedMeal("2026-10-21", { ...recipe, servings: undefined });
  assert.match(plan({ meals: { [unknown.date]: unknown } }), /Recipe batches/);
});

const shoppingItems = [
  { key: "2026-10-19:rice", name: "Rice", measure: "200 g", requiredMeasure: "300 g", pantryMeasure: "100 g", needsReview: false, notes: ["Rice dinner: 300 g minus stock"], recipeTitles: ["Rice dinner"], mealDates: ["2026-10-21"] },
  { key: "2026-10-19:oil", name: "Oil", measure: "10 ml", requiredMeasure: "10 ml", pantryMeasure: "", needsReview: false, notes: [], recipeTitles: ["Rice dinner"], mealDates: ["2026-10-21"] },
  { key: "2026-10-19:salt", name: "Salt", measure: "Review amount", requiredMeasure: "To taste", pantryMeasure: "", needsReview: true, notes: ["Unclear source amount"], recipeTitles: ["Rice dinner"], mealDates: ["2026-10-21", "2026-10-22"] },
];
const shoppingProps = { items: shoppingItems, checked: { "2026-10-19:rice": true }, update: noop, hasPlan: true, goPlan: noop, reviewMeal: noop, week: "2026-10-19" };
const shopping = (props = {}) => renderToStaticMarkup(createElement(DurableShoppingView, { ...shoppingProps, ...props }));

test("shopping keeps unchecked review rows first and bought items collapsed below", () => {
  const before = structuredClone(shoppingItems);
  const html = shopping();
  const pending = html.slice(html.indexOf('aria-label="To buy"'), html.indexOf('<details class="bought-items"'));
  assert.match(html, /2 items left/);
  assert.ok(pending.indexOf("Bought Salt") < pending.indexOf("Bought Oil"));
  assert.doesNotMatch(pending, /Bought Rice/);
  assert.match(html, /<details class="bought-items"><summary>Bought \(1\)<\/summary>/);
  assert.match(html, /aria-label="Bought Rice 200 g" checked=""/);
  assert.match(html, /Review Salt for Wed, Oct 21/);
  assert.match(html, /Review Salt for Thu, Oct 22/);
  assert.doesNotMatch(html, /Shop once, cook all week|At a glance/);
  assert.deepEqual(shoppingItems, before);
});

test("shopping calculations remain collapsed and distinct from all-bought and empty states", () => {
  const html = shopping();
  assert.match(html, /<details class="calculation-details"><summary>See calculation<\/summary><small>Plan: 300 g · Pantry: 100 g/);
  assert.match(html, /Unclear source amount/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  assert.match(shopping({ checked: Object.fromEntries(shoppingItems.map((item) => [item.key, true])) }), /Everything on this list is checked/);
  assert.match(shopping({ items: [] }), /No remaining shopping for these dinners/);
  assert.match(shopping({ items: [], hasPlan: false }), /Plan a few dinners first/);
});

test("shopping check, uncheck and reset actions alter only checks in the selected week", () => {
  const children = (element) => {
    if (!element || typeof element !== "object") return [];
    return [element, ...[element.props?.children].flat(Infinity).flatMap(children)];
  };
  let state = { pantry: [{ id: "rice", name: "Rice", measure: "100 g" }], meals: { saved: true }, shoppingChecked: { "2026-10-19:rice": true, "2026-10-26:rice": true } };
  const pantry = state.pantry, meals = state.meals;
  const props = { ...shoppingProps, update: (change) => { state = change(state); } };
  const nodes = children(DurableShoppingView(props));
  nodes.find((node) => node.props?.["aria-label"] === "Bought Salt Review amount").props.onChange({ target: { checked: true } });
  assert.equal(state.shoppingChecked["2026-10-19:salt"], true);
  nodes.find((node) => node.props?.["aria-label"] === "Bought Rice 200 g").props.onChange({ target: { checked: false } });
  assert.equal(state.shoppingChecked["2026-10-19:rice"], false);
  nodes.find((node) => node.type === "button" && node.props.children === "Uncheck all").props.onClick();
  assert.deepEqual(state.shoppingChecked, { "2026-10-26:rice": true });
  assert.equal(state.pantry, pantry);
  assert.equal(state.meals, meals);
});
