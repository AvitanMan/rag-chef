import { createRuntimeModelAdmission } from "./runtime-model-admission";
import { RuntimeAdmissionError } from "./runtime-admission-types";
import { withJobTrace, recordServiceEvent } from "./service-observability";
import { catalogService } from "./catalog-service";
import { CatalogJobExecutionError, createCatalogJobExecutor } from "./catalog-job-executor";
import { CatalogJobLeaseLostError, claimCatalogJob, completeCatalogJob, failCatalogJob, heartbeatCatalogJob } from "./catalog-job-store";

/** Only the Catalog Worker's queue/cron entry points call this runner in production. */
export async function drainCatalogJobs(options: { jobId?: string; limit?: number } = {}): Promise<{ processed: number }> {
  let processed = 0;
  const limit = Math.max(1, Math.min(options.limit ?? 1, 5));
  for (let index = 0; index < limit; index++) {
    const lease = await claimCatalogJob(options.jobId);
    if (!lease) break;
    processed++;
    await withJobTrace(lease.id, async () => {
      const started = performance.now();
      let status = 200;
      const fence = lease.fence;
      const executor = createCatalogJobExecutor({ admission: createRuntimeModelAdmission(), catalog: {
        ...catalogService,
        upsertSource: source => catalogService.upsertSource(source, fence),
        startSync: sourceId => catalogService.startSync(sourceId, fence),
        finishSync: (id, status, result) => catalogService.finishSync(id, status, result, fence),
        upsertRecipe: input => catalogService.upsertRecipe({ ...input, jobFence: fence }),
        saveEmbeddings: records => catalogService.saveEmbeddings(records, fence),
      } });
      try {
        const result = await executor.execute(lease.input, {
          signal: AbortSignal.timeout(12 * 60_000),
          checkpoint: progress => heartbeatCatalogJob(fence, progress),
        });
        await completeCatalogJob(fence, result);
      } catch (error) {
        // A replacement worker owns recovery after lease loss; this attempt must
        // never change the replacement's status or persisted catalog content.
        if (error instanceof CatalogJobLeaseLostError) { status = 409; return; }
        const admission = error instanceof RuntimeAdmissionError;
        status = admission ? error.status : 503;
        const known = error instanceof CatalogJobExecutionError;
        const guarded = error instanceof Error && "code" in error
          && (error.code === "CATALOG_WRITE_GUARD_CHANGED" || error.code === "CATALOG_JOB_RECIPE_CHANGED");
        try {
          const failed = await failCatalogJob(fence, {
            code: admission ? error.code : known ? error.code : guarded ? String(error.code) : "CATALOG_JOB_FAILED",
            message: admission ? error.message : known ? error.message : guarded ? "Source permissions, recipe content, or job ownership changed. Review the catalog before retrying." : "Catalog processing was interrupted. Completed work is retained; retrying when possible.",
          }, admission ? error.code === "service_busy" : known ? error.retryable : !guarded, admission ? Math.min(error.retryAfterSec ?? 0, 86_400) * 1_000 : 0);
          if (failed.status === "queued") {
            try {
              const { env } = await import("cloudflare:workers");
              await (env as unknown as { CATALOG_TASKS?: Queue<{ jobId: string }> }).CATALOG_TASKS?.send({ jobId: failed.id }, { delaySeconds: Math.max(1, Math.ceil((failed.availableAt - Date.now()) / 1_000)) });
            } catch { /* Scheduled recovery also finds every due retry. */ }
          }
        } catch (failure) {
          if (!(failure instanceof CatalogJobLeaseLostError)) throw failure;
        }
      } finally {
        recordServiceEvent({ operation: "catalog.job.run", status, durationMs: performance.now() - started, jobId: lease.id, attempt: lease.attempts });
      }
    });
  }
  return { processed };
}
