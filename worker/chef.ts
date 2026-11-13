import { createChefService, type ChefService } from "../app/lib/chef-service";
import { createChefModelTransport } from "../app/lib/chef-provider";
import { checkChefHealth } from "../app/lib/chef-health";
import { parseChefRequest } from "../app/lib/chef-schema";
import { getKitchenDocument } from "../app/lib/kitchen-store";
import { catalogReadService } from "../app/lib/catalog-read-service";
import { configureHouseholdRuntime, validateHouseholdContext } from "../app/lib/household";
import { chefErrorResponse, chefOperationTimeoutMs, readChefEnvelope } from "../app/lib/chef-protocol";
import { authorizeChefUsage } from "../app/lib/runtime-admission";
import { createRuntimeModelAdmission } from "../app/lib/runtime-model-admission";
import { recordServiceEvent, requestedControlsSupported, withInternalTrace } from "../app/lib/service-observability";
import { serviceReadiness } from "../app/lib/service-readiness";

export interface ChefWorkerDependencies {
  chef?: ChefService;
  health?: typeof checkChefHealth;
  validateContext?: typeof validateHouseholdContext;
  operationTimeoutMs?: (operation: "answer" | "health") => number;
  authorizeUsage?: typeof authorizeChefUsage;
}

/** Private service entry point. Neither operation exposes a kitchen write port. */
export function createChefWorker(dependencies: ChefWorkerDependencies = {}) {
  const chef = dependencies.chef ?? createChefService({
    kitchen: { read: getKitchenDocument }, catalog: catalogReadService, models: createChefModelTransport({ admission: createRuntimeModelAdmission() }),
  });
  const health = dependencies.health ?? checkChefHealth;
  const validateContext = dependencies.validateContext ?? validateHouseholdContext;
  return {
    async fetch(request: Request, env: object): Promise<Response> {
      configureHouseholdRuntime(env);
      const path = new URL(request.url).pathname;
      return withInternalTrace("chef", path === "/health" ? "chef.health" : path === "/ready" ? "services.ready" : "chef.answer", request, async () => {
        if (!requestedControlsSupported(request)) return Response.json({ error: { code: "service_version_mismatch", message: "Unsupported service controls." } }, { status: 503 });
        if (request.method === "GET" && path === "/ready") return serviceReadiness("chef", env);
        if (request.method !== "POST" || path !== "/answer" && path !== "/health") return new Response("Not found", { status: 404 });
        const operation = path === "/answer" ? "answer" : "health";
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout((dependencies.operationTimeoutMs ?? chefOperationTimeoutMs)(operation))]);
        try {
          signal.throwIfAborted();
          const envelope = await readChefEnvelope(new Request(request, { signal }));
          const household = await validateContext(envelope.household);
          let result: { status: number; body: unknown };
          try {
            signal.throwIfAborted();
            const input = operation === "answer" ? parseChefRequest(envelope.input) : undefined;
            if (operation === "answer") await (dependencies.authorizeUsage ?? authorizeChefUsage)(household);
            result = operation === "answer"
              ? { status: 200, body: await chef.answer(input!, { household, signal }) }
              : await health(envelope.query!, { household, signal });
          } finally {
            // A valid initial session cannot authorize output after revocation,
            // including deterministic answers with no ranked recipe candidates.
            await validateContext(household);
          }
          signal.throwIfAborted();
          if (operation === "answer" && result.body && typeof result.body === "object" && "timings" in result.body
            && result.body.timings && typeof result.body.timings === "object") {
            const timings = result.body.timings as Record<string, number>;
            recordServiceEvent({ operation: "chef.stages", status: result.status, durationMs: timings.totalMs, timings });
          }
          return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
        } catch (error) { return chefErrorResponse(error, signal); }
      });
    },
  };
}

const chefWorker = createChefWorker();
export default chefWorker;
