/** Close the stream without waiting for provider-specific cancellation cleanup. */
export function cancelProviderBody(response: Pick<Response, "body">): void {
  void response.body?.cancel().catch(() => {});
}

/**
 * Keep provider deadlines effective even when a transport returns a stream that
 * does not inherit fetch's AbortSignal. Canceling the reader closes pending
 * reads immediately; an underlying cancellation promise need not settle first.
 */
export async function readProviderText(response: Pick<Response, "body">, signal: AbortSignal): Promise<string> {
  if (signal.aborted) { cancelProviderBody(response); signal.throwIfAborted(); }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
