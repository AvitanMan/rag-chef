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
const { normalizeConstraints, evaluateRecipeConstraints, ingredientDietConflicts, proposedChangeConflicts } = await import(pathToFileURL(join(dir, "recipe-constraints.mjs")));
const recipe = (...names) => ({ id: "test", ingredients: names.map((name) => ({ name, measure: "" })) });
const decide = (names, profile, metadata) => evaluateRecipeConstraints(recipe(...names), metadata, normalizeConstraints(profile));

test("allergies expand the same aliases used across browsing, Chef and planning", () => {
  for (const [allergy, name] of [["dairy", "mozzarella balls"], ["milk", "parmesan"], ["gluten", "farfalle"], ["wheat", "fried bread"], ["fish", "Worcestershire sauce"], ["shellfish", "squid"]]) {
    assert.equal(decide([name], { allergies: [allergy] }).eligible, false, `${allergy}/${name}`);
  }
  assert.equal(decide(["eggplant", "rice vinegar"], { allergies: ["egg", "peanut"] }).eligible, true);
});

test("new fish names and wheat ingredients are excluded by their food families", () => {
  for (const ingredient of ["fresh whole tilapia", "halibut fillet"]) {
    assert.equal(decide([ingredient], { allergies: ["fish"] }).eligible, false, ingredient);
    assert.equal(decide([ingredient], { excludedIngredients: ["fish"] }).eligible, false, ingredient);
    for (const diet of ["Vegan", "Vegetarian"]) assert.equal(decide([ingredient], { diet }).eligible, false, `${diet}: ${ingredient}`);
  }
  const ingredient = "bulghur";
  for (const allergy of ["wheat", "gluten"]) assert.equal(decide([ingredient], { allergies: [allergy] }).eligible, false, `${allergy}: ${ingredient}`);
  assert.equal(decide([ingredient], { diet: "Gluten-free" }).eligible, false, ingredient);
  assert.equal(decide([ingredient], { excludedIngredients: ["gluten"] }).eligible, false, ingredient);
  assert.equal(decide([ingredient], { excludedIngredients: ["wheat"] }).eligible, false, ingredient);
  assert.equal(decide(["olive oil", "tomato"], { allergies: ["fish", "wheat"] }).eligible, true);
});

test("wheat exclusions conservatively recognize soy sauce and gnocchi", () => {
  for (const ingredient of ["soy sauce", "potato gnocchi"]) {
    for (const profile of [{ allergies: ["wheat"] }, { allergies: ["gluten"] }, { excludedIngredients: ["wheat"] }, { diet: "Gluten-free" }]) {
      assert.equal(decide([ingredient], profile).eligible, false, `${ingredient}: ${JSON.stringify(profile)}`);
    }
  }
  assert.equal(ingredientDietConflicts(recipe("gluten-free gnocchi"), "gluten_free"), false);
});

test("ground crayfish conflicts with vegetarian and vegan diets without reviewed metadata", () => {
  for (const diet of ["Vegetarian", "Vegan"]) {
    assert.equal(decide(["ground crayfish (optional)"], { diet }).eligible, false, diet);
  }
  assert.equal(decide(["ground crayfish (optional)"], { allergies: ["shellfish"] }).eligible, false);
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

test("adaptation checks distinguish removed ingredients from their replacements", () => {
  const vegan = normalizeConstraints({ diet: "Vegan" });
  for (const change of [
    "Replace cheese with tofu.", "Use tofu instead of cheese.", "Use tofu in place of cheese.",
    "Swap cheese for tofu.", "Substitute tofu for cheese.", "Substitute cheese with tofu.",
    "Omit cheese.", "Leave out the cheese.", "Leave cheese out.", "Do not add cheese.",
    "Replace cheese and butter with tofu and olive oil.",
    "Replace cheese with tofu and replace butter with olive oil.",
    "Omit cheese; omit eggs. Use tofu and olive oil.",
  ]) assert.equal(proposedChangeConflicts(change, vegan), false, change);
  for (const change of [
    "Replace tofu with cheese.", "Use cheese instead of tofu.", "Swap tofu for cheese.",
    "Substitute cheese for tofu.", "Replace oil with ghee.", "Use vegan ghee instead of oil.",
    "Replace cheese with tofu and butter.", "Omit cheese and add milk.",
    "Replace cheese with tofu, but keep parmesan.", "Use tofu instead of cheese, keeping butter.",
    "Replace cheese with tofu and stir in milk.", "Do not replace cheese with tofu.",
    "Do not omit cheese.", "Keep cheese or replace it with tofu.", "Reduce cheese and add tofu.",
    "Use tofu instead of cheese if desired.",
  ]) assert.equal(proposedChangeConflicts(change, vegan), true, change);
});

test("removal objects cannot swallow retained ingredients or exceptions", () => {
  for (const profile of [{ diet: "Vegan" }, { allergies: ["milk"] }]) {
    const constraints = normalizeConstraints(profile);
    for (const change of [
      "Use tofu instead of cheese, leaving the butter unchanged.",
      "Use tofu instead of cheese, preserve butter.",
      "Use tofu in place of cheese, maintain the butter.",
      "Substitute tofu for cheese, butter stays in the filling.",
      "Use oil instead of butter, leaving milk unchanged.",
      "Omit cheese except parmesan.", "Omit cheese excluding parmesan.",
      "Omit cheese apart from parmesan.", "Omit cheese other than parmesan.",
      "Omit cheese save for parmesan.", "Omit cheese (leave the butter unchanged).",
      "Omit cheese — butter remains.", "Omit cheese: preserve butter.",
      "Use tofu instead of cheese leaving butter.",
      "Use tofu instead of cheese preserving butter.",
      "Omit cheese that is optional; butter remains.",
      "Use tofu instead of cheese; omit eggs, preserve butter.",
      "Replace cheese, leaving butter unchanged, with tofu.",
    ]) assert.equal(proposedChangeConflicts(change, constraints), true, `${JSON.stringify(profile)}: ${change}`);
    for (const change of [
      "Use tofu instead of cheese, leaving the olive oil unchanged.",
      "Use tofu instead of cheese, preserve the texture.",
      "Omit cheese except tofu.", "Omit cheese (preserve the olive oil).",
      "Omit cheese — preserve the texture.",
      "Use olive oil instead of 2 tablespoons whipping cream.",
      "Omit milk and cheese; replace butter with olive oil.",
    ]) assert.equal(proposedChangeConflicts(change, constraints), false, `${JSON.stringify(profile)}: ${change}`);
  }
  for (const [change, profile] of [
    ["Omit peanuts except peanut oil.", { allergies: ["peanut"] }],
    ["Use rice instead of peanuts, preserve almonds.", { allergies: ["nuts"] }],
    ["Omit tomatoes except passata.", { excludedIngredients: ["tomato"] }],
    ["Use rice instead of tofu, leaving soy sauce unchanged.", { allergies: ["soy"] }],
  ]) assert.equal(proposedChangeConflicts(change, normalizeConstraints(profile)), true, change);
  const vegan = normalizeConstraints({ diet: "Vegan" });
  assert.equal(proposedChangeConflicts("Omit cheese except vegan cheese.", vegan), false);
  assert.equal(proposedChangeConflicts("Omit cheese except vegan cheese.", normalizeConstraints({ allergies: ["milk"] })), true, "A plant label does not certify a named allergen away");
  for (const reason of ["Omit cheese except parmesan.", "Omit cheese, preserve butter.", "Use tofu instead of cheese, leaving butter unchanged."]) {
    assert.equal(proposedChangeConflicts("Replace cheese with tofu.", vegan, reason), true, reason);
  }
  assert.equal(proposedChangeConflicts("Replace cheese with tofu.", vegan, "Omit cheese, preserve the texture."), false);
});

test("removed ingredient discussion is allowed without allowing its reintroduction in a reason", () => {
  const vegan = normalizeConstraints({ diet: "Vegan" });
  for (const reason of [
    "The cheese is removed for the requested vegan adaptation.",
    "Tofu gives a similar texture to cheese.",
    "Cheese adds creaminess.",
    "The original cheese adds creaminess; tofu replaces that ingredient.",
    "This removes cheese from the adapted version.",
  ]) assert.equal(proposedChangeConflicts("Replace cheese with tofu.", vegan, reason), false, reason);
  for (const reason of [
    "Add cheese at the end.", "Using cheese will improve the texture.",
    "The replacement contains cheese.", "The adapted version has a little cheese.",
    "The adapted version has 5 g cheese.", "Cheese remains in the filling.",
    "Cheese can still be sprinkled on top.", "The topping is cheese.",
    "Cheese is optional.",
    "Serve the tofu with butter.", "A little ghee improves the texture.",
  ]) assert.equal(proposedChangeConflicts("Replace cheese with tofu.", vegan, reason), true, reason);
});

test("recorded vegan replacements distinguish original ingredients, plant binders and retained texture", () => {
  const vegan = normalizeConstraints({ diet: "Vegan" });
  const recorded = [
    { change: "Replace 2 eggs with a flax egg or commercial egg replacer.", reason: "Eggs provide structure; plant binders mimic this without animal products.", allergies: ["egg"] },
    { change: "Replace 200 ml milk with soy, oat, or almond milk.", reason: "Dairy milk is replaced to remove animal-derived liquid.", allergies: ["milk", "soy", "tree nuts"] },
    { change: "Replace 50 g butter and 250 g cheese with vegan butter and nutritional yeast or vegan cheese.", reason: "Butter and cheese are dairy; plant-based versions maintain fat and flavor.", allergies: ["milk"] },
  ];
  for (const row of recorded) {
    assert.equal(proposedChangeConflicts(row.change, vegan, row.reason), false, row.change);
    for (const allergy of row.allergies) assert.equal(proposedChangeConflicts(row.change, normalizeConstraints({ diet: "Vegan", allergies: [allergy] }), row.reason), true, `${allergy}: ${row.change}`);
  }
  assert.equal(proposedChangeConflicts("Replace cheese with tofu.", vegan, "Tofu replaces cheese while keeping the creamy texture."), false);
  assert.equal(proposedChangeConflicts("Replace milk with almond milk.", vegan, "To replace milk while retaining creaminess."), false);
  for (const reason of ["Tofu replaces cheese while keeping butter.", "To replace milk with ghee.", "Tofu replaces cheese while retaining cheese.", "Tofu replaces cheese while preserving butter.", "Add cheese for texture."]) {
    assert.equal(proposedChangeConflicts("Replace cheese with tofu.", vegan, reason), true, reason);
  }
  assert.equal(proposedChangeConflicts("Replace eggs with commercial egg replacer.", vegan), true, "An unspecified replacer alone is not assumed plant-based");
  assert.equal(proposedChangeConflicts("Replace eggs with a flax egg or commercial egg replacer with whole milk.", vegan), true);
});

test("replacement direction and claimed safety never override introduced allergens or exclusions", () => {
  const milk = normalizeConstraints({ allergies: ["milk"] });
  for (const change of ["Replace butter with olive oil.", "Use olive oil instead of butter.", "Omit milk and cheese."]) {
    assert.equal(proposedChangeConflicts(change, milk), false, change);
  }
  for (const change of ["Replace oil with butter.", "Use butter instead of oil.", "Add allergen-free butter.", "Use dairy-free butter instead of oil.", "Omit milk; add ghee."]) {
    assert.equal(proposedChangeConflicts(change, milk), true, change);
  }
  assert.equal(proposedChangeConflicts("Replace cheese with tofu.", normalizeConstraints({ allergies: ["soy"] })), true);
  assert.equal(proposedChangeConflicts("Use rice instead of tofu.", normalizeConstraints({ allergies: ["soy"] })), false);
  assert.equal(proposedChangeConflicts("Replace peanuts with almonds.", normalizeConstraints({ allergies: ["nuts"] })), true);
  assert.equal(proposedChangeConflicts("Omit peanuts.", normalizeConstraints({ allergies: ["peanut"] }), "Add peanut oil for flavor."), true);
  assert.equal(proposedChangeConflicts("Replace tomatoes with mushrooms.", normalizeConstraints({ excludedIngredients: ["tomato"] })), false);
  assert.equal(proposedChangeConflicts("Replace tomatoes with passata.", normalizeConstraints({ excludedIngredients: ["tomato"] })), true);
});


test("vegan proposals recognize explicitly plant-based egg replacements", () => {
  const vegan = normalizeConstraints({ diet: "Vegan" });
  for (const food of ["flax eggs", "chia egg", "vegan eggs", "plant based egg"]) assert.equal(proposedChangeConflicts(`Replace the eggs with ${food}.`, vegan), false, food);
  assert.equal(proposedChangeConflicts("Replace the eggs with duck eggs.", vegan), true);
});
