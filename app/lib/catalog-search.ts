import { buildRecipeEmbeddingText, buildRecipeQueryText, cosineSimilarity, embedTextsWithOllama, isValidEmbeddingVector } from "./recipe-embeddings";
import { listCatalogRecipes, listStoredRecipeEmbeddings } from "./recipe-store";
import { normalizeRecipeSearch, recipePantryDetails } from "./recipe-browser";
import { evaluateRecipeConstraints, normalizeConstraints, type RecipeEligibility } from "./recipe-constraints";
import type { Recipe, RecipeConstraints, RecipeMetadataMap, RecipeSearchOptions } from "./recipe-types";

export type CatalogRetrievalMethod = "precomputed_embeddings" | "lexical_pantry" | "catalog_order" | "empty";
export type CatalogSearchOutcome = "matches" | "no_match" | "constraints_unsatisfied" | "catalog_empty";
export const catalogRelevanceThresholds = { lexical: 0.333333, semantic: 0.82855, version: "recipe-relevance-v1" } as const;
export interface CatalogRankedRecipe {
  recipe: Recipe;
  score: number;
  pantryScore: number;
  lexicalScore: number;
  semanticScore: number | null;
  pantryMatch: string[];
  missingIngredients: string[];
  exactTitle: boolean;
  eligibility: RecipeEligibility;
}
export interface CatalogSearchResult {
  recipes: Recipe[];
  ranked: CatalogRankedRecipe[];
  method: CatalogRetrievalMethod;
  catalogCount: number;
  embeddingCount: number;
  allergyExcludedCount: number;
  constraintExcludedCount: number;
  metadataByRecipeId: RecipeMetadataMap;
  embedModel: string;
  warning?: string;
  outcome: CatalogSearchOutcome;
}

const STOP_WORDS = new Set("a an and are as at be by can cook cooking could dish dishes do find for from give have help how i in ingredients is it like make meal meals me most my of on only or pantry please perishable quick recipe recipes recommend some something suggest suggestions that the to tonight use want what when which with would dinner ideas using".split(" "));

export interface RecipeQueryIntent {
  topic: string;
  broad: boolean;
  mode: "recommendation" | "adaptation";
  excludedIngredients: string[];
  diets: string[];
  adaptationDiets: string[];
  maxTotalMinutes?: number;
}

export function queryRequestsAdaptation(query: string, hasRecipeFocus = false): boolean {
  const request = query.replace(/\bwithout\s+(?:changing|rewriting|altering|modifying)\b[^.;!?]*/gi, "");
  return /\b(substitut\w*|replac\w*|instead|swap\w*|adapt\w*|chang\w*|can i use|could i use|scal(?:e|ing)|halv(?:e|ing)|doubl(?:e|ing))\b/i.test(request)
    || hasRecipeFocus && /\bmake\b.+\b(?:vegan|vegetarian|gluten[ -]free|dairy[ -]free)\b/i.test(request)
    || /\b(?:halve|reduce|cut)\b.+\b(?:salt|sugar|butter|oil|amount)\b/i.test(request);
}

/** Deterministic intent only: do not let generated text relax stored exclusions. */
export function recipeQueryIntent(query: string, hasRecipeFocus = false): RecipeQueryIntent {
  const text = query.normalize("NFKD").replace(/\p{M}/gu, "").replaceAll("’", "'").toLowerCase();
  const excluded: string[] = [];
  const positive = text.replace(/\b(?:do\s+not\s+use|don't\s+use|leave\s+out|without|excluding|exclude|avoid|no|not)\s+(.+?)(?=[.;!?]|\b(?:but|with|using|under|within|for|instead|please)\b|$)/g, (clause, ingredients: string) => {
    if (/^(?:only|just|necessarily|bake|cook|need|longer|more|less|changing|rewriting|altering|modifying)\b/.test(ingredients.trim())) return clause;
    excluded.push(...ingredients.split(/,|\band\b|\bor\b/g).map((item) => normalizeRecipeSearch(item)
      .replace(/^(?:(?:do not use|don t use|leave out|without|excluding|exclude|avoid|no|not)\s+)+/, "")
      .replace(/^(?:any|all|the|a|an)\s+/, "").replace(/\s+(?:dishes|recipes|meals)$/, "")).filter(Boolean));
    return " ";
  });
  const mode = queryRequestsAdaptation(query, hasRecipeFocus) || hasRecipeFocus && excluded.length > 0 ? "adaptation" : "recommendation";
  const namedAdaptation = mode === "adaptation" && hasRecipeFocus;
  const normalized = normalizeRecipeSearch(positive);
  const time = normalized.match(/\b(?:under|within|less than|up to|in)\s+(\d{1,3})\s*(?:minutes?|mins?)\b/);
  const diets = [
    ...( /\bvegan\b/.test(normalized) ? ["vegan"] : []),
    ...( /\bvegetarian\b/.test(normalized) ? ["vegetarian"] : []),
    ...( /\bgluten free\b/.test(normalized) ? ["gluten_free"] : []),
    ...( /\blow carb\b/.test(normalized) ? ["low_carb"] : []),
  ];
  const topic = normalized.replace(/\b(?:under|within|less than|up to|in)\s+\d{1,3}\s*(?:minutes?|mins?)\b/g, " ")
    .replace(/\b(?:vegan|vegetarian|gluten free|low carb)\b/g, " ")
    .split(" ").filter((word) => word && word !== "but" && !STOP_WORDS.has(word)).join(" ");
  return { topic, broad: !topic, mode, excludedIngredients: namedAdaptation ? [] : [...new Set(excluded)], diets: namedAdaptation ? [] : diets, adaptationDiets: namedAdaptation ? diets : [], ...(time && Number(time[1]) > 0 ? { maxTotalMinutes: Number(time[1]) } : {}) };
}

export function constraintsForRecipeQuery(query: string, constraints: RecipeConstraints, hasRecipeFocus = false): RecipeConstraints {
  const intent = recipeQueryIntent(query, hasRecipeFocus);
  const parsed = normalizeConstraints({ ...constraints, diets: [...constraints.diets, ...intent.diets], excludedIngredients: [...(constraints.excludedIngredients ?? []), ...intent.excludedIngredients] });
  const maximum = [constraints.maxTotalMinutes, intent.maxTotalMinutes].filter((x): x is number => x !== undefined);
  return { ...parsed, ...(maximum.length ? { maxTotalMinutes: Math.min(...maximum) } : {}) };
}

export function recipeRetrievalQuery(query: string, hasRecipeFocus = false): string {
  const intent = recipeQueryIntent(query, hasRecipeFocus);
  return intent.excludedIngredients.length ? intent.topic : query.trim();
}

/** Pantry coverage orders relevant recipes, but cannot make an unrelated dish relevant. */
export function queryRelevanceDecision(item: Pick<CatalogRankedRecipe, "exactTitle" | "lexicalScore" | "semanticScore">, query: string, thresholds: { lexical: number; semantic: number } = catalogRelevanceThresholds): boolean {
  return recipeQueryIntent(query).broad || item.exactTitle || item.lexicalScore >= thresholds.lexical || (item.semanticScore !== null && item.semanticScore >= thresholds.semantic);
}

/** Only explicit positive named-dish requests; not a general intent classifier. */
export function focusedRecipeId(query: string, recipes: Recipe[]): string | null {
  const request = normalizeRecipeSearch(query);
  const matches = recipes.filter((recipe) => {
    const title = normalizeRecipeSearch(recipe.title);
    return title && (request === title || ["for", "recommend", "make", "scale", "halve", "help me cook", "help me make", "how do i cook", "how do i make"].some((prefix) => request === `${prefix} ${title}` || request.startsWith(`${prefix} ${title} `)));
  }).sort((a, b) => b.title.length - a.title.length);
  return matches[0]?.id ?? null;
}
function lexicalCoverage(query: string, text: string): number {
  const words = [...new Set(normalizeRecipeSearch(query).split(" "))].filter((word) => word && !STOP_WORDS.has(word));
  if (!words.length) return 0;
  const target = new Set(normalizeRecipeSearch(text).split(" "));
  return words.filter((word) => target.has(word)).length / words.length;
}

/** Shared by the catalog endpoint and Chef; never rewrites source recipes. */
export function rankCatalogRecipes(recipes: Recipe[], options: RecipeSearchOptions, vectors = new Map<string, number[]>(), queryVector: number[] | null = null, metadataByRecipeId: RecipeMetadataMap = {}): CatalogRankedRecipe[] {
  const query = options.query?.trim() ?? "";
  const pantry = options.pantry ?? [];
  const focus = focusedRecipeId(query, recipes);
  const lexicalQuery = recipeRetrievalQuery(query, Boolean(focus));
  const constraints = constraintsForRecipeQuery(query, options.constraints ?? normalizeConstraints({ allergies: options.allergies }), Boolean(focus));
  const broad = recipeQueryIntent(query).broad;
  const dinnerPriority = (recipe: Recipe) => {
    if (!broad) return 0;
    const role = metadataByRecipeId[recipe.id]?.dinnerRole;
    return role === "main" ? 0 : !role || role === "unknown" ? 1 : 2;
  };
  return recipes.map((recipe) => {
    const eligibility = evaluateRecipeConstraints(recipe, metadataByRecipeId[recipe.id], constraints);
    const details = recipePantryDetails(recipe, pantry);
    const lexicalScore = 0.6 * lexicalCoverage(lexicalQuery, recipe.title) + 0.4 * lexicalCoverage(lexicalQuery, buildRecipeEmbeddingText(recipe));
    const vector = vectors.get(recipe.id);
    const semanticScore = queryVector && isValidEmbeddingVector(vector, queryVector.length) ? (cosineSimilarity(queryVector, vector) + 1) / 2 : null;
    const baseScore = query ? semanticScore === null ? 0.7 * lexicalScore + 0.3 * details.coverage : 0.74 * semanticScore + 0.21 * details.coverage + 0.05 * lexicalScore : details.coverage;
    const score = baseScore - 0.1 * eligibility.dislikedIngredients.length / Math.max(recipe.ingredients.length, 1);
    return { recipe, score, lexicalScore, semanticScore, pantryScore: details.coverage, pantryMatch: details.matched, missingIngredients: details.missing, exactTitle: recipe.id === focus, eligibility };
  }).filter((item) => item.eligibility.eligible).sort((a, b) => Number(b.exactTitle) - Number(a.exactTitle) || dinnerPriority(a.recipe) - dinnerPriority(b.recipe) || b.score - a.score || a.recipe.title.localeCompare(b.recipe.title, "en", { sensitivity: "base" }) || a.recipe.id.localeCompare(b.recipe.id));
}

export async function searchRecipeCatalog(options: RecipeSearchOptions, embedModel: string): Promise<CatalogSearchResult> {
  // This loader enforces active recipes and database source approval/permissions.
  const stored = await listCatalogRecipes(1000);
  const requestedFocus = focusedRecipeId(options.query ?? "", stored.map((item) => item.recipe));
  const searchQuery = recipeRetrievalQuery(options.query ?? "", Boolean(requestedFocus));
  const constraints = constraintsForRecipeQuery(options.query ?? "", options.constraints ?? normalizeConstraints({ allergies: options.allergies }), Boolean(requestedFocus));
  const metadataByRecipeId: RecipeMetadataMap = Object.fromEntries(stored.flatMap((item) => item.metadata ? [[item.recipe.id, item.metadata]] : []));
  const evaluated = stored.map(({ recipe }) => ({ recipe, eligibility: evaluateRecipeConstraints(recipe, metadataByRecipeId[recipe.id], constraints) }));
  const eligible = evaluated.filter((item) => item.eligibility.eligible).map((item) => item.recipe);
  const result: CatalogSearchResult = { recipes: [], ranked: [], method: "empty", outcome: stored.length ? "constraints_unsatisfied" : "catalog_empty", catalogCount: stored.length, embeddingCount: 0, allergyExcludedCount: evaluated.filter((item) => item.eligibility.allergyMatches.length).length, constraintExcludedCount: stored.length - eligible.length, metadataByRecipeId, embedModel };
  const blocked = evaluated.find((item) => item.recipe.id === requestedFocus && !item.eligibility.eligible);
  if (blocked) {
    result.warning = `${blocked.recipe.title} conflicts with your requirements. ${blocked.eligibility.reasons.join(" ")}`;
    return result;
  }
  if (!eligible.length) return result;

  let vectors = new Map<string, number[]>();
  let queryVector: number[] | null = null;
  if (searchQuery.trim()) {
    try {
      vectors = await loadPrecomputedRecipeEmbeddingMap(embedModel);
      result.embeddingCount = vectors.size;
      // Don't compare semantic scores with differently scaled partial-index scores.
      if (!eligible.every((recipe) => vectors.has(recipe.id))) throw new Error("Search embeddings are pending.");
      const query = await embedTextsWithOllama([buildRecipeQueryText(searchQuery, [])], { model: embedModel, timeoutMs: 8000 });
      queryVector = query.vectors[0] ?? null;
      const dimension = queryVector?.length;
      if (!dimension || !eligible.every((recipe) => isValidEmbeddingVector(vectors.get(recipe.id), dimension))) throw new Error("Search embedding dimensions differ.");
    } catch {
      queryVector = null;
      result.warning = "Meaning-based search is unavailable or its index is pending. Results use recipe names, ingredients, and pantry matches.";
    }
  }
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 8), 1), 20);
  const ranked = rankCatalogRecipes(eligible, { ...options, constraints }, vectors, queryVector, metadataByRecipeId);
  result.ranked = ranked.filter((item) => queryRelevanceDecision(item, options.query ?? "")).slice(0, limit);
  result.outcome = result.ranked.length ? "matches" : "no_match";
  result.recipes = result.ranked.map((item) => item.recipe);
  result.method = queryVector ? "precomputed_embeddings" : options.query?.trim() || options.pantry?.length ? "lexical_pantry" : "catalog_order";
  return result;
}

export async function loadPrecomputedRecipeEmbeddingMap(model: string): Promise<Map<string, number[]>> {
  const records = await listStoredRecipeEmbeddings(model);
  return new Map(records.flatMap((record) => isValidEmbeddingVector(record.vector) ? [[record.recipeId, record.vector] as const] : []));
}
