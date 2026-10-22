import { searchRecipeCatalog } from "@/app/lib/catalog-search";
import { DEFAULT_RECIPE_EMBED_MODEL } from "@/app/lib/recipe-embeddings";
import { RecipeSourceError, searchRecipes, THE_MEAL_DB_SOURCE } from "@/app/lib/recipe-source";
import { isRecipeCatalogConfigured } from "@/app/lib/recipe-store";
import { evaluateRecipeConstraints, normalizeConstraints } from "@/app/lib/recipe-constraints";

const MAX_QUERY_LENGTH = 120;
const MAX_PANTRY_ITEMS = 20;
const MAX_PANTRY_ITEM_LENGTH = 64;

function jsonError(message: string, code: string, status: number): Response {
  return Response.json(
    {
      recipes: [],
      error: { code, message },
      source: THE_MEAL_DB_SOURCE,
    },
    { status },
  );
}

function readPantry(searchParams: URLSearchParams): string[] {
  return [
    ...new Set(
      searchParams
        .getAll("pantry")
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export async function GET(request: Request): Promise<Response> {
  let url: URL;

  try {
    url = new URL(request.url);
  } catch {
    return jsonError("The recipe request URL is invalid.", "INVALID_REQUEST", 400);
  }

  const query = url.searchParams.get("q")?.trim() ?? "";
  const pantry = readPantry(url.searchParams);
  const allergies = url.searchParams.getAll("allergy").map((item) => item.trim()).filter(Boolean);
  const constraints = normalizeConstraints({ allergies, diets: url.searchParams.getAll("diet"), dislikes: url.searchParams.getAll("dislike"), equipment: url.searchParams.getAll("equipment"), maxTotalMinutes: Number(url.searchParams.get("maxMinutes")) || undefined });
  if (allergies.length > 30 || allergies.some((item) => item.length > 100)) return jsonError("Invalid allergy exclusions.", "INVALID_ALLERGIES", 400);

  if (query.length > MAX_QUERY_LENGTH) {
    return jsonError(
      `q must be ${MAX_QUERY_LENGTH} characters or fewer.`,
      "INVALID_QUERY",
      400,
    );
  }

  if (
    pantry.length > MAX_PANTRY_ITEMS ||
    pantry.some((item) => item.length > MAX_PANTRY_ITEM_LENGTH)
  ) {
    return jsonError(
      `pantry accepts up to ${MAX_PANTRY_ITEMS} comma-separated items of ${MAX_PANTRY_ITEM_LENGTH} characters each.`,
      "INVALID_PANTRY",
      400,
    );
  }

  try {
    if (await isRecipeCatalogConfigured()) {
      try {
        const catalog = await searchRecipeCatalog(
          { pantry, query, constraints },
          embeddingModel(),
        );
        if (catalog.catalogCount > 0 || allergies.length > 0) {
          return Response.json(
            {
              recipes: catalog.recipes,
              metadataByRecipeId: catalog.metadataByRecipeId,
              meta: {
                count: catalog.recipes.length,
                mode: query ? "search" : pantry.length > 0 ? "pantry" : "curated",
                query: query || null,
                pantry,
                source: { name: "the approved catalog", url: "#source-note" },
                sourceNotice:
                  "Results come from normalized, prototype-approved recipe records with source attribution preserved.",
                retrieval: {
                  method: catalog.method,
                  catalogCount: catalog.catalogCount,
                  embeddingCount: catalog.embeddingCount,
                  embedModel: catalog.embedModel,
                  allergyExcludedCount: catalog.allergyExcludedCount,
                  warning: catalog.warning,
                },
              },
            },
            { headers: { "Cache-Control": "private, max-age=60" } },
          );
        }
      } catch {
        // Keep the product usable while a local database is being initialized.
      }
    }

    const recipes = (await searchRecipes({ pantry, query })).filter((recipe) => evaluateRecipeConstraints(recipe, undefined, constraints).eligible);
    const mode = query ? "search" : pantry.length > 0 ? "pantry" : "curated";

    return Response.json(
      {
        recipes,
        metadataByRecipeId: {},
        meta: {
          count: recipes.length,
          mode,
          query: query || null,
          pantry,
          source: THE_MEAL_DB_SOURCE,
          sourceNotice:
            "Recipe details and images are provided by and attributed to TheMealDB.",
          retrieval: { method: "live_source_fallback" },
        },
      },
      {
        headers: {
          "Cache-Control": "private, max-age=60",
        },
      },
    );
  } catch (error) {
    if (error instanceof RecipeSourceError) {
      return jsonError(error.message, "RECIPE_SOURCE_UNAVAILABLE", error.status);
    }

    return jsonError(
      "Recipes could not be loaded right now.",
      "RECIPE_SOURCE_UNAVAILABLE",
      502,
    );
  }
}

function embeddingModel(): string {
  return (
    (typeof process !== "undefined"
      ? process.env?.OLLAMA_EMBED_MODEL?.trim()
      : "") || DEFAULT_RECIPE_EMBED_MODEL
  );
}
