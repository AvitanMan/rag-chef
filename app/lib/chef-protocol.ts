import { catalogReadScope } from "./catalog-read-service";
import { ChefServiceError } from "./chef-errors";
import { ChefValidationError } from "./chef-schema";
import { RuntimeAdmissionError } from "./runtime-admission-types";
import { cancelProviderBody } from "./provider-response";
import { householdError, HouseholdAuthError, localHousehold, type HouseholdContext } from "./household";

export type ChefOperation = "answer" | "health";
export interface ChefHealthQuery { provider: string | null; model: string }
export interface ChefEnvelope {
  version: 1;
  scope: ReturnType<typeof catalogReadScope>;
  household: HouseholdContext;
  /** Raw public JSON: normalization is not idempotent for optional equipment. */
  input?: unknown;
  query?: ChefHealthQuery;
}
export const MAX_CHEF_REQUEST_BYTES = 1_500_000;
const MAX_CHEF_ENVELOPE_BYTES = MAX_CHEF_REQUEST_BYTES + 100_000;

export function chefOperationTimeoutMs(operation: ChefOperation): number {
  // Covers up to two configured five-minute generations, verification, and
  // sequential Catalog/step-evidence calls. Individual provider limits remain.
  return operation === "answer" ? 20 * 60_000 : 15_000;
}
export const chefJson = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export function chefJsonError(status: number, code: string, message: string, details: Record<string, unknown> = {}): Response {
  return chefJson({ error: { code, message }, ...details }, status);
}
export function chefErrorResponse(error: unknown, signal?: AbortSignal): Response {
  if (signal?.aborted) {
    return signal.reason instanceof Error && signal.reason.name === "TimeoutError"
      ? chefJsonError(504, "chef_timeout", "Chef took too long to answer. Retry when it is running; your kitchen is unchanged.")
      : chefJsonError(499, "cancelled", "Request cancelled.");
  }
  if (error instanceof HouseholdAuthError) return householdError(error);
  if (error instanceof RuntimeAdmissionError) {
    const response = chefJsonError(error.status, error.code, error.message);
    if (error.retryAfterSec !== undefined) response.headers.set("Retry-After", String(error.retryAfterSec));
    return response;
  }
  if (error instanceof ChefServiceError) return chefJsonError(error.status, error.code, error.message, error.details);
  if (error instanceof ChefValidationError) return chefJsonError(400, "invalid_request", error.message);
  if (error instanceof Error && error.name === "AbortError") return chefJsonError(499, "cancelled", "Request cancelled.");
  if (error instanceof Error && error.name === "TimeoutError") return chefJsonError(504, "chef_timeout", "Chef took too long to answer. Retry when it is running; your kitchen is unchanged.");
  return chefJsonError(503, "chef_unavailable", "Chef could not answer right now. Retry when it is running; your kitchen is unchanged.");
}

export async function readChefBody(request: Pick<Request, "headers" | "signal" | "body">, maximum = MAX_CHEF_REQUEST_BYTES): Promise<string> {
  const tooLarge = () => new ChefServiceError(413, "request_too_large", "Request body is too large.");
  if (Number(request.headers.get("content-length")) > maximum) { cancelProviderBody(request); throw tooLarge(); }
  if (request.signal.aborted) cancelProviderBody(request);
  request.signal.throwIfAborted();
  const reader = request.body?.getReader();
  if (!reader) return "";
  const cancel = () => { void reader.cancel(request.signal.reason).catch(() => {}); };
  request.signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", bytes = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const chunk = await reader.read();
      request.signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) throw tooLarge();
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    // Invalid UTF-8 and size errors can arrive before the producer closes.
    // Cancel every rejected stream, without waiting for its cleanup promise.
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally { request.signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

/** Private binding protocol. Public JSON can never select its household. */
export async function readChefEnvelope(request: Request): Promise<ChefEnvelope> {
  let value: unknown;
  try { value = JSON.parse(await readChefBody(request, MAX_CHEF_ENVELOPE_BYTES)); }
  catch (error) {
    if (error instanceof ChefServiceError || request.signal.aborted) throw error;
    throw new ChefServiceError(400, "invalid_json", "Request body must be valid JSON.");
  }
  const invalid = () => new ChefServiceError(400, "invalid_chef_envelope", "Invalid private Chef request.");
  if (!record(value) || value.version !== 1 || !record(value.scope) || !record(value.household)) throw invalid();
  const operation = new URL(request.url).pathname === "/health" ? "health" : "answer";
  const dataKey = operation === "health" ? "query" : "input";
  if (!Object.hasOwn(value, dataKey) || Object.keys(value).some(key => !["version", "scope", "household", dataKey].includes(key))) throw invalid();
  const actual = catalogReadScope();
  if (Object.keys(value.scope).some(key => !["hosted", "sourceIds"].includes(key))
    || value.scope.hosted !== actual.hosted || !Array.isArray(value.scope.sourceIds)
    || value.scope.sourceIds.length !== actual.sourceIds.length || value.scope.sourceIds.some((id, index) => id !== actual.sourceIds[index])) {
    throw new ChefServiceError(503, "chef_configuration_mismatch", "Chef and the application must use the same hosted and source settings.");
  }
  const household = value.household;
  if (Object.keys(household).some(key => !["mode", "userId", "householdId", "role", "timezone", "assistantEnabled", "sessionId"].includes(key))
    || household.mode !== (actual.hosted ? "hosted" : "local")
    || !["owner", "member"].includes(String(household.role)) || typeof household.assistantEnabled !== "boolean"
    || ![household.userId, household.householdId, household.timezone].every(identifier)
    || (actual.hosted ? !identifier(household.sessionId) : household.sessionId !== undefined)) throw invalid();
  if (!actual.hosted) {
    const local = localHousehold();
    if (Object.entries(local).some(([key, expected]) => household[key] !== expected)) throw invalid();
  }
  if (operation === "health" && (!record(value.query) || Object.keys(value.query).some(key => !["provider", "model"].includes(key))
    || value.query.provider !== null && typeof value.query.provider !== "string" || typeof value.query.model !== "string")) throw invalid();
  return value as unknown as ChefEnvelope;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function identifier(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value); }
