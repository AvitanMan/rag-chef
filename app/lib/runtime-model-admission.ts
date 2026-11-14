import type { ModelAdmission } from "./model-admission";
import { acquireModelPermit, releaseModelPermit, MODEL_OPERATION_MAX_MS } from "./runtime-admission";
import { RuntimeAdmissionError, type RuntimeAdmissionStore, type ModelPermit } from "./runtime-admission-types";
import { currentServiceTrace, recordServiceEvent } from "./service-observability";

/** Chef and Catalog share the same durable provider pools in D1. */
export function createRuntimeModelAdmission(options: { store?: Pick<RuntimeAdmissionStore, "acquireModelPermit" | "releaseModelPermit"> } = {}): ModelAdmission {
  const store = options.store ?? { acquireModelPermit, releaseModelPermit };
  return {
    async run(provider, operation, callback, options = {}) {
      const started = performance.now();
      const duration = options.timeoutMs ?? MODEL_OPERATION_MAX_MS;
      if (!Number.isFinite(duration) || duration <= 0) throw new RuntimeAdmissionError("runtime_policy_invalid", "The model operation timeout is invalid.", 503);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException("The model operation timed out.", "TimeoutError")), Math.min(duration, MODEL_OPERATION_MAX_MS));
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      let permit: ModelPermit | undefined;
      let status = 200;
      try {
        signal.throwIfAborted();
        try { permit = await store.acquireModelPermit(provider, { requestId: currentServiceTrace()?.requestId }); }
        catch (error) {
          signal.throwIfAborted();
          if (error instanceof RuntimeAdmissionError) throw error;
          throw new RuntimeAdmissionError("runtime_policy_invalid", "Model capacity could not be checked. Retry when the service is ready.", 503);
        }
        signal.throwIfAborted();
        const result = await callback(signal);
        signal.throwIfAborted();
        return result;
      } catch (error) {
        status = error instanceof RuntimeAdmissionError ? error.status
          : signal.aborted ? signal.reason?.name === "TimeoutError" ? 504 : 499
          : error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 503;
        throw error;
      } finally {
        clearTimeout(timer);
        // Do not release on headers or race an unfinished callback against a
        // timeout. The propagated abort ends the actual body/parse operation.
        if (permit) try { await store.releaseModelPermit(permit); }
        catch {
          // Keep the successful answer. The unreleased permit expires and
          // conservatively reduces capacity; never repeat a paid request here.
          status = 503;
        }
        recordServiceEvent({ operation: `model.${operation}`, provider, status, durationMs: performance.now() - started });
      }
    },
  };
}
