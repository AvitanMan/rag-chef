import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

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
];
const results = [];
for (const item of cases) {
  const started = performance.now();
  try {
    const response = await fetch(new URL("/api/chef", base), {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(150_000),
      body: JSON.stringify({ provider: "ollama", model, query: item.query, context: { recipeId: item.recipeId }, profile: { allergies: [] }, pantry: [] }),
    });
    const result = await response.json();
    const recipe = catalog.find((recipe) => recipe.id === item.recipeId);
    const selected = result.selectedEvidenceByRecipeId?.[item.recipeId] ?? [];
    const exactEvidence = (result.sourceFacts ?? []).every((fact) => {
      const match = fact.evidenceId?.match(/^([IS])([1-9]\d{0,2})$/);
      if (fact.recipeId !== recipe.id || !match || !selected.includes(fact.evidenceId)) return false;
      const index = Number(match[2]) - 1;
      return fact.fact === (match[1] === "I" ? [recipe.ingredients[index]?.measure, recipe.ingredients[index]?.name].filter(Boolean).join(" ") : recipe.instructions[index]);
    });
    const expectedEvidence = !item.evidence || (result.sourceFacts ?? []).some((fact) => fact.recipeId === recipe.id && fact.evidenceId === item.evidence);
    const answerMatches = item.unsupported ? result.answerStatus === "unsupported"
      : item.unknown ? /\b(?:unknown|not (?:provided|given|stated|established|specified)|does not establish|doesn't (?:state|provide|specify))\b/i.test(result.answer ?? "")
      : result.generation === "ai" && result.answerStatus === "answered" && item.answer.test(result.answer ?? "");
    const noUnverifiedAnswer = result.answerStatus !== "unverified";
    const passed = response.ok && result.outcome === "matches" && exactEvidence && expectedEvidence && answerMatches && noUnverifiedAnswer;
    results.push({ id: item.id, query: item.query, passed, exactEvidence, expectedEvidence, answerMatches, noUnverifiedAnswer,
      milliseconds: Math.round(performance.now() - started), generation: result.generation, answerStatus: result.answerStatus,
      answer: result.answer, sourceFacts: result.sourceFacts, selectedEvidence: selected, verification: result.verification, answerValidation: result.answerValidation, timings: result.timings });
  } catch (error) {
    results.push({ id: item.id, passed: false, error: error.message, milliseconds: Math.round(performance.now() - started) });
  }
  console.error(`${item.id}: ${results.at(-1).passed ? "pass" : "FAIL"} (${results.at(-1).milliseconds} ms)`);
}
const unchanged = kitchenBefore === await get("/api/kitchen") && catalogBefore === await get("/api/recipes/catalog");
const report = { reportVersion: 1, generatedAt: new Date().toISOString(), model: installed.name, modelDigest: installed.digest, ollamaVersion: version.version,
  corpusSha256: createHash("sha256").update(catalogBefore).digest("hex"), syntheticRecipes: catalog.length,
  passed: results.filter((result) => result.passed).length, total: cases.length, unchanged, results,
  scope: "Five fixed synthetic source-answering cases. This is not a general answer-accuracy benchmark." };
await writeFile(join(process.env.RAG_CHEF_TEST_ARTIFACTS, "grounding-results.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (!unchanged || results.some((result) => !result.passed)) process.exitCode = 1;
