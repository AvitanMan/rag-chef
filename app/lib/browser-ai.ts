import { kitchenFetch } from "./app-session";

export const LOCAL_AI_KEY = "rag-chef-local-ai-v1";
export type AISelection = { provider: "ollama" | "openai"; ollamaModel: string; openaiModel: string };
export type LocalAIConnection = { endpoint: string; model: string; origin: string; testedAt: string };
type BrowserModelTask = { taskId: string; token: string; operation: string; model: string; expiresAt: string; ollamaRequest: Record<string, unknown> };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function validTask(value: unknown, model: string): value is BrowserModelTask {
  if (!object(value) || typeof value.taskId !== "string" || !/^[\w-]{1,100}$/.test(value.taskId) || typeof value.token !== "string" || !/^[\w-]{20,100}$/.test(value.token) || value.model !== model || typeof value.operation !== "string" || !["assistant_intent", "plan_intent", "chef_answer", "verify_claims"].includes(value.operation) || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) return false;
  const body = value.ollamaRequest;
  return object(body) && Object.keys(body).every(key => ["model", "messages", "format", "stream", "think", "options"].includes(key)) && body.model === model && body.stream === false && body.think === false
    && object(body.format) && body.format.type === "object" && object(body.format.properties) && Array.isArray(body.format.required) && body.format.additionalProperties === false
    && Array.isArray(body.messages) && body.messages.length > 0 && body.messages.length <= 8 && body.messages.every(message => object(message) && ["system", "user", "assistant"].includes(String(message.role)) && typeof message.content === "string" && message.content.length <= 150_000 && Object.keys(message).every(key => ["role", "content"].includes(key)))
    && object(body.options) && Object.keys(body.options).every(key => ["temperature", "num_predict"].includes(key)) && body.options.temperature === 0 && typeof body.options.num_predict === "number" && Number.isInteger(body.options.num_predict) && body.options.num_predict > 0 && body.options.num_predict <= 8000;
}

export function localOllamaEndpoint(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use Ollama on this computer, for example http://127.0.0.1:11434.");
  return url.origin;
}

export function readLocalAI(storage: Pick<Storage, "getItem">): LocalAIConnection | null {
  try {
    const value = JSON.parse(storage.getItem(LOCAL_AI_KEY) ?? "null");
    if (!value || typeof value.model !== "string" || !/^[\w./:-]{1,120}$/.test(value.model) || typeof value.origin !== "string" || typeof value.testedAt !== "string" || !Number.isFinite(Date.parse(value.testedAt))) return null;
    return { ...value, endpoint: localOllamaEndpoint(value.endpoint) };
  } catch { return null; }
}

async function checkLocalNetworkPermission(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) return;
  // Querying does not prompt. Unsupported names fall through for older browsers.
  for (const name of ["loopback-network", "local-network-access"]) {
    let state: PermissionState;
    try { state = (await navigator.permissions.query({ name: name as PermissionName })).state; }
    catch { continue; }
    if (state === "denied") throw new Error("Local-network access is blocked for this site. Allow it in browser site settings, then connect to Ollama again.");
    return;
  }
}

async function localJson(endpoint: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const origin = localOllamaEndpoint(endpoint);
  signal?.throwIfAborted();
  await checkLocalNetworkPermission();
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(45_000);
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, { method: body ? "POST" : "GET", credentials: "omit", redirect: "error", cache: "no-store",
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeout.aborted) throw new Error("The local model timed out. Try a smaller model or retry after it has loaded.");
    throw new Error("Cannot reach Ollama. Check that it is running on this computer, allow this site in OLLAMA_ORIGINS, and allow local-network access in browser site settings.");
  }
  if (!response.ok) throw new Error(response.status === 404 ? "That model is not installed in Ollama. Choose an installed model." : `Ollama returned ${response.status}. Check the model and retry.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Ollama returned an empty response.");
  let text = ""; let size = 0; const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 256_000) { await reader.cancel(); throw new Error("Ollama returned too much output. Choose another model."); }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  try { return JSON.parse(text); } catch { throw new Error("Ollama returned invalid JSON. Choose a model with structured output support."); }
}

export async function listLocalModels(endpoint: string, signal?: AbortSignal): Promise<string[]> {
  const data = await localJson(endpoint, "/api/tags", undefined, signal) as { models?: Array<{ name?: string }> };
  return (data.models ?? []).map(model => model.name).filter((name): name is string => typeof name === "string" && name.length <= 120);
}

export async function testLocalModel(endpoint: string, model: string, signal?: AbortSignal): Promise<void> {
  if (!model.trim()) throw new Error("Choose an installed model first.");
  const result = await localJson(endpoint, "/api/chat", { model, stream: false, think: false, messages: [{ role: "user", content: "Return ready true using the supplied JSON schema." }], format: { type: "object", properties: { ready: { type: "boolean", const: true } }, required: ["ready"], additionalProperties: false }, options: { temperature: 0, num_predict: 60 } }, signal) as { message?: { content?: string }; done_reason?: string };
  try { if (result.done_reason === "length" || JSON.parse(result.message?.content ?? "{}").ready !== true) throw new Error(); }
  catch { throw new Error("This model did not pass the structured-output check. Choose another installed model."); }
}

/** Runs bounded server-selected inference phases; Apply is always a separate request. */
export async function assistantFetch(url: string, input: Record<string, unknown>, options: { selection: AISelection; hosted: boolean; storage: Storage; signal?: AbortSignal; fetcher?: typeof kitchenFetch }): Promise<Response> {
  const fetcher = options.fetcher ?? kitchenFetch;
  const ai = { provider: options.selection.provider === "ollama" ? "browser_ollama" : "openai", model: options.selection.provider === "ollama" ? options.selection.ollamaModel : options.selection.openaiModel };
  let connection: LocalAIConnection | null = null;
  if (options.hosted && ai.provider === "browser_ollama" && input.intent === undefined) {
    connection = readLocalAI(options.storage);
    if (!connection || connection.origin !== window.location.origin || connection.model !== ai.model) throw new Error("Connect and test this local model in Settings first. Manual kitchen controls remain available.");
  }
  const fingerprint = (value: LocalAIConnection | null) => value ? JSON.stringify([value.endpoint, value.model, value.origin, value.testedAt]) : "";
  const connectionFingerprint = fingerprint(connection);
  const requireConnection = () => { if (!connection || fingerprint(readLocalAI(options.storage)) !== connectionFingerprint) throw new Error("Your local connection changed. Prepare the request again using the current connection."); };
  const cancelTask = (task: unknown) => {
    if (!object(task) || typeof task.taskId !== "string" || !/^[\w-]{1,100}$/.test(task.taskId) || typeof task.token !== "string" || task.token.length > 100) return;
    void fetcher(`/api/ai/tasks/${encodeURIComponent(task.taskId)}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: task.token }), keepalive: true }).catch(() => {});
  };
  let response = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json" }, signal: options.signal, body: JSON.stringify({ ...input, ...(options.hosted ? { ai } : url === "/api/assistant" ? { provider: options.selection.provider, model: ai.model } : {}) }) });
  for (let phase = 0; phase < 6 && response.status === 202; phase++) {
    const body = await response.clone().json() as { status?: string; task?: BrowserModelTask };
    if (body.status !== "requires_model" || !body.task) throw new Error("The assistant returned an invalid model task. Prepare the request again.");
    const task = body.task;
    if (!validTask(task, ai.model)) { cancelTask(task); throw new Error("The AI task expired or is invalid. Prepare the request again."); }
    const taskUrl = `/api/ai/tasks/${encodeURIComponent(task.taskId)}`;
    const cancel = () => cancelTask(task);
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      options.signal?.throwIfAborted();
      requireConnection();
      const generated = await localJson(connection!.endpoint, "/api/chat", task.ollamaRequest, options.signal) as { message?: { content?: string }; done_reason?: string };
      if (generated.done_reason === "length" || typeof generated.message?.content !== "string") throw new Error("The local model returned an incomplete answer. Retry or choose another model.");
      options.signal?.throwIfAborted(); requireConnection();
      response = await fetcher(`${taskUrl}/result`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: options.signal, body: JSON.stringify({ token: task.token, rawOutput: generated.message.content }) });
    } catch (error) { cancel(); throw error; }
    finally { options.signal?.removeEventListener("abort", cancel); }
  }
  if (response.status === 202) { try { const body = await response.clone().json() as { task?: unknown }; cancelTask(body.task); } catch { /* No usable task token was returned. */ } throw new Error("The assistant reached its request limit. Simplify the request and retry."); }
  return response;
}
