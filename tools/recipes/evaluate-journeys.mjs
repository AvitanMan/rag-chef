import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { JOURNEY_DATE, journeyCases, journeyTitles } from "./journey-cases.mjs";
import { gradeJourneyAnswer, parseJourneyOptions, summarizeJourneys } from "./journey-grading.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hash = value => createHash("sha256").update(value).digest("hex");
const base = process.env.RAG_CHEF_TEST_BASE_URL;
if (process.env.RAG_CHEF_JOURNEY_ISOLATED !== "1" || !base || !["127.0.0.1", "localhost"].includes(new URL(base).hostname) || !new URL(base).port || new URL(base).port === "3000") throw new Error("Run pnpm recipes:journey-eval; journey writes require its disposable preview.");
const options = parseJourneyOptions(process.argv.slice(2));
const artifacts = process.env.RAG_CHEF_TEST_ARTIFACTS;
if (!artifacts) throw new Error("The isolated runner must supply an artifact directory.");
const api = async (path, body) => {
  const response = await fetch(new URL(path, base), { method: body === undefined ? "GET" : path === "/api/kitchen" ? "PUT" : "POST", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(path === "/api/chef" ? 150_000 : 15_000) });
  const data = await response.json(); return { status: response.status, data };
};
const kitchen = async () => { const result = await api("/api/kitchen"); if (result.status !== 200) throw new Error("Cannot read disposable kitchen."); return result.data; };
const save = async state => { const current = await kitchen(); const result = await api("/api/kitchen", { revision: current.revision, state }); if (result.status !== 200) throw new Error(`Disposable kitchen save failed: ${result.status}`); const saved = await kitchen(); if (!isDeepStrictEqual(saved.state, state)) throw new Error("Disposable kitchen did not persist the requested state."); return saved; };
const directory = await mkdtemp(join(tmpdir(), "chef-journey-modules-"));
let report;
const reportPath = join(artifacts, "journey-results.json");
const persist = async () => {
  report.summary = summarizeJourneys(report.journeys, options.latencyBudgetMs);
  report.gatesPassed = report.complete && report.summary.qualityPassed && report.summary.latencyPassed && report.catalogUnchanged;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  const s = report.summary;
  const lines = ["# RAG user journey evaluation", "", `Track: **${options.catalog}${options.journey ? ` / subset: ${options.journey}` : " / full suite"}** · Model: **${report.model}** · Catalog: **${report.recipeCount} recipes**`, "", `Journeys: **${s.journeysPassed}/${s.journeys}** · Answer turns: **${s.turnsPassed}/${s.turns}** · Blocked turns: **${s.blocked}**`, "", `Quality gate: **${report.complete ? s.qualityPassed ? "PASS" : "FAIL" : "RUNNING"}** · Model-attempted response p95: **${s.latencyApplicable ? `${s.latency.modelAttempted.p95Ms ?? "unavailable"} ms` : "not applicable"}** (budget ${s.latencyBudgetMs} ms)`, "", "| Journey | Step | Result | Time | Failed checks |", "| --- | --- | --- | --- | --- |"];
  for (const journey of report.journeys) for (const step of journey.steps) lines.push(`| ${journey.id} | ${step.id} | ${step.passed ? "PASS" : step.executed ? "FAIL" : "BLOCKED"} | ${step.milliseconds ?? "—"} ms | ${(step.checks ?? []).filter(c => !c.passed).map(c => c.name).join(", ") || step.error || "—"} |`);
  lines.push("", "These are API journeys through the built app, not a browser or a general answer-accuracy benchmark. Exact source quotes, fixed expected facts, quantities and outcomes are checked independently of generation. The pipeline's own model-assisted verification status is also recorded; it is not an independent semantic judge. Timeouts and large event-loop gaps fail the run; timing-gap samples are excluded from percentiles and shown as unreliable. Setup and indexing time are excluded from response latency. First-turn cold response time is included. Failed and blocked turns are never counted as passes.", "", "Both tracks use a disposable database and local Ollama only. The local track copies existing data read-only; no sources are imported, no paid provider is used, and the original kitchen is never submitted to Chef. Only the fixed evaluation pantry and plans are used.", "", "See journey-results.json for prompts, answers, failed checks, source evidence, model/corpus/code fingerprints and latency groups.");
  await writeFile(join(artifacts, "journey-report.md"), lines.join("\n") + "\n");
};
try {
  for (const name of ["chef-context", "kitchen-types", "kitchen-state", "quantities"]) {
    const source = await readFile(join(ROOT, "app/lib", name + ".ts"), "utf8");
    await writeFile(join(directory, name + ".mjs"), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"'));
  }
  const { chefRecipeHash, chefMealHash } = await import(pathToFileURL(join(directory, "chef-context.mjs")));
  const { createPlannedMeal } = await import(pathToFileURL(join(directory, "kitchen-state.mjs")));
  const catalogResult = await api("/api/recipes/catalog");
  if (catalogResult.status !== 200) throw new Error("Cannot read evaluation catalog.");
  const catalog = catalogResult.data.recipes;
  await writeFile(join(artifacts, "journey-catalog.json"), JSON.stringify(catalogResult.data, null, 2) + "\n");
  const aliases = Object.fromEntries(Object.entries(journeyTitles).map(([key, title]) => {
    const matches = catalog.filter(recipe => recipe.title === title);
    if (matches.length !== 1) throw new Error(`The fixed journey label requires exactly one ${title} record.`);
    return [key, matches[0]];
  }));
  // Corpus drift stops the run; expected answers are never rewritten to fit results.
  if (!/200.*400.*30/.test(aliases.bake.instructions[7]) || !/packag/i.test(aliases.bake.instructions[0]) || aliases.bake.ingredients[0]?.measure !== "400 g" || aliases.bake.ingredients[3]?.measure !== "200 ml" || !/20.*30.*soft/.test(aliases.soup.instructions[2]) || catalogResult.data.metadataByRecipeId?.[aliases.bake.id]?.totalMinutes != null) throw new Error("Fixed journey source facts changed. Review the labels before running this corpus.");
  const models = await (await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(5000) })).json();
  const installed = models.models?.find(row => row.name === options.model || row.name === options.model + ":latest");
  if (!installed) throw new Error("The selected local chat model is unavailable.");
  const version = await (await fetch("http://127.0.0.1:11434/api/version", { signal: AbortSignal.timeout(5000) })).json();
  const sourceFiles = [];
  async function walk(folder) { for (const entry of await readdir(folder, { withFileTypes: true })) { const path = join(folder, entry.name); if (entry.isDirectory()) await walk(path); else if (/\.tsx?$/.test(entry.name)) sourceFiles.push(path); } }
  await walk(join(ROOT, "app"));
  report = { reportVersion: 2, generatedAt: new Date().toISOString(), complete: false, ...options, model: installed.name, modelDigest: installed.digest, ollamaVersion: version.version, embeddingModel: models.models?.find(row => /^nomic-embed-text(?::|$)/.test(row.name)), recipeCount: catalog.length, corpusSha256: hash(JSON.stringify(catalogResult.data)), labelsSha256: hash(await readFile(join(ROOT, "tools/recipes/journey-cases.mjs"))), evaluationSha256: hash((await Promise.all(["tools/recipes/evaluate-journeys.mjs", "tools/recipes/journey-grading.mjs", "tools/testing/run-isolated.mjs", "tools/testing/journey-fixtures.mjs", "tools/testing/fixtures.mjs", "tools/testing/snapshot-local-catalog.py"].map(path => readFile(join(ROOT, path))))).map(data => data.toString()).join("\n")), sourceSha256: hash((await Promise.all(sourceFiles.sort().map(path => readFile(path)))).map(data => data.toString()).join("\n")), selectedRecipeHashes: Object.fromEntries(await Promise.all(Object.entries(aliases).map(async ([key, recipe]) => [key, await chefRecipeHash(recipe)]))), catalogUnchanged: true, journeys: [] };
  const contextFor = async (step, document, checkpoint, previous) => {
    const context = { purpose: step.purpose ?? "planning", today: JOURNEY_DATE, targetDate: step.targetDate ?? JOURNEY_DATE, kitchenRevision: document.revision };
    const meal = step.savedMeal ? document.state.meals[JOURNEY_DATE] : undefined;
    const recipe = meal ? aliases.bake : step.focus ? aliases[step.focus] : undefined;
    if (recipe) Object.assign(context, { recipeId: recipe.id, recipeHash: await chefRecipeHash(recipe) });
    if (meal) Object.assign(context, { mealDate: meal.date, mealId: meal.id, mealHash: await chefMealHash(meal), ...(step.purpose === "cooking" ? {} : { servings: meal.servings }) });
    if (step.previous) context.previousRecipeIds = previous?.recommendations?.map(row => row.recipeId) ?? [];
    if (step.stepEvidenceId) context.stepEvidenceId = step.stepEvidenceId;
    if (step.stale === "revision") Object.assign(context, checkpoint);
    if (step.stale === "meal") context.mealHash = checkpoint.mealHash;
    return context;
  };
  const scenarios = options.journey ? journeyCases.filter(row => row.id === options.journey) : journeyCases;
  report.selectedJourneyIds = scenarios.map(row => row.id); report.fullSuite = !options.journey;
  for (const scenario of scenarios) {
    const result = { id: scenario.id, title: scenario.title, steps: [] }; report.journeys.push(result);
    let previous, checkpoint, history = [], profile = { allergies: [], diet: "No restriction", dislikes: [], equipment: ["Oven", "Stovetop"] }, actionFailed = false;
    await save({ schemaVersion: 2, pantry: structuredClone(scenario.pantry), meals: {}, shoppingChecked: {}, migratedLegacy: true });
    for (const step of scenario.steps) {
      const row = { id: step.id, kind: step.action ? "action" : "ask", category: step.expect?.calculated ? "calculated" : step.expect?.factual ? "factual" : step.expect?.minRecommendations ? "discovery" : "control", expectedStatus: step.expect?.status, executed: false, passed: false, checks: [] }; result.steps.push(row);
      const started = performance.now();
      try {
        if (actionFailed || step.requiresMultipleChoices && (previous?.recommendations?.length ?? 0) < 2) { row.error = "An earlier journey precondition failed."; continue; }
        row.executed = true;
        const document = await kitchen();
        if (step.action) {
          const state = structuredClone(document.state);
          if (step.action === "plan") { const meal = createPlannedMeal(JOURNEY_DATE, aliases[step.recipe]); meal.servings = step.servings; meal.ingredientOverrides = step.overrides ?? {}; state.meals[JOURNEY_DATE] = meal; }
          else if (step.action === "meal") state.meals[JOURNEY_DATE].servings = step.servings;
          else if (step.action === "pantry") Object.assign(state.pantry.find(item => item.id === step.patch.id), step.patch);
          const saved = await save(state);
          if (step.checkpoint) checkpoint = await contextFor({ savedMeal: true }, saved);
          row.passed = true;
        } else {
          if (step.clearHistory) { history = []; previous = undefined; }
          const context = await contextFor(step, document, checkpoint, previous);
          profile = { ...profile, ...(step.profile ?? {}) };
          const body = { provider: "ollama", model: installed.name, query: step.query, profile, pantry: document.state.pantry.map(item => ({ name: item.name, quantity: item.measure || undefined })), context, history: history.slice(-6) };
          const before = JSON.stringify(document);
          const apiStarted = performance.now();
          let lastTick = performance.now(), largestGap = 0;
          const monitor = setInterval(() => { const now = performance.now(); largestGap = Math.max(largestGap, now - lastTick); lastTick = now; }, 1000);
          let response;
          try { response = await api("/api/chef", body); }
          finally { clearInterval(monitor); row.timingReliable = Math.max(largestGap, performance.now() - lastTick) < 10_000; }

          row.milliseconds = Math.round(performance.now() - apiStarted);
          const after = await kitchen();
          row.checks = gradeJourneyAnswer({ ...response, expected: step.expect, catalog, aliases, unchanged: before === JSON.stringify(after) });
          row.passed = row.checks.every(check => check.passed);
          Object.assign(row, { query: step.query, requestContext: context, requestProfile: profile, expected: step.expect, httpStatus: response.status, response: response.data, answer: response.data.answer, generation: response.data.generation, answerStatus: response.data.answerStatus, timings: response.data.timings, verification: response.data.verification, factCount: response.data.sourceFacts?.length ?? 0, sourceFacts: response.data.sourceFacts, selectedEvidence: response.data.selectedEvidenceByRecipeId, readiness: response.data.readinessByRecipeId, recommendedTitles: response.data.recommendations?.map(rec => catalog.find(recipe => recipe.id === rec.recipeId)?.title) });
          if (response.status === 200 && response.data.answerStatus !== "unverified") { previous = response.data; history.push({ role: "user", content: step.query }, { role: "assistant", content: response.data.answer }); }
        }
      } catch (error) { row.error = error.message; row.milliseconds ??= Math.round(performance.now() - started); if (step.action) actionFailed = true; }
      finally { await persist(); console.error(`${scenario.id}/${step.id}: ${row.passed ? "pass" : row.executed ? "FAIL" : "BLOCKED"} (${row.milliseconds ?? "setup"} ms)`); }
    }
  }
  report.complete = true;
  report.catalogUnchanged = JSON.stringify(catalogResult.data) === JSON.stringify((await api("/api/recipes/catalog")).data);
  await persist();
  console.log(JSON.stringify({ reportPath, gatesPassed: report.gatesPassed, summary: report.summary }, null, 2));
  if (!report.gatesPassed) process.exitCode = 1;
} catch (error) {
  if (report) { report.error = error.message; await persist(); }
  else await writeFile(reportPath, JSON.stringify({ complete: false, gatesPassed: false, error: error.message }) + "\n");
  console.error(error.message); process.exitCode = 1;
} finally { await rm(directory, { recursive: true, force: true }); }
