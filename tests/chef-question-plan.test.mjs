import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
const dir = await mkdtemp(join(tmpdir(), "chef-question-plan-"));
after(() => rm(dir, { recursive: true, force: true }));
for (const name of ["chef-question-plan", "chef-planning-answer", "chef-grounding", "quantities", "kitchen-types"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(dir, name + ".mjs"), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"'));
}
const { recipeQuestionParts, partialRecipeAnswer } = await import(pathToFileURL(join(dir, "chef-question-plan.mjs")));
const recipe = { id: "bake", ingredients: [{ name: "any small pasta", measure: "400 g" }, { name: "milk", measure: "200 ml" }], instructions: ["Bake at 200°C for 30 minutes until firm."], servings: 4 };

test("question splitting preserves ingredient lists and separates actual requests", () => {
  assert.deepEqual(recipeQuestionParts("For Test rice 0, how many calories?"), ["For Test rice 0, how many calories?"]);
  assert.deepEqual(recipeQuestionParts("How much pasta and milk do I need?"), ["How much pasta and milk do I need?"]);
  assert.deepEqual(recipeQuestionParts("How many calories per serving, and how long does it bake?"), ["How many calories per serving", "how long does it bake?"]);
  assert.deepEqual(recipeQuestionParts("Why rinse rice, why add sugar?"), ["Why rinse rice", "why add sugar?"]);
  assert.deepEqual(recipeQuestionParts("What is total time; how much pasta does the original recipe use?"), ["What is total time", "how much pasta does the original recipe use?"]);
});
test("missing nutrition keeps a known baking time without inventing a total", () => {
  const out = partialRecipeAnswer(recipe, "How many calories per serving, and how long does it bake?");
  assert.equal(out.answerStatus, "answered"); assert.equal(out.remainingQuery, "");
  assert.match(out.answer, /does not state.*nutrition/); assert.ok(out.answer.includes(recipe.instructions[0]));
  assert.deepEqual(out.evidenceIds, ["S1"]); assert.doesNotMatch(out.answer, /total.*30/);
});
test("missing total time keeps an exact original quantity", () => {
  const out = partialRecipeAnswer(recipe, "What is the total time, and how much pasta does the original recipe use?");
  assert.equal(out.answerStatus, "answered"); assert.equal(out.remainingQuery, "");
  assert.match(out.answer, /does not establish a total/); assert.match(out.answer, /400 g any small pasta/);
  assert.deepEqual(out.evidenceIds, ["I1"]);
  const unknown = partialRecipeAnswer(recipe, "What is the total time, and how many calories per serving?");
  assert.equal(unknown.answerStatus, "unsupported"); assert.deepEqual(unknown.evidenceIds, []);
});
test("saved quantities in partial answers keep final overrides and label their basis", () => {
  const meal = { recipeId: recipe.id, recipe, baseServings: 4, servings: 2, batches: 1, ingredientOverrides: { "1": "80 ml" } };
  const out = partialRecipeAnswer(recipe, "How many calories per serving, and how much milk do I need?", undefined, meal);
  assert.match(out.answer, /2 servings.*80 ml/); assert.doesNotMatch(out.answer, /200 ml/);
  assert.equal(out.planningFacts[0].basis, "saved_override"); assert.equal(out.planningFacts[0].measure, "80 ml");
  const original = partialRecipeAnswer(recipe, "How many calories per serving, and how much milk does the original recipe use?", undefined, meal);
  assert.match(original.answer, /Original recipe ingredient: 200 ml milk/);
});
test("ambiguous step timing remains a separate query instead of guessing a source step", () => {
  const out = partialRecipeAnswer({ ...recipe, instructions: ["Boil water for 2 minutes.", "Boil beans for 10 minutes."] }, "How many calories per serving, and how long do I boil it?");
  assert.equal(out.remainingQuery, "how long do I boil it?"); assert.deepEqual(out.evidenceIds, []);
});
test("partial answers preserve the requested ingredient and focused step", () => {
  const source = { ...recipe, ingredients: [...recipe.ingredients, { name: "sugar", measure: "1 tsp" }], instructions: ["Boil pasta for 10 minutes.", "Add the milk.", "Add sugar.", "Add sugar to balance acidity."] };
  const named = partialRecipeAnswer(source, "How many calories per serving, and how long should I boil the milk?");
  assert.equal(named.remainingQuery, "how long should I boil the milk?"); assert.deepEqual(named.evidenceIds, []);
  const focused = partialRecipeAnswer(source, "How many calories per serving, and how long do I boil it?", undefined, undefined, { evidenceId: "S2", number: 2, text: source.instructions[1] });
  assert.equal(focused.remainingQuery, "how long do I boil it?"); assert.deepEqual(focused.evidenceIds, []);
  const purpose = partialRecipeAnswer(source, "How many calories per serving, and what is sugar used for in this step?", undefined, undefined, { evidenceId: "S3", number: 3, text: source.instructions[2] });
  assert.equal(purpose.remainingQuery, "what is sugar used for in this step?"); assert.deepEqual(purpose.evidenceIds, []);
});
test("partial timing does not borrow another action's duration or a negated duration", () => {
  for (const text of ["Bake until golden. Rest for 10 minutes.", "Bake until golden, then rest for 10 minutes.", "Bake and rest for 10 minutes.", "Do not bake for 10 minutes."]) {
    const out = partialRecipeAnswer({ ...recipe, instructions: [text] }, "How many calories per serving, and how long does it bake?");
    assert.equal(out.remainingQuery, "how long does it bake?", text); assert.deepEqual(out.evidenceIds, [], text);
  }
});
