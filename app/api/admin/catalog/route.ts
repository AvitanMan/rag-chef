import {
  DEFAULT_RECIPE_EMBED_MODEL,
  buildRecipeSearchText,
  precomputeRecipeEmbeddings,
  precomputeRecipeStepEmbeddings,
  RECIPE_STEP_EMBEDDING_KIND,
  sha256Hex,
} from "@/app/lib/recipe-embeddings";
import { searchRecipes, THE_MEAL_DB_SOURCE } from "@/app/lib/recipe-source";
import {
  ensureRecipeCatalogSchema,
  finishCatalogSync,
  getCatalogStatus,
  listStoredRecipeEmbeddings,
  listCatalogRecipes,
  saveRecipeEmbeddings,
  startCatalogSync,
  upsertApprovedRecipeSource,
  upsertCatalogRecipe,
  type ApprovedRecipeSourceInput,
} from "@/app/lib/recipe-store";
import { authorizeCatalogRequest } from "@/app/lib/catalog-auth";

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
  let embeddingsOnly = false;
  try {
    const text = await request.text();
    if (text.length > 1024) return json({ error: "Request body is too large." }, 413);
    if (text.trim()) {
      const input = JSON.parse(text);
      if (input?.embeddingsOnly !== true || Object.keys(input).some((key) => key !== "embeddingsOnly")) return json({ error: "Expected embeddingsOnly: true, or an empty body for source sync." }, 400);
      embeddingsOnly = true;
    }
  } catch { return json({ error: "Invalid request body." }, 400); }
  let syncRunId: string | null = null;
  let recordsSeen = 0;
  let recordsUpserted = 0;

  try {
    await ensureRecipeCatalogSchema();
    if (embeddingsOnly) {
      const records = await listCatalogRecipes(1000, { forEmbedding: true });
      const contentHashes = new Map(records.map((item) => [item.recipe.id, item.contentHash]));
      const embedded = await precomputeRecipeEmbeddings(records.map((item) => item.recipe), await listStoredRecipeEmbeddings(model), { model, timeoutMs: embeddingTimeoutMs(), contentHashes });
      await saveRecipeEmbeddings(embedded.embeddings);
      const steps = await precomputeRecipeStepEmbeddings(records.map((item) => item.recipe), await listStoredRecipeEmbeddings(model, RECIPE_STEP_EMBEDDING_KIND), { model, timeoutMs: embeddingTimeoutMs(), contentHashes });
      await saveRecipeEmbeddings(steps.embeddings);
      return json({ stepEmbeddings: { ...steps, embeddings: undefined }, ok: embedded.failures.length === 0 && steps.failures.length === 0, embeddings: { model, checkedCount: embedded.checkedCount, skippedCount: embedded.skippedCount, requestedCount: embedded.requestedCount, completedCount: embedded.completedCount, failures: embedded.failures }, catalog: await getCatalogStatus(model) });
    }
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
