import { setTimeout as delay } from "node:timers/promises";

const message = (value, fallback) => typeof value?.error === "string" ? value.error : value?.error?.message || fallback;

/** Read an accepted catalog operation through its terminal report. */
export async function catalogOperationResult(response, { base, headers = {}, signal, onQueued } = {}) {
  let value = await response.json();
  if (!response.ok) throw new Error(message(value, `Catalog request failed (${response.status}).`));
  if (response.status !== 202) return value;
  if (typeof value.statusUrl !== "string" || !/^\/api\/admin\/catalog\/jobs\/[a-zA-Z0-9-]{1,200}$/.test(value.statusUrl)) throw new Error("The catalog returned an invalid progress link.");
  const url = new URL(value.statusUrl, base);
  onQueued?.(value.job);
  while (true) {
    signal?.throwIfAborted();
    if (value.job?.status === "succeeded") return value.job.result;
    if (value.job?.status === "failed") throw new Error(message(value.job, "The catalog operation failed."));
    if (!["queued", "running"].includes(value.job?.status)) throw new Error("The catalog returned an invalid operation status.");
    await delay(1_000, undefined, { signal });
    response = await fetch(url, { headers, signal, cache: "no-store", redirect: "error" });
    value = await response.json();
    if (!response.ok) throw new Error(message(value, `Catalog progress could not be read (${response.status}).`));
  }
}

/** Retrying a lost acceptance response never creates a second operation. */
export async function submitCatalogOperation(url, body, { headers = {}, signal, requestId = crypto.randomUUID() } = {}) {
  let lastError;
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json", "Idempotency-Key": requestId }, body: serialized, signal, redirect: "error" });
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      if (attempt < 2) await delay(1_000, undefined, { signal });
    }
  }
  throw lastError;
}
