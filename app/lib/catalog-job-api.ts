import { enqueueCatalogJob, CatalogJobAccessError, CatalogJobRequestError, CatalogJobReuseError } from "./catalog-job-store";
import type { CatalogJob, CatalogJobInput } from "./catalog-job-types";
import { hostedMode, requireIdentity, HouseholdAuthError, householdError } from "./household";
import { recordServiceEvent } from "./service-observability";
import { cancelProviderBody } from "./provider-response";

export const catalogJobJson = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export const catalogJobResponse = (job: CatalogJob, status = 200) => catalogJobJson({ ok: true, job, statusUrl: `/api/admin/catalog/jobs/${job.id}` }, status);
export async function catalogJobActor(request: Request) {
  return hostedMode() ? { actorId: (await requireIdentity(request)).user.id, actorMode: "hosted" as const } : { actorId: "local-admin", actorMode: "local" as const };
}
export function catalogJobError(error: unknown): Response {
  if (error instanceof HouseholdAuthError) return householdError(error);
  const known = error instanceof CatalogJobAccessError || error instanceof CatalogJobRequestError || error instanceof CatalogJobReuseError;
  return catalogJobJson({ ok: false, error: { code: known ? error.code : "CATALOG_UNAVAILABLE", message: known ? error.message : "Catalog storage is unavailable. Apply database migrations and retry with the same request ID." } }, known ? error.status : 503);
}
/** Persist first. Queue delivery is a wake-up; cron recovers a lost publication. */
export async function submitCatalogJob(request: Request, input: CatalogJobInput): Promise<Response> {
  try {
    const actor = await catalogJobActor(request);
    const requestId = request.headers.get("Idempotency-Key") ?? crypto.randomUUID();
    const { job } = await enqueueCatalogJob({ ...actor, requestId, input });
    recordServiceEvent({ operation: "catalog.job.accepted", status: 202, durationMs: 0, jobId: job.id });
    if (job.status === "queued") {
      try {
        const { env } = await import("cloudflare:workers");
        await (env as unknown as { CATALOG_TASKS?: Queue<{ jobId: string }> }).CATALOG_TASKS?.send({ jobId: job.id });
      } catch { /* The durable row remains discoverable by scheduled recovery. */ }
    }
    return catalogJobResponse(job, 202);
  } catch (error) { return catalogJobError(error); }
}

export class CatalogBodyTooLargeError extends Error {}
export async function catalogRequestText(request: Request, maximum: number): Promise<string> {
  if (Number(request.headers.get("content-length")) > maximum) { cancelProviderBody(request); throw new CatalogBodyTooLargeError(); }
  if (request.signal.aborted) cancelProviderBody(request);
  request.signal.throwIfAborted();
  const reader = request.body?.getReader();
  if (!reader) return "";
  const cancel = () => { void reader.cancel(request.signal.reason).catch(() => {}); };
  request.signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let size = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const { done, value } = await reader.read();
      request.signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new CatalogBodyTooLargeError();
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) { void reader.cancel(error).catch(() => {}); throw error; }
  finally { request.signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}
