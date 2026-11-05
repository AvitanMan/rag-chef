import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { planningCases, PLANNING_WEEK, PLANNING_TODAY } from "./planning-cases.mjs";
import { planningLatency, planningRequestedDates } from "./planning-grading.mjs";
import { localOllamaBaseUrl } from "../testing/local-ollama.mjs";
const ollamaURL = localOllamaBaseUrl();
const base = process.env.RAG_CHEF_TEST_BASE_URL;
if (process.env.RAG_CHEF_PLANNING_ISOLATED !== "1" || !process.env.RAG_CHEF_TEST_STATE_DIR || !base || !["127.0.0.1", "localhost"].includes(new URL(base).hostname) || !new URL(base).port || new URL(base).port === "3000") throw new Error("Planning evaluation requires its disposable isolated runner.");
const artifacts = process.env.RAG_CHEF_TEST_ARTIFACTS;
if (!artifacts) throw new Error("The isolated runner must supply an artifact directory.");
const args = process.argv.slice(2), modelIndex = args.indexOf("--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "qwen3.5:9b";
if (args.some((argument, index) => argument !== "--model" && index !== modelIndex + 1) || !model) throw new Error("Only --model MODEL is supported; release evaluation always covers all 40 cases.");
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const hash = value => createHash("sha256").update(value).digest("hex");
const api = async (path, body) => { const response = await fetch(new URL(path, base), { method: body ? path === "/api/kitchen" ? "PUT" : "POST" : "GET", ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40_000) }); return { status: response.status, data: await response.json() }; };
const readKitchen = async () => { const result = await api("/api/kitchen"); if (result.status !== 200) throw new Error("Disposable kitchen unavailable."); return result.data; };
const dir = await mkdtemp(join(tmpdir(), "chef-planning-eval-"));
let report;
try {
  for (const file of await readdir(join(ROOT, "app/lib"))) if (file.endsWith(".ts")) await writeFile(join(dir, file.replace(/\.ts$/, ".mjs")), ts.transpileModule(await readFile(join(ROOT, "app/lib", file), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"'));
  const { evaluateRecipeConstraints, normalizeConstraints } = await import(pathToFileURL(join(dir, "recipe-constraints.mjs")));
  const { shoppingForWeek } = await import(pathToFileURL(join(dir, "shopping-purchases.mjs")));
  const { EMPTY_KITCHEN, DEFAULT_COOKING_PROFILE, DINNER_AMOUNT_LIMITS, mealScale } = await import(pathToFileURL(join(dir, "kitchen-types.mjs")));
  const { createPlannedMeal, addDateDays } = await import(pathToFileURL(join(dir, "kitchen-state.mjs")));
  const { defaultPlanIntent } = await import(pathToFileURL(join(dir, "chef-plan-intent.mjs")));
  const catalog = await api("/api/recipes/catalog"); if (catalog.status !== 200) throw new Error("Disposable catalog unavailable.");
  const models = await (await fetch(`${ollamaURL}/api/tags`, { signal: AbortSignal.timeout(5000) })).json();
  const installed = models.models?.find(row => row.name === model || row.name === model + ":latest"); if (!installed) throw new Error("Local planning model is not installed.");
  // Include shared helpers so changes to persistence, allocation or source eligibility
  // cannot leave the reported runtime fingerprint unchanged.
  const sourcePaths = [...(await readdir(join(ROOT, "app/lib"))).filter(file => file.endsWith(".ts")).map(file => `app/lib/${file}`), "app/api/chef/plan/route.ts", "app/api/chef/plan/apply/route.ts", "app/api/kitchen/route.ts", "app/api/recipes/catalog/route.ts"].sort();
  const fingerprint = async paths => hash((await Promise.all(paths.map(async path => `${path}\n${await readFile(join(ROOT, path), "utf8")}`))).join("\n"));
  report = { version: 1, generatedAt: new Date().toISOString(), complete: false, model: installed.name, modelDigest: installed.digest, corpusSha256: hash(JSON.stringify(catalog.data)), labelsSha256: hash(await readFile(new URL("./planning-cases.mjs", import.meta.url))), sourceSha256: await fingerprint(sourcePaths), evaluatorSha256: await fingerprint(["tools/recipes/evaluate-planning.mjs", "tools/recipes/planning-grading.mjs", "tools/testing/run-isolated.mjs", "tools/testing/local-ollama.mjs"]), records: [], kitchenUnchanged: true };
  const initial = await readKitchen();
  const protectedRecipe = catalog.data.recipes.find(recipe => recipe.id === "fixture-tomato-rice");
  if (!protectedRecipe) throw new Error("Expected original planning fixture is missing.");
  const protectedMeal = { ...createPlannedMeal("2026-11-08", protectedRecipe, true), id: "planning-protected-sunday", locked: true };
  const seededKitchen = { ...structuredClone(EMPTY_KITCHEN), cookingProfile: { ...DEFAULT_COOKING_PROFILE, allergies: ["peanuts"] },
    pantry: [{ id: "planning-rice", name: "rice", measure: "400 g", useBy: "2026-11-04" }, { id: "planning-beans", name: "beans", measure: "400 g", useBy: "2026-11-06" }, { id: "planning-carrot", name: "carrot", measure: "200 g", useBy: PLANNING_TODAY }], meals: { "2026-11-08": protectedMeal } };
  const seeded = await api("/api/kitchen", { revision: initial.revision, state: seededKitchen });
  if (seeded.status !== 200) throw new Error("Could not seed the isolated planning kitchen.");
  const document = await readKitchen(), kitchen = document.state;
  if (!isDeepStrictEqual(kitchen, seededKitchen)) throw new Error("Synthetic kitchen did not persist exactly.");
  const profile = kitchen.cookingProfile;
  report.kitchenFixtureSha256 = hash(JSON.stringify(seededKitchen));
  const manual = await api("/api/chef/plan", { week: PLANNING_WEEK, today: PLANNING_TODAY, kitchenRevision: document.revision, intent: { ...defaultPlanIntent(PLANNING_WEEK, PLANNING_TODAY), count: 3, dates: ["2026-11-03", "2026-11-05", "2026-11-06"], servings: 4 } });
  if (!manual.data.draft) throw new Error(`Initial manual draft failed: ${JSON.stringify(manual.data)}`);
  const original = JSON.stringify(document);
  for (const test of planningCases) {
    const started = performance.now(); const checks = []; let result, error;
    try { result = await api("/api/chef/plan", { query: test.query, week: PLANNING_WEEK, today: PLANNING_TODAY, kitchenRevision: document.revision, model, ...(test.previous ? { previousDraft: manual.data.draft } : {}) }); }
    catch (failure) { error = String(failure); }
    const milliseconds = Math.round(performance.now() - started);
    checks.push({ name: "http_200", passed: result?.status === 200 });
    if (test.clarification) checks.push({ name: "required_clarification", passed: Boolean(result?.data.clarification) && !result?.data.draft });
    else {
      const draft = result?.data.draft;
      checks.push({ name: "answerable_without_clarification", passed: Boolean(draft) && !result?.data.clarification });
      for (const [field, expected] of Object.entries(test.expected ?? {})) {
        const actual = field.split(".").reduce((value, key) => value?.[key], draft?.intent);
        checks.push({ name: `intent:${field}`, passed: isDeepStrictEqual(actual, expected), expected, actual });
      }
      if (draft) {
        const metadata = catalog.data.metadataByRecipeId ?? {};
        const savedConstraints = normalizeConstraints(profile);
        const constraintsForDate = date => { const daily = draft.intent.perDate[date]; return normalizeConstraints({ ...savedConstraints, diets: [...savedConstraints.diets, ...draft.intent.diets, ...(daily?.diet ? [daily.diet] : [])], excludedIngredients: [...(savedConstraints.excludedIngredients ?? []), ...draft.intent.excludedIngredients], excludedEquipment: [...(savedConstraints.excludedEquipment ?? []), ...draft.intent.excludedEquipment], maxTotalMinutes: draft.intent.maxTotalMinutes }); };
        checks.push({ name: "saved_constraints", passed: draft.changes.every(change => evaluateRecipeConstraints(change.meal.recipe, metadata[change.meal.recipeId], savedConstraints).eligible) });
        checks.push({ name: "request_constraints", passed: draft.changes.every(change => evaluateRecipeConstraints(change.meal.recipe, metadata[change.meal.recipeId], constraintsForDate(change.date)).eligible) });
        const targets = test.previous ? manual.data.draft.intent.dates : test.expected?.dates ?? Array.from({ length: 7 }, (_, index) => addDateDays(PLANNING_WEEK, index)).filter(date => date >= PLANNING_TODAY && !kitchen.meals[date]).slice(0, test.expected?.count ?? draft.intent.count);
        // A complete no-choice explanation is valid only when the catalog independently
        // offers no eligible dinner for any requested date; the draft cannot assert that.
        const requireProposal = targets.some(date => {
          const saved = kitchen.meals[date], daily = draft.intent.perDate[date];
          if (saved && (saved.locked || saved.status === "cooked" || !draft.intent.replaceDates.includes(date) && !draft.intent.authorizedReplacementDates?.includes(date))) return false;
          const servings = daily?.servings ?? (daily?.batches === undefined ? draft.intent.servings : null);
          const batches = daily?.batches ?? (daily?.servings === undefined ? draft.intent.batches : null);
          const otherSaved = Object.values(kitchen.meals).filter(meal => meal.date !== date && meal.date >= PLANNING_WEEK && meal.date < addDateDays(PLANNING_WEEK, 7));
          return catalog.data.recipes.some(recipe => {
            if (!draft.intent.allowRepeats && otherSaved.some(meal => meal.recipeId === recipe.id)) return false;
            if (daily?.recipeId && daily.recipeId !== recipe.id) return false;
            if (!recipe.servings && servings !== null && batches === null) return false;
            const scaled = recipe.servings && batches !== null ? recipe.servings * batches : null;
            if (scaled !== null && (!Number.isInteger(scaled) || scaled < DINNER_AMOUNT_LIMITS.servings.min || scaled > DINNER_AMOUNT_LIMITS.servings.max)) return false;
            const recipeMetadata = metadata[recipe.id], role = recipeMetadata?.dinnerRole;
            if (!recipeMetadata?.coreDinner && role && role !== "main" && role !== "unknown") return false;
            return evaluateRecipeConstraints(recipe, recipeMetadata, constraintsForDate(date)).eligible;
          });
        });
        checks.push({ name: "requested_dates", passed: planningRequestedDates(draft, targets, { requireProposal }) });
        checks.push({ name: "requested_quantities", passed: draft.changes.every(change => { const daily = draft.intent.perDate[change.date], servings = daily?.servings ?? (daily?.batches === undefined ? draft.intent.servings : null), batches = daily?.batches ?? (daily?.servings === undefined ? draft.intent.batches : null); return batches !== null ? mealScale(change.meal) === batches : servings !== null ? change.meal.servings === servings && change.meal.baseServings !== null : true; }) });
        const projected = { ...kitchen, meals: { ...kitchen.meals, ...Object.fromEntries(draft.changes.map(change => [change.date, change.meal])) } };
        checks.push({ name: "calculated_shopping", passed: isDeepStrictEqual(shoppingForWeek(projected, PLANNING_WEEK, PLANNING_TODAY), draft.shopping) });
        checks.push({ name: "protected_dinners", passed: draft.changes.every(change => !kitchen.meals[change.date]?.locked && kitchen.meals[change.date]?.status !== "cooked") });
        checks.push({ name: "approved_recipe_ids", passed: draft.changes.every(change => catalog.data.recipes.some(recipe => recipe.id === change.meal.recipeId)) });
      }
    }
    const unchanged = JSON.stringify(await readKitchen()) === original;
    checks.push({ name: "no_writes_before_apply", passed: unchanged }); report.kitchenUnchanged &&= unchanged;
    const record = { id: test.id, split: test.split, query: test.query, milliseconds, modelExpected: !test.clarification, modelSucceeded: result?.status === 200 && result?.data.draft?.interpretation === "ollama", passed: checks.every(check => check.passed), checks, ...(error ? { error } : {}), response: result?.data };
    report.records.push(record);
    console.log(`${record.passed ? "PASS" : "FAIL"} ${test.id} ${milliseconds}ms ${checks.filter(check => !check.passed).map(check => check.name).join(", ")}`);
    await writeFile(join(artifacts, "planning-results.json"), JSON.stringify(report, null, 2) + "\n");
  }
  const splits = Object.fromEntries(["development", "held_out"].map(split => { const rows = report.records.filter(row => row.split === split); return [split, { passed: rows.filter(row => row.passed).length, total: rows.length, gatePassed: rows.length === 20 && rows.filter(row => row.passed).length >= 18 }]; }));
  const safetyPassed = report.records.every(row => row.checks.filter(check => ["saved_constraints", "request_constraints", "no_writes_before_apply", "protected_dinners"].includes(check.name)).every(check => check.passed));
  report.catalogUnchanged = isDeepStrictEqual((await api("/api/recipes/catalog")).data, catalog.data);
  report.complete = report.records.length === 40 && new Set(report.records.map(row => row.id)).size === 40;
  report.summary = { splits, safetyPassed, latency: planningLatency(report.records, planningCases) };
  report.gatesPassed = report.complete && Object.values(splits).every(split => split.gatePassed) && safetyPassed && report.kitchenUnchanged && report.catalogUnchanged && report.summary.latency.gatePassed;
  await writeFile(join(artifacts, "planning-results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ report: join(artifacts, "planning-results.json"), ...report.summary, gatesPassed: report.gatesPassed }, null, 2));
  if (!report.gatesPassed) process.exitCode = 1;
} finally { await rm(dir, { recursive: true, force: true }); }
