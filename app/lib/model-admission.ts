export type ModelProvider = "ollama" | "openai";
export type ModelOperation = "generation" | "verification" | "embedding";
export interface ModelAdmission {
  run<T>(provider: ModelProvider, operation: ModelOperation, callback: (signal: AbortSignal) => Promise<T>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>;
}

/** Pure ports stay usable in tests without requiring a Worker or database. */
export function runModelOperation<T>(admission: ModelAdmission | undefined, provider: ModelProvider, operation: ModelOperation,
  callback: (signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  if (admission) return admission.run(provider, operation, callback, options);
  return callback(options.signal ?? new AbortController().signal);
}
