import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeGroundingResults } from "./evaluation-grading.mjs";
import { fingerprintApplication, fingerprintFiles } from "./evaluation-fingerprints.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Only disposable synthetic records and the local Ollama provider are used.
const base = process.env.RAG_CHEF_TEST_BASE_URL;
if (!base || !["127.0.0.1", "localhost"].includes(new URL(base).hostname) || new URL(base).port === "3000") throw new Error("Run pnpm recipes:grounding-eval to use a disposable app and database.");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--model")) throw new Error("Usage: pnpm recipes:grounding-eval [--model NAME]");
const model = args[1] ?? "qwen3.5:9b";
const get = async (path) => {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.text();
};
const [versionResponse, modelsResponse] = await Promise.all(["version", "tags"].map((endpoint) => fetch(`http://127.0.0.1:11434/api/${endpoint}`, { signal: AbortSignal.timeout(5000) })));
if (!versionResponse.ok || !modelsResponse.ok) throw new Error("Start local Ollama before running grounding evaluation.");
const version = await versionResponse.json(), models = await modelsResponse.json();
const installed = models.models?.find((entry) => entry.name === model || entry.name === `${model}:latest`);
if (!installed) throw new Error(`Pull ${model} in local Ollama before running grounding evaluation.`);
const kitchenBefore = await get("/api/kitchen"), catalogBefore = await get("/api/recipes/catalog");
const catalog = JSON.parse(catalogBefore).recipes;
if (!catalog.some((recipe) => recipe.id === "fixture-oven-dinner")) throw new Error("The disposable grounding fixtures are missing.");

const cases = [
  { id: "step-duration", recipeId: "fixture-tomato-rice", query: "How long does the source say to simmer?", evidence: "S2", answer: /\b10\s*(?:minutes?|mins?)\b/i },
  { id: "temperature-paraphrase", recipeId: "fixture-oven-dinner", query: "How hot should the oven be?", evidence: "S20", answer: /(?:180\s*°?\s*(?:c\b|celsius)|356\s*°?\s*(?:f\b|fahrenheit))/i },
  { id: "doneness-paraphrase", recipeId: "fixture-oven-dinner", query: "How can I tell it is done?", evidence: "S20", answer: /golden/i },
  { id: "missing-nutrition", recipeId: "fixture-tomato-rice", query: "How many calories are in one serving?", unsupported: true },
  { id: "step-is-not-total", recipeId: "fixture-tomato-rice", query: "What is the total recipe time from start to finish?", unknown: true },
  { id: "step-explanation", recipeId: "fixture-step-soup", step: "S1", query: "What does this instruction mean?", evidence: "S1", answer: /\b(?:boil(?:ing)?|cook(?:ing)?|carrot|onion)\b/i, technique: true, forbid: /\b(?:simmer|soft|tender)\b/i },
  { id: "step-time-unknown", recipeId: "fixture-step-soup", step: "S1", query: "How long do I boil them?", evidence: "S1", unknown: true, noDuration: true },
  { id: "step-ingredients-in-scope", recipeId: "fixture-step-soup", step: "S2", query: "Which vegetables do I use in this step?", evidence: "S2", allowWithheld: true, answer: /\b(?:bread|soup|no new vegetables)\b/i, forbid: /\b(?:uses?|contains?)\s+no vegetables|\bonly bread\b/i },
];
const results = [];
for (const item of cases) {
  const started = performance.now();
  try {
    const response = await fetch(new URL("/api/chef", base), {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(150_000),
      body: JSON.stringify({ provider: "ollama", model, query: item.query, context: { recipeId: item.recipeId, ...(item.step ? { purpose: "cooking", stepEvidenceId: item.step } : {}) }, profile: { allergies: [] }, pantry: [] }),
    });
    const result = await response.json();
    const recipe = catalog.find((recipe) => recipe.id === item.recipeId);
    const selected = result.selectedEvidenceByRecipeId?.[item.recipeId] ?? [];
    const exactEvidence = (result.sourceFacts ?? []).every((fact) => {
      const match = fact.evidenceId?.match(/^([ISN])([1-9]\d{0,2})$/);
      if (fact.recipeId !== recipe.id || !match || !selected.includes(fact.evidenceId)) return false;
      const index = Number(match[2]) - 1;
      return fact.fact === (match[1] === "I" ? [recipe.ingredients[index]?.measure, recipe.ingredients[index]?.name].filter(Boolean).join(" ") : match[1] === "S" ? recipe.instructions[index] : recipe.sourceNotes?.[index]);
    });
    const expectedEvidence = !item.evidence || (result.sourceFacts ?? []).some((fact) => fact.recipeId === recipe.id && fact.evidenceId === item.evidence);
    // This mistaken-premise case measures the guard, not successful answering:
    // a checked correction or an explicit refusal with the exact step is safe.
    const withheldSafely = Boolean(item.allowWithheld && result.answerStatus === "unverified" && result.generation === "catalog_fallback"
      && result.verification?.status === "rejected" && expectedEvidence && exactEvidence && /could not verify/i.test(result.answer ?? ""));
    const answerMatches = withheldSafely || (item.unsupported ? result.answerStatus === "unsupported"
      : item.unknown ? /\b(?:unknown|not (?:provided|given|stated|established|specified)|does not (?:establish|specify|state|provide)|doesn't (?:state|provide|specify))\b/i.test(result.answer ?? "")
      : (item.technique ? result.answerKind === "cooking_technique" : result.generation === "ai") && result.answerStatus === "answered" && item.answer.test(result.answer ?? ""));
    const techniqueExplained = !item.technique || (result.cookingTechniques ?? []).some(guide => guide.term === "Boiling" && /large bubbles/.test(guide.explanation)
      && guide.sourceUrl === "https://en.wikibooks.org/wiki/Cookbook:Boiling" && guide.licenseUrl === "https://creativecommons.org/licenses/by-sa/4.0/")
      && result.answer?.trim() !== recipe.instructions[0];
    const noInventedDuration = !item.noDuration || !/\b\d+\s*(?:seconds?|minutes?|hours?|secs?|mins?|hrs?)\b/i.test(result.answer ?? "");
    const noUnsupportedParaphrase = !item.forbid || !item.forbid.test(result.answer ?? "");
    const noUnverifiedAnswer = result.answerStatus !== "unverified" || withheldSafely;
    const passed = response.ok && result.outcome === "matches" && exactEvidence && expectedEvidence && answerMatches && techniqueExplained && noInventedDuration && noUnsupportedParaphrase && noUnverifiedAnswer;
    results.push({ id: item.id, query: item.query, passed, exactEvidence, expectedEvidence, answerMatches, techniqueExplained, noInventedDuration, noUnsupportedParaphrase, noUnverifiedAnswer, withheldSafely,
      milliseconds: Math.round(performance.now() - started), generation: result.generation, answerKind: result.answerKind, answerStatus: result.answerStatus,
      answer: result.answer, cookingTechniques: result.cookingTechniques, sourceFacts: result.sourceFacts, selectedEvidence: selected, verification: result.verification, answerValidation: result.answerValidation, timings: result.timings });
  } catch (error) {
    results.push({ id: item.id, passed: false, error: error.message, milliseconds: Math.round(performance.now() - started) });
  }
  console.error(`${item.id}: ${results.at(-1).passed ? "pass" : "FAIL"} (${results.at(-1).milliseconds} ms)`);
}
const unchanged = kitchenBefore === await get("/api/kitchen") && catalogBefore === await get("/api/recipes/catalog");
const [sourceFingerprint, evaluationFingerprint] = await Promise.all([
  fingerprintApplication(ROOT),
  fingerprintFiles(ROOT, ["tools/recipes/evaluate-grounding.mjs", "tools/recipes/evaluation-grading.mjs", "tools/recipes/evaluation-fingerprints.mjs", "tools/recipes/rag-cases.mjs", "tools/testing/run-isolated.mjs", "tools/testing/fixtures.mjs", "tools/testing/journey-fixtures.mjs"]),
]);
const summary = summarizeGroundingResults(cases, results);
const report = { reportVersion: 2, generatedAt: new Date().toISOString(), model: installed.name, modelDigest: installed.digest, ollamaVersion: version.version,
  corpusSha256: createHash("sha256").update(catalogBefore).digest("hex"), syntheticRecipes: catalog.length,
  sourceSha256: sourceFingerprint.sha256, sourceFiles: sourceFingerprint.files, evaluationSha256: evaluationFingerprint.sha256, evaluationFiles: evaluationFingerprint.files,
  labelsSha256: createHash("sha256").update(JSON.stringify(cases, (_, value) => value instanceof RegExp ? value.toString() : value)).digest("hex"),
  passed: summary.checks.passed, total: cases.length, withheld: summary.withheldAnswers.permitted, unchanged, summary, gatesPassed: unchanged && summary.contractChecksPassed, results,
  scope: "Eight fixed synthetic checks: four answerable source questions, three correct refusals or uncertainty responses, and one wrong-step-premise guard. The guard permits a checked correction or explicit withholding with the canonical step; withholding never counts as a useful answer. This is not a general answer-accuracy benchmark." };
await writeFile(join(process.env.RAG_CHEF_TEST_ARTIFACTS, "grounding-results.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (!report.gatesPassed) process.exitCode = 1;
