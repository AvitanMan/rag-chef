import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const directory = await mkdtemp(join(tmpdir(), "jff-chef-ingredient-answers-"));
after(() => rm(directory, { recursive: true, force: true }));
for (const name of ["chef-planning-answer", "quantities", "kitchen-types"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"');
  await writeFile(join(directory, `${name}.mjs`), code);
}
const { originalIngredientAnswer, planningIngredientStepAnswer } = await import(pathToFileURL(join(directory, "chef-planning-answer.mjs")));
const recipe = (ingredients, instructions = []) => ({ id: "pasta", title: "Pasta", ingredients, instructions, servings: 4 });
const source = recipe([{ name: "any small pasta", measure: "400 g" }, { name: "milk", measure: "200 ml" }, { name: "Salt", measure: "" }], [
  "Cook the pasta as directed on the packaging. Drain.",
  "Combine the eggs, milk, salt, and pepper in a mixing bowl.",
  "Bake at 200°C for 30 minutes.",
]);
const dinner = { recipeId: source.id, recipe: source, baseServings: 4, servings: 2, batches: 1, ingredientOverrides: { "1": "80 ml" } };

test("source quantities do not match ingredient words inside different foods", () => {
  for (const [requested, name] of [["sugar", "sugar snap peas"], ["milk", "milk chocolate"], ["flour", "flour tortillas"], ["butter", "peanut butter"], ["rice", "rice vinegar"], ["milk", "coconut milk"]]) {
    const value = recipe([{ name, measure: "200 g" }]);
    const answer = originalIngredientAnswer(value, `How much ${requested} does the original recipe use?`);
    if (["sugar snap peas", "milk chocolate", "flour tortillas"].includes(name)) {
      assert.equal(answer?.answerStatus, "unsupported", name);
      assert.equal(answer.evidenceId, "I1");
      assert.equal(answer.answer, `The source ingredient list specifies 200 g ${name}. It does not give a separate amount of ${requested}.`);
    } else assert.equal(answer, undefined, name);
    assert.match(originalIngredientAnswer(value, `How much ${name} does the original recipe use?`).answer, /200 g/);
  }
});

test("different-food explanations defer when another ingredient or direction may provide the requested amount", () => {
  const tortillas = recipe([{ name: "flour tortillas", measure: "8" }]);
  assert.match(originalIngredientAnswer({ ...tortillas, ingredients: [...tortillas.ingredients, { name: "flour", measure: "1 cup" }] }, "How much flour does the original recipe use?").answer, /1 cup flour/);
  assert.equal(originalIngredientAnswer({ ...tortillas, ingredients: [...tortillas.ingredients, { name: "flour, sifted", measure: "1 cup" }] }, "How much flour does the original recipe use?"), undefined);
  for (const details of [{ instructions: ["Use 1 cup flour to dust the surface."] }, { sourceNotes: ["Add a handful of flour if needed."] }]) {
    assert.equal(originalIngredientAnswer({ ...tortillas, ...details }, "How much flour does the original recipe use?"), undefined);
  }
});

test("source quantity matching retains reviewed varieties, exact fractions and ambiguity", () => {
  const sugar = recipe([{ name: "granulated sugar", measure: "1 ½ tsp" }]);
  assert.deepEqual(originalIngredientAnswer(sugar, "How much sugar does the original recipe use?"), {
    answer: "Original recipe ingredient: 1 ½ tsp granulated sugar.", answerStatus: "answered", evidenceId: "I1",
  });
  const twoSugars = recipe([{ name: "brown sugar", measure: "1 tsp" }, { name: "white sugar", measure: "2 tsp" }]);
  assert.equal(originalIngredientAnswer(twoSugars, "How much sugar does the recipe use?"), undefined);
  assert.match(originalIngredientAnswer(twoSugars, "How much brown sugar does the recipe use?").answer, /1 tsp brown sugar/);
});

test("a missing source measure is stated explicitly without inventing an amount", () => {
  for (const query of ["How much salt should I use?", "How much salt do I need?", "How much salt?", "How much salt does the original recipe use?"]) {
    assert.deepEqual(originalIngredientAnswer(source, query), {
      answer: "The source ingredient list does not specify an amount for Salt.", answerStatus: "unsupported", evidenceId: "I3",
    }, query);
  }
  const qualitative = recipe([{ name: "salt", measure: "to taste" }]);
  assert.match(originalIngredientAnswer(qualitative, "How much salt should I use?").answer, /to taste salt/);
});

test("a blank ingredient measure cannot conceal an amount in source directions or notes", () => {
  for (const direction of ["Add 1 tsp salt.", "Add half a teaspoon of salt.", "Add a pinch of salt.", "Add salt to taste.", "Add ½ tsp salt."]) {
    assert.equal(originalIngredientAnswer({ ...source, instructions: [direction] }, "How much salt should I use?"), undefined, direction);
    assert.equal(originalIngredientAnswer({ ...source, sourceNotes: [direction] }, "How much salt should I use?"), undefined, direction);
  }
});

test("a nearby reason for another action cannot answer an ingredient-purpose question", () => {
  for (const text of [
    "Add sugar. Cover the pan to prevent splattering.",
    "Add sugar; cover the pan to prevent splattering.",
    "Add sugar and cover the pan to prevent splattering.",
    "Add sugar because it is listed. Cover the pan to prevent splattering.",
  ]) {
    const result = originalIngredientAnswer(recipe([{ name: "sugar", measure: "1 tsp" }], [text]), "What is the sugar used for?");
    assert.equal(result, undefined, text);
  }
});

test("direct source purpose and negated taste contrast remain exact quotes", () => {
  for (const text of [
    "Add sugar to balance the acidity.",
    "Sugar is added to balance the acidity.",
    "You do not want the sauce to be sweet, just not sour. Add sugar a little at a time.",
    "Taste and season accordingly. You do not want the sauce to be salty, just not unsalty. You do not want the sauce to be sweet, just not sour. Season by adding the remaining salt and sugar a little at a time, stirring completely between tastes.",
  ]) {
    for (const query of ["What is the sugar used for?", "Why add sugar?", "Why does the source tell me to add sugar?", "Why is sugar added?"]) {
      const answer = originalIngredientAnswer(recipe([{ name: "granulated sugar", measure: "1 ½ tsp" }], [text]), query);
      assert.equal(answer?.answer, `Source step 1: ${text}`, `${query}: ${text}`);
      assert.equal(answer.answerStatus, "answered");
    }
  }
});

test("purpose answers cannot borrow another step or omit a compound question", () => {
  const value = recipe([{ name: "sugar", measure: "1 tsp" }], ["Add sugar.", "Add sugar to balance acidity."]);
  assert.equal(originalIngredientAnswer(value, "Why add sugar?", { evidenceId: "S1", number: 1, text: value.instructions[0] }), undefined);
  for (const query of [
    "Why rinse rice, why add sugar?", "Why rinse rice why add sugar?", "Why rinse rice; why add sugar?",
    "Why add sugar, and how long do I cook it?", "How much sugar does the recipe use, why?",
    "How much sugar does the recipe use? Why add it?", "Why rinse rice then add sugar?",
  ]) assert.equal(originalIngredientAnswer(value, query), undefined, query);
});

test("saved quantity plus addition step preserves the override and exact source directions", () => {
  const before = structuredClone({ source, dinner });
  for (const query of [
    "How much milk do I need, and when should I add it?",
    "How much milk do I need and when do I add the milk?",
    "How much milk do I need? When should I add it?",
  ]) {
    const answer = planningIngredientStepAnswer(dinner, source, query);
    assert.equal(answer?.answerStatus, "answered", query);
    assert.equal(answer.answer, `For your dinner (2 servings): milk: 80 ml. Source step 2: ${source.instructions[1]}`);
    assert.deepEqual(answer.sourceStep, { evidenceId: "S2", number: 2, text: source.instructions[1] });
    assert.deepEqual(answer.planningFacts, [{ recipeId: source.id, ingredientIndex: 1, sourceEvidenceId: "I2", name: "milk", measure: "80 ml", needsReview: false, basis: "saved_override" }]);
  }
  assert.deepEqual({ source, dinner }, before);
  assert.match(originalIngredientAnswer(source, "How much milk does the original recipe use?").answer, /200 ml/);
});

test("saved mixed answers scale original amounts when there is no override", () => {
  const answer = planningIngredientStepAnswer({ ...dinner, ingredientOverrides: {} }, source, "How much milk do I need, and when should I add it?");
  assert.equal(answer.planningFacts[0].measure, "100 ml");
  assert.equal(answer.planningFacts[0].basis, "source_scaled");
});

test("mixed answers defer unknown saved amounts, changed identities and source scope", () => {
  const query = "How much milk do I need, and when should I add it?";
  for (const meal of [
    { ...dinner, ingredientOverrides: { "1": "a splash" } },
    { ...dinner, recipeId: "other" },
    { ...dinner, planningIngredients: [{ name: "milk", measure: "200 ml" }, { name: "pasta", measure: "400 g" }] },
    { ...dinner, planningIngredients: [{ name: "pasta", measure: "400 g" }, { name: "oat milk", measure: "200 ml" }] },
  ]) assert.equal(planningIngredientStepAnswer(meal, source, query), undefined);
  assert.equal(planningIngredientStepAnswer(dinner, source, "How much milk does the original recipe use, and when should I add it?"), undefined);
});

test("an addition answer needs one explicit addition of this ingredient", () => {
  for (const instructions of [
    ["Warm the milk."], ["Add milk chocolate to the bowl."], ["Add the eggs to the milk."],
    ["Do not add milk."], ["If needed, add milk."], ["Add milk.", "Add the remaining milk."],
  ]) assert.equal(planningIngredientStepAnswer(dinner, { ...source, instructions }, "How much milk do I need, and when should I add it?"), undefined, instructions.join(" "));
});

test("mixed shortcut declines unrelated, multi-ingredient and additional requests", () => {
  for (const query of [
    "How much milk do I need, and when should I add the pasta?",
    "How much pasta and milk do I need, and when should I add it?",
    "How much milk do I need, and when should I add it and why?",
    "How much milk do I need, and when should I add it? Why?",
    "How much milk do I need, and should I boil it?",
    "How much milk do I need, and when should I add it to stop curdling?",
  ]) assert.equal(planningIngredientStepAnswer(dinner, source, query), undefined, query);
});
