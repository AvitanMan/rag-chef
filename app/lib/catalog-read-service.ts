import type { ModelAdmission } from "./model-admission";
import { RuntimeAdmissionError } from "./runtime-admission-types";
import { compatibleServiceResponse, serviceRequestHeaders } from "./service-observability";
import { cancelProviderBody, readProviderText } from "./provider-response";
import { searchRecipeCatalog, type CatalogSearchDependencies, type CatalogSearchResult } from "./catalog-search";
import { embedTextsWithOllama } from "./recipe-embeddings";
import { hostedMode, householdSetting, initializeHouseholdRuntime } from "./household";
import type { RecipeSearchOptions } from "./recipe-types";
import * as store from "./recipe-store";

/** Catalog reads have no kitchen, ingestion or metadata mutation capability. */
export interface CatalogReadRepository {
  list: typeof store.listCatalogRecipes;
  embeddings: typeof store.listStoredRecipeEmbeddings;
  sourcePolicy: typeof store.getRecipeSourcePolicy;
  configured: typeof store.isRecipeCatalogConfigured;
}
export interface CatalogReadService extends CatalogReadRepository {
  search(options: RecipeSearchOptions, model: string): Promise<CatalogSearchResult>;
}

export function createCatalogReadService(repository: CatalogReadRepository, options: Partial<Pick<CatalogSearchDependencies, "embedTexts" | "semanticSearchEnabled">> = {}): CatalogReadService {
  return {
    list: (...args) => repository.list(...args),
    embeddings: (...args) => repository.embeddings(...args),
    sourcePolicy: (...args) => repository.sourcePolicy(...args),
    configured: () => repository.configured(),
    search: (query, model) => searchRecipeCatalog(query, model, {
      listRecipes: (...args) => repository.list(...args),
      listEmbeddings: (...args) => repository.embeddings(...args),
      embedTexts: options.embedTexts ?? embedTextsWithOllama,
      semanticSearchEnabled: options.semanticSearchEnabled ?? (() => !hostedMode()),
    }),
  };
}

/** Used inside the Catalog Worker and by explicitly injected source tests. */
const localRepository: CatalogReadRepository = {
  list: store.listCatalogRecipes, embeddings: store.listStoredRecipeEmbeddings,
  sourcePolicy: store.getRecipeSourcePolicy, configured: store.isRecipeCatalogConfigured,
};
export const localCatalogReadService = createCatalogReadService(localRepository);
/** Only the actual Worker composition supplies durable model admission. */
export function createRuntimeCatalogReadService(admission: ModelAdmission): CatalogReadService {
  return createCatalogReadService(localRepository, {
    embedTexts: (texts, options) => embedTextsWithOllama(texts, { ...options, admission }),
  });
}

export type CatalogReadMethod = keyof CatalogReadService;
/** Both Workers must agree on hosted distribution before any retrieval runs. */
export function catalogReadScope(): { hosted: boolean; sourceIds: string[] } {
  const hosted = hostedMode();
  const enabled = householdSetting("HOSTED_RECIPE_SOURCE_IDS").split(",").map(id => id.trim())
    .filter(id => /^[a-z0-9][a-z0-9_-]{0,99}$/.test(id));
  return { hosted, sourceIds: hosted ? [...new Set(["rag-chef-starters", ...enabled])].sort() : [] };
}

async function read<K extends CatalogReadMethod>(method: K, args: unknown[], signal?: AbortSignal): Promise<Awaited<ReturnType<CatalogReadService[K]>>> {
  await initializeHouseholdRuntime();
  let binding: Fetcher | undefined;
  let workerRuntime = false;
  try {
    const { env } = await import("cloudflare:workers");
    workerRuntime = true;
    binding = (env as unknown as { CATALOG?: Fetcher }).CATALOG;
  } catch { /* Dependency-injected Node tests can use the local read service. */ }
  if (!binding) {
    if (workerRuntime) throw new Error("The private Catalog service binding is unavailable.");
    const call = localCatalogReadService[method] as (...args: unknown[]) => Promise<Awaited<ReturnType<CatalogReadService[K]>>>;
    return call(...args);
  }
  // Query embedding retains its own 8-second provider limit. Leave time for
  // catalog reads, ranking and the service hop; the caller can abort sooner.
  const deadline = AbortSignal.timeout(30_000);
  const activeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const response = await binding.fetch("https://catalog.internal/read", {
    method: "POST", headers: { "content-type": "application/json", ...serviceRequestHeaders() }, body: JSON.stringify({ version: 1, method, args, scope: catalogReadScope() }),
    signal: activeSignal,
  });
  if (!compatibleServiceResponse(response)) {
    cancelProviderBody(response);
    throw new Error("The private Catalog service contract is incompatible with the application.");
  }
  const readResult = async () => JSON.parse(await readProviderText(response, activeSignal));
  if (!response.ok) {
    const result = await readResult().catch(() => { activeSignal.throwIfAborted(); return null; }) as { error?: { code?: string; message?: string; retryAfterSec?: number } } | null;
    const error = result?.error;
    if (error && ["service_busy", "usage_limit_exceeded", "runtime_policy_invalid"].includes(error.code ?? "")) {
      const retryAfter = Number(response.headers.get("Retry-After")) || error.retryAfterSec;
      throw new RuntimeAdmissionError(error.code as "service_busy" | "usage_limit_exceeded" | "runtime_policy_invalid", error.message || "The model service is busy.", response.status === 429 ? 429 : 503, retryAfter);
    }
    throw new Error("The recipe catalog is temporarily unavailable.");
  }
  return await readResult() as Awaited<ReturnType<CatalogReadService[K]>>;
}

/** Application-facing read port; the deployed app uses the private service binding. */
export const catalogReadService: CatalogReadService = {
  list: (...args) => read("list", args),
  embeddings: (...args) => read("embeddings", args),
  sourcePolicy: (...args) => read("sourcePolicy", args),
  configured: () => read("configured", []),
  search: (options, model) => { const { signal, ...query } = options; return read("search", [query, model], signal); },
};
