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
const { chefGroundingIssue, lacksRequestedTotalTime } = await import(pathToFileURL(join(directory, "chef-grounding.mjs")).href);
const step = "Bake at 180°C for 25–30 minutes.";
const facts = [{ recipeId: "bake", evidenceId: "S1", fact: step }];
const sources = [{ recipeId: "bake", evidence: [{ evidenceId: "I1", text: "200 g rice" }, { evidenceId: "S1", text: step }] }];
const answer = (text, extra = {}) => ({ answer: text, sourceFacts: facts, recommendations: [], chefChanges: [], warnings: [], ...extra });
const check = (text, extra = {}, metadata = {}, options = {}) => chefGroundingIssue(answer(text, extra), sources, metadata, { cookingStep: false, ...options });

test("a real citation cannot support an invented cooking time or temperature", () => {
  for (const text of ["Bake for 99 minutes.", "A 99-minute bake.", "Bake at 250°C.", "Bake for two hours.", "Bake for one hundred twenty minutes."]) assert.equal(check(text), "unsupported_detail", text);
  assert.equal(check("Bake for 30 minutes.", { sourceFacts: [{ recipeId: "bake", evidenceId: "I1", fact: "200 g rice" }] }), "unsupported_detail");
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
  assert.equal(lacksRequestedTotalTime("What is the total amount of rice?", recipe), false);
  assert.equal(lacksRequestedTotalTime("What is the total time?", recipe, { totalMinutes: 20 }), false);
  assert.equal(lacksRequestedTotalTime("What is the total time?", { instructions: ["Total time: 20 minutes."] }), false);
});
test("reviewed total time is usable and curator estimates must remain labeled", () => {
  const metadata = { bake: { totalMinutes: 45, provenance: { totalMinutes: { basis: "source" } } } };
  assert.equal(check("Total time is 45 minutes.", {}, metadata), null);
  assert.equal(check("Simmer for 45 minutes.", {}, metadata), "unsupported_detail");
  metadata.bake.provenance.totalMinutes.basis = "curator_estimate";
  assert.equal(check("Total time is 45 minutes.", {}, metadata), "unlabeled_time_estimate");
  assert.equal(check("Estimated total time is about 45 minutes.", {}, metadata), null);
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
