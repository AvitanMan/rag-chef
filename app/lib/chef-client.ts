import { catalogReadScope } from "./catalog-read-service";
import { initializeHouseholdRuntime } from "./household";
import { compatibleServiceResponse, serviceRequestHeaders } from "./service-observability";
import { cancelProviderBody } from "./provider-response";
import { chefErrorResponse, chefJson, chefJsonError, chefOperationTimeoutMs, readChefBody, type ChefEnvelope, type ChefOperation } from "./chef-protocol";

type ChefPayload = Pick<ChefEnvelope, "household" | "input" | "query">;
export function createChefClient(options: { binding?: () => Promise<Fetcher | undefined>; timeoutMs?: number } = {}) {
  return {
    async request(operation: ChefOperation, payload: ChefPayload, signal?: AbortSignal): Promise<Response> {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new DOMException("Chef request deadline exceeded", "TimeoutError")), options.timeoutMs ?? chefOperationTimeoutMs(operation));
      const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      try {
        combined.throwIfAborted();
        await initializeHouseholdRuntime();
        const binding = options.binding ? await options.binding() : ((await import("cloudflare:workers")).env as unknown as { CHEF?: Fetcher }).CHEF;
        if (!binding) return chefJsonError(503, "chef_unavailable", "The private Chef service binding is unavailable.");
        const response = await binding.fetch(`https://chef.internal/${operation}`, {
          method: "POST", headers: { "content-type": "application/json", ...serviceRequestHeaders() }, signal: combined,
          body: JSON.stringify({ version: 1, scope: catalogReadScope(), ...payload }),
        });
        if (!compatibleServiceResponse(response)) {
          cancelProviderBody(response);
          throw new Error("Chef service controls are incompatible");
        }
        // Keep the deadline active through error/success body consumption too.
        let body: unknown;
        try { body = JSON.parse(await readChefBody({ headers: response.headers, body: response.body, signal: combined }, 10_000_000)); }
        catch (error) {
          if (combined.aborted) throw combined.reason;
          throw new Error("Invalid Chef service response", { cause: error });
        }
        combined.throwIfAborted();
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid Chef service response");
        const result = chefJson(body, response.status);
        const retry = response.headers.get("retry-after");
        if (retry && /^\d{1,8}$/.test(retry)) result.headers.set("Retry-After", retry);
        return result;
      } catch (error) { return chefErrorResponse(error, combined); }
      finally { clearTimeout(timer); }
    },
  };
}

export const callChef = createChefClient().request;
