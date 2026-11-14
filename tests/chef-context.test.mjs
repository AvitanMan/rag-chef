import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";
import { attachCatalogReadBinding } from "./helpers/catalog-binding.mjs";
import { attachChefBinding } from "./helpers/chef-binding.mjs";
import { createSqliteD1 } from "./helpers/sqlite-d1.mjs";
// Execute the real transitive graph and replace only storage boundaries.
const sources = await createSourceLoader({ name: "chef-context", externals: { "cloudflare:workers": "export const env = {};" }, overrides: {
  "app/lib/kitchen-store.ts": `
    export const fixture = { document: null, reads: 0 };
    export async function getKitchenDocument() { fixture.reads++; return fixture.document; }
    export async function saveKitchenDocument() { throw new Error("Chef cannot write kitchen state"); }
    export class KitchenConflictError extends Error {}
  `,
  "app/lib/recipe-store.ts": `
    export const fixture = { records: [] };
    export async function listCatalogRecipes() { return fixture.records; }
    export async function listStoredRecipeEmbeddings() { return []; }
    export async function getRecipeSourcePolicy() { return null; }
    export async function isRecipeCatalogConfigured() { return true; }
    export function catalogRecipeId() { throw new Error("Chef cannot create catalog identities"); }
  `,
} });
const operationalSql = await createSqliteD1();
after(async () => { operationalSql.close(); await sources.dispose(); });
const load = name => sources.import(name === "chef-route" ? "app/api/chef/route.ts" : `app/lib/${name}.ts`);
const { chefMealPreview, chefMealHash, chefMealReadiness, chefPantryProjection, chefRecipeHash, recipeEvidence, selectQuestionEvidence, cookingSourceStep, focusedCookingStep, cookingTechniqueGuides, isCookingMeaningQuestion, focusedCookingMeaningAnswer } = await load("chef-context");
const { parseChefRequest, CHEF_RESPONSE_JSON_SCHEMA } = await load("chef-schema");
const { mealReadiness } = await load("quantities");
const { createPlannedMeal, localDate, addDateDays } = await load("kitchen-state");
const { plannedDinnerFingerprint } = await load("cooking-session");
const { fixture: kitchenFixture } = await load("kitchen-store");
const { fixture: catalogFixture } = await load("recipe-store");
const { env } = await sources.import("cloudflare:workers");
env.DB = operationalSql.binding;
await attachCatalogReadBinding(sources, env);
await attachChefBinding(sources, env);
const { POST } = await load("chef-route");
const recipe = { id: "rice", title: "Rice", ingredients: [{ name: "rice, cooked", measure: "400 g" }, { name: "tomato", measure: "2" }], instructions: Array.from({ length: 30 }, (_, i) => `Source direction ${i + 1}.`), servings: 2, sourceUrl: "https://example.invalid/rice" };
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

test("Chef accepts 121–500 pantry rows and names up to the kitchen's 200-character limit without truncation", () => {
  for (const count of [121, 250, 500]) {
    const pantry = Array.from({ length: count }, (_, index) => ({ name: `Ingredient ${index} `.padEnd(121 + index % 80, "x"), quantity: "Amount unknown; check the package. ".repeat(4).trim() }));
    assert.deepEqual(parseChefRequest({ query: "Dinner", pantry }).pantry, pantry);
    assert.deepEqual(parseChefRequest({ query: "Dinner", pantry: pantry.map(item => item.name) }).pantry, pantry.map(({ name }) => ({ name })));
  }
  for (const pantry of [Array(501).fill("rice"), ["x".repeat(201)], [{ name: "x".repeat(201) }], [{ name: "rice", quantity: "x".repeat(161) }], [{ name: "rice", unit: "x".repeat(41) }]]) {
    assert.throws(() => parseChefRequest({ query: "Dinner", pantry }), /pantry/);
  }
});

test("Chef pantry projection preserves physical amounts and notes but excludes zero and past-date stock", () => {
  const pantry = [
    { id: "rice", name: "rice", measure: "1 kg", useBy: "2026-10-25" },
    { id: "notes", name: "beans", measure: "  An opened bag; weigh before cooking.  " },
    { id: "package", name: "tomato", measure: "2 cans" },
    { id: "missing", name: "salt", measure: "" },
    { id: "empty", name: "oil", measure: "0 ml" },
    { id: "past", name: "milk", measure: "1 l", useBy: "2026-10-24" },
  ];
  const before = structuredClone(pantry);
  assert.deepEqual(chefPantryProjection(pantry, "2026-10-25"), pantry.slice(0, 4).map(item => ({ name: item.name, quantity: item.measure })));
  assert.deepEqual(chefPantryProjection(pantry, "2026-10-26"), pantry.slice(1, 4).map(item => ({ name: item.name, quantity: item.measure })));
  assert.deepEqual(pantry, before);
});

test("cooking readiness uses today's physical stock without changing saved dates, amounts or version meanings", async () => {
  const saved = { ...createPlannedMeal("2026-11-03", recipe), id: "saved", ingredientOverrides: { "0": "250 g" } };
  const reserved = { ...saved, id: "other", date: "2026-11-02" };
  const stock = { pantry: [{ id: "rice", name: "cooked rice", measure: "250 g", useBy: "2026-10-25" }, { id: "tomato", name: "tomato", measure: "2" }], meals: [reserved], targetDate: saved.date, today: "2026-10-25" };
  const before = structuredClone({ saved, stock });
  const hash = await chefMealHash(saved), fingerprint = plannedDinnerFingerprint(saved);
  assert.equal(chefMealReadiness(saved, stock, "cooking").coveredCount, 2);
  assert.equal(chefMealReadiness(saved, stock, "planning").coveredCount, 0);
  assert.deepEqual({ saved, stock }, before);
  assert.equal(await chefMealHash(saved), hash);
  assert.equal(plannedDinnerFingerprint(saved), fingerprint);
  assert.equal(await chefMealHash({ ...saved, date: stock.today }), hash, "meal versions still ignore scheduling dates");
  assert.equal(plannedDinnerFingerprint({ ...saved, date: stock.today }), fingerprint);
  assert.notEqual(await chefMealHash({ ...saved, servings: 8 }), hash);
  assert.notEqual(plannedDinnerFingerprint({ ...saved, servings: 8 }), fingerprint);
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

const routeRecipe = { ...recipe, id: "test:rice", title: "Rice dinner", image: null, category: "Dinner", cuisine: "", tags: [],
  source: { name: "Test", url: "https://example.invalid" }, ingredients: [{ name: "rice", measure: "200 g" }], instructions: ["Stir the rice."] };
const today = "2026-10-25";
function savedDinner(date, overrides = {}) {
  return { ...createPlannedMeal(date, routeRecipe), id: `dinner:${date}`, ingredientOverrides: { "0": "250 g" }, ...overrides };
}
async function savedContext(meal, overrides = {}) {
  return { purpose: "cooking", recipeId: meal.recipeId, recipeHash: await chefRecipeHash(meal.recipe), mealHash: await chefMealHash(meal),
    mealDate: meal.date, mealId: meal.id, kitchenRevision: 7, targetDate: meal.date, today, ...overrides };
}
function chefHarness(t, state, source = routeRecipe, onGeneration) {
  const document = { revision: 7, state, updatedAt: null }, prompts = [];
  kitchenFixture.document = document; kitchenFixture.reads = 0;
  catalogFixture.records = [{ recipe: source, contentHash: "fixture" }];
  t.mock.method(globalThis, "fetch", async (_url, request) => {
    const body = JSON.parse(request.body), text = body.messages.find(item => item.role === "user").content;
    const offset = text.indexOf("\n\n{");
    assert.notEqual(offset, -1);
    prompts.push({ text, data: JSON.parse(text.slice(offset + 2)) });
    onGeneration?.(document);
    return Response.json({ error: "Provider deliberately offline in context tests" }, { status: 503 });
  });
  return { document, prompts, async ask(context, pantry = [{ name: "client-only", quantity: "999 kg" }], query = "Can I cook this dinner with my pantry?") {
    const response = await POST(new Request("http://localhost/api/chef", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, provider: "ollama", context, pantry }) }));
    return { status: response.status, body: await response.json() };
  } };
}
function kitchenState(pantry, meals = []) {
  return { schemaVersion: 2, pantry, meals: Object.fromEntries(meals.map(meal => [meal.date, meal])), shoppingChecked: {}, migratedLegacy: false };
}

for (const useBy of [today, "2026-11-04"]) test(`early cross-week cooking ignores planned reservations and uses stock eligible today (use-by ${useBy})`, async t => {
  const saved = savedDinner("2026-11-03");
  const others = [savedDinner(today, { ingredientOverrides: { "0": "500 g" } }), savedDinner("2026-11-02", { ingredientOverrides: { "0": "500 g" } })];
  const state = kitchenState([{ id: "rice", name: "rice", measure: "500 g", useBy }], [saved, ...others]);
  const before = structuredClone(state), hash = await chefMealHash(saved), fingerprint = plannedDinnerFingerprint(saved);
  const harness = chefHarness(t, state);
  const context = await savedContext(saved, { targetDate: "2026-11-10", servings: 8, stepEvidenceId: "S1" });
  const { status, body } = await harness.ask(context);
  assert.equal(status, 200);
  assert.equal(body.readinessByRecipeId[saved.recipeId].coveredCount, 1);
  assert.deepEqual(body.readinessByRecipeId[saved.recipeId].shopping, []);
  assert.deepEqual(body.resolvedContext, context);
  assert.equal(harness.prompts.length, 1);
  const prompt = harness.prompts[0];
  assert.equal(prompt.data.focusedCookingStep.evidenceId, "S1", "exercise the focused cooking prompt too");
  assert.deepEqual(prompt.data.pantry, [{ name: "rice", quantity: "500 g" }]);
  assert.deepEqual(prompt.data.retrievedRecipes[0].pantryMatch, ["rice"]);
  assert.equal(prompt.data.savedDinnerAmounts[0].measure, "250 g", "cooking ignores requested preview servings");
  assert.match(prompt.data.pantryContextWarning, /physical pantry stock on 2026-10-25, without virtual reservations/);
  assert.ok(body.warnings.includes(prompt.data.pantryContextWarning));
  assert.match(prompt.text, /before planned reservations, not unreserved balances/);
  assert.deepEqual(state, before);
  assert.equal(await chefMealHash(saved), hash); assert.equal(plannedDinnerFingerprint(saved), fingerprint);
});

test("cooking without dinner.today falls back to localDate rather than the saved future date", async t => {
  const actualToday = localDate(), saved = savedDinner(addDateDays(actualToday, 10));
  const harness = chefHarness(t, kitchenState([{ id: "rice", name: "rice", measure: "250 g", useBy: actualToday }], [saved]));
  const context = await savedContext(saved); delete context.today;
  const result = await harness.ask(context);
  assert.equal(result.status, 200);
  assert.equal(result.body.readinessByRecipeId[saved.recipeId].coveredCount, 1);
  assert.ok(result.body.warnings.some(warning => warning.includes(`physical pantry stock on ${actualToday}`)));
  assert.equal(result.body.resolvedContext.mealDate, saved.date);
  assert.equal(result.body.resolvedContext.targetDate, saved.date);
});

test("planning retains the target date's week allocation while the model sees physical on-hand amounts", async t => {
  const saved = savedDinner("2026-10-27"), targetDate = "2026-11-03";
  const state = kitchenState([
    { id: "rice", name: "rice", measure: "500 g", useBy: targetDate },
    { id: "early", name: "milk", measure: "1 l", useBy: "2026-11-02" },
    { id: "zero", name: "oil", measure: "0 ml" },
  ], [saved, savedDinner("2026-10-26", { ingredientOverrides: { "0": "500 g" } }), savedDinner("2026-11-02", { ingredientOverrides: { "0": "300 g" } })]);
  const before = structuredClone(state), harness = chefHarness(t, state);
  const context = await savedContext(saved, { purpose: "planning", targetDate });
  const result = await harness.ask(context);
  assert.equal(result.status, 200);
  assert.equal(result.body.readinessByRecipeId[saved.recipeId].partialCount, 1);
  assert.equal(result.body.readinessByRecipeId[saved.recipeId].shopping[0].measure, "50 g");
  const prompt = harness.prompts[0];
  assert.deepEqual(prompt.data.pantry, [{ name: "rice", quantity: "500 g" }], "raw on-hand stock is not the 200 g reservation balance");
  assert.match(prompt.data.pantryContextWarning, /Planning availability is checked for 2026-11-03.*target week \(2026-11-02 to 2026-11-08\)/);
  assert.match(prompt.data.pantryContextWarning, /before reservations, not unreserved quantities/);
  assert.ok(result.body.warnings.includes(prompt.data.pantryContextWarning));
  assert.deepEqual(result.body.resolvedContext, context);
  assert.deepEqual(state, before);
});

test("new planning previews still replace only the unlocked planned target slot", async t => {
  const targetDate = "2026-11-03", slot = savedDinner(targetDate, { ingredientOverrides: { "0": "500 g" } });
  const harness = chefHarness(t, kitchenState([{ id: "rice", name: "rice", measure: "500 g" }], [slot]));
  const context = { purpose: "planning", recipeId: routeRecipe.id, kitchenRevision: 7, today, targetDate };
  const replacement = await harness.ask(context);
  assert.equal(replacement.status, 200);
  assert.equal(replacement.body.readinessByRecipeId[routeRecipe.id].coveredCount, 1);
  slot.locked = true;
  const protectedSlot = await harness.ask(context);
  assert.equal(protectedSlot.status, 200);
  assert.equal(protectedSlot.body.readinessByRecipeId[routeRecipe.id].missingCount, 1);
});

for (const count of [121, 250, 500]) test(`saved pantry remains authoritative for retrieval and generation with ${count} long-name rows`, async t => {
  const pantry = Array.from({ length: count }, (_, index) => ({ id: `stock:${index}`, name: `Ingredient ${index} `.padEnd(200, "x"), measure: index === count - 1 ? "2 cans" : "  Unknown amount; weigh the opened package before cooking.  " }));
  const source = { ...routeRecipe, ingredients: [{ name: pantry.at(-1).name, measure: "100 g" }] };
  const state = kitchenState(pantry), before = structuredClone(state), harness = chefHarness(t, state, source);
  const submitted = pantry.map(item => ({ name: item.name, quantity: "1000 kg" })); submitted[0].name = "client-only";
  const result = await harness.ask({ purpose: "planning", recipeId: source.id, kitchenRevision: 7, today, targetDate: today }, submitted);
  assert.equal(result.status, 200);
  assert.equal(harness.prompts.length, 1);
  const prompt = harness.prompts[0];
  assert.deepEqual(prompt.data.pantry, pantry.map(item => ({ name: item.name, quantity: item.measure })));
  assert.deepEqual(prompt.data.retrievedRecipes[0].pantryMatch, [pantry.at(-1).name]);
  assert.equal(result.body.readinessByRecipeId[source.id].coveredCount, 0, "package counts are not converted to mass");
  assert.equal(result.body.readinessByRecipeId[source.id].reviewCount, 1);
  assert.match(prompt.text, /Preserve raw amount notes as unknown amounts; never invent package-content, mass-to-volume or cooked-to-raw conversions/);
  assert.deepEqual(state, before);
});

test("unplanned cooking uses physical stock even when another locked dinner reserves it", async t => {
  const reservation = savedDinner("2026-11-03", { locked: true });
  const state = kitchenState([{ id: "rice", name: "rice", measure: "250 g" }], [reservation]);
  const before = structuredClone(state), harness = chefHarness(t, state);
  const result = await harness.ask({ purpose: "cooking", recipeId: routeRecipe.id, kitchenRevision: 7, today, targetDate: reservation.date });
  assert.equal(result.status, 200);
  assert.equal(result.body.readinessByRecipeId[routeRecipe.id].coveredCount, 1);
  assert.equal(result.body.readinessByRecipeId[routeRecipe.id].missingCount, 0);
  assert.equal(result.body.resolvedContext.mealDate, undefined);
  assert.match(harness.prompts[0].data.pantryContextWarning, /without virtual reservations/);
  assert.deepEqual(state, before);
});

test("authoritative empty kitchens do not fall back to a submitted pantry", async t => {
  const harness = chefHarness(t, null);
  const result = await harness.ask({ purpose: "cooking", recipeId: routeRecipe.id, kitchenRevision: 7, today, targetDate: "2026-11-03" }, [{ name: "rice", quantity: "500 g" }]);
  assert.equal(result.status, 200);
  assert.deepEqual(harness.prompts[0].data.pantry, []);
  assert.deepEqual(harness.prompts[0].data.retrievedRecipes[0].pantryMatch, []);
  assert.equal(result.body.readinessByRecipeId[routeRecipe.id].missingCount, 1);
});

test("stale kitchen revisions and meal hashes still reject before generation", async t => {
  const saved = savedDinner("2026-11-03"), state = kitchenState([{ id: "rice", name: "rice", measure: "500 g" }], [saved]);
  const before = structuredClone(state), harness = chefHarness(t, state);
  const staleRevision = await harness.ask(await savedContext(saved, { kitchenRevision: 6 }));
  assert.equal(staleRevision.status, 409); assert.equal(staleRevision.body.error.code, "kitchen_changed");
  const staleMeal = await harness.ask(await savedContext(saved, { mealHash: await chefMealHash({ ...saved, servings: 8 }) }));
  assert.equal(staleMeal.status, 409); assert.equal(staleMeal.body.error.code, "context_changed");
  assert.equal(harness.prompts.length, 0);
  assert.deepEqual(state, before);
});

test("a kitchen revision change during the answer still rejects the result", async t => {
  const saved = savedDinner("2026-11-03"), state = kitchenState([{ id: "rice", name: "rice", measure: "500 g" }], [saved]);
  const before = structuredClone(state), harness = chefHarness(t, state, routeRecipe, document => document.revision++);
  const result = await harness.ask(await savedContext(saved));
  assert.equal(result.status, 409); assert.equal(result.body.error.code, "context_changed");
  assert.equal(harness.prompts.length, 1); assert.equal(kitchenFixture.reads, 2);
  assert.deepEqual(state, before);
});
