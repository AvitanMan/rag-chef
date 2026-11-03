import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
const directory = await mkdtemp(join(tmpdir(), "jff-chef-context-"));
after(() => rm(directory, { recursive: true, force: true }));
for (const name of ["recipe-instructions", "chef-planning-answer", "chef-context", "chef-schema", "quantities", "kitchen-types"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(directory, `${name}.mjs`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"'));
}
const load = (name) => import(pathToFileURL(join(directory, `${name}.mjs`)));
const { chefMealPreview, chefRecipeHash, recipeEvidence, selectQuestionEvidence, cookingSourceStep, focusedCookingStep, cookingTechniqueGuides, isCookingMeaningQuestion, focusedCookingMeaningAnswer } = await load("chef-context");
const { parseChefRequest, CHEF_RESPONSE_JSON_SCHEMA } = await load("chef-schema");
const { mealReadiness } = await load("quantities");
const recipe = { id: "rice", title: "Rice", ingredients: [{ name: "rice, cooked", measure: "400 g" }, { name: "tomato", measure: "2" }], instructions: Array.from({ length: 30 }, (_, i) => `Source direction ${i + 1}.`), servings: 2, sourceUrl: "https://example.invalid/rice" };
test("Chef batch previews accept the same quarter-batch bounds as saved dinners", () => {
  for (const batches of [0.25, 0.75, 1, 2.5, 20]) assert.equal(parseChefRequest({ query: "How much rice?", context: { batches } }).context.batches, batches);
  for (const batches of [0, 0.1, 1.1, 20.25, 100, Infinity, NaN, "2.5"]) assert.throws(() => parseChefRequest({ query: "How much rice?", context: { batches } }), /context.batches/);
  for (const servings of [0.25, 1.5, 101]) assert.throws(() => parseChefRequest({ query: "How much rice?", context: { servings } }), /context.servings/);
  for (const kitchenRevision of [-1, 0.25, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parseChefRequest({ query: "How much rice?", context: { kitchenRevision } }), /context.kitchenRevision/);
});
test("recipe version includes source quantities, directions and yield while ignoring display-only images", async () => {
  assert.equal(await chefRecipeHash(recipe), await chefRecipeHash({ ...recipe, image: "new" }));
  assert.notEqual(await chefRecipeHash(recipe), await chefRecipeHash({ ...recipe, servings: 4 }));
  assert.notEqual(await chefRecipeHash(recipe), await chefRecipeHash({ ...recipe, instructions: ["Changed"] }));
  assert.notEqual(await chefRecipeHash(recipe), await chefRecipeHash({ ...recipe, sourceNotes: ["Total time: 30 minutes."] }));
});
test("source notes have canonical IDs without renumbering ingredients or steps", () => {
  const source = { ...recipe, sourceNotes: ["Total time: 45 minutes.", "Protein: 12 g per serving."] };
  assert.deepEqual(recipeEvidence(source).slice(-2), source.sourceNotes.map((text, index) => ({ evidenceId: `N${index + 1}`, text })));
  assert.deepEqual(recipeEvidence(source).slice(0, 32), recipeEvidence(recipe));
  assert.deepEqual(selectQuestionEvidence(source, "Explain this step", "S20").slice(-2), recipeEvidence(source).slice(-2));
  const validId = new RegExp(CHEF_RESPONSE_JSON_SCHEMA.properties.sourceFacts.items.properties.evidenceId.pattern);
  for (const id of ["I1", "S20", "N1", "N20"]) assert.ok(validId.test(id), id);
  for (const id of ["N0", "N01", "N-1", "Q1"]) assert.ok(!validId.test(id), id);
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
test("numbered source directions retain canonical evidence IDs after display normalization", () => {
  const source = { ...recipe, instructions: ["Stovetop instructions", "1. Rinse rice.", "Step 2) Simmer for 10 minutes.", "Oven", "1. Rinse rice.", "2. Bake for 20 minutes."] };
  const before = structuredClone(source);
  assert.equal(cookingSourceStep(source, ["Rinse rice.", "Simmer for 10 minutes."], 0), "S2");
  assert.equal(cookingSourceStep(source, ["Rinse rice.", "Simmer for 10 minutes."], 1), "S3");
  assert.equal(cookingSourceStep(source, ["Rinse rice.", "Bake for 20 minutes."], 0), undefined, "repeated source actions still need an unambiguous match");
  assert.equal(cookingSourceStep(source, ["Rinse rice.", "Bake for 20 minutes."], 1), "S6");
  assert.equal(cookingSourceStep(source, ["Edited rice instruction."], 0), undefined);
  assert.equal(recipeEvidence(source).find(row => row.evidenceId === "S3").text, "Step 2) Simmer for 10 minutes.");
  assert.deepEqual(source, before);
});
test("cosmetic numbering never resolves an ambiguous step, and exact matches keep priority", () => {
  const source = { ...recipe, instructions: ["1. Mix.", "2. Mix.", "3. Finish."] };
  assert.equal(cookingSourceStep(source, ["Mix."], 0), undefined);
  assert.equal(cookingSourceStep(source, ["2. Mix."], 0), "S2");
  assert.equal(cookingSourceStep(source, ["Mix.", "Mix.", "Finish."], 1), "S2");
  assert.equal(cookingSourceStep(source, ["Mix gently."], 0), undefined);
});
test("cooking focus uses the current canonical step unless a valid numbered step is requested", () => {
  assert.deepEqual(focusedCookingStep(recipe, "What does this mean?", "S20"), { evidenceId: "S20", number: 20, text: recipe.instructions[19] });
  for (const noun of ["step", "direction", "instruction"]) {
    assert.equal(focusedCookingStep(recipe, `Explain ${noun} #17`, "S20").evidenceId, "S17");
  }
  for (const [query, step] of [["Explain this", undefined], ["Explain this", "S0"], ["Explain step 99", "S20"], ["Explain step 0", "S20"]]) {
    assert.equal(focusedCookingStep(recipe, query, step), null);
  }
});
test("reviewed technique definitions explain only verbs present in the focused source step", () => {
  const [boiling] = cookingTechniqueGuides("Boil the vegetables in water until cooked.", "What does this instruction mean?");
  assert.equal(boiling.term, "Boiling"); assert.match(boiling.explanation, /large bubbles/);
  assert.equal(boiling.sourceUrl, "https://en.wikibooks.org/wiki/Cookbook:Boiling");
  assert.equal(boiling.licenseUrl, "https://creativecommons.org/licenses/by-sa/4.0/");
  assert.doesNotMatch(boiling.explanation, /\d|minutes?|degrees?|tender|fork/);
  assert.equal(cookingTechniqueGuides("Simmer the stock.", "How do I do this?")[0].term, "Simmering");
  assert.deepEqual(cookingTechniqueGuides("Put bread in a bowl.", "Explain boiling"), []);
  assert.deepEqual(cookingTechniqueGuides("Simmer the stock.", "What does boiling mean?"), []);
  assert.deepEqual(cookingTechniqueGuides("Boil the vegetables.", "How long do I boil them?"), []);
});
test("only standalone meaning requests use reviewed definitions without generation", () => {
  for (const question of ["What does this instruction mean?", "Explain this source step.", "Please explain this step", "What does boiling mean?"]) assert.equal(isCookingMeaningQuestion(question), true, question);
  for (const question of ["What does this instruction mean, and how long does it take?", "Explain step 2", "How do I tell when it is cooked?", "Why boil instead of simmer?", "What does this instruction mean? Can I substitute rice?"]) assert.equal(isCookingMeaningQuestion(question), false, question);
});
test("step meanings retain every source action and do not turn source prohibitions into boiling advice", () => {
  for (const text of [
    "Do not boil the yogurt. Remove the pan from heat and stir it in gently.",
    "Add the cream and enough of the remaining asparagus cooking water to give the soup the consistency you want. Season to taste with salt, freshly ground black pepper, and cayenne pepper. Reheat gently over low heat, making sure not to let the soup boil.",
    "Heat thoroughly, but not to boiling.",
    "Do one of the following: Put on the lid, turn down the heat, and allow the potatoes to cook in their own steam until cooked through. A little extra water can be added if necessary, but as little as possible should be used. The potatoes should not boil. Put the spiced potatoes on a tray in a hot oven until cooked through.",
    "Don’t boil the milk; heat gently.",
  ]) {
    const step = { evidenceId: "S1", number: 1, text };
    const query = "What does this step mean?";
    const result = focusedCookingMeaningAnswer(step, query, cookingTechniqueGuides(text, query));
    assert.ok(result.startsWith(`Source step 1: ${text}`));
    assert.match(result, /This step says to avoid boiling/);
    assert.match(result, /The term reference describes that state: Boiling means/);
    assert.doesNotMatch(result, /Look for|curdl|because/);
  }
});
test("positive step meanings keep endpoints and standalone term meanings remain descriptive references", () => {
  const text = "Boil the potatoes until cooked through, then drain them and return the pan to low heat.";
  const step = { evidenceId: "S2", number: 2, text };
  const result = focusedCookingMeaningAnswer(step, "Explain this step", cookingTechniqueGuides(text, "Explain this step"));
  assert.ok(result.startsWith(`Source step 2: ${text}`));
  assert.match(result, /Term reference only/);
  assert.match(result, /large bubbles/);
  assert.doesNotMatch(result, /Look for|minutes?|fork/);
  const negative = { ...step, text: "Do not boil the milk." };
  const definition = focusedCookingMeaningAnswer(negative, "What does boiling mean?", cookingTechniqueGuides(negative.text, "What does boiling mean?"));
  assert.match(definition, /Do not boil the milk/);
  assert.match(definition, /Term reference only; follow the source instruction/);
  assert.match(definition, /Boiling means/);
  assert.doesNotMatch(definition, /Look for/);
  assert.equal(focusedCookingMeaningAnswer(step, "How long should I boil it?", cookingTechniqueGuides(text, "Explain this step")), undefined);
  assert.equal(focusedCookingMeaningAnswer(step, "Explain this step", []), undefined);
});
test("discussion and dinner context are bounded, typed and backward compatible", () => {
  assert.equal(parseChefRequest({ query: "Dinner" }).context, undefined);
  const request = parseChefRequest({ query: "Explain this step", context: { recipeId: "rice", targetDate: "2026-10-25", stepEvidenceId: "S20", kitchenRevision: 2 }, history: [{ role: "user", content: "Rice" }], refinements: ["without peanuts"] });
  assert.equal(request.context.stepEvidenceId, "S20");
  for (const extra of [{ history: Array(7).fill({ role: "user", content: "x" }) }, { history: [{ role: "system", content: "x" }] }, { context: { recipeId: "rice", targetDate: "2026-02-30" } }, { context: { servings: 0 } }, { context: { stepEvidenceId: "S1" } }, { context: { recipeId: "rice", unknown: true } }]) assert.throws(() => parseChefRequest({ query: "Rice", ...extra }));
});
test("Chef preserves full saved preference lists and rejects oversized exclusions instead of truncating them", () => {
  const values = Array.from({ length: 100 }, (_, index) => `ingredient ${index}`.padEnd(120, "x"));
  const profile = { allergies: values, dislikes: values, equipment: values, diet: "x".repeat(120), skillLevel: "x".repeat(120), budget: "x".repeat(120) };
  const parsed = parseChefRequest({ query: "Dinner", profile }).profile;
  for (const key of ["allergies", "dislikes", "equipment"]) assert.deepEqual(parsed[key], profile[key]);
  assert.deepEqual(parsed.diet, [profile.diet]);
  assert.equal(parsed.skillLevel, profile.skillLevel);
  assert.equal(parsed.budget, profile.budget);
  for (const key of ["allergies", "dislikes", "equipment", "diet"]) {
    for (const value of [[...values, "peanut"], ["x".repeat(121)], [42], "peanut"]) {
      if (key === "diet" && typeof value === "string") continue;
      assert.throws(() => parseChefRequest({ query: "Dinner", profile: { [key]: value } }), /profile\./);
    }
  }
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

test("follow-up paraphrases retrieve timing, temperature, and doneness evidence", () => {
  const source = { ...recipe, instructions: recipe.instructions.map((text, index) => index === 19 ? "Preheat to 180°C. Bake for 25–30 minutes until golden." : text) };
  for (const query of ["What heat should I use?", "How hot should the oven be?", "How long should it stay there?", "How can I tell it is done?"]) {
    const evidence = selectQuestionEvidence(source, query);
    assert.ok(evidence.some((item) => item.evidenceId === "S20"), query);
    assert.ok(!evidence.some((item) => item.evidenceId === "S1"), query);
  }
});
test("explicit step questions keep source IDs and weak matches fall back to available context", () => {
  for (const noun of ["step", "direction", "instruction"]) assert.deepEqual(selectQuestionEvidence(recipe, `What does ${noun} 17 say?`).filter((item) => item.evidenceId.startsWith("S")).map((item) => item.evidenceId), ["S16", "S17", "S18"]);
  assert.equal(selectQuestionEvidence(recipe, "Why is this technique useful?").length, 32);
  const huge = { ...recipe, instructions: recipe.instructions.map((text) => text + " Original source wording.".repeat(50)) };
  assert.ok(selectQuestionEvidence(huge, "Why is this technique useful?").length < 32);
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

const { isPlanningQuantityQuestion, planningQuantityAnswer } = await load("chef-planning-answer");
test("saved amount answers use final overrides, scale source amounts, and retain source IDs", () => {
  const source = { ...recipe, ingredients: [{ name: "pasta", measure: "400 g" }, { name: "milk", measure: "100 ml" }], servings: 4 };
  const meal = { recipeId: source.id, recipe: source, baseServings: 4, servings: 2, batches: 1, ingredientOverrides: { "1": "80 ml" } };
  const before = structuredClone(meal);
  const answer = planningQuantityAnswer(meal, "How much pasta and milk do I need for this saved dinner?");
  assert.equal(answer.answerStatus, "answered");
  assert.deepEqual(answer.planningFacts.map(row => [row.ingredientIndex, row.measure, row.basis, row.sourceEvidenceId]), [[0, "200 g", "source_scaled", "I1"], [1, "80 ml", "saved_override", "I2"]]);
  assert.deepEqual(meal, before);
  for (const query of ["How much pasta does this dinner need?", "How much pasta do we need?"]) assert.equal(planningQuantityAnswer(meal, query).planningFacts[0].measure, "200 g", query);
  assert.equal(planningQuantityAnswer({ ...meal, ingredientOverrides: { "1": "a splash" } }, "How much milk?").answerStatus, "needs_clarification");
  assert.equal(planningQuantityAnswer({ ...meal, baseServings: null, servings: null, batches: 2 }, "How much pasta?").planningFacts[0].measure, "800 g");
});
test("amount lookup keeps preparation state, longest names and unknown ingredients distinct", () => {
  const meal = { recipeId: "rice", recipe: { ...recipe, ingredients: [{ name: "rice", measure: "100 g" }, { name: "rice vinegar", measure: "20 ml" }] }, baseServings: 2, servings: 2, batches: 1, ingredientOverrides: {} };
  assert.deepEqual(planningQuantityAnswer(meal, "How much rice vinegar?").planningFacts.map(row => row.ingredientIndex), [1]);
  for (const query of ["How much cooked rice?", "How much rice, cooked?", "How much soy sauce?", "Tell me ingredient amounts: cooked rice"]) {
    const answer = planningQuantityAnswer(meal, query);
    assert.equal(answer.answerStatus, "needs_clarification", query); assert.deepEqual(answer.planningFacts, []);
  }
  assert.equal(planningQuantityAnswer(meal, "How much rice and soy sauce do I need?").answerStatus, "needs_clarification");
  assert.equal(planningQuantityAnswer(meal, "What are the ingredient amounts?").planningFacts.length, 2);
  for (const query of ["How much pasta?", "What are the ingredient amounts?"]) assert.equal(isPlanningQuantityQuestion(query), true);
  for (const query of ["How much pasta does the original source use?", "How much milk should I heat?", "How many minutes do I boil it?", "How much pasta and why?", "How much milk can I use instead?"]) assert.equal(isPlanningQuantityQuestion(query), false, query);
});

test("mixed amount and cooking questions keep their entire request on the evidence path", () => {
  for (const query of [
    "How much pasta do I need, and how do I cook it?",
    "How much pasta do I need, and should it be drained?",
    "How much rice do I need? Is it rinsed first?",
    "How much rice do I need; explain the next step.",
    "How much rice do I need, could it be rinsed first?",
    "How much milk do I need, then stir it in?",
    "How much pasta do I need, help me get it tender?",
    "How much milk do I need and I want it without lumps?",
    "How much milk do I need\nand I want it without lumps?",
  ]) assert.equal(isPlanningQuantityQuestion(query), false, query);
  for (const query of ["How much pasta and milk do I need for this saved dinner?", "How much cooked rice do we need?", "What are all the ingredient amounts?"]) assert.equal(isPlanningQuantityQuestion(query), true, query);
});

test("plain-English meaning requests explain the prohibited boiling state without inventing a cause", () => {
  const step = { evidenceId: "S1", number: 1, text: "Heat thoroughly, but not to boiling." };
  const answer = focusedCookingMeaningAnswer(step, "Explain this step in plain English.", cookingTechniqueGuides(step.text, "Explain this step in plain English."));
  assert.ok(answer.includes(step.text)); assert.match(answer, /says to avoid boiling/); assert.match(answer, /large bubbles/);
  assert.doesNotMatch(answer, /curdl|because|Look for/);
  const conditional = { ...step, text: "If the water is not boiling yet, turn up the heat until it boils." };
  assert.doesNotMatch(focusedCookingMeaningAnswer(conditional, "Explain this step simply.", cookingTechniqueGuides(conditional.text, "Explain this step simply.")), /says to avoid boiling/);
  const positive = { ...step, text: "Do not drain the beans, but bring to a boil." };
  assert.doesNotMatch(focusedCookingMeaningAnswer(positive, "Explain this step simply.", cookingTechniqueGuides(positive.text, "Explain this step simply.")), /says to avoid boiling/);
});
