import { catalogReadScope, createRuntimeCatalogReadService } from "../app/lib/catalog-read-service";
import { drainCatalogJobs } from "../app/lib/catalog-job-runner";
import { configureHouseholdRuntime } from "../app/lib/household";
import { createRuntimeModelAdmission } from "../app/lib/runtime-model-admission";
import { RuntimeAdmissionError } from "../app/lib/runtime-admission-types";
import { requestedControlsSupported, withInternalTrace } from "../app/lib/service-observability";
import { serviceReadiness } from "../app/lib/service-readiness";

const readService = createRuntimeCatalogReadService(createRuntimeModelAdmission());

const optionalText = (value: unknown) => value == null || typeof value === "string" && value.length <= 500;
function validReadArgs(method: string, args: unknown[]): boolean {
  switch (method) {
    case "configured": return args.length === 0;
    case "list": return args.length <= 2
      && (args[0] == null || typeof args[0] === "number" && Number.isFinite(args[0]))
      && (args[1] == null || typeof args[1] === "object" && !Array.isArray(args[1])
        && Object.entries(args[1]).every(([key, value]) => key === "forEmbedding" && typeof value === "boolean"));
    case "embeddings": return args.length <= 3 && args.every(optionalText);
    case "sourcePolicy": return args.length === 1 && typeof args[0] === "string" && args[0].length > 0 && args[0].length <= 200;
    case "search": return args.length === 2 && Boolean(args[0]) && typeof args[0] === "object" && !Array.isArray(args[0])
      && typeof args[1] === "string" && args[1].length > 0 && args[1].length <= 500;
    default: return false;
  }
}

/** Private service binding only: the application gateway authenticates callers. */
const catalogWorker = {
  async fetch(request: Request, env: object): Promise<Response> {
    configureHouseholdRuntime(env);
    return withInternalTrace("catalog", new URL(request.url).pathname === "/ready" ? "services.ready" : "catalog.read", request, async () => {
      if (!requestedControlsSupported(request)) return Response.json({ error: "Catalog runtime controls are incompatible." }, { status: 503 });
      if (request.method === "GET" && new URL(request.url).pathname === "/ready") return serviceReadiness("catalog", env);
      if (request.method !== "POST" || new URL(request.url).pathname !== "/read") return new Response("Not found", { status: 404 });
      try {
        const { version, method, args, scope } = await request.json() as { version?: unknown; method: string; args: unknown[]; scope?: { hosted?: unknown; sourceIds?: unknown } };
        if (version !== undefined && version !== 1) return Response.json({ error: "Unsupported Catalog protocol version." }, { status: 400 });
        const actualScope = catalogReadScope();
        if (!scope || scope.hosted !== actualScope.hosted || !Array.isArray(scope.sourceIds)
          || scope.sourceIds.length !== actualScope.sourceIds.length || scope.sourceIds.some((id, index) => id !== actualScope.sourceIds[index])) {
          return Response.json({ error: "Catalog distribution configuration does not match the application." }, { status: 503, headers: { "Cache-Control": "no-store" } });
        }
        if (!Array.isArray(args) || !validReadArgs(method, args)) return new Response("Invalid read request", { status: 400 });
        // JSON arrays encode optional undefined arguments as null. Preserve the
        // local repository's defaults across the service boundary.
        const optionalArgs = args.map(value => value === null ? undefined : value);
        let result: unknown;
        switch (method) {
          case "configured": result = await readService.configured(); break;
          case "list": result = await readService.list(...optionalArgs as Parameters<typeof readService.list>); break;
          case "embeddings": result = await readService.embeddings(...optionalArgs as Parameters<typeof readService.embeddings>); break;
          case "sourcePolicy": result = await readService.sourcePolicy(...args as Parameters<typeof readService.sourcePolicy>); break;
          case "search": {
            const [query, model] = args as Parameters<typeof readService.search>;
            result = await readService.search({ ...query, signal: request.signal }, model); break;
          }
          default: return new Response("Unknown read operation", { status: 400 });
        }
        return Response.json(result, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        if (error instanceof RuntimeAdmissionError) return Response.json({ error: { code: error.code, message: error.message, retryAfterSec: error.retryAfterSec } }, {
          status: error.status, headers: { "Cache-Control": "no-store", ...(error.retryAfterSec ? { "Retry-After": String(error.retryAfterSec) } : {}) },
        });
        return Response.json({ error: "Catalog unavailable" }, { status: 503 });
      }
    });
  },
  async queue(batch: MessageBatch<{ jobId: string }>, env: object): Promise<void> {
    configureHouseholdRuntime(env);
    for (const message of batch.messages) {
      try {
        if (typeof message.body?.jobId === "string") await drainCatalogJobs({ jobId: message.body.jobId });
        message.ack();
      } catch { message.retry({ delaySeconds: 10 }); }
    }
  },
  async scheduled(_controller: ScheduledController, env: object): Promise<void> {
    configureHouseholdRuntime(env);
    // Recovers queue publication failures, backoff retries and expired leases.
    await drainCatalogJobs();
  },
};

export default catalogWorker;
