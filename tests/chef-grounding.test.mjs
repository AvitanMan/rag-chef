import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const directory = await mkdtemp(join(tmpdir(), "jff-chef-grounding-"));
after(() => rm(directory, { recursive: true, force: true }));
const source = await readFile(new URL("../app/lib/chef-grounding.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
await writeFile(join(directory, "chef-grounding.mjs"), compiled);
const { chefGroundingIssue, lacksRequestedTotalTime, lacksRequestedNutrition } = await import(pathToFileURL(join(directory, "chef-grounding.mjs")).href);
const step = "Bake at 180°C for 25–30 minutes.";
const facts = [{ recipeId: "bake", evidenceId: "S1", fact: step }];
const sources = [{ recipeId: "bake", evidence: [{ evidenceId: "I1", text: "200 g rice" }, { evidenceId: "S1", text: step }] }];
const answer = (text, extra = {}) => ({ answer: text, sourceFacts: facts, recommendations: [], chefChanges: [], warnings: [], ...extra });
const check = (text, extra = {}, metadata = {}, options = {}) => chefGroundingIssue(answer(text, extra), sources, metadata, { cookingStep: false, ...options });

test("missing nutrition is explicit while source-provided nutrition stays answerable", () => {
  const recipe = { ingredients: [{ measure: "200 g", name: "rice" }], instructions: ["Boil for 10 minutes."], sourceNotes: [] };
  assert.equal(lacksRequestedNutrition("How many calories per serving?", recipe), true);
  assert.equal(lacksRequestedNutrition("How much protein per serving?", recipe), true);
  assert.equal(lacksRequestedNutrition("How long do I boil it?", recipe), false);
  assert.equal(lacksRequestedNutrition("How many calories?", { ...recipe, sourceNotes: ["Energy: 250 calories per serving."] }), false);
  assert.equal(lacksRequestedNutrition("How much protein?", { ...recipe, sourceNotes: ["Protein: 12 g per serving."] }), false);
});
test("ingredient purpose and amount requests do not become nutrition requests", () => {
  const recipe = { ingredients: [{ measure: "50 g", name: "sugar" }, { measure: "20 g", name: "fat" }], instructions: ["Add sugar and fry in the fat."] };
  for (const query of ["What is the sugar used for?", "What is the fat used for?", "How much sugar?", "How much fat do I use?", "How much sugar should I add per serving?", "What is the purpose of sugar?", "Why do I use fat?", "How much protein powder?", "How much protein powder per serving?"]) {
    assert.equal(lacksRequestedNutrition(query, recipe), false, query);
  }
  for (const query of ["How much sugar per serving?", "What is the fat content?", "How much protein?", "What is the nutritional information?", "How much sugar should I add and how many calories per serving?"]) {
    assert.equal(lacksRequestedNutrition(query, recipe), true, query);
  }
});
test("ingredient weights and cooking directions cannot establish nutrients while source notes can", () => {
  const recipe = { ingredients: [{ measure: "50 g", name: "sugar" }], instructions: ["Add 50 g sugar."] };
  assert.equal(lacksRequestedNutrition("How much sugar per serving?", recipe), true);
  assert.equal(lacksRequestedNutrition("How much sugar per serving?", { ...recipe, sourceNotes: ["Add 50 g sugar."] }), true);
  assert.equal(lacksRequestedNutrition("How much sugar per serving?", { ...recipe, sourceNotes: ["Sugar: 8 g per serving."] }), false);
  assert.equal(lacksRequestedNutrition("How much fat per serving?", { ...recipe, sourceNotes: ["Sugar: 8 g per serving."] }), true);
  assert.equal(lacksRequestedNutrition("How much protein per serving?", { ...recipe, sourceNotes: ["50 g protein powder"] }), true);
  assert.equal(lacksRequestedNutrition("What is the nutritional content of the protein powder?", { ...recipe, sourceNotes: ["50 g protein powder"] }), true);
  for (const [evidenceId, fact] of [["I1", "50 g sugar"], ["I1", "Sugar: 50 g"], ["S1", "Add 50 g sugar."], ["N1", "Add 50 g sugar."]]) {
    assert.equal(check("Each serving has 50 g sugar.", { sourceFacts: [{ recipeId: "bake", evidenceId, fact }] }), "unsupported_detail", fact);
  }
  assert.equal(check("Each serving has 8 g sugar.", { sourceFacts: [{ recipeId: "bake", evidenceId: "N1", fact: "Sugar: 8 g per serving." }] }), null);
  assert.equal(check("Use 50 g sugar.", { sourceFacts: [{ recipeId: "bake", evidenceId: "I1", fact: "50 g sugar" }] }), null);
});

test("a real citation cannot support an invented cooking time or temperature", () => {
  for (const text of ["Bake for 99 minutes.", "A 99-minute bake.", "Bake at 250°C.", "Bake for two hours.", "Bake for one hundred twenty minutes."]) assert.equal(check(text), "unsupported_detail", text);
  assert.equal(check("Bake for 30 minutes.", { sourceFacts: [{ recipeId: "bake", evidenceId: "I1", fact: "200 g rice" }] }), "unsupported_detail");
});
test("cited ingredient labels remain amounts without establishing nutrient values", () => {
  const sourceFacts = [{ recipeId: "bake", evidenceId: "I1", fact: "50 g sugar" }, { recipeId: "bake", evidenceId: "I2", fact: "20 g fat" }];
  for (const text of ["Sugar: 50 g.", "Ingredients:\nSugar: 50 g.\nFat: 20 g.", "Ingredients:\n- Sugar: 50 g\n- Fat: 20 g", "Sugar: 50000 mg."]) {
    assert.equal(check(text, { sourceFacts }), null, text);
  }
  for (const text of ["Sugar: 500 g.", "Fat: 50 g.", "Each serving has 50 g sugar.", "Sugar: 50 g per serving.", "Nutrition:\nSugar: 50 g.", "Nutrition facts:\n- Fat: 20 g.", "Nutrition per portion:\nSugar: 50 g.", "Per serving:\nSugar: 50 g.", "Per-serving:\nSugar: 50 g.", "Each‑portion:\nFat: 20 g.", "**Nutrition:**\nSugar: 50 g."]) {
    assert.equal(check(text, { sourceFacts }), "unsupported_detail", text);
  }
  assert.equal(check("Sugar: 50 g.", { sourceFacts: [{ recipeId: "bake", evidenceId: "I1", fact: "sugar" }] }), "unsupported_detail");
  assert.equal(check("Nutrition:\nSugar: 8 g.", { sourceFacts: [{ recipeId: "bake", evidenceId: "N1", fact: "Nutrition per serving: sugar: 8 g." }] }), null);
  assert.equal(check("Nutrition is unknown.\nIngredients:\nSugar: 50 g.", { sourceFacts }), null);
  assert.equal(check("Sugar: 50 g.", { sourceFacts: [{ recipeId: "bake", evidenceId: "I1", fact: "50 g granulated sugar" }] }), null);
  for (const [text, fact] of [["Sugar: 50 g.", "50 g sugar snap peas"], ["Fat: 50 g.", "50 g fat-free yogurt"]]) {
    assert.equal(check(text, { sourceFacts: [{ recipeId: "bake", evidenceId: "I1", fact }] }), "unsupported_detail", fact);
  }
});
test("supported time ranges, unit conversions, and temperatures survive validation", () => {
  for (const text of ["Bake for 25–30 minutes at 180°C.", "Bake for half an hour.", "Bake for 0.5 hours at 356°F.", "Bake for thirty minutes."]) assert.equal(check(text), null, text);
  assert.equal(check("Bake for 31 minutes."), "unsupported_detail");
  assert.equal(check("Bake for 1/2 hour."), null);
  assert.equal(check("Bake for ½ hour."), null);
  assert.equal(check("Bake at -180°C."), "unsupported_detail");
  assert.equal(check("Bake for -30 minutes."), "unsupported_detail");
  assert.equal(check("Bake for a quarter of an hour."), "unsupported_detail");
  assert.equal(check("Bake at 180°F."), "unsupported_detail");
  assert.equal(check("Bake at 250 degrees Celsius."), "unsupported_detail");
});
test("a step duration cannot become total recipe time", () => {
  for (const text of ["Total time is 30 minutes.", "Dinner is ready in 30 minutes.", "This recipe takes 30 minutes."]) assert.equal(check(text), "unsupported_total_time", text);
  assert.equal(check("The baking step takes 30 minutes."), null);
  assert.equal(check("It takes 30 minutes.", {}, {}, { cookingStep: true }), null);
  assert.equal(check("Bake for 30 minutes; total time is unknown."), null);
  assert.equal(check("The source specifies baking for 30 minutes but does not give a total recipe time."), null);
  assert.equal(check("The recipe includes a baking step of 30 minutes, but the total time from start to finish is not specified."), null);
  assert.equal(check("Bake for 30 minutes, not a total recipe time."), null);
});
test("total-time questions refuse known source gaps without blocking source totals or unrelated questions", () => {
  const recipe = { instructions: ["Rinse rice.", "Simmer for 10 minutes."] };
  assert.equal(lacksRequestedTotalTime("What is the total recipe time from start to finish?", recipe), true);
  assert.equal(lacksRequestedTotalTime("How long should I simmer?", recipe), false);
  for (const question of ["How long does the first one take?", "How long does the second recipe take to cook?", "How long will this dish take?"]) assert.equal(lacksRequestedTotalTime(question, recipe), true, question);
  for (const question of ["How long does the first step take?", "How long does it take?", "How long does the first one take to boil?"]) assert.equal(lacksRequestedTotalTime(question, recipe), false, question);
  assert.equal(lacksRequestedTotalTime("What is the total amount of rice?", recipe), false);
  assert.equal(lacksRequestedTotalTime("What is the total time?", recipe, { totalMinutes: 20 }), false);
  assert.equal(lacksRequestedTotalTime("What is the total time?", { instructions: ["Total time: 20 minutes."] }), false);
  assert.equal(lacksRequestedTotalTime("What is the total time?", { instructions: ["Simmer for 10 minutes."], sourceNotes: ["Total time: 20 minutes."] }), false);
  assert.equal(check("Total time is 20 minutes.", { sourceFacts: [{ recipeId: "bake", evidenceId: "N1", fact: "Total time: 20 minutes." }] }), null);
  assert.equal(lacksRequestedTotalTime("What is the total time?", { instructions: ["Simmer for 10 minutes."], sourceNotes: ["The sauce is ready in 5 minutes."] }), true);
});
test("reviewed total time is usable and curator estimates must remain labeled", () => {
  const metadata = { bake: { totalMinutes: 45, provenance: { totalMinutes: { basis: "source" } } } };
  assert.equal(check("Total time is 45 minutes.", {}, metadata), null);
  assert.equal(check("Simmer for 45 minutes.", {}, metadata), "unsupported_detail");
  metadata.bake.provenance.totalMinutes.basis = "curator_estimate";
  assert.equal(check("Total time is 45 minutes.", {}, metadata), "unlabeled_time_estimate");
  assert.equal(check("Estimated total time is about 45 minutes.", {}, metadata), null);
});
test("plain Time labels establish recipe ranges only in original source notes", () => {
  const note = "Time: 20–25 minutes";
  const recipe = { ingredients: [], instructions: ["Cook the pasta."], sourceNotes: [note] };
  assert.equal(lacksRequestedTotalTime("What does the source say about total time?", recipe), false);
  assert.equal(lacksRequestedTotalTime("What is the total time?", { ...recipe, sourceNotes: [], instructions: [note] }), true);
  const noteFacts = [{ recipeId: "bake", evidenceId: "N1", fact: note }];
  const metadata = { bake: { totalMinutes: 25, provenance: { totalMinutes: { basis: "source", evidence: note } } } };
  assert.equal(check("The total recipe time is 20–25 minutes.", { sourceFacts: noteFacts }, metadata), null);
  assert.equal(check("The total recipe time is 20–25 minutes.", { sourceFacts: noteFacts }), null);
  assert.equal(check("The total recipe time is 20–25 minutes.", { sourceFacts: [{ ...noteFacts[0], evidenceId: "S1" }] }), "unsupported_total_time");
  assert.equal(check("The total recipe time is 20–25 minutes.", { sourceFacts: [{ ...noteFacts[0], evidenceId: "I1" }] }), "unsupported_total_time");
  assert.equal(check("The total recipe time is 15–25 minutes.", { sourceFacts: noteFacts }, metadata), "unsupported_detail");
  metadata.bake.provenance.totalMinutes.basis = "curator_estimate";
  assert.equal(check("The total recipe time is 20–25 minutes.", { sourceFacts: noteFacts }, metadata), null);
});
test("reviewed metadata preserves an original range only when its provenance matches available note evidence", () => {
  const note = "Time: 20–25 minutes";
  const source = [{ recipeId: "bake", evidence: [{ evidenceId: "S1", text: step }, { evidenceId: "N1", text: note }] }];
  const metadata = { bake: { totalMinutes: 25, provenance: { totalMinutes: { basis: "source", evidence: "Time: 20-25 minutes" } } } };
  const result = () => chefGroundingIssue(answer("The total recipe time is 20–25 minutes."), source, metadata, { cookingStep: false });
  assert.equal(result(), null);
  source[0].evidence[1].evidenceId = "S2";
  assert.ok(result(), "A step label must not expand metadata to a recipe total range");
  source[0].evidence[1].evidenceId = "N1";
  metadata.bake.provenance.totalMinutes.evidence = "Time: 10–15 minutes";
  assert.ok(result(), "Unmatched provenance must not establish the range");
  metadata.bake.provenance.totalMinutes.evidence = note;
  metadata.bake.totalMinutes = 45;
  assert.ok(result(), "The reviewed scalar must belong to the matched source range");
});
test("nutrition values require nutrition evidence rather than ingredient weights", () => {
  for (const text of ["It has 650 calories.", "Each portion has 25 g protein.", "Protein: 25 g."]) assert.equal(check(text), "unsupported_detail", text);
  assert.equal(check("It has 25 g protein.", { sourceFacts: [{ recipeId: "bake", fact: "50 g protein powder" }] }), "unsupported_detail");
  const nutrition = [{ recipeId: "bake", evidenceId: "S2", fact: "Nutrition per portion: protein: 25 g; sodium: 200 mg; 650 calories." }];
  assert.equal(check("It has 650 calories and 25 g protein.", { sourceFacts: nutrition }), null);
  assert.equal(check("It has 0.2 g sodium.", { sourceFacts: nutrition }), null);
  assert.equal(check("It has 10 mg sodium.", { sourceFacts: [{ recipeId: "bake", fact: "Sodium: 1 mg." }] }), "unsupported_detail");
  assert.equal(check("It has 650 calories.", { sourceFacts: [{ recipeId: "bake", fact: "Calories: 650; protein 25 g." }] }), null);
});
test("provider status cannot exempt invented facts from checks", () => {
  assert.equal(check("There are 650 calories.", { answerStatus: "unsupported" }), "unsupported_detail");
  assert.equal(check("Nutrition is not provided by the supplied source.", { answerStatus: "unsupported", sourceFacts: [] }), null);
});

test("generated warnings receive the same numeric source checks as the answer", () => {
  for (const warning of ["Bake for 99 minutes.", "Bake at 250°C.", "It provides 99 g protein per serving.", "Total time is 30 minutes."]) {
    assert.ok(check("Read the original source.", { warnings: [warning] }), warning);
  }
  assert.equal(check("Read the original source.", { warnings: ["Bake at 180°C for 25–30 minutes."] }), null);
});
test("recommendation reasons are checked against their own supplied source", () => {
  assert.equal(check("Here is a recipe.", { recommendations: [{ recipeId: "bake", reason: "Bakes for 99 minutes." }] }), "unsupported_detail");
  assert.equal(check("Here is a recipe.", { recommendations: [{ recipeId: "other", reason: "Bake for 30 minutes." }] }), "unsupported_detail");
  assert.equal(check("Here is a recipe.", { recommendations: [{ recipeId: "bake", reason: "Bakes for 30 minutes." }] }), null);
});
test("explicit advisory changes stay separate from factual source claims", () => {
  assert.equal(check("Consider the requested adaptation below.", { chefChanges: [{ recipeId: "bake", change: "Try 40 minutes at 170°C.", reason: "A proposed adaptation, not source-tested." }] }), null);
  assert.equal(check("Bake for 40 minutes at 170°C.", { chefChanges: [{ recipeId: "bake", change: "Try a cooler oven.", reason: "Advisory." }] }), "unsupported_detail");
});

test("ambiguous step pronouns and component readiness never establish whole recipe timing", () => {
  for (const text of ["It takes 5 minutes for the sauce to thicken.", "The sauce is ready in 5 minutes.", "The onions take 5 minutes altogether."]) {
    const recipe = { instructions: [text, "Bake the assembled dish for 30 minutes."] };
    assert.equal(lacksRequestedTotalTime("What is the total recipe time?", recipe), true, text);
    const facts = [{ recipeId: "dish", evidenceId: "S1", fact: text }];
    const source = [{ recipeId: "dish", evidence: [{ evidenceId: "S1", text }] }];
    assert.equal(chefGroundingIssue({ answer: "The total recipe time is 5 minutes.", sourceFacts: facts, recommendations: [], chefChanges: [], warnings: [] }, source, {}, { cookingStep: false }), "unsupported_total_time", text);
    assert.equal(chefGroundingIssue({ answer: "This step takes 5 minutes.", sourceFacts: facts, recommendations: [], chefChanges: [], warnings: [] }, source, {}, { cookingStep: true }), null, text);
  }
  for (const text of ["Total time: 45 minutes.", "The recipe takes 45 minutes.", "This dinner is ready in 45 minutes."]) assert.equal(lacksRequestedTotalTime("What is the total recipe time?", { instructions: [text] }), false, text);
});
