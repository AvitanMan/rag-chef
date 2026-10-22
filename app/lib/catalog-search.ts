import { buildRecipeEmbeddingText, buildRecipeQueryText, cosineSimilarity, embedTextsWithOllama, isValidEmbeddingVector } from "./recipe-embeddings";
import { listCatalogRecipes, listStoredRecipeEmbeddings } from "./recipe-store";
import { normalizeRecipeSearch, recipePantryDetails } from "./recipe-browser";
import { matchedRecipeAllergies } from "./recipe-safety";
import type { Recipe, RecipeSearchOptions } from "./recipe-types";

export type CatalogRetrievalMethod = "precomputed_embeddings" | "lexical_pantry" | "catalog_order" | "empty";
export interface CatalogRankedRecipe {
  recipe: Recipe;
  score: number;
  pantryScore: number;
  lexicalScore: number;
  semanticScore: number | null;
  pantryMatch: string[];
  missingIngredients: string[];
  exactTitle: boolean;
}
export interface CatalogSearchResult {
  recipes: Recipe[];
  ranked: CatalogRankedRecipe[];
  method: CatalogRetrievalMethod;
  catalogCount: number;
  embeddingCount: number;
  allergyExcludedCount: number;
  embedModel: string;
  warning?: string;
}

const STOP_WORDS = new Set("a an and can cook for from i in make me my of please recipe recipes the to want what with something dinner tonight".split(" "));

/** Only explicit positive named-dish requests; not a general intent classifier. */
export function focusedRecipeId(query: string, recipes: Recipe[]): string | null {
  const request = normalizeRecipeSearch(query);
  const matches = recipes.filter((recipe) => {
    const title = normalizeRecipeSearch(recipe.title);
    return title && (request === title || ["for", "recommend", "help me cook", "help me make", "how do i cook", "how do i make"].some((prefix) => request === `${prefix} ${title}` || request.startsWith(`${prefix} ${title} `)));
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
export function rankCatalogRecipes(recipes: Recipe[], options: RecipeSearchOptions, vectors = new Map<string, number[]>(), queryVector: number[] | null = null): CatalogRankedRecipe[] {
  const query = options.query?.trim() ?? "";
  const pantry = options.pantry ?? [];
  const focus = focusedRecipeId(query, recipes);
  return recipes.map((recipe) => {
    const details = recipePantryDetails(recipe, pantry);
    const lexicalScore = 0.6 * lexicalCoverage(query, recipe.title) + 0.4 * lexicalCoverage(query, buildRecipeEmbeddingText(recipe));
    const vector = vectors.get(recipe.id);
    const semanticScore = queryVector && isValidEmbeddingVector(vector, queryVector.length) ? (cosineSimilarity(queryVector, vector) + 1) / 2 : null;
    const score = query ? semanticScore === null ? 0.7 * lexicalScore + 0.3 * details.coverage : 0.74 * semanticScore + 0.21 * details.coverage + 0.05 * lexicalScore : details.coverage;
    return { recipe, score, lexicalScore, semanticScore, pantryScore: details.coverage, pantryMatch: details.matched, missingIngredients: details.missing, exactTitle: recipe.id === focus };
  }).sort((a, b) => Number(b.exactTitle) - Number(a.exactTitle) || b.score - a.score || a.recipe.title.localeCompare(b.recipe.title, "en", { sensitivity: "base" }) || a.recipe.id.localeCompare(b.recipe.id));
}

export async function searchRecipeCatalog(options: RecipeSearchOptions, embedModel: string): Promise<CatalogSearchResult> {
  // This loader enforces active recipes and database source approval/permissions.
  const stored = await listCatalogRecipes(1000);
  const eligible = stored.filter(({ recipe }) => !matchedRecipeAllergies(recipe, options.allergies ?? []).length).map(({ recipe }) => recipe);
  const result: CatalogSearchResult = { recipes: [], ranked: [], method: "empty", catalogCount: stored.length, embeddingCount: 0, allergyExcludedCount: stored.length - eligible.length, embedModel };
  if (!eligible.length) return result;

  let vectors = new Map<string, number[]>();
  let queryVector: number[] | null = null;
  if (options.query?.trim()) {
    try {
      vectors = await loadPrecomputedRecipeEmbeddingMap(embedModel);
      result.embeddingCount = vectors.size;
      // Don't compare semantic scores with differently scaled partial-index scores.
      if (!eligible.every((recipe) => vectors.has(recipe.id))) throw new Error("Search embeddings are pending.");
      const query = await embedTextsWithOllama([buildRecipeQueryText(options.query, options.pantry ?? [])], { model: embedModel, timeoutMs: 8000 });
      queryVector = query.vectors[0] ?? null;
      const dimension = queryVector?.length;
      if (!dimension || !eligible.every((recipe) => isValidEmbeddingVector(vectors.get(recipe.id), dimension))) throw new Error("Search embedding dimensions differ.");
    } catch {
      queryVector = null;
      result.warning = "Meaning-based search is unavailable or its index is pending. Results use recipe names, ingredients, and pantry matches.";
    }
  }
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 8), 1), 20);
  result.ranked = rankCatalogRecipes(eligible, options, vectors, queryVector).slice(0, limit);
  result.recipes = result.ranked.map((item) => item.recipe);
  result.method = queryVector ? "precomputed_embeddings" : options.query?.trim() || options.pantry?.length ? "lexical_pantry" : "catalog_order";
  return result;
}

export async function loadPrecomputedRecipeEmbeddingMap(model: string): Promise<Map<string, number[]>> {
  const records = await listStoredRecipeEmbeddings(model);
  return new Map(records.flatMap((record) => isValidEmbeddingVector(record.vector) ? [[record.recipeId, record.vector] as const] : []));
}
