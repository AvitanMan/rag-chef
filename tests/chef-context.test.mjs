import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
const directory = await mkdtemp(join(tmpdir(), "jff-chef-context-"));
after(() => rm(directory, { recursive: true, force: true }));
for (const name of ["chef-context", "chef-schema", "quantities", "kitchen-types"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(directory, `${name}.mjs`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"'));
}
const load = (name) => import(pathToFileURL(join(directory, `${name}.mjs`)));
const { chefMealPreview, chefRecipeHash, selectQuestionEvidence, cookingSourceStep } = await load("chef-context");
const { parseChefRequest } = await load("chef-schema");
const { mealReadiness } = await load("quantities");
const recipe = { id: "rice", title: "Rice", ingredients: [{ name: "rice, cooked", measure: "400 g" }, { name: "tomato", measure: "2" }], instructions: Array.from({ length: 30 }, (_, i) => `Source direction ${i + 1}.`), servings: 2, sourceUrl: "https://example.invalid/rice" };
test("recipe version includes source quantities, directions and yield while ignoring display-only images", async () => {
  assert.equal(await chefRecipeHash(recipe), await chefRecipeHash({ ...recipe, image: "new" }));
  assert.notEqual(await chefRecipeHash(recipe), await chefRecipeHash({ ...recipe, servings: 4 }));
  assert.notEqual(await chefRecipeHash(recipe), await chefRecipeHash({ ...recipe, instructions: ["Changed"] }));
});
test("step evidence keeps original IDs and adjacent directions without sending an entire long method", () => {
  const evidence = selectQuestionEvidence(recipe, "Explain this step", "S20");
  assert.deepEqual(evidence.map((item) => item.evidenceId), ["I1", "I2", "S19", "S20", "S21"]);
  assert.equal(evidence[0].text, "400 g rice, cooked");
  assert.equal(evidence[3].text, recipe.instructions[19]);
});
test("legacy cooking methods map source steps only when unambiguous", () => {
  assert.equal(cookingSourceStep(recipe, recipe.instructions.slice(10, 15), 2), "S13");
  const repeated = { ...recipe, instructions: ["Mix", "Mix", "Finish"] };
  assert.equal(cookingSourceStep(repeated, ["Mix"], 0), undefined);
  assert.equal(cookingSourceStep(repeated, ["Mix", "Mix", "Finish"], 1), "S2");
  assert.equal(cookingSourceStep(recipe, ["Edited local step"], 0), undefined);
});
test("discussion and dinner context are bounded, typed and backward compatible", () => {
  assert.equal(parseChefRequest({ query: "Dinner" }).context, undefined);
  const request = parseChefRequest({ query: "Explain this step", context: { recipeId: "rice", targetDate: "2026-10-25", stepEvidenceId: "S20", kitchenRevision: 2 }, history: [{ role: "user", content: "Rice" }], refinements: ["without peanuts"] });
  assert.equal(request.context.stepEvidenceId, "S20");
  for (const extra of [{ history: Array(7).fill({ role: "user", content: "x" }) }, { history: [{ role: "system", content: "x" }] }, { context: { recipeId: "rice", targetDate: "2026-02-30" } }, { context: { servings: 0 } }, { context: { stepEvidenceId: "S1" } }, { context: { recipeId: "rice", unknown: true } }]) assert.throws(() => parseChefRequest({ query: "Rice", ...extra }));
});
test("readiness distinguishes preparation, partial quantities and unknown amounts", () => {
  const meal = { id: "dinner", date: "2026-10-25", recipeId: recipe.id, recipe, baseServings: 2, servings: 2, batches: 1, status: "planned", ingredientOverrides: {} };
  const pantry = [{ id: "raw", name: "rice", measure: "1 kg" }, { id: "cooked", name: "cooked rice", measure: "100 g" }, { id: "tomato", name: "tomatoes", measure: "2" }];
  const before = structuredClone(pantry);
  const result = mealReadiness(meal, pantry, "2026-10-25");
  assert.equal(result.coveredCount, 1); assert.equal(result.partialCount, 1);
  assert.equal(result.shopping[0].measure, "300 g");
  assert.match(result.shopping[0].preparationNote, /Cooked and uncooked/);
  assert.deepEqual(pantry, before);
});

test("question evidence normalizes cooking verbs without changing source text or ingredient identity", () => {
  const source = { ...recipe, instructions: recipe.instructions.map((text, index) => index === 19 ? "Bake in the oven for 30 minutes." : text) };
  const evidence = selectQuestionEvidence(source, "Which step mentions baking?");
  assert.ok(evidence.some((item) => item.evidenceId === "S20" && item.text === "Bake in the oven for 30 minutes."));
  assert.ok(!evidence.some((item) => item.evidenceId === "S1"));
});

test("pantry amount notes accepted by kitchen storage also remain valid Chef inputs", () => {
  const note = "Amount unknown; check the opened package before planning. ".repeat(2);
  const request = parseChefRequest({ query: "Dinner", pantry: [{ name: "rice", quantity: note }] });
  assert.equal(request.pantry[0].quantity, note.trim());
});

test("planning previews apply portions while preserving final overrides and cooking uses the saved meal", () => {
  const saved = { id: "saved", date: "2026-10-25", recipeId: recipe.id, recipe, baseServings: 2, servings: 2, batches: 1, status: "planned", ingredientOverrides: { "0": "250 g" } };
  const before = structuredClone(saved);
  const preview = chefMealPreview(saved, { purpose: "planning", targetDate: "2026-10-26", servings: 4 });
  assert.equal(preview.servings, 4); assert.equal(preview.date, "2026-10-26");
  assert.deepEqual(preview.ingredientOverrides, { "0": "250 g" });
  assert.strictEqual(chefMealPreview(saved, { purpose: "cooking", servings: 8 }), saved);
  assert.deepEqual(saved, before);
  const batches = { ...saved, baseServings: null, servings: null };
  assert.equal(chefMealPreview(batches, { batches: 2 }).batches, 2);
  assert.equal(chefMealPreview(batches, { servings: 4 }).servings, null);
  assert.throws(() => parseChefRequest({ query: "Dinner", context: { purpose: "unknown" } }));
});
