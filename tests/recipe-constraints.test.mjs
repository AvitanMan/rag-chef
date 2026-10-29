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

test("generic nut allergies cover peanuts and tree nuts without broadening explicit families", () => {
  for (const allergy of ["nut", "nuts", "Nut allergy"]) {
    for (const name of ["peanut butter", "peanuts", "groundnuts", "almonds", "walnuts"]) {
      assert.equal(decide([name], { allergies: [allergy] }).eligible, false, `${allergy}/${name}`);
    }
    assert.equal(decide(["nutmeg", "rice"], { allergies: [allergy] }).eligible, true);
  }
  assert.equal(decide(["peanuts"], { allergies: ["tree nuts"] }).eligible, true);
  assert.equal(decide(["walnuts"], { allergies: ["peanut"] }).eligible, true);
  assert.equal(decide(["walnuts"], { allergies: ["tree nuts"] }).eligible, false);
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
  const metadata = { diets: { vegan: "fits", vegetarian: "fits", gluten_free: "unknown", low_carb: "unknown" }, equipment: ["oven"], totalMinutes: 20, provenance: { totalMinutes: { basis: "source", evidence: "Total time: 20 minutes." } } };
  assert.equal(decide(["butter"], { diet: "Vegan" }, metadata).eligible, false);
  assert.equal(decide(["peanut"], { allergies: ["peanut"] }, metadata).eligible, false);
  assert.deepEqual(decide(["rice"], { diet: "Vegan" }, metadata).dietUnknowns, []);
  assert.equal(decide(["rice"], { maxTotalMinutes: 30 }, metadata).eligible, true);
  assert.equal(decide(["rice"], { maxTotalMinutes: 30 }).eligible, false);
  assert.equal(decide(["rice"], { maxTotalMinutes: 30 }, { ...metadata, provenance: { totalMinutes: { basis: "curator_estimate", evidence: "Estimated 20 minutes." } } }).eligible, false, "An estimate cannot satisfy a hard total-time limit");
  assert.equal(decide(["rice"], { equipment: ["Stovetop"] }, metadata).eligible, false);
});

test("dislikes are a soft preference, not a food exclusion", () => {
  const value = decide(["chopped mushrooms", "rice"], { dislikes: ["mushrooms"] });
  assert.equal(value.eligible, true); assert.deepEqual(value.dislikedIngredients, ["chopped mushrooms"]);
  assert.deepEqual(normalizeConstraints({ diet: "Gluten-free" }).diets, ["gluten_free"]);
});

test("omitted appliances are unspecified; an explicit empty selection means no available appliances", () => {
  const metadata = { diets: {}, equipment: ["Oven"] };
  const unspecified = normalizeConstraints();
  assert.equal(unspecified.equipmentSpecified, false);
  assert.equal(evaluateRecipeConstraints(recipe("rice"), metadata, unspecified).eligible, true);
  assert.equal(normalizeConstraints(unspecified).equipmentSpecified, false, "Repeated normalization preserves omitted equipment");
  const none = normalizeConstraints({ equipment: [] });
  assert.equal(none.equipmentSpecified, true);
  assert.equal(evaluateRecipeConstraints(recipe("rice"), metadata, none).eligible, false);
  assert.deepEqual(evaluateRecipeConstraints(recipe("rice"), metadata, none).equipmentMissing, ["Oven"]);
  assert.equal(decide(["rice"], { equipment: [] }).eligible, true, "Unknown recipe equipment remains eligible");
  assert.equal(decide(["rice"], { equipment: [] }, { diets: {}, equipment: [] }).eligible, true, "A reviewed no-appliance recipe is compatible with none available");
});

test("explicit equipment exclusions override availability and require a reviewed equipment list", () => {
  const restrictions = { equipment: ["Oven", "Stovetop"], excludedEquipment: ["OVEN"] };
  assert.equal(decide(["rice"], restrictions, { diets: {}, equipment: ["Oven"] }).eligible, false);
  assert.equal(decide(["rice"], restrictions, { diets: {}, equipment: ["Stovetop"] }).eligible, true);
  assert.equal(decide(["rice"], restrictions).eligible, false);
  assert.equal(decide(["rice"], restrictions, { diets: {}, equipment: null }).eligible, false);
  assert.equal(decide(["rice"], restrictions, { diets: {}, equipment: [] }).eligible, true);
  assert.ok(decide(["rice"], restrictions).reasons.some((reason) => reason.includes("equipment list is not verified")));
  const aliases = normalizeConstraints({ equipment: ["hob"], excludedEquipment: ["stove", "stove top"] });
  assert.deepEqual(aliases.excludedEquipment, ["stovetop"]);
  assert.equal(evaluateRecipeConstraints(recipe("rice"), { diets: {}, equipment: ["Stovetop"] }, aliases).eligible, false);
});
