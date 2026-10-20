import {
  DEFAULT_RECIPE_EMBED_MODEL,
  buildRecipeSearchText,
  precomputeRecipeEmbeddings,
  sha256Hex,
} from "@/app/lib/recipe-embeddings";
import { searchRecipes, THE_MEAL_DB_SOURCE } from "@/app/lib/recipe-source";
import {
  ensureRecipeCatalogSchema,
  finishCatalogSync,
  getCatalogStatus,
  listStoredRecipeEmbeddings,
  saveRecipeEmbeddings,
  startCatalogSync,
  upsertApprovedRecipeSource,
  upsertCatalogRecipe,
  type ApprovedRecipeSourceInput,
} from "@/app/lib/recipe-store";

const SOURCE_ID = "themealdb";
const RUNNING_SYNC_TTL_MS = 10 * 60 * 1_000;

const PROTOTYPE_SOURCE_APPROVAL: ApprovedRecipeSourceInput = {
  id: SOURCE_ID,
  name: THE_MEAL_DB_SOURCE.name,
  url: THE_MEAL_DB_SOURCE.url,
  licenseId: "NOASSERTION",
  termsUrl: "https://www.themealdb.com/terms_of_use.php",
  attributionText: "Recipe details and images attributed to TheMealDB.",
  permissionBasis:
    "Official API development terms, reviewed and approved for this local prototype",
  approvalStatus: "approved",
  approvedBy: "prototype owner",
  approvalNotes:
    "Local prototype only. Re-review storage, indexing, embedding, image, and commercial permissions before any public launch.",
  allowDisplay: true,
  allowCache: true,
  allowIndexText: true,
  allowEmbed: true,
  allowDerive: false,
  allowCommercial: false,
  allowImages: true,
};

export async function GET(request: Request): Promise<Response> {
  const authorizationError = authorizeCatalogRequest(request);
  if (authorizationError) return authorizationError;

  try {
    const model = embeddingModel();
    await ensureRecipeCatalogSchema();
    return json({ ok: true, catalog: await getCatalogStatus(model) });
  } catch (error) {
    return catalogError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorizationError = authorizeCatalogRequest(request);
  if (authorizationError) return authorizationError;

  const model = embeddingModel();
  let syncRunId: string | null = null;
  let recordsSeen = 0;
  let recordsUpserted = 0;

  try {
    await ensureRecipeCatalogSchema();
    const before = await getCatalogStatus(model);
    if (
      before.lastSync?.status === "running" &&
      Date.now() - before.lastSync.startedAt < RUNNING_SYNC_TTL_MS
    ) {
      return json(
        {
          ok: false,
          error: {
            code: "CATALOG_SYNC_RUNNING",
            message: "A catalog sync is already running.",
          },
        },
        409,
      );
    }

    await upsertApprovedRecipeSource(PROTOTYPE_SOURCE_APPROVAL);
    syncRunId = await startCatalogSync(SOURCE_ID);

    const sourceRecipes = await searchRecipes({ limit: 12 });
    recordsSeen = sourceRecipes.length;
    const catalogRecipes = [];
    let changedRecipeCount = 0;

    for (const recipe of sourceRecipes) {
      const searchText = buildRecipeSearchText(recipe);
      const contentHash = await sha256Hex(searchText);
      const stored = await upsertCatalogRecipe({
        sourceId: SOURCE_ID,
        recipe,
        contentHash,
        searchText,
        syncRunId,
      });
      recordsUpserted += 1;
      changedRecipeCount += Number(stored.contentChanged);
      catalogRecipes.push({ ...recipe, id: stored.catalogId });
    }

    const existingEmbeddings = await listStoredRecipeEmbeddings(model);
    const embeddingResult = await precomputeRecipeEmbeddings(
      catalogRecipes,
      existingEmbeddings,
      {
        model,
        timeoutMs: embeddingTimeoutMs(),
      },
    );
    await saveRecipeEmbeddings(embeddingResult.embeddings);
    await finishCatalogSync(syncRunId, "succeeded", {
      recordsSeen,
      recordsUpserted,
    });
    const catalog = await getCatalogStatus(model);

    return json({
      ok: embeddingResult.failures.length === 0,
      import: {
        sourceId: SOURCE_ID,
        syncRunId,
        recordsSeen,
        recordsUpserted,
        changedRecipeCount,
      },
      embeddings: {
        model: embeddingResult.model,
        checkedCount: embeddingResult.checkedCount,
        skippedCount: embeddingResult.skippedCount,
        requestedCount: embeddingResult.requestedCount,
        completedCount: embeddingResult.completedCount,
        dimensions: embeddingResult.dimension,
        failures: embeddingResult.failures,
      },
      catalog,
    });
  } catch (error) {
    if (syncRunId) {
      try {
        await finishCatalogSync(syncRunId, "failed", {
          recordsSeen,
          recordsUpserted,
          errorMessage: safeErrorMessage(error),
        });
      } catch {
        // Preserve the original ingestion error in the response.
      }
    }
    return catalogError(error);
  }
}

function authorizeCatalogRequest(request: Request): Response | null {
  const url = new URL(request.url);
  if (isLoopbackHost(url.hostname)) return null;

  const token = serverEnv("CATALOG_ADMIN_TOKEN");
  if (!token) {
    return json(
      {
        ok: false,
        error: {
          code: "CATALOG_ADMIN_NOT_CONFIGURED",
          message: "Catalog administration is disabled until CATALOG_ADMIN_TOKEN is set.",
        },
      },
      503,
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return json(
      {
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "A valid catalog administrator token is required.",
        },
      },
      401,
    );
  }
  return null;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function embeddingModel(): string {
  return serverEnv("OLLAMA_EMBED_MODEL") || DEFAULT_RECIPE_EMBED_MODEL;
}

function embeddingTimeoutMs(): number {
  const parsed = Number(serverEnv("OLLAMA_EMBED_TIMEOUT_MS"));
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 120_000
    ? parsed
    : 30_000;
}

function serverEnv(name: string): string {
  return typeof process !== "undefined" && process.env?.[name]
    ? process.env[name]!.trim()
    : "";
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message.slice(0, 500)
    : "Catalog sync failed.";
}

function catalogError(error: unknown): Response {
  return json(
    {
      ok: false,
      error: {
        code: "CATALOG_ERROR",
        message: safeErrorMessage(error),
      },
    },
    500,
  );
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
