import { AsyncLocalStorage } from "node:async_hooks";

export type ServiceName = "gateway" | "catalog" | "chef";
export interface ServiceTrace { service: ServiceName; requestId: string; jobId?: string }
const traces = new AsyncLocalStorage<ServiceTrace>();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const operations = new Set(["gateway.request", "chef.answer", "chef.stages", "chef.health", "catalog.read", "kitchen.read", "kitchen.save", "kitchen.command", "recipes.search", "recipes.list", "catalog.admin", "catalog.import", "catalog.demo", "catalog.metadata", "catalog.job.status", "catalog.job.accepted", "catalog.job.run", "services.ready", "model.generation", "model.verification", "model.embedding"]);
export const SERVICE_PROTOCOL = "1";
export const SERVICE_CONTROLS = "1";
export const currentServiceTrace = () => traces.getStore();
export function serviceRequestHeaders(): Record<string, string> {
  const trace = currentServiceTrace();
  return { "x-rag-chef-required-controls": SERVICE_CONTROLS, ...(trace ? { "x-rag-chef-request-id": trace.requestId } : {}) };
}
export function serviceResponseHeaders(): Record<string, string> {
  return { "x-rag-chef-protocol": SERVICE_PROTOCOL, "x-rag-chef-controls": SERVICE_CONTROLS };
}
export function compatibleServiceResponse(response: Response): boolean {
  return response.headers.get("x-rag-chef-protocol") === SERVICE_PROTOCOL && response.headers.get("x-rag-chef-controls") === SERVICE_CONTROLS;
}
export function requestedControlsSupported(request: Request): boolean {
  const required = request.headers.get("x-rag-chef-required-controls");
  return required === null || required === SERVICE_CONTROLS;
}

/** Never spread caller data into logs. All values below have bounded domains. */
export function recordServiceEvent(event: { operation: string; status: number; durationMs: number; provider?: string; jobId?: string; attempt?: number; timings?: Record<string, number> }): void {
  const trace = currentServiceTrace();
  if (!trace || !operations.has(event.operation)) return;
  const entry: Record<string, unknown> = { event: "service.operation", service: trace.service, requestId: trace.requestId, operation: event.operation };
  if (Number.isInteger(event.status) && event.status >= 100 && event.status <= 599) entry.status = event.status;
  if (Number.isFinite(event.durationMs)) entry.durationMs = Math.round(Math.max(0, Math.min(event.durationMs, 86_400_000)));
  if (event.provider === "ollama" || event.provider === "openai") entry.provider = event.provider;
  const jobId = event.jobId ?? trace.jobId;
  if (jobId && uuid.test(jobId)) entry.jobId = jobId;
  if (Number.isSafeInteger(event.attempt) && event.attempt! >= 1 && event.attempt! <= 100) entry.attempt = event.attempt;
  if (event.timings) {
    const timings: Record<string, number> = {};
    for (const key of ["retrievalMs", "generationMs", "verificationMs", "totalMs"]) {
      const value = event.timings[key];
      if (Number.isFinite(value) && value >= 0 && value <= 86_400_000) timings[key] = Math.round(value);
    }
    if (Object.keys(timings).length) entry.timings = timings;
  }
  try { console.info(JSON.stringify(entry)); } catch { /* Diagnostics cannot fail a kitchen operation. */ }
}

async function tracedResponse(trace: ServiceTrace, operation: string, callback: () => Promise<Response>, internal: boolean): Promise<Response> {
  return traces.run(trace, async () => {
    const started = performance.now();
    let status = 500;
    try {
      const response = await callback(); status = response.status;
      const result = new Response(response.body, response);
      result.headers.set("x-request-id", trace.requestId);
      if (internal) for (const [name, value] of Object.entries(serviceResponseHeaders())) result.headers.set(name, value);
      return result;
    } finally { recordServiceEvent({ operation, status, durationMs: performance.now() - started }); }
  });
}

export function withGatewayTrace<T extends unknown[]>(operation: string, handler: (request: Request, ...args: T) => Promise<Response>) {
  return (request: Request, ...args: T) => {
    const active = currentServiceTrace();
    // Only an existing gateway invocation may reuse authority over a trace ID.
    // Incoming public headers (including valid-looking UUIDs) are ignored.
    const trace: ServiceTrace = active?.service === "gateway" ? active : { service: "gateway", requestId: crypto.randomUUID() };
    return tracedResponse(trace, operation, () => handler(request, ...args), false);
  };
}
export function withInternalTrace(service: "chef" | "catalog", operation: string, request: Request, callback: () => Promise<Response>): Promise<Response> {
  const supplied = request.headers.get("x-rag-chef-request-id");
  return tracedResponse({ service, requestId: supplied && uuid.test(supplied) ? supplied : crypto.randomUUID() }, operation, callback, true);
}
export function withJobTrace<T>(jobId: string, callback: () => Promise<T>): Promise<T> {
  const safeId = uuid.test(jobId) ? jobId : crypto.randomUUID();
  return traces.run({ service: "catalog", requestId: safeId, jobId: safeId }, callback);
}
