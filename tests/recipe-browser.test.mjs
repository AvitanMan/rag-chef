import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const directory = await mkdtemp(join(tmpdir(), "jff-recipe-browser-"));
after(() => rm(directory, { recursive: true, force: true }));
for (const name of ["recipe-browser", "quantities", "kitchen-types"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"');
  await writeFile(join(directory, `${name}.mjs`), compiled);
}
const { browseRecipes, normalizeRecipeSearch, recipePantryDetails, RECIPE_PAGE_SIZE } = await import(pathToFileURL(join(directory, "recipe-browser.mjs")).href);
const recipe = (id, title, names = []) => ({ id, title, ingredients: names.map((name) => ({ name, measure: "" })) });

test("local browsing matches every word across title and ingredients, not other metadata", () => {
  const recipes = [recipe("a", "Lemon Rice", ["garlic", "rice"]), recipe("b", "Rice Bowl", ["lemon"]), { ...recipe("c", "Soup", ["water"]), cuisine: "Lemon Rice" }];
  assert.deepEqual(browseRecipes(recipes, "lemon garlic", []).map((r) => r.id), ["a"]);
  assert.deepEqual(browseRecipes(recipes, "lemon rice", []).map((r) => r.id), ["a", "b"]);
  assert.deepEqual(browseRecipes(recipes, "missing", []), []);
  assert.equal(browseRecipes([], "", []).length, 0);
});

test("case, accents and punctuation normalize consistently", () => {
  assert.equal(normalizeRecipeSearch("  CRÈME—Brûlée!!! "), "creme brulee");
  const recipes = [recipe("a", "Crème-Brûlée", ["egg yolks"])];
  assert.equal(browseRecipes(recipes, "creme brulee", []).length, 1);
  assert.equal(browseRecipes(recipes, "EGG, yolks!", []).length, 1);
  assert.equal(browseRecipes(recipes, "!!!", []).length, 1);
});

test("exact names beat pantry coverage; other matches rank by coverage and alphabetically", () => {
  const recipes = [recipe("c", "Tomato Soup Deluxe", ["tomato"]), recipe("b", "Tomato Soup", ["water"]), recipe("a", "A Tomato Soup", ["tomato", "rice"]), recipe("d", "Z Tomato Soup", ["tomato", "rice"])];
  assert.deepEqual(browseRecipes(recipes, "tomato soup", ["tomato"]).map((r) => r.id), ["b", "c", "a", "d"]);
  assert.deepEqual(browseRecipes(recipes, "", ["tomato"]).map((r) => r.id), ["c", "a", "d", "b"]);
  assert.deepEqual(browseRecipes(recipes, "", []).map((r) => r.id), ["a", "b", "c", "d"]);
  assert.deepEqual(browseRecipes(recipes, "", ["", "tomato", "tomato"]).map((r) => r.id), ["c", "a", "d", "b"]);
});

test("browsing has stable ties, reaches 102 records in 24-card pages, and does not mutate input or call AI", () => {
  const recipes = Array.from({ length: 102 }, (_, i) => recipe(`r${String(i).padStart(3, "0")}`, "Dinner", ["rice"]));
  const before = structuredClone(recipes);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Browsing must not use a provider"); };
  try {
    const results = browseRecipes(recipes.slice().reverse(), "dinner", ["rice"]);
    assert.equal(RECIPE_PAGE_SIZE, 24);
    for (const [limit, expected] of [[24, 24], [48, 48], [72, 72], [96, 96], [120, 102]]) assert.equal(results.slice(0, limit).length, expected);
    assert.equal(new Set(results.map((r) => r.id)).size, 102);
    assert.equal(results[0].id, "r000");
    assert.deepEqual(recipes, before);
  } finally { globalThis.fetch = oldFetch; }
});

test("pantry coverage reports actual ingredient counts, not an inflated percentage", () => {
  const dinner = recipe("a", "Dinner", ["rice", "tomato", "garlic"]);
  assert.deepEqual(recipePantryDetails(dinner, []), { matched: [], missing: ["rice", "tomato", "garlic"], total: 3, coverage: 0 });
  assert.deepEqual(recipePantryDetails(dinner, ["Rice", "tomatoes", "rice", ""]), { matched: ["rice", "tomato"], missing: ["garlic"], total: 3, coverage: 2 / 3 });
  assert.equal(recipePantryDetails(dinner, ["rice", "tomato", "garlic"]).coverage, 1);
  assert.equal(recipePantryDetails(recipe("b", "Empty"), ["rice"]).coverage, 0);
});

test("pantry names normalize safely without treating related ingredients as interchangeable", () => {
  const dinner = recipe("a", "Dinner", ["rice vinegar", "eggplant", "crème fraîche", "spring onion"]);
  const details = recipePantryDetails(dinner, ["rice", "egg", "CREME FRAICHE", "scallions"]);
  assert.deepEqual(details.matched, ["crème fraîche", "spring onion"]);
  assert.deepEqual(details.missing, ["rice vinegar", "eggplant"]);
  const sorted = browseRecipes([recipe("v", "A Vinegar", ["rice vinegar"]), recipe("r", "Z Rice", ["rice"])], "", ["rice"]);
  assert.deepEqual(sorted.map((r) => r.id), ["r", "v"]);
});

test("pantry coverage uses the same preparation identities and clear quantities as planning", () => {
  const dinner = recipe("a", "Rice", ["rice, cooked", "uncooked rice", "200 g dried chickpeas", "dried basil"]);
  assert.deepEqual(recipePantryDetails(dinner, ["rice", "chickpeas", "basil"]).matched, ["uncooked rice", "200 g dried chickpeas"]);
  assert.deepEqual(recipePantryDetails(dinner, ["cooked rice"]).matched, ["rice, cooked"]);
});
