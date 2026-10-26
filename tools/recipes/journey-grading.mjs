import { isDeepStrictEqual } from "node:util";
import { journeyCases } from "./journey-cases.mjs";

export function parseJourneyOptions(args) {
  const options = { catalog: "fixtures", model: "qwen3.5:9b", latencyBudgetMs: 60_000 };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
    if (flag === "--catalog" && ["fixtures", "local"].includes(value)) options.catalog = value;
    else if (flag === "--journey" && journeyCases.some(row => row.id === value)) options.journey = value;
    else if (flag === "--model" && /^[\w./:-]{1,120}$/.test(value)) options.model = value;
    else if (flag === "--latency-budget-ms" && /^\d+$/.test(value) && Number(value) >= 1000 && Number(value) <= 150_000) options.latencyBudgetMs = Number(value);
    else throw new Error("Usage: pnpm recipes:journey-eval [--catalog fixtures|local] [--model NAME] [--journey ID] [--latency-budget-ms 1000..150000]");
  }
  return options;
}

export function gradeJourneyAnswer({ status, data, expected, catalog, aliases, unchanged }) {
  const checks = [];
  const check = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) });
  check("http", status === (expected.httpStatus ?? 200), status);
  check("kitchen_unchanged", unchanged);
  if (expected.httpStatus && expected.httpStatus !== 200) {
    check("context_error", data.error?.code === expected.errorCode, data.error?.code);
    return checks;
  }
  const recipes = data.recipes ?? [], recommendations = data.recommendations ?? [], facts = data.sourceFacts ?? [];
  const known = new Map(catalog.map(recipe => [recipe.id, recipe]));
  const returned = new Set(recipes.map(recipe => recipe.id));
  check("canonical_recipes", recipes.every(recipe => known.has(recipe.id) && isDeepStrictEqual(recipe, known.get(recipe.id))));
  check("valid_references", [...recommendations, ...facts, ...(data.chefChanges ?? []), ...(data.citations ?? [])].every(row => returned.has(row.recipeId)));
  check("exact_selected_quotes", facts.every(fact => {
    const recipe = known.get(fact.recipeId), match = /^([IS])([1-9]\d*)$/.exec(fact.evidenceId ?? "");
    if (!recipe || !match || !data.selectedEvidenceByRecipeId?.[recipe.id]?.includes(fact.evidenceId)) return false;
    const index = Number(match[2]) - 1, ingredient = recipe.ingredients[index];
    const text = match[1] === "S" ? recipe.instructions[index] : ingredient && [ingredient.measure, ingredient.name].filter(Boolean).join(" ");
    return typeof text === "string" && text.length > 0 && fact.fact === text;
  }));
  check("source_links_present", [...recommendations, ...facts].every(row => (data.citations ?? []).some(citation => citation.recipeId === row.recipeId)));
  check("canonical_citations", (data.citations ?? []).every(row => { const recipe = known.get(row.recipeId); return recipe && row.sourceUrl === recipe.sourceUrl && row.title === recipe.title && row.sourceName === recipe.source.name; }));
  check("no_unsolicited_changes", (data.chefChanges ?? []).length === 0);
  check("no_internal_references", !/\bR[1-8]\b/.test(JSON.stringify([data.answer, data.warnings, recommendations.map(row => row.reason)])));
  check("answer_status", data.answerStatus === (expected.status ?? "answered"), data.answerStatus);
  if (expected.outcome) check("retrieval_outcome", data.outcome === expected.outcome, data.outcome);
  if (expected.generation) check("generation", data.generation === expected.generation, data.generation);
  if (expected.first) check("first_recommendation", recommendations[0]?.recipeId === aliases[expected.first].id, recommendations[0]?.recipeId);
  if (expected.only) {
    const id = aliases[expected.only].id;
    check("recipe_scope", recipes.length === 1 && recipes[0].id === id && [...recommendations, ...facts].every(row => row.recipeId === id));
  }
  if (expected.emptyRecipes) check("excluded_recipe_not_returned", recipes.length === 0 && recommendations.length === 0);
  if (expected.minRecommendations !== undefined) {
    check("useful_suggestions", recommendations.length >= expected.minRecommendations, recommendations.length);
    check("generated_suggestions", data.generation === "ai", data.generation);
    check("distinct_suggestions", new Set(recommendations.map(row => row.recipeId)).size === recommendations.length);
  }
  if (expected.maxRecommendations !== undefined) check("recommendation_limit", recommendations.length <= expected.maxRecommendations, recommendations.length);
  if (expected.calculated) {
    check("calculated_answer", data.answerKind === "planning_quantities" && data.generation === "catalog_fallback");
    check("no_model_calls", data.verification?.status === "not_required" && data.timings?.generationMs === 0 && data.timings?.verificationMs === 0);
    const rows = data.planningFacts ?? [];
    check("exact_planning_amounts", rows.length === expected.calculated.length && expected.calculated.every(expectedRow => rows.some(row => row.recipeId === aliases[expected.only].id && row.ingredientIndex === expectedRow.ingredientIndex && row.measure === expectedRow.measure && row.basis === expectedRow.basis && row.needsReview === false && row.sourceEvidenceId === `I${row.ingredientIndex + 1}` && data.selectedEvidenceByRecipeId?.[row.recipeId]?.includes(row.sourceEvidenceId) && facts.some(fact => fact.recipeId === row.recipeId && fact.evidenceId === row.sourceEvidenceId))));
  }
  if (expected.factual) {
    check("supported_answer_available", data.generation === "ai" && data.answerStatus === "answered" && facts.length > 0);
    check("pipeline_evidence_check", data.verification?.status === "checked", data.verification?.status);
  }
  for (const pattern of expected.answerPatterns ?? []) check("expected_answer:" + pattern, new RegExp(pattern, "i").test(data.answer ?? ""));
  for (const pattern of expected.forbiddenAnswerPatterns ?? []) check("no_invented_answer:" + pattern, !new RegExp(pattern, "i").test(data.answer ?? ""));
  for (const id of expected.evidence ?? []) check("expected_evidence:" + id, facts.some(fact => fact.evidenceId === id && (!expected.only || fact.recipeId === aliases[expected.only].id)));
  if (expected.servings !== undefined) check("current_portions", data.resolvedContext?.servings === expected.servings, data.resolvedContext?.servings);
  const readiness = data.readinessByRecipeId?.[aliases[expected.only ?? expected.first]?.id];
  for (const [key, value] of Object.entries(expected.readiness ?? {})) check("pantry:" + key, readiness?.[key] === value, readiness?.[key]);
  for (const row of expected.shopping ?? []) check("shopping:" + row.name, readiness?.shopping?.some(item => item.name === row.name && item.measure === row.measure && item.needsReview === row.needsReview));
  return checks;
}

export function summarizeJourneys(results, latencyBudgetMs) {
  const turns = results.flatMap(journey => journey.steps.filter(step => step.kind === "ask"));
  const rate = (rows, fn) => rows.length ? rows.filter(fn).length / rows.length : null;
  const latency = rows => { const values = rows.filter(row => row.executed && row.timingReliable !== false && Number.isFinite(row.milliseconds)).map(row => row.milliseconds).sort((a, b) => a - b); return { count: values.length, medianMs: values.length ? values[Math.floor(values.length / 2)] : null, p95Ms: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null }; };
  const group = name => turns.filter(row => row.category === name);
  const factual = group("factual"), discovery = group("discovery"), refusals = turns.filter(row => row.expectedStatus === "unsupported"), quotes = turns.filter(row => row.factCount > 0);
  const modelTurns = turns.filter(row => row.generation === "ai" || row.timings?.generationMs > 0 || row.timings?.verificationMs > 0 || row.error);
  const modelAttempted = latency(modelTurns);
  const executionFailures = turns.filter(row => row.executed && row.error).length;
  const unreliableTimings = turns.filter(row => row.timingReliable === false).length;
  const mutationChecks = turns.flatMap(row => row.checks?.filter(check => check.name === "kitchen_unchanged") ?? []);
  const checkPassed = name => row => row.checks?.find(check => check.name === name)?.passed === true;
  return {
    journeys: results.length, journeysPassed: results.filter(row => row.steps.length && row.steps.every(step => step.passed)).length,
    turns: turns.length, turnsPassed: turns.filter(row => row.passed).length, blocked: turns.filter(row => !row.executed).length,
    factualTurnPassRate: rate(factual, row => row.passed), suggestionTurnPassRate: rate(discovery, row => row.passed), correctRefusalRate: rate(refusals, row => row.passed),
    exactQuoteTurnRate: rate(quotes, checkPassed("exact_selected_quotes")), kitchenChecks: { checked: mutationChecks.length, unchanged: mutationChecks.filter(check => check.passed).length, changed: mutationChecks.filter(check => !check.passed).length, unchecked: turns.filter(row => row.executed).length - mutationChecks.length }, executionFailures, unreliableTimings,
    latency: { calculated: latency(group("calculated")), factual: latency(factual), discovery: latency(discovery), refusal: latency(refusals), modelAttempted },
    latencyBudgetMs, latencyApplicable: modelTurns.length > 0, latencyPassed: turns.some(row => row.executed) && executionFailures === 0 && unreliableTimings === 0 && (modelTurns.length === 0 || modelAttempted.count > 0 && modelAttempted.p95Ms <= latencyBudgetMs),
    qualityPassed: results.length > 0 && turns.length > 0 && results.every(journey => journey.steps.length > 0 && journey.steps.every(step => step.passed)),
  };
}
