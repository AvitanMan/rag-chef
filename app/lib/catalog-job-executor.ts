import type { ModelAdmission } from "./model-admission";
import { RuntimeAdmissionError } from "./runtime-admission-types";
import { type CatalogService, type ApprovedRecipeSourceInput, catalogRecipeId } from "./catalog-service";
import type { CatalogJobInput, CatalogJobProgress } from "./catalog-job-types";
import { DEMO_RECIPES, DEMO_SOURCE } from "./demo-recipes";
import { hostedMode } from "./household";
import { validateRecipeSnapshot } from "./kitchen-validation";
import { WIKIBOOKS_SOURCE, draftRecipe, validateImportDraft } from "./recipe-import";
import {
  DEFAULT_RECIPE_EMBED_MODEL, RECIPE_STEP_EMBEDDING_KIND, buildRecipeSearchText,
  precomputeRecipeEmbeddings, precomputeRecipeStepEmbeddings, sha256Hex,
  type OllamaEmbeddingOptions, type RecipeEmbeddingRecord, type RecipeEmbeddingRunResult, type StoredRecipeEmbedding,
} from "./recipe-embeddings";
import { searchRecipes, THE_MEAL_DB_SOURCE } from "./recipe-source";
import type { Recipe } from "./recipe-types";

export type CatalogJobCatalog = Pick<CatalogService,
  "ensureReady" | "sourceEnabled" | "sourcePolicy" | "upsertSource" | "startSync" | "finishSync"
  | "list" | "embeddings" | "upsertRecipe" | "saveEmbeddings" | "status">;
export interface CatalogJobExecutorDependencies {
  /** The runner binds every mutator to its current durable job lease. */
  catalog: CatalogJobCatalog;
  admission?: ModelAdmission;
  providers?: Partial<{
    searchRecipes: typeof searchRecipes;
    precomputeRecipeEmbeddings: typeof precomputeRecipeEmbeddings;
    precomputeRecipeStepEmbeddings: typeof precomputeRecipeStepEmbeddings;
  }>;
  hosted?: () => boolean;
  embeddingModel?: () => string;
  embeddingTimeoutMs?: () => number;
}
export interface CatalogJobExecutionOptions {
  signal?: AbortSignal;
  checkpoint?: (progress?: CatalogJobProgress) => Promise<void>;
}
export class CatalogJobExecutionError extends Error {
  constructor(message: string, readonly code: string, readonly retryable = false) {
    super(message); this.name = "CatalogJobExecutionError";
  }
}

const PROTOTYPE_SOURCE_APPROVAL: ApprovedRecipeSourceInput = {
  id: "themealdb", name: THE_MEAL_DB_SOURCE.name, url: THE_MEAL_DB_SOURCE.url,
  licenseId: "NOASSERTION", termsUrl: "https://www.themealdb.com/terms_of_use.php",
  attributionText: "Recipe details and images attributed to TheMealDB.",
  permissionBasis: "Official API development terms, reviewed and approved for this local prototype",
  approvalStatus: "approved", approvedBy: "prototype owner",
  approvalNotes: "Local prototype only. Re-review storage, indexing, embedding, image, and commercial permissions before any public launch.",
  allowDisplay: true, allowCache: true, allowIndexText: true, allowEmbed: true,
  allowDerive: false, allowCommercial: false, allowImages: true,
};
const errorMessage = (error: unknown) => error instanceof Error ? error.message.slice(0, 500) : "Catalog update failed.";

/** Source policy and storage constraints remain authoritative during execution. */
export function createCatalogJobExecutor(dependencies: CatalogJobExecutorDependencies) {
  const catalog = dependencies.catalog;
  const providers = { searchRecipes, precomputeRecipeEmbeddings, precomputeRecipeStepEmbeddings, ...dependencies.providers };
  return {
    async execute(input: CatalogJobInput, options: CatalogJobExecutionOptions = {}): Promise<Record<string, unknown>> {
      const hosted = (dependencies.hosted ?? hostedMode)();
      if (hosted && (input.kind === "sync" || input.kind === "embeddings" || input.kind === "import" && input.retryEmbeddingsOnly)) {
        throw new CatalogJobExecutionError("Hosted catalogs do not request local source sync or server embeddings.", "HOSTED_CATALOG_SYNC_DISABLED");
      }
      const model = dependencies.embeddingModel?.() || env("OLLAMA_EMBED_MODEL") || DEFAULT_RECIPE_EMBED_MODEL;
      const configuredTimeout = dependencies.embeddingTimeoutMs?.() ?? Number(env("OLLAMA_EMBED_TIMEOUT_MS"));
      const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 1_000 ? Math.min(configuredTimeout, 30_000) : 30_000;
      const interrupted = new Set<unknown>();
      const terminalWriteError = (error: unknown) => error instanceof Error && "code" in error
        && ["CATALOG_WRITE_GUARD_CHANGED", "CATALOG_JOB_RECIPE_CHANGED"].includes(String(error.code));
      async function checkpoint(progress?: CatalogJobProgress) {
        try {
          options.signal?.throwIfAborted();
          await options.checkpoint?.(progress);
          options.signal?.throwIfAborted();
        } catch (error) { interrupted.add(error); throw error; }
      }
      const embeddingOptions = { model, timeoutMs, batchSize: 8, admission: dependencies.admission, signal: options.signal, beforeBatch: () => checkpoint() };
      const dimensions = new Map<string, number>();
      async function embed(kind: "search" | "steps", recipes: Recipe[], existing: Iterable<StoredRecipeEmbedding>, sourceIds: string[], overrides: OllamaEmbeddingOptions = {}) {
        const persisted = new Set<string>();
        const key = (record: RecipeEmbeddingRecord) => JSON.stringify([record.recipeId, record.kind, record.chunkIndex ?? 0, record.model, record.contentHash]);
        async function persist(records: readonly RecipeEmbeddingRecord[]) {
          if (!records.length) return;
          await checkpoint();
          for (const record of records) {
            const expected = dimensions.get(kind);
            if (expected !== undefined && expected !== record.dimensions) throw new CatalogJobExecutionError("The embedding provider changed vector dimensions during this refresh.", "EMBEDDING_PROVIDER_FAILED", true);
            dimensions.set(kind, record.dimensions);
          }
          await catalog.saveEmbeddings(records);
          for (const record of records) persisted.add(key(record));
        }
        async function beforeBatch() {
          try {
            for (const sourceId of new Set(sourceIds)) await requireSource(sourceId);
          } catch (error) { interrupted.add(error); throw error; }
        }
        const provider = kind === "search" ? providers.precomputeRecipeEmbeddings : providers.precomputeRecipeStepEmbeddings;
        await beforeBatch();
        const result = await provider(recipes, existing, { ...embeddingOptions, ...overrides, beforeBatch, onBatchComplete: persist });
        await checkpoint();
        // Injected providers may return complete results without streaming batches.
        await persist(result.embeddings.filter(record => !persisted.has(key(record))));
        return result;
      }
      async function requireSource(source: ApprovedRecipeSourceInput | string, initialize = false) {
        await checkpoint();
        const sourceId = typeof source === "string" ? source : source.id;
        if (!await catalog.sourceEnabled(sourceId)) throw new CatalogJobExecutionError("This source has not been enabled for hosted distribution.", "SOURCE_DISABLED");
        let policy = await catalog.sourcePolicy(sourceId);
        // Initialization is insert-only at the repository boundary. Never use
        // a fixed approval to replace an operator's later restriction.
        if (!policy && initialize && typeof source !== "string") {
          await catalog.upsertSource(source);
          policy = await catalog.sourcePolicy(sourceId);
        }
        if (!policy || policy.approval_status !== "approved" || !policy.allow_display || !policy.allow_cache || !policy.allow_index_text || !policy.allow_embed) {
          throw new CatalogJobExecutionError("This source has been disabled or its permissions restricted.", "SOURCE_DISABLED");
        }
      }
      await checkpoint({ phase: "preparing" });
      await catalog.ensureReady();

      if (input.kind === "demo") {
        await requireSource(DEMO_SOURCE, true);
        for (let index = 0; index < DEMO_RECIPES.length; index++) {
          await requireSource(DEMO_SOURCE);
          const recipe = DEMO_RECIPES[index];
          const searchText = buildRecipeSearchText(recipe);
          await catalog.upsertRecipe({ sourceId: DEMO_SOURCE.id, recipe, searchText, contentHash: await sha256Hex(searchText) });
          await checkpoint({ phase: "saving", completed: index + 1, total: DEMO_RECIPES.length });
        }
        return { ok: true, count: DEMO_RECIPES.length };
      }

      if (input.kind === "embeddings") {
        const records = await catalog.list(1000, { forEmbedding: true });
        const searchExisting = await catalog.embeddings(model);
        const stepExisting = await catalog.embeddings(model, RECIPE_STEP_EMBEDDING_KIND);
        const summary = (): RecipeEmbeddingRunResult => ({ model, checkedCount: 0, skippedCount: 0, requestedCount: 0, completedCount: 0, dimension: null, embeddings: [], failures: [] });
        const embedded = summary(), steps = summary();
        const accumulate = (total: RecipeEmbeddingRunResult, part: RecipeEmbeddingRunResult) => {
          total.checkedCount += part.checkedCount; total.skippedCount += part.skippedCount;
          total.requestedCount += part.requestedCount; total.completedCount += part.completedCount;
          total.dimension ??= part.dimension; total.failures.push(...part.failures);
        };
        await checkpoint({ phase: "indexing", completed: 0, total: records.length });
        for (let offset = 0; offset < records.length; offset += 8) {
          const batch = records.slice(offset, offset + 8);
          const contentHashes = new Map(batch.map(item => [item.recipe.id, item.contentHash]));
          const recipes = batch.map(item => item.recipe);
          const sourceIds = batch.map(record => record.sourceId);
          const search = await embed("search", recipes, searchExisting, sourceIds, { contentHashes });
          accumulate(embedded, search);
          if (search.failures.length) throw new CatalogJobExecutionError("Some recipe search data could not be prepared. Saved recipes and completed results are retained; retry this update when the model is available.", "EMBEDDING_PROVIDER_FAILED", true);
          const step = await embed("steps", recipes, stepExisting, sourceIds, { contentHashes });
          accumulate(steps, step);
          if (step.failures.length) throw new CatalogJobExecutionError("Some recipe steps could not be prepared for search. Completed results are retained; retry this update when the model is available.", "EMBEDDING_PROVIDER_FAILED", true);
          await checkpoint({ phase: "indexing", completed: Math.min(offset + batch.length, records.length), total: records.length });
        }
        return { ok: true,
          embeddings: { model, checkedCount: embedded.checkedCount, skippedCount: embedded.skippedCount, requestedCount: embedded.requestedCount, completedCount: embedded.completedCount, failures: embedded.failures },
          stepEmbeddings: { ...steps, embeddings: undefined }, catalog: await catalog.status(model) };
      }

      if (input.kind === "import") {
        await requireSource(WIKIBOOKS_SOURCE, true);
        const results: { sourceUrl: string; status: string; catalogId?: string; version?: number; contentChanged?: boolean; embedding?: string; error?: string }[] = [];
        const seen = new Set<string>();
        const existingEmbeddings = hosted ? [] : await catalog.embeddings(model);
        const savedRecipes = input.retryEmbeddingsOnly ? await catalog.list(1000) : [];
        for (const raw of input.recipes) {
          await requireSource(WIKIBOOKS_SOURCE);
          let sourceUrl = raw && typeof raw === "object" && "sourceUrl" in raw && typeof raw.sourceUrl === "string" ? raw.sourceUrl : "";
          try {
            const draft = await validateImportDraft(raw);
            sourceUrl = draft.sourceUrl;
            if (seen.has(sourceUrl)) throw new Error("Duplicate source URL in this batch.");
            seen.add(sourceUrl);
            const recipe = await draftRecipe(draft);
            validateRecipeSnapshot(recipe);
            const searchText = buildRecipeSearchText(recipe);
            const contentHash = await sha256Hex(searchText);
            const id = catalogRecipeId("wikibooks", recipe.id);
            let stored;
            if (input.retryEmbeddingsOnly) {
              const current = savedRecipes.find(record => record.catalogId === id);
              if (!current || current.contentHash !== contentHash) throw new Error("Saved recipe differs from this draft. Collect and review the current version again.");
              stored = { catalogId: id, version: current.version, contentChanged: false };
            } else {
              stored = await catalog.upsertRecipe({ sourceId: "wikibooks", recipe, searchText, contentHash });
            }
            await checkpoint();
            // Saving reviewed text does not depend on an available model.
            let embedding = hosted ? "not_required" : "pending";
            if (!hosted) try {
              const embedded = await embed("search", [{ ...recipe, id }], existingEmbeddings, [WIKIBOOKS_SOURCE.id], { timeoutMs: Math.min(timeoutMs, 5_000) });
              embedding = embedded.failures.length ? "pending" : "ready";
            } catch (error) {
              if (interrupted.has(error) || error instanceof RuntimeAdmissionError || terminalWriteError(error)) throw error;
              // A later embedding job can retry without re-collecting text.
            }
            results.push({ sourceUrl, status: "saved", ...stored, embedding });
          } catch (error) {
            if (interrupted.has(error) || error instanceof RuntimeAdmissionError || terminalWriteError(error)) throw error;
            results.push({ sourceUrl, status: "failed", error: errorMessage(error) });
          }
          // Lease/cancellation errors must escape per-recipe error reporting.
          await checkpoint({ phase: "saving", completed: results.length, total: input.recipes.length });
          await requireSource(WIKIBOOKS_SOURCE);
        }
        return { ok: results.every(item => item.status === "saved"), results };
      }

      await requireSource(PROTOTYPE_SOURCE_APPROVAL, true);
      const syncRunId = await catalog.startSync(PROTOTYPE_SOURCE_APPROVAL.id);
      let recordsSeen = 0, recordsUpserted = 0;
      try {
        await checkpoint({ phase: "collecting" });
        const sourceRecipes = await providers.searchRecipes({ limit: 12 });
        await checkpoint();
        recordsSeen = sourceRecipes.length;
        const catalogRecipes = [];
        let changedRecipeCount = 0;
        for (const recipe of sourceRecipes) {
          await requireSource(PROTOTYPE_SOURCE_APPROVAL);
          const searchText = buildRecipeSearchText(recipe);
          const contentHash = await sha256Hex(searchText);
          const stored = await catalog.upsertRecipe({ sourceId: PROTOTYPE_SOURCE_APPROVAL.id, recipe, searchText, contentHash, syncRunId });
          recordsUpserted++;
          changedRecipeCount += Number(stored.contentChanged);
          catalogRecipes.push({ ...recipe, id: stored.catalogId });
          await checkpoint({ phase: "saving", completed: recordsUpserted, total: recordsSeen });
        }
        const embedded = await embed("search", catalogRecipes, await catalog.embeddings(model), [PROTOTYPE_SOURCE_APPROVAL.id]);
        if (embedded.failures.length) throw new CatalogJobExecutionError("Recipes were saved, but some search data could not be prepared. Completed results are retained; retry this update when the model is available.", "EMBEDDING_PROVIDER_FAILED", true);
        await catalog.finishSync(syncRunId, "succeeded", { recordsSeen, recordsUpserted });
        return { ok: embedded.failures.length === 0,
          import: { sourceId: PROTOTYPE_SOURCE_APPROVAL.id, syncRunId, recordsSeen, recordsUpserted, changedRecipeCount },
          embeddings: { model: embedded.model, checkedCount: embedded.checkedCount, skippedCount: embedded.skippedCount, requestedCount: embedded.requestedCount, completedCount: embedded.completedCount, dimensions: embedded.dimension, failures: embedded.failures },
          catalog: await catalog.status(model) };
      } catch (error) {
        try { await catalog.finishSync(syncRunId, "failed", { recordsSeen, recordsUpserted, errorMessage: errorMessage(error) }); }
        catch { /* Preserve the first error, including loss of the execution lease. */ }
        throw error;
      }
    },
  };
}

function env(name: string): string { return typeof process !== "undefined" ? process.env?.[name]?.trim() ?? "" : ""; }
