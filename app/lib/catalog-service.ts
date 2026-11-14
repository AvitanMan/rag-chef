import { searchRecipeCatalog, type CatalogSearchResult, type CatalogSearchDependencies } from "./catalog-search";
import { embedTextsWithOllama } from "./recipe-embeddings";
import { hostedMode } from "./household";
import type { RecipeSearchOptions } from "./recipe-types";
import * as store from "./recipe-store";

/** Storage owns source permissions and immutable source/version identities. */
export interface CatalogRepository {
  list: typeof store.listCatalogRecipes;
  embeddings: typeof store.listStoredRecipeEmbeddings;
  sourcePolicy: typeof store.getRecipeSourcePolicy;
  configured: typeof store.isRecipeCatalogConfigured;
  sourceEnabled: typeof store.isRecipeSourceEnabled;
  ensureReady: typeof store.ensureRecipeCatalogSchema;
  upsertSource: typeof store.upsertApprovedRecipeSource;
  startSync: typeof store.startCatalogSync;
  finishSync: typeof store.finishCatalogSync;
  upsertRecipe: typeof store.upsertCatalogRecipe;
  saveEmbeddings: typeof store.saveRecipeEmbeddings;
  status: typeof store.getCatalogStatus;
  reviewMetadata: typeof store.reviewRecipeMetadata;
}

/** Repository-local search port; application retrieval uses catalog-read-service. */
export interface CatalogReadService extends Pick<CatalogRepository, "list" | "embeddings" | "sourcePolicy"> {
  search(options: RecipeSearchOptions, embedModel: string): Promise<CatalogSearchResult>;
}

export interface CatalogService extends CatalogRepository, CatalogReadService {}

export function createCatalogService(repository: CatalogRepository, options: Partial<Pick<CatalogSearchDependencies, "embedTexts" | "semanticSearchEnabled">> = {}): CatalogService {
  const searchDependencies: CatalogSearchDependencies = {
    listRecipes: (...args) => repository.list(...args),
    listEmbeddings: (...args) => repository.embeddings(...args),
    embedTexts: options.embedTexts ?? embedTextsWithOllama,
    semanticSearchEnabled: options.semanticSearchEnabled ?? (() => !hostedMode()),
  };
  return {
    search: (query, model) => searchRecipeCatalog(query, model, searchDependencies),
    list: (...args) => repository.list(...args),
    embeddings: (...args) => repository.embeddings(...args),
    sourcePolicy: (...args) => repository.sourcePolicy(...args),
    configured: () => repository.configured(),
    sourceEnabled: (...args) => repository.sourceEnabled(...args),
    ensureReady: () => repository.ensureReady(),
    upsertSource: (...args) => repository.upsertSource(...args),
    startSync: (...args) => repository.startSync(...args),
    finishSync: (...args) => repository.finishSync(...args),
    upsertRecipe: (...args) => repository.upsertRecipe(...args),
    saveEmbeddings: (...args) => repository.saveEmbeddings(...args),
    status: (...args) => repository.status(...args),
    reviewMetadata: (...args) => repository.reviewMetadata(...args),
  };
}

/** Local administration/job adapter. Public retrieval uses the private Catalog binding. */
export const catalogService = createCatalogService({
  list: store.listCatalogRecipes,
  embeddings: store.listStoredRecipeEmbeddings,
  sourcePolicy: store.getRecipeSourcePolicy,
  configured: store.isRecipeCatalogConfigured,
  sourceEnabled: store.isRecipeSourceEnabled,
  ensureReady: store.ensureRecipeCatalogSchema,
  upsertSource: store.upsertApprovedRecipeSource,
  startSync: store.startCatalogSync,
  finishSync: store.finishCatalogSync,
  upsertRecipe: store.upsertCatalogRecipe,
  saveEmbeddings: store.saveRecipeEmbeddings,
  status: store.getCatalogStatus,
  reviewMetadata: store.reviewRecipeMetadata,
});

export { catalogRecipeId, type ApprovedRecipeSourceInput } from "./recipe-store";
