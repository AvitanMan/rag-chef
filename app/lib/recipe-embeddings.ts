import type { Recipe } from "./recipe-types";
import { normalizePlanningIngredient } from "./quantities";

export const DEFAULT_RECIPE_EMBED_MODEL = "nomic-embed-text";
export const DEFAULT_OLLAMA_EMBED_BASE_URL = "http://127.0.0.1:11434";
export const RECIPE_EMBEDDING_KIND = "recipe-search-v2";
export const RECIPE_STEP_EMBEDDING_KIND = "recipe-step-v1";

const DEFAULT_EMBED_BATCH_SIZE = 32;
const DEFAULT_EMBED_TIMEOUT_MS = 30_000;
const MAX_EMBED_BATCH_SIZE = 128;

export type RecipeEmbeddingRefreshReason =
  | "missing"
  | "content_changed"
  | "model_changed"
  | "format_changed"
  | "invalid_vector";

export type RecipeEmbeddingProviderErrorCode =
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_rejected"
  | "invalid_provider_response";

export interface StoredRecipeEmbedding {
  chunkIndex?: number;
  recipeId: string;
  contentHash: string;
  model: string;
  vector: unknown;
  kind?: string;
}

export interface PreparedRecipeEmbedding {
  recipe: Recipe;
  recipeId: string;
  searchText: string;
  contentHash: string;
  reason: RecipeEmbeddingRefreshReason;
}

export interface RecipeEmbeddingRefreshPlan {
  model: string;
  checkedCount: number;
  currentRecipeIds: string[];
  stale: PreparedRecipeEmbedding[];
}

export interface RecipeEmbeddingRecord {
  chunkIndex?: number;
  recipeId: string;
  contentHash: string;
  model: string;
  dimensions: number;
  vector: number[];
  embeddedAt: string;
  kind: string;
}

export interface RecipeEmbeddingFailure {
  recipeIds: string[];
  code: RecipeEmbeddingProviderErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
}

export interface RecipeEmbeddingRunResult {
  model: string;
  checkedCount: number;
  skippedCount: number;
  requestedCount: number;
  completedCount: number;
  dimension: number | null;
  embeddings: RecipeEmbeddingRecord[];
  failures: RecipeEmbeddingFailure[];
}

export interface TextEmbeddingResult {
  model: string;
  dimension: number | null;
  vectors: number[][];
}

export interface OllamaEmbeddingOptions {
  contentHashes?: ReadonlyMap<string, string>;
  signal?: AbortSignal;
  model?: string;
  baseUrl?: string;
  batchSize?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type ResolvedOllamaEmbeddingOptions = {
  signal?: AbortSignal;
  model: string;
  baseUrl: string;
  batchSize: number;
  timeoutMs: number;
  fetchImpl: typeof fetch;
};

export class RecipeEmbeddingProviderError extends Error {
  readonly code: RecipeEmbeddingProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    message: string,
    options: {
      code: RecipeEmbeddingProviderErrorCode;
      retryable: boolean;
      status?: number;
    },
  ) {
    super(message);
    this.name = "RecipeEmbeddingProviderError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

/**
 * Stable recipe-content representation. Keep this independent of the embedding
 * format: changing search must never invalidate an approved recipe or snapshot.
 */
export function buildRecipeSearchText(recipe: Recipe): string {
  const tags = [...new Set(recipe.tags.map(normalizeText).filter(Boolean))].sort(
    compareCodePoints,
  );
  const ingredients = recipe.ingredients.map((ingredient, index) => {
    const measure = normalizeText(ingredient.measure);
    const name = normalizeText(ingredient.name);
    return `${index + 1}. ${[measure, name].filter(Boolean).join(" ")}`;
  });
  const instructions = recipe.instructions.map(
    (instruction, index) => `${index + 1}. ${normalizeText(instruction)}`,
  );

  return [
    `Title: ${normalizeText(recipe.title)}`,
    `Category: ${normalizeText(recipe.category)}`,
    `Cuisine: ${normalizeText(recipe.cuisine)}`,
    ...(recipe.servings === undefined ? [] : [`Servings: ${recipe.servings}`]),
    `Tags: ${tags.join(", ")}`,
    "Ingredients:",
    ...ingredients,
    "Instructions:",
    ...instructions,
  ].join("\n");
}

export async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto is unavailable; recipe content cannot be hashed.");
  }

  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function recipeEmbeddingContentHash(recipe: Recipe): Promise<string> {
  return sha256Hex(buildRecipeSearchText(recipe));
}

export function buildRecipeEmbeddingText(recipe: Recipe): string {
  const ingredients = recipe.ingredients.map((item) => normalizeText(normalizePlanningIngredient(item).name));
  return `search_document: ${[
    `Title: ${normalizeText(recipe.title)}`,
    `Category: ${normalizeText(recipe.category)}`,
    `Cuisine: ${normalizeText(recipe.cuisine)}`,
    `Ingredients: ${ingredients.join("; ")}`,
    `Tags: ${[...new Set(recipe.tags.map(normalizeText).filter(Boolean))].sort(compareCodePoints).join(", ")}`,
    ...(recipe.servings === undefined ? [] : [`Servings: ${recipe.servings}`]),
  ].join("\n")}`;
}

export function buildRecipeQueryText(query: string, pantry: string[]): string {
  return `search_query: ${normalizeText(query)}${pantry.length ? `\nAvailable ingredients: ${pantry.map(normalizeText).filter(Boolean).join(", ")}` : ""}`;
}

export function isValidEmbeddingVector(
  value: unknown,
  expectedDimension?: number,
): value is number[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (
    expectedDimension !== undefined &&
    (!Number.isInteger(expectedDimension) ||
      expectedDimension <= 0 ||
      value.length !== expectedDimension)
  ) {
    return false;
  }

  let squaredNorm = 0;
  for (const component of value) {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      return false;
    }
    squaredNorm += component * component;
  }

  return squaredNorm > 0 && Number.isFinite(squaredNorm);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (!isValidEmbeddingVector(left)) {
    throw new TypeError("left must be a finite, non-zero embedding vector.");
  }
  if (!isValidEmbeddingVector(right, left.length)) {
    throw new TypeError(
      "right must be a finite, non-zero embedding vector with matching dimensions.",
    );
  }

  const leftNorm = vectorNorm(left);
  const rightNorm = vectorNorm(right);
  let normalizedDotProduct = 0;
  for (let index = 0; index < left.length; index += 1) {
    normalizedDotProduct +=
      (left[index] / leftNorm) * (right[index] / rightNorm);
  }

  if (!Number.isFinite(normalizedDotProduct)) {
    throw new TypeError("Embedding vectors produced a non-finite similarity.");
  }
  return Math.max(-1, Math.min(1, normalizedDotProduct));
}

/**
 * Hashes recipes and selects only missing, changed, model-mismatched, or
 * invalid stored embeddings. A valid matching vector is never re-requested.
 */
export async function planRecipeEmbeddingRefresh(
  recipes: readonly Recipe[],
  existing: Iterable<StoredRecipeEmbedding> = [],
  options: Pick<OllamaEmbeddingOptions, "model" | "contentHashes"> = {},
): Promise<RecipeEmbeddingRefreshPlan> {
  const model = resolveModel(options.model);
  const existingByRecipe = indexExistingEmbeddings(existing);
  const seenRecipeIds = new Set<string>();
  const currentRecipeIds: string[] = [];
  const stale: PreparedRecipeEmbedding[] = [];

  for (const recipe of recipes) {
    if (seenRecipeIds.has(recipe.id)) {
      throw new TypeError(`Duplicate recipe id "${recipe.id}" cannot be embedded.`);
    }
    seenRecipeIds.add(recipe.id);

    const searchText = buildRecipeEmbeddingText(recipe);
    const contentHash = options.contentHashes?.get(recipe.id) ?? await recipeEmbeddingContentHash(recipe);
    const records = existingByRecipe.get(recipe.id) ?? [];
    const matchingModel = records.find((record) => record.model === model);
    const reason = refreshReason(records, matchingModel, contentHash);

    if (reason) {
      stale.push({ recipe, recipeId: recipe.id, searchText, contentHash, reason });
    } else {
      currentRecipeIds.push(recipe.id);
    }
  }

  return {
    model,
    checkedCount: recipes.length,
    currentRecipeIds,
    stale,
  };
}

/**
 * Embeds text in bounded sequential batches. Any provider or response problem
 * rejects with RecipeEmbeddingProviderError; no placeholder vectors are made.
 */
export async function embedTextsWithOllama(
  texts: readonly string[],
  options: OllamaEmbeddingOptions = {},
): Promise<TextEmbeddingResult> {
  const resolved = resolveOptions(options);
  const preparedTexts = texts.map((text, index) => {
    const prepared = text.trim();
    if (!prepared) {
      throw new TypeError(`texts[${index}] must not be empty.`);
    }
    return prepared;
  });
  const vectors: number[][] = [];
  let dimension: number | null = null;

  for (let offset = 0; offset < preparedTexts.length; offset += resolved.batchSize) {
    const batch = preparedTexts.slice(offset, offset + resolved.batchSize);
    const embedded = await requestOllamaBatch(batch, resolved, dimension);
    dimension ??= embedded.dimension;
    vectors.push(...embedded.vectors);
  }

  return { model: resolved.model, dimension, vectors };
}

/**
 * Plans and executes stale-only recipe embedding. Successful earlier batches
 * are returned if a later batch fails, together with a structured failure for
 * every recipe left unembedded.
 */
export async function precomputeRecipeEmbeddings(
  recipes: readonly Recipe[],
  existing: Iterable<StoredRecipeEmbedding> = [],
  options: OllamaEmbeddingOptions = {},
): Promise<RecipeEmbeddingRunResult> {
  const resolved = resolveOptions(options);
  const plan = await planRecipeEmbeddingRefresh(recipes, existing, {
    model: resolved.model,
    contentHashes: options.contentHashes,
  });
  const embeddings: RecipeEmbeddingRecord[] = [];
  const failures: RecipeEmbeddingFailure[] = [];
  let dimension: number | null = null;

  for (let offset = 0; offset < plan.stale.length; offset += resolved.batchSize) {
    const batch = plan.stale.slice(offset, offset + resolved.batchSize);

    try {
      const embedded = await requestOllamaBatch(
        batch.map((item) => item.searchText),
        resolved,
        dimension,
      );
      dimension ??= embedded.dimension;
      const embeddedAt = new Date().toISOString();
      embedded.vectors.forEach((vector, index) => {
        const item = batch[index];
        embeddings.push({
          recipeId: item.recipeId,
          contentHash: item.contentHash,
          model: resolved.model,
          dimensions: vector.length,
          vector,
          embeddedAt,
          kind: RECIPE_EMBEDDING_KIND,
        });
      });
    } catch (error) {
      const providerError = normalizeProviderError(error);
      failures.push({
        recipeIds: plan.stale.slice(offset).map((item) => item.recipeId),
        code: providerError.code,
        message: providerError.message,
        retryable: providerError.retryable,
        ...(providerError.status !== undefined
          ? { status: providerError.status }
          : {}),
      });
      break;
    }
  }

  return {
    model: resolved.model,
    checkedCount: plan.checkedCount,
    skippedCount: plan.currentRecipeIds.length,
    requestedCount: plan.stale.length,
    completedCount: embeddings.length,
    dimension,
    embeddings,
    failures,
  };
}

/** Whole source steps, independently refreshable without rewriting recipes. */
export function buildRecipeStepText(recipe: Recipe, index: number): string {
  return `search_document: Title: ${recipe.title}\nSource step ${index + 1}: ${recipe.instructions[index]}`;
}
export async function precomputeRecipeStepEmbeddings(recipes: readonly Recipe[], existing: Iterable<StoredRecipeEmbedding> = [], options: OllamaEmbeddingOptions = {}): Promise<RecipeEmbeddingRunResult> {
  const resolved = resolveOptions(options);
  const previous = new Map([...existing].map((record) => [`${record.recipeId}:${record.chunkIndex ?? 0}:${record.model}`, record]));
  const stale: Array<{ recipe: Recipe; chunkIndex: number; contentHash: string }> = [];
  let checkedCount = 0;
  for (const recipe of recipes) {
    const contentHash = options.contentHashes?.get(recipe.id) ?? await recipeEmbeddingContentHash(recipe);
    recipe.instructions.forEach((_, chunkIndex) => {
      checkedCount++;
      const record = previous.get(`${recipe.id}:${chunkIndex}:${resolved.model}`);
      if (!record || record.kind !== RECIPE_STEP_EMBEDDING_KIND || record.contentHash !== contentHash || !isValidEmbeddingVector(record.vector)) stale.push({ recipe, chunkIndex, contentHash });
    });
  }
  const embeddings: RecipeEmbeddingRecord[] = [], failures: RecipeEmbeddingFailure[] = [];
  let dimension: number | null = null;
  for (let offset = 0; offset < stale.length; offset += resolved.batchSize) {
    const batch = stale.slice(offset, offset + resolved.batchSize);
    try {
      const result = await requestOllamaBatch(batch.map((item) => buildRecipeStepText(item.recipe, item.chunkIndex)), resolved, dimension);
      dimension ??= result.dimension;
      result.vectors.forEach((vector, index) => embeddings.push({ recipeId: batch[index].recipe.id, chunkIndex: batch[index].chunkIndex,
        contentHash: batch[index].contentHash, model: resolved.model, kind: RECIPE_STEP_EMBEDDING_KIND, dimensions: vector.length, vector, embeddedAt: new Date().toISOString() }));
    } catch (error) {
      const problem = normalizeProviderError(error);
      failures.push({ recipeIds: [...new Set(stale.slice(offset).map((item) => item.recipe.id))], code: problem.code, message: problem.message, retryable: problem.retryable });
      break;
    }
  }
  return { model: resolved.model, checkedCount, skippedCount: checkedCount - stale.length, requestedCount: stale.length, completedCount: embeddings.length, dimension, embeddings, failures };
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function vectorNorm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, component) => sum + component * component, 0));
}

function resolveModel(value?: string): string {
  return value?.trim() || env("OLLAMA_EMBED_MODEL") || DEFAULT_RECIPE_EMBED_MODEL;
}

function resolveOptions(
  options: OllamaEmbeddingOptions,
): ResolvedOllamaEmbeddingOptions {
  const baseUrl = (
    options.baseUrl?.trim() ||
    env("OLLAMA_BASE_URL") ||
    DEFAULT_OLLAMA_EMBED_BASE_URL
  ).replace(/\/+$/, "");
  assertHttpUrl(baseUrl);

  const batchSize = options.batchSize ?? DEFAULT_EMBED_BATCH_SIZE;
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_EMBED_BATCH_SIZE
  ) {
    throw new RangeError(
      `batchSize must be an integer from 1 to ${MAX_EMBED_BATCH_SIZE}.`,
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number.");
  }

  return {
    signal: options.signal,
    model: resolveModel(options.model),
    baseUrl,
    batchSize,
    timeoutMs,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
  };
}

function assertHttpUrl(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new TypeError("Embedding provider baseUrl must be an HTTP(S) URL.");
  }
}

function env(name: string): string {
  const value =
    typeof process !== "undefined" && process.env ? process.env[name] : undefined;
  return value?.trim() ?? "";
}

function indexExistingEmbeddings(
  existing: Iterable<StoredRecipeEmbedding>,
): Map<string, StoredRecipeEmbedding[]> {
  const indexed = new Map<string, StoredRecipeEmbedding[]>();
  for (const record of existing) {
    const records = indexed.get(record.recipeId) ?? [];
    records.push(record);
    indexed.set(record.recipeId, records);
  }
  return indexed;
}

function refreshReason(
  records: StoredRecipeEmbedding[],
  matchingModel: StoredRecipeEmbedding | undefined,
  contentHash: string,
): RecipeEmbeddingRefreshReason | null {
  if (records.length === 0) return "missing";
  if (!matchingModel) return "model_changed";
  if (matchingModel.kind !== RECIPE_EMBEDDING_KIND) return "format_changed";
  if (matchingModel.contentHash !== contentHash) return "content_changed";
  if (!isValidEmbeddingVector(matchingModel.vector)) return "invalid_vector";
  return null;
}

async function requestOllamaBatch(
  texts: string[],
  options: ResolvedOllamaEmbeddingOptions,
  expectedDimension: number | null,
): Promise<{ vectors: number[][]; dimension: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await options.fetchImpl(`${options.baseUrl}/api/embed`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        input: texts,
        truncate: false,
      }),
      signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
    });

    if (!response.ok) {
      throw new RecipeEmbeddingProviderError(
        `Embedding provider returned HTTP ${response.status}.`,
        {
          code: "provider_rejected",
          status: response.status,
          retryable:
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
        },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      invalidProviderResponse("Embedding provider returned malformed JSON.");
    }
    if (!isRecord(payload) || !Array.isArray(payload.embeddings)) {
      invalidProviderResponse("Embedding provider response has no embeddings array.");
    }
    if (payload.embeddings.length !== texts.length) {
      invalidProviderResponse(
        `Embedding provider returned ${payload.embeddings.length} vectors for ${texts.length} inputs.`,
      );
    }

    const vectors: number[][] = [];
    let dimension = expectedDimension;
    for (const value of payload.embeddings) {
      if (!isValidEmbeddingVector(value, dimension ?? undefined)) {
        invalidProviderResponse(
          dimension === null
            ? "Embedding provider returned an invalid vector."
            : "Embedding provider returned an invalid or inconsistent vector.",
        );
      }
      const vector = [...value];
      dimension ??= vector.length;
      vectors.push(vector);
    }

    if (dimension === null) {
      invalidProviderResponse("Embedding provider returned an empty batch.");
    }
    return { vectors, dimension };
  } catch (error) {
    if (error instanceof RecipeEmbeddingProviderError) throw error;
    if (controller.signal.aborted) {
      throw new RecipeEmbeddingProviderError(
        `Embedding provider timed out after ${options.timeoutMs} ms.`,
        { code: "provider_timeout", retryable: true },
      );
    }
    throw new RecipeEmbeddingProviderError("Embedding provider is unavailable.", {
      code: "provider_unavailable",
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeProviderError(error: unknown): RecipeEmbeddingProviderError {
  if (error instanceof RecipeEmbeddingProviderError) return error;
  return new RecipeEmbeddingProviderError("Embedding provider failed.", {
    code: "provider_unavailable",
    retryable: true,
  });
}

function invalidProviderResponse(message: string): never {
  throw new RecipeEmbeddingProviderError(message, {
    code: "invalid_provider_response",
    retryable: true,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
