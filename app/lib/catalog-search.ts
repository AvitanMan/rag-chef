import {
  cosineSimilarity,
  embedTextsWithOllama,
  isValidEmbeddingVector,
} from "./recipe-embeddings";
import {
  listCatalogRecipes,
  listStoredRecipeEmbeddings,
} from "./recipe-store";
import type { Recipe, RecipeSearchOptions } from "./recipe-types";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

export type CatalogRetrievalMethod =
  | "precomputed_embeddings"
  | "lexical_pantry"
  | "catalog_order"
  | "empty";

export interface CatalogSearchResult {
  recipes: Recipe[];
  method: CatalogRetrievalMethod;
  catalogCount: number;
  embeddingCount: number;
  embedModel: string;
}

export async function searchRecipeCatalog(
  options: RecipeSearchOptions,
  embedModel: string,
): Promise<CatalogSearchResult> {
  const stored = await listCatalogRecipes();
  const limit = Math.min(
    Math.max(Math.floor(options.limit ?? DEFAULT_LIMIT), 1),
    MAX_LIMIT,
  );
  if (stored.length === 0) {
    return {
      recipes: [],
      method: "empty",
      catalogCount: 0,
      embeddingCount: 0,
      embedModel,
    };
  }

  const query = options.query?.trim() ?? "";
  const pantry = uniqueNormalized(options.pantry ?? []);
  const embeddings = await loadPrecomputedRecipeEmbeddingMap(embedModel);
  let queryVector: number[] | null = null;

  if (query && embeddings.size > 0) {
    try {
      const result = await embedTextsWithOllama(
        [catalogQueryText(query, pantry)],
        { model: embedModel },
      );
      queryVector = result.vectors[0] ?? null;
    } catch {
      queryVector = null;
    }
  }

  const ranked = stored
    .map((item, position) => {
      const pantryScore = pantryCoverage(item.recipe, pantry);
      const lexicalScore = lexicalCoverage(query, item.searchText);
      const vector = embeddings.get(item.catalogId);
      const semanticScore =
        queryVector && vector && vector.length === queryVector.length
          ? normalizeSimilarity(cosineSimilarity(queryVector, vector))
          : null;
      const score = query
        ? semanticScore === null
          ? 0.7 * lexicalScore + 0.3 * pantryScore
          : 0.74 * semanticScore + 0.21 * pantryScore + 0.05 * lexicalScore
        : pantry.length > 0
          ? pantryScore
          : 1 - position / Math.max(stored.length, 1) / 100;
      return { item, position, score };
    })
    .sort((left, right) =>
      right.score === left.score
        ? left.position - right.position
        : right.score - left.score,
    );

  return {
    recipes: ranked.slice(0, limit).map(({ item }) => item.recipe),
    method: queryVector
      ? "precomputed_embeddings"
      : query || pantry.length > 0
        ? "lexical_pantry"
        : "catalog_order",
    catalogCount: stored.length,
    embeddingCount: embeddings.size,
    embedModel,
  };
}

export async function loadPrecomputedRecipeEmbeddingMap(
  model: string,
): Promise<Map<string, number[]>> {
  const records = await listStoredRecipeEmbeddings(model);
  return new Map(
    records.flatMap((record) =>
      isValidEmbeddingVector(record.vector)
        ? [[record.recipeId, record.vector] as const]
        : [],
    ),
  );
}

function catalogQueryText(query: string, pantry: string[]): string {
  return [
    `Cooking request: ${query}`,
    pantry.length > 0 ? `Available ingredients: ${pantry.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function lexicalCoverage(query: string, searchText: string): number {
  const tokens = significantTokens(query);
  if (tokens.length === 0) return 0;
  const haystack = normalize(searchText);
  return (
    tokens.filter((token) => haystack.includes(token)).length / tokens.length
  );
}

function pantryCoverage(recipe: Recipe, pantry: string[]): number {
  if (pantry.length === 0) return 0;
  const ingredients = recipe.ingredients.map((item) => normalize(item.name));
  const matches = pantry.filter((item) =>
    ingredients.some(
      (ingredient) => ingredient.includes(item) || item.includes(ingredient),
    ),
  ).length;
  return matches / pantry.length;
}

function significantTokens(value: string): string[] {
  return uniqueNormalized(value.split(/\s+/)).filter(
    (token) => token.length > 2,
  );
}

function uniqueNormalized(values: string[]): string[] {
  return [...new Set(values.map(normalize).filter(Boolean))];
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSimilarity(value: number): number {
  return Math.max(0, Math.min(1, (value + 1) / 2));
}
