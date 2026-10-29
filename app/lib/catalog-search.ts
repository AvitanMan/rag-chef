import { bm25Scores, reciprocalRanks, retrievalTerms } from "./retrieval-ranking";
import { STOP_WORDS, recipeQueryIntent, constraintsForRecipeQuery, recipeRetrievalQuery } from "./recipe-query";
export { recipeQueryIntent, queryRequestsRecipes, queryRequestsAdaptation, constraintsForRecipeQuery, recipeRetrievalQuery, type RecipeQueryIntent } from "./recipe-query";
import { buildRecipeEmbeddingText, buildRecipeQueryText, cosineSimilarity, embedTextsWithOllama, isValidEmbeddingVector } from "./recipe-embeddings";
import { listCatalogRecipes, listStoredRecipeEmbeddings } from "./recipe-store";
import { normalizeRecipeSearch, recipePantryDetails } from "./recipe-browser";
import { evaluateRecipeConstraints, normalizeConstraints, type RecipeEligibility } from "./recipe-constraints";
import type { Recipe, RecipeMetadata, RecipeMetadataMap, RecipeSearchOptions } from "./recipe-types";
import { allocateStockForMeals, mealReadiness, normalizePlanningIngredient, type MealReadiness } from "./quantities";

export type CatalogRetrievalMethod = "precomputed_embeddings" | "lexical_pantry" | "catalog_order" | "empty";
export type CatalogSearchOutcome = "matches" | "no_match" | "constraints_unsatisfied" | "catalog_empty";
export const catalogRelevanceThresholds = { lexical: 0.333333, semantic: 0.82855, version: "recipe-relevance-v1" } as const;
export const catalogShortlistPolicy = { version: "recipe-shortlist-v2", lexicalQueryCoverage: 2 / 3, secondaryQueryCoverage: 1, maximumTargetedResults: 3 } as const;
export interface CatalogRankedRecipe {
  readiness?: MealReadiness;
  bm25Score?: number;
  fusionScore?: number;
  recipe: Recipe;
  score: number;
  pantryScore: number;
  lexicalScore: number;
  semanticScore: number | null;
  queryCoverage: number;
  matchedQueryTerms: string[];
  missingQueryTerms: string[];
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

/** Pantry coverage orders relevant recipes, but cannot make an unrelated dish relevant. */
export function queryRelevanceDecision(item: Pick<CatalogRankedRecipe, "exactTitle" | "lexicalScore" | "semanticScore" | "queryCoverage">, query: string, thresholds: { lexical: number; semantic: number } = catalogRelevanceThresholds): boolean {
  return recipeQueryIntent(query).broad || item.exactTitle || item.lexicalScore >= thresholds.lexical && item.queryCoverage >= catalogShortlistPolicy.lexicalQueryCoverage || (item.semanticScore !== null && item.semanticScore >= thresholds.semantic);
}

// Search-only normalization. These aliases never change cooking amounts,
// ingredient identity, allergy rules or the original recipe text.
const QUERY_DESCRIPTORS = new Set("cozy comforting warming warm made cooked served breakfast lunch brunch supper bowl based style people person".split(" "));

function searchTerms(text: string): string[] {
  return retrievalTerms(text);
}

export function recipeQueryEvidence(query: string, recipe: Recipe): Pick<CatalogRankedRecipe, "queryCoverage" | "matchedQueryTerms" | "missingQueryTerms"> {
  const terms = [...new Set(searchTerms(recipeQueryIntent(query).topic).filter((word) => !QUERY_DESCRIPTORS.has(word)))];
  const content = new Set(searchTerms([recipe.title, recipe.category, recipe.cuisine, ...recipe.ingredients.map((item) => item.name), ...recipe.tags].join(" ")));
  const matchedQueryTerms = terms.filter((term) => content.has(term));
  const missingQueryTerms = terms.filter((term) => !content.has(term));
  return { queryCoverage: terms.length ? matchedQueryTerms.length / terms.length : 0, matchedQueryTerms, missingQueryTerms };
}

/** Explain an already-selected result without changing relevance or eligibility. */
export function catalogMatchReason(item: Pick<CatalogRankedRecipe, "exactTitle" | "matchedQueryTerms" | "queryCoverage" | "pantryMatch">, query: string, metadata?: Pick<RecipeMetadata, "dinnerRole">): string {
  if (item.exactTitle) return "Matches the recipe you named.";
  if (recipeQueryIntent(query).broad) {
    if (metadata?.dinnerRole === "main") return "Reviewed as a main dinner.";
    return item.pantryMatch.length ? "Uses ingredient names from your pantry." : "Suggested from your approved catalog.";
  }
  if (item.matchedQueryTerms.length) return `${item.queryCoverage === 1 ? "Matches your search words" : "Matches some search words"}: ${item.matchedQueryTerms.join(", ")}.`;
  return "Related to your request by meaning.";
}

/** The same final selection is used by production retrieval and evaluation. */
export function selectCatalogShortlist(ranked: CatalogRankedRecipe[], query: string, limit = 8, thresholds: { lexical: number; semantic: number } = catalogRelevanceThresholds): CatalogRankedRecipe[] {
  const maximum = Math.min(Math.max(Math.floor(limit), 1), 20);
  const relevant = ranked.filter((item) => queryRelevanceDecision(item, query, thresholds));
  const focus = relevant.find((item) => item.exactTitle);
  if (focus) return [focus];
  if (recipeQueryIntent(query).broad) return relevant.slice(0, maximum);
  relevant.sort((a, b) => Number(b.queryCoverage === 1) - Number(a.queryCoverage === 1)
    || (b.fusionScore ?? 0) - (a.fusionScore ?? 0)
    || (b.semanticScore ?? b.lexicalScore) - (a.semanticScore ?? a.lexicalScore)
    || b.lexicalScore - a.lexicalScore || b.score - a.score
    || a.recipe.title.localeCompare(b.recipe.title, "en", { sensitivity: "base" }) || a.recipe.id.localeCompare(b.recipe.id));
  return relevant.filter((item, index) => index === 0 || item.queryCoverage >= catalogShortlistPolicy.secondaryQueryCoverage)
    .slice(0, Math.min(maximum, catalogShortlistPolicy.maximumTargetedResults));
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
  const focus = options.recipeId ?? focusedRecipeId(query, recipes);
  const lexicalQuery = recipeRetrievalQuery(query, Boolean(focus));
  const constraints = constraintsForRecipeQuery(query, options.constraints ?? normalizeConstraints({ allergies: options.allergies }), Boolean(focus));
  const broad = recipeQueryIntent(query).broad;
  const stock = options.stockContext;
  const remaining = stock ? allocateStockForMeals(stock.meals, stock.pantry, stock.today).pantry : [];
  const dinnerPriority = (recipe: Recipe) => {
    if (!broad) return 0;
    const role = metadataByRecipeId[recipe.id]?.dinnerRole;
    return role === "main" ? 0 : !role || role === "unknown" ? 1 : 2;
  };
  const bm25 = bm25Scores(recipes.map((recipe) => ({ id: recipe.id, title: recipe.title, ingredients: recipe.ingredients.map((item) => item.name).join(" "), other: [recipe.category, recipe.cuisine, ...recipe.tags].join(" ") })), lexicalQuery);
  const ranked = recipes.map((recipe) => {
    const readiness = stock ? mealReadiness({ id: `preview:${recipe.id}`, date: stock.targetDate, recipeId: recipe.id, recipe, title: recipe.title,
      baseServings: recipe.servings ?? null, servings: recipe.servings ? stock.servings ?? recipe.servings : null, batches: recipe.servings ? 1 : stock.batches ?? 1,
      ingredientOverrides: {}, planningIngredients: recipe.ingredients.map(normalizePlanningIngredient), locked: false, status: "planned" }, remaining, stock.today) : undefined;
    const eligibility = evaluateRecipeConstraints(recipe, metadataByRecipeId[recipe.id], constraints);
    const details = recipePantryDetails(recipe, pantry);
    const lexicalScore = 0.6 * lexicalCoverage(lexicalQuery, recipe.title) + 0.4 * lexicalCoverage(lexicalQuery, buildRecipeEmbeddingText(recipe));
    const vector = vectors.get(recipe.id);
    const semanticScore = queryVector && isValidEmbeddingVector(vector, queryVector.length) ? (cosineSimilarity(queryVector, vector) + 1) / 2 : null;
    const baseScore = query ? semanticScore === null ? 0.7 * lexicalScore + 0.3 * details.coverage : 0.74 * semanticScore + 0.21 * details.coverage + 0.05 * lexicalScore : details.coverage;
    const score = baseScore - 0.1 * eligibility.dislikedIngredients.length / Math.max(recipe.ingredients.length, 1);
    return { recipe, score, lexicalScore, semanticScore, bm25Score: bm25.get(recipe.id) ?? 0, fusionScore: 0, ...recipeQueryEvidence(query, recipe), pantryScore: details.coverage, pantryMatch: details.matched, missingIngredients: details.missing, exactTitle: recipe.id === focus, eligibility, ...(readiness ? { readiness } : {}) };
  }).filter((item) => item.eligibility.eligible);
  const admitted = ranked.filter((item) => queryRelevanceDecision(item, query));
  const fusion = reciprocalRanks([
    [...admitted].filter((item) => item.bm25Score > 0).sort((a, b) => b.bm25Score - a.bm25Score || a.recipe.id.localeCompare(b.recipe.id)).map((item) => item.recipe.id),
    [...admitted].filter((item) => item.semanticScore !== null).sort((a, b) => b.semanticScore! - a.semanticScore! || a.recipe.id.localeCompare(b.recipe.id)).map((item) => item.recipe.id),
  ]);
  for (const item of ranked) item.fusionScore = fusion.get(item.recipe.id) ?? 0;
  return ranked.sort((a, b) => Number(b.exactTitle) - Number(a.exactTitle) || dinnerPriority(a.recipe) - dinnerPriority(b.recipe)
    || (broad && stock ? Number((b.readiness?.useSoonCoverage ?? 0) > 0) - Number((a.readiness?.useSoonCoverage ?? 0) > 0) || (b.readiness?.coverage ?? 0) - (a.readiness?.coverage ?? 0) : 0)
    || b.fusionScore - a.fusionScore || b.score - a.score || (b.readiness?.coverage ?? 0) - (a.readiness?.coverage ?? 0) || a.recipe.title.localeCompare(b.recipe.title, "en", { sensitivity: "base" }) || a.recipe.id.localeCompare(b.recipe.id));
}

export async function searchRecipeCatalog(options: RecipeSearchOptions, embedModel: string): Promise<CatalogSearchResult> {
  // This loader enforces active recipes and database source approval/permissions.
  const stored = await listCatalogRecipes(1000);
  const requestedFocus = options.recipeId ?? focusedRecipeId(options.query ?? "", stored.map((item) => item.recipe));
  const searchQuery = recipeRetrievalQuery(options.query ?? "", Boolean(requestedFocus));
  const constraints = constraintsForRecipeQuery(options.query ?? "", options.constraints ?? normalizeConstraints({ allergies: options.allergies }), Boolean(requestedFocus));
  const metadataByRecipeId: RecipeMetadataMap = Object.fromEntries(stored.flatMap((item) => item.metadata ? [[item.recipe.id, item.metadata]] : []));
  const evaluated = stored.map(({ recipe }) => ({ recipe, eligibility: evaluateRecipeConstraints(recipe, metadataByRecipeId[recipe.id], constraints) }));
  const eligible = evaluated.filter((item) => item.eligibility.eligible).map((item) => item.recipe);
  const result: CatalogSearchResult = { recipes: [], ranked: [], method: "empty", outcome: stored.length ? "constraints_unsatisfied" : "catalog_empty", catalogCount: stored.length, embeddingCount: 0, allergyExcludedCount: evaluated.filter((item) => item.eligibility.allergyMatches.length).length, constraintExcludedCount: stored.length - eligible.length, metadataByRecipeId, embedModel };
  const notices = [
    ...(constraints.excludedIngredients?.includes("dairy") ? ["Diet not verified: dairy free. Known dairy ingredient conflicts are excluded; check source ingredients and product labels."] : []),
    ...(constraints.excludedEquipment?.length && stored.some((item) => item.metadata?.equipment == null) ? ["Recipes without reviewed equipment requirements were excluded for this request."] : []),
  ];
  if (notices.length) result.warning = notices.join(" ");
  const blocked = evaluated.find((item) => item.recipe.id === requestedFocus && !item.eligibility.eligible);
  if (blocked) {
    result.warning = `${blocked.recipe.title} conflicts with your requirements. ${blocked.eligibility.reasons.join(" ")}`;
    return result;
  }
  if (!eligible.length) return result;
  if (options.recipeId) {
    const pinned = eligible.filter((recipe) => recipe.id === options.recipeId);
    result.ranked = rankCatalogRecipes(pinned, { ...options, constraints }, new Map(), null, metadataByRecipeId);
    result.recipes = result.ranked.map((item) => item.recipe);
    result.method = "catalog_order";
    result.outcome = pinned.length ? "matches" : "no_match";
    return result;
  }

  let vectors = new Map<string, number[]>();
  let queryVector: number[] | null = null;
  if (searchQuery.trim()) {
    try {
      vectors = await loadPrecomputedRecipeEmbeddingMap(embedModel);
      result.embeddingCount = vectors.size;
      // Don't compare semantic scores with differently scaled partial-index scores.
      if (!vectors.size) throw new Error("Search embeddings are pending.");
      const query = await embedTextsWithOllama([buildRecipeQueryText(searchQuery, [])], { model: embedModel, timeoutMs: 8000, signal: options.signal });
      queryVector = query.vectors[0] ?? null;
      const dimension = queryVector?.length;
      if (!dimension) throw new Error("Search embedding dimensions differ.");
      vectors = new Map([...vectors].filter(([, vector]) => isValidEmbeddingVector(vector, dimension)));
      if (!vectors.size) throw new Error("Search embedding dimensions differ.");
      if (!eligible.every((recipe) => vectors.has(recipe.id))) result.warning = [result.warning, "Some recipes have pending meaning-based indexes; those recipes use keywords."].filter(Boolean).join(" ");
    } catch {
      queryVector = null;
      result.warning = [result.warning, "Meaning-based search is unavailable or its index is pending. Results use recipe names, ingredients, and pantry matches."].filter(Boolean).join(" ");
    }
  }
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 8), 1), 20);
  const ranked = rankCatalogRecipes(eligible, { ...options, constraints }, vectors, queryVector, metadataByRecipeId);
  result.ranked = selectCatalogShortlist(ranked, options.query ?? "", limit);
  result.outcome = result.ranked.length ? "matches" : "no_match";
  result.recipes = result.ranked.map((item) => item.recipe);
  result.method = queryVector ? "precomputed_embeddings" : options.query?.trim() || options.pantry?.length ? "lexical_pantry" : "catalog_order";
  return result;
}

export async function loadPrecomputedRecipeEmbeddingMap(model: string): Promise<Map<string, number[]>> {
  const records = await listStoredRecipeEmbeddings(model);
  return new Map(records.flatMap((record) => isValidEmbeddingVector(record.vector) ? [[record.recipeId, record.vector] as const] : []));
}
