import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const dir = await mkdtemp(join(tmpdir(), "jff-constraints-"));
after(() => rm(dir, { recursive: true, force: true }));
for (const name of ["recipe-constraints", "recipe-safety"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(dir, `${name}.mjs`), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"'));
}
const { normalizeConstraints, evaluateRecipeConstraints, ingredientDietConflicts } = await import(pathToFileURL(join(dir, "recipe-constraints.mjs")));
const recipe = (...names) => ({ id: "test", ingredients: names.map((name) => ({ name, measure: "" })) });
const decide = (names, profile, metadata) => evaluateRecipeConstraints(recipe(...names), metadata, normalizeConstraints(profile));

test("allergies expand the same aliases used across browsing, Chef and planning", () => {
  for (const [allergy, name] of [["dairy", "mozzarella balls"], ["milk", "parmesan"], ["gluten", "farfalle"], ["wheat", "fried bread"], ["fish", "Worcestershire sauce"], ["shellfish", "squid"]]) {
    assert.equal(decide([name], { allergies: [allergy] }).eligible, false, `${allergy}/${name}`);
  }
  assert.equal(decide(["eggplant", "rice vinegar"], { allergies: ["egg", "peanut"] }).eligible, true);
});

test("known diet conflicts are excluded while unknowns stay eligible and labeled", () => {
  for (const [diet, names] of [["Vegetarian", ["chicken stock"]], ["Vegan", ["butter"]], ["Vegan", ["mozzarella"]], ["Gluten-free", ["farfalle"]]]) assert.equal(decide(names, { diet }).eligible, false);
  const unknown = decide(["rice", "tomatoes"], { diet: "Vegan" });
  assert.equal(unknown.eligible, true); assert.deepEqual(unknown.dietUnknowns, ["vegan"]);
  assert.equal(decide(["rice"], { diet: "Low-carb" }).eligible, true);
  assert.deepEqual(decide(["rice"], { diet: "Low-carb" }).dietUnknowns, ["low_carb"]);
  assert.equal(ingredientDietConflicts(recipe("coconut milk", "peanut butter", "vegan cheese"), "vegan"), false);
  assert.equal(ingredientDietConflicts(recipe("rice flour", "gluten-free pasta"), "gluten_free"), false);
});

test("ingredient evidence overrides reviewed fits and a diet review never overrides an allergy", () => {
  const metadata = { diets: { vegan: "fits", vegetarian: "fits", gluten_free: "unknown", low_carb: "unknown" }, equipment: ["oven"], totalMinutes: 20 };
  assert.equal(decide(["butter"], { diet: "Vegan" }, metadata).eligible, false);
  assert.equal(decide(["peanut"], { allergies: ["peanut"] }, metadata).eligible, false);
  assert.deepEqual(decide(["rice"], { diet: "Vegan" }, metadata).dietUnknowns, []);
  assert.equal(decide(["rice"], { maxTotalMinutes: 30 }, metadata).eligible, true);
  assert.equal(decide(["rice"], { maxTotalMinutes: 30 }).eligible, false);
  assert.equal(decide(["rice"], { equipment: ["Stovetop"] }, metadata).eligible, false);
});

test("dislikes are a soft preference, not a food exclusion", () => {
  const value = decide(["chopped mushrooms", "rice"], { dislikes: ["mushrooms"] });
  assert.equal(value.eligible, true); assert.deepEqual(value.dislikedIngredients, ["chopped mushrooms"]);
  assert.deepEqual(normalizeConstraints({ diet: "Gluten-free" }).diets, ["gluten_free"]);
});
