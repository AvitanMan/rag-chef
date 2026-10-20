import type {
  Recipe,
  RecipeIngredient,
  RecipeSearchOptions,
  RecipeSourceAttribution,
} from "./recipe-types";

const API_BASE_URL = "https://www.themealdb.com/api/json/v1/1";
const REQUEST_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 15 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 64;
const MAX_PANTRY_FILTER_CALLS = 3;
const MAX_DETAIL_LOOKUPS = 6;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 12;

// A deliberately small, varied weeknight set. Each item is still loaded from
// TheMealDB so recipe text and attribution stay attached to the source record.
const DEFAULT_RECIPE_IDS = [
  "52772", // Teriyaki Chicken Casserole
  "52773", // Honey Teriyaki Salmon
  "52774", // Pad See Ew
  "52775", // Vegan Lasagna
  "52777", // Mediterranean Pasta Salad
  "52819", // Cajun spiced fish tacos
] as const;

export const THE_MEAL_DB_SOURCE: RecipeSourceAttribution = Object.freeze({
  name: "TheMealDB",
  url: "https://www.themealdb.com/",
});

export class RecipeSourceError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "RecipeSourceError";
    this.status = status;
  }
}

interface MealDbPayload {
  meals: unknown[] | null;
}

interface CacheEntry {
  expiresAt: number;
  payload: MealDbPayload;
}

const responseCache = new Map<string, CacheEntry>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeHttpUrl(value: unknown, fallback: string): string {
  const candidate = textValue(value);

  if (!candidate) {
    return fallback;
  }

  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : fallback;
  } catch {
    return fallback;
  }
}

function splitInstructions(value: unknown): string[] {
  const instructions = textValue(value)
    .replace(/\r/g, "")
    .replace(/\s+(?=(?:step\s+)?\d+[.)]\s+)/gi, "\n");

  if (!instructions) {
    return [];
  }

  let lines = instructions
    .split(/\n+/)
    .map((line) =>
      line
        .trim()
        .replace(/^(?:step\s+)?\d+[.)]\s+/i, "")
        .trim(),
    )
    .filter(
      (line) =>
        Boolean(line) &&
        !/^(?:step\s*#?\s*\d+|instructions?|directions?)\s*[:.)-]?$/i.test(
          line,
        ),
    );

  // Some source records contain a single wall of text. Split only on explicit
  // cooking transitions so the source wording stays intact.
  if (lines.length === 1 && lines[0].length > 320) {
    const transitions = lines[0]
      .split(
        /(?<=[.!?])\s+(?=(?:next|then|meanwhile|finally|once|after that|to serve)\b)/i,
      )
      .map((line) => line.trim())
      .filter(Boolean);
    if (transitions.length > 1) lines = transitions;
  }

  return lines.length > 0 ? lines : [instructions];
}

function extractIngredients(meal: Record<string, unknown>): RecipeIngredient[] {
  const ingredients: RecipeIngredient[] = [];

  for (let index = 1; index <= 20; index += 1) {
    const name = textValue(meal[`strIngredient${index}`]);

    if (!name) {
      continue;
    }

    ingredients.push({
      name,
      measure: textValue(meal[`strMeasure${index}`]),
    });
  }

  return ingredients;
}

export function normalizeMeal(value: unknown): Recipe | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = textValue(value.idMeal);
  const title = textValue(value.strMeal);

  if (!id || !title) {
    return null;
  }

  const rawTags = textValue(value.strTags);
  return {
    id,
    title,
    image: safeHttpUrl(value.strMealThumb, "") || null,
    category: textValue(value.strCategory) || "Other",
    cuisine: textValue(value.strArea) || "International",
    source: THE_MEAL_DB_SOURCE,
    sourceUrl: THE_MEAL_DB_SOURCE.url,
    ingredients: extractIngredients(value),
    instructions: splitInstructions(value.strInstructions),
    tags: rawTags
      ? [...new Set(rawTags.split(",").map((tag) => tag.trim()).filter(Boolean))]
      : [],
  };
}

function readCachedPayload(url: string): MealDbPayload | null {
  const cached = responseCache.get(url);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    responseCache.delete(url);
    return null;
  }

  return cached.payload;
}

function cachePayload(url: string, payload: MealDbPayload): void {
  if (responseCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;

    if (typeof oldestKey === "string") {
      responseCache.delete(oldestKey);
    }
  }

  responseCache.set(url, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    payload,
  });
}

async function fetchMealDb(
  endpoint: "filter.php" | "lookup.php" | "search.php",
  params: Record<string, string>,
): Promise<MealDbPayload> {
  const url = new URL(`${API_BASE_URL}/${endpoint}`);
  url.search = new URLSearchParams(params).toString();

  const cached = readCachedPayload(url.toString());

  if (cached) {
    return cached;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new RecipeSourceError(
        `TheMealDB request failed with status ${response.status}.`,
      );
    }

    const value: unknown = await response.json();

    if (!isRecord(value) || !("meals" in value)) {
      throw new RecipeSourceError("TheMealDB returned an unexpected response.");
    }

    const payload: MealDbPayload = {
      meals: Array.isArray(value.meals) ? value.meals : null,
    };
    cachePayload(url.toString(), payload);
    return payload;
  } catch (error) {
    if (error instanceof RecipeSourceError) {
      throw error;
    }

    if (controller.signal.aborted) {
      throw new RecipeSourceError("TheMealDB request timed out.");
    }

    throw new RecipeSourceError("TheMealDB is temporarily unavailable.");
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePantryTerm(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ingredientKey(value: string): string {
  return normalizePantryTerm(value)
    .split(" ")
    .map((word) => (word.length > 3 ? word.replace(/s$/, "") : word))
    .join(" ");
}

function pantryMatchCount(recipe: Recipe, pantry: string[]): number {
  const ingredients = recipe.ingredients.map(({ name }) => ingredientKey(name));

  return pantry.reduce((count, pantryItem) => {
    const item = ingredientKey(pantryItem);
    const matched = ingredients.some(
      (ingredient) => ingredient.includes(item) || item.includes(ingredient),
    );
    return count + Number(matched);
  }, 0);
}

function rankByPantry(recipes: Recipe[], pantry: string[]): Recipe[] {
  if (pantry.length === 0) {
    return recipes;
  }

  return recipes
    .map((recipe, position) => ({
      recipe,
      position,
      matches: pantryMatchCount(recipe, pantry),
    }))
    .sort((left, right) =>
      right.matches === left.matches
        ? left.position - right.position
        : right.matches - left.matches,
    )
    .map(({ recipe }) => recipe);
}

async function lookupRecipes(ids: string[]): Promise<Recipe[]> {
  const results = await Promise.allSettled(
    ids.slice(0, MAX_DETAIL_LOOKUPS).map(async (id) => {
      const payload = await fetchMealDb("lookup.php", { i: id });
      return payload.meals?.map(normalizeMeal).find(Boolean) ?? null;
    }),
  );

  const recipes = results.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : [],
  );

  if (recipes.length === 0 && results.some((result) => result.status === "rejected")) {
    throw new RecipeSourceError("TheMealDB is temporarily unavailable.");
  }

  return recipes;
}

async function searchByName(query: string): Promise<Recipe[]> {
  const payload = await fetchMealDb("search.php", { s: query });
  return (payload.meals ?? [])
    .map(normalizeMeal)
    .filter((recipe): recipe is Recipe => recipe !== null);
}

async function searchByPantry(pantry: string[], limit: number): Promise<Recipe[]> {
  const terms = pantry.slice(0, MAX_PANTRY_FILTER_CALLS);
  const filterResults = await Promise.allSettled(
    terms.map((ingredient) =>
      fetchMealDb("filter.php", { i: ingredient.replace(/\s+/g, "_") }),
    ),
  );
  const candidateIds = new Map<string, Set<number>>();

  filterResults.forEach((result, termIndex) => {
    if (result.status !== "fulfilled") {
      return;
    }

    for (const meal of result.value.meals ?? []) {
      if (!isRecord(meal)) {
        continue;
      }

      const id = textValue(meal.idMeal);

      if (!id) {
        continue;
      }

      const matches = candidateIds.get(id) ?? new Set<number>();
      matches.add(termIndex);
      candidateIds.set(id, matches);
    }
  });

  const orderedIds = [...candidateIds.entries()]
    .sort((left, right) => right[1].size - left[1].size)
    .map(([id]) => id)
    .slice(0, Math.min(limit, MAX_DETAIL_LOOKUPS));

  if (orderedIds.length === 0) {
    if (filterResults.every((result) => result.status === "rejected")) {
      throw new RecipeSourceError("TheMealDB is temporarily unavailable.");
    }

    return [];
  }

  return rankByPantry(await lookupRecipes(orderedIds), pantry);
}

export async function searchRecipes(
  options: RecipeSearchOptions = {},
): Promise<Recipe[]> {
  const pantry = [...new Set((options.pantry ?? []).map(normalizePantryTerm).filter(Boolean))];
  const query = options.query?.trim() ?? "";
  const limit = Math.min(
    Math.max(Math.floor(options.limit ?? DEFAULT_LIMIT), 1),
    MAX_LIMIT,
  );

  if (query) {
    return rankByPantry(await searchByName(query), pantry).slice(0, limit);
  }

  if (pantry.length > 0) {
    return (await searchByPantry(pantry, limit)).slice(0, limit);
  }

  return (await lookupRecipes([...DEFAULT_RECIPE_IDS])).slice(0, limit);
}
