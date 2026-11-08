/** Fixed, content-free operational counters. Never add request text, IDs, state,
 * model responses or provider credentials to these events. */
export function recordAssistantMetric(event: { operation: "prepare" | "apply"; status: number; durationMs: number; resumed?: boolean; result?: "draft" | "clarification" | "applied" | "replay" }): void {
  console.info(JSON.stringify({ event: "assistant_operation", operation: event.operation, status: event.status,
    durationMs: Math.max(0, Math.round(event.durationMs)), measurement: "server_phase", resumed: Boolean(event.resumed),
    outcome: event.status === 202 ? "requires_model" : event.status === 409 ? "conflict" : event.status >= 400 ? "error" : event.result ?? "success" }));
}
