import type { CatalogJob } from "./catalog-job-types";

export interface CatalogJobResponse { ok: boolean; job: CatalogJob; statusUrl: string }
export class CatalogJobFailedError extends Error {
  constructor(message: string) { super(message); this.name = "CatalogJobFailedError"; }
}

export function catalogJobStatusPath(value: unknown): string {
  if (typeof value !== "string" || !/^\/api\/admin\/catalog\/jobs\/[a-zA-Z0-9-]{1,200}$/.test(value)) throw new Error("The catalog returned an invalid progress link.");
  return value;
}

/** Polling reads status only; the background worker owns all recipe changes. */
export async function waitForCatalogJob(fetcher: typeof fetch, statusUrl: string, signal: AbortSignal): Promise<CatalogJob> {
  const path = catalogJobStatusPath(statusUrl);
  while (true) {
    signal.throwIfAborted();
    const response = await fetcher(path, { cache: "no-store", redirect: "error", signal });
    const result = await response.json() as Partial<CatalogJobResponse> & { error?: string | { message?: string } };
    if (!response.ok || !result.job) throw new Error(typeof result.error === "string" ? result.error : result.error?.message || "Recipe progress could not be checked. Retry to reconnect.");
    if (result.job.status === "succeeded") return result.job;
    if (result.job.status === "failed") throw new CatalogJobFailedError(result.job.error?.message || "The recipes could not be saved. Retry to finish adding them.");
    if (!["queued", "running"].includes(result.job.status)) throw new Error("The catalog returned an invalid progress status.");
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1_000);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}
