import { runLMStudioInference } from "./lmstudio";
import type { HouseholdContext } from "./household";
import { householdDb, householdSetting, HouseholdAuthError, householdError, validateHouseholdContext } from "./household";
import { getKitchenDocument } from "./kitchen-store";
import { readOpenAIConnection, runOpenAIInference } from "./ai-connections";
import { DEFAULT_OLLAMA_CHAT_MODEL, DEFAULT_OPENAI_MODEL } from "./chef-schema";

export type StructuredInferenceRequest = { operation: string; schema: Record<string, unknown>; messages: Array<{ role: "system" | "user" | "assistant"; content: string }>; maxOutputTokens?: number };
export type StructuredInference = (request: StructuredInferenceRequest) => Promise<unknown>;
export type AiProviderSelection = { provider: "openai" | "browser_ollama" | "browser_lmstudio"; model?: string };
export type AiResume = { workflowId: string; transcript: Array<{ requestHash: string; rawOutput: string }> };
export type AiModelTask = { provider: "browser_ollama" | "browser_lmstudio"; taskId: string; token: string; operation: string; model: string; expiresAt: string; ollamaRequest: { model: string; messages: StructuredInferenceRequest["messages"]; format: Record<string, unknown>; stream: false; think: false; options: { temperature: number; num_predict: number } } };
export class AiError extends Error { constructor(message: string, public code = "ai_unavailable", public status = 503) { super(message); this.name = "AiError"; } }
export class AiTaskRequired extends Error { constructor(public task: AiModelTask) { super("Continue this request with the local model on your device."); this.name = "AiTaskRequired"; } }
export const aiJson = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
export function aiWorkflowResponse(error: unknown): Response | undefined {
  if (error instanceof HouseholdAuthError) return householdError(error);
  if (error instanceof AiTaskRequired) return aiJson({ status: "requires_model", task: error.task }, 202);
  if (error instanceof AiError) return aiJson({ error: { code: error.code, message: error.message } }, error.status);
}
export async function aiHash(value: string): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, "0")).join(""); }
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
export function parseAiSelection(value: unknown): AiProviderSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AiError("Choose your personal OpenAI connection or this device's Ollama or LM Studio model.", "ai_connection_required", 400);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["provider", "model"].includes(key)) || !["openai", "browser_ollama", "browser_lmstudio"].includes(String(row.provider)) || row.model !== undefined && (typeof row.model !== "string" || !/^[\w./:-]{1,120}$/.test(row.model))) throw new AiError("Choose a valid AI connection and model.", "invalid_ai_connection", 400);
  return row as AiProviderSelection;
}
export async function createAiWorkflow(request: Request, context: HouseholdContext, descriptor: { operation: "assistant" | "chef" | "plan"; input: Record<string, unknown>; kitchenRevision: number }, resume?: AiResume): Promise<{ infer: StructuredInference; provider: AiProviderSelection["provider"] | "server_ollama" | "server_lmstudio"; model: string }> {
  if (context.mode === "hosted" && !context.assistantEnabled) throw new AiError("The household assistant is not enabled for this beta.", "assistant_disabled", 403);
  // Standalone mode retains its existing server-local configuration. This path
  // is never available to a hosted household or a browser task continuation.
  if (context.mode === "local" && descriptor.input.ai === undefined && !resume) {
    const provider = descriptor.input.provider ?? "ollama";
    if (provider !== "ollama" && provider !== "openai" && provider !== "lmstudio") throw new AiError("Choose Ollama, LM Studio, or OpenAI.", "invalid_ai_connection", 400);
    const model = descriptor.input.model ?? (householdSetting(provider === "openai" ? "OPENAI_MODEL" : provider === "lmstudio" ? "LMSTUDIO_MODEL" : "OLLAMA_CHAT_MODEL") || (provider === "openai" ? DEFAULT_OPENAI_MODEL : provider === "lmstudio" ? "" : DEFAULT_OLLAMA_CHAT_MODEL));
    if (typeof model !== "string" || !/^[\w./:-]{1,120}$/.test(model)) throw new AiError(provider === "lmstudio" ? "Choose the model identifier shown in LM Studio or configure LMSTUDIO_MODEL." : "Choose a valid model.", "invalid_ai_connection", 400);
    const apiKey = householdSetting("OPENAI_API_KEY");
    if (provider === "openai" && !apiKey) throw new AiError("Configure OPENAI_API_KEY for this standalone installation.", "ai_connection_required", 400);
    let calls = 0;
    return { provider: provider === "openai" ? "openai" : provider === "lmstudio" ? "server_lmstudio" : "server_ollama", model, infer: async inference => {
      if (++calls > 6) throw new AiError("Split this request into smaller requests.", "task_limit", 400);
      try {
        let value: unknown;
        if (provider === "openai") value = await runOpenAIInference({ apiKey, model }, model, inference, request.signal);
        else if (provider === "lmstudio") value = await runLMStudioInference(model, inference, request.signal);
        else {
          const baseUrl = householdSetting("OLLAMA_BASE_URL") || "http://127.0.0.1:11434", url = new URL(baseUrl);
          if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("Use a loopback Ollama address.");
          const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/chat`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]), body: JSON.stringify({ model, stream: false, think: false, format: inference.schema, messages: inference.messages, options: { temperature: 0, num_predict: inference.maxOutputTokens ?? 1400 } }) });
          if (!response.ok) throw new Error("Local model unavailable.");
          const text = await response.text(); if (text.length > 200_000) throw new Error("Oversized model response.");
          const result = JSON.parse(text); if (result.done_reason === "length" || typeof result.message?.content !== "string") throw new Error("Incomplete model response.");
          value = JSON.parse(result.message.content);
        }
        validateAiSchema(value, inference.schema); return value;
      } catch (error) { if (error instanceof AiError) throw error; throw new AiError(request.signal.aborted ? "Request cancelled." : "The selected AI connection is unavailable or returned invalid output. Retry or use manual controls.", request.signal.aborted ? "cancelled" : "ai_unavailable", request.signal.aborted ? 499 : 503); }
    } };
  }
  const selection = parseAiSelection(descriptor.input.ai);
  const connection = selection.provider === "openai" ? await readOpenAIConnection(context) : undefined;
  const model = selection.model ?? connection?.model ?? (selection.provider === "browser_lmstudio" ? "" : DEFAULT_OLLAMA_CHAT_MODEL);
  if (!model) throw new AiError("Choose and test a model in LM Studio settings first.", "invalid_ai_connection", 400);
  if (selection.provider === "openai" && !connection) throw new AiError("Add your own OpenAI API key in AI connections.", "ai_connection_required", 400);
  let phase = 0;
  const infer: StructuredInference = async inference => {
    if (phase >= 6) throw new AiError("This request needs too many model steps. Split it into smaller requests.", "task_limit", 400);
    if (request.signal.aborted) throw new AiError("Request cancelled.", "cancelled", 499);
    const requestHash = await aiHash(JSON.stringify(canonical({ version: 1, actor: context.userId, household: context.householdId, revision: descriptor.kitchenRevision, provider: selection.provider, model, inference })));
    if (selection.provider === "openai") {
      await validateHouseholdContext(context);
      const current = await readOpenAIConnection(context);
      if (!current || current.apiKey !== connection!.apiKey || current.model !== connection!.model) throw new AiError("Your OpenAI connection changed. Prepare the request again using the current connection.", "ai_connection_changed", 409);
      phase++;
      const value = await runOpenAIInference(current, model, inference, request.signal);
      validateAiSchema(value, inference.schema); return value;
    }
    const prior = resume?.transcript[phase++];
    if (prior) {
      if (prior.requestHash !== requestHash) throw new AiError("The recipe or kitchen context changed. Prepare a new request.", "context_changed", 409);
      let value: unknown; try { value = JSON.parse(prior.rawOutput); } catch { throw new AiError("The local model returned invalid JSON. Retry or use the manual controls.", "invalid_interpretation", 502); }
      validateAiSchema(value, inference.schema); return value;
    }
    const db = await householdDb();
    await validateHouseholdContext(context);
    const workflowId = resume?.workflowId ?? crypto.randomUUID();
    if (resume && await db.prepare("SELECT id FROM ai_model_tasks WHERE workflow_id = ? AND actor_id = ? AND household_id = ? AND status = 'cancelled' LIMIT 1").bind(workflowId, context.userId, context.householdId).first()) throw new AiError("Request cancelled.", "cancelled", 409);
    const taskId = crypto.randomUUID(), token = randomToken(), expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const task: AiModelTask = { provider: selection.provider, taskId, token, operation: inference.operation, model, expiresAt, ollamaRequest: { model, messages: inference.messages, format: inference.schema, stream: false, think: false, options: { temperature: 0, num_predict: inference.maxOutputTokens ?? 1400 } } };
    // Delete expired private task context opportunistically; it is never kitchen state.
    await db.prepare("DELETE FROM ai_model_tasks WHERE expires_at < ?").bind(new Date().toISOString()).run();
    const created = await db.prepare("INSERT INTO ai_model_tasks (id, workflow_id, actor_id, household_id, operation, token_hash, request_hash, kitchen_revision, input_json, transcript_json, status, expires_at, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ? WHERE NOT EXISTS (SELECT 1 FROM ai_model_tasks WHERE workflow_id=? AND status='cancelled') RETURNING id").bind(taskId, workflowId, context.userId, context.householdId, descriptor.operation, await aiHash(token), requestHash, descriptor.kitchenRevision, JSON.stringify(descriptor.input), JSON.stringify(resume?.transcript ?? []), expiresAt, new Date().toISOString(), workflowId).first();
    if (!created) throw new AiError("Request cancelled.", "cancelled", 409);
    throw new AiTaskRequired(task);
  };
  return { infer, provider: selection.provider, model };
}

/** Transport shape checks complement operation-specific semantic validation. */
export function validateAiSchema(value: unknown, schema: Record<string, unknown>, depth = 0): void {
  const invalid = () => { throw new AiError("The model returned an invalid structured answer. Retry or use the manual controls.", "invalid_interpretation", 502); };
  if (depth > 16) invalid();
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some(option => { try { validateAiSchema(value, option as Record<string, unknown>, depth + 1); return true; } catch { return false; } })) invalid();
    return;
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const matches = types.some(type => type === undefined || type === "null" && value === null || type === "object" && Boolean(value && typeof value === "object" && !Array.isArray(value)) || type === "array" && Array.isArray(value) || type === "string" && typeof value === "string" || type === "boolean" && typeof value === "boolean" || type === "number" && typeof value === "number" && Number.isFinite(value) || type === "integer" && typeof value === "number" && Number.isInteger(value));
  if (!matches || Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) invalid();
  if (typeof value === "number" && (typeof schema.minimum === "number" && value < schema.minimum || typeof schema.maximum === "number" && value > schema.maximum)) invalid();
  if (typeof value === "string" && (typeof schema.minLength === "number" && value.length < schema.minLength || typeof schema.maxLength === "number" && value.length > schema.maxLength || typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value))) invalid();
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems || typeof schema.maxItems === "number" && value.length > schema.maxItems) invalid();
    if (schema.items && typeof schema.items === "object") for (const item of value) validateAiSchema(item, schema.items as Record<string, unknown>, depth + 1);
  } else if (value && typeof value === "object") {
    const row = value as Record<string, unknown>, properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key !== "string" || !Object.hasOwn(row, key))) invalid();
    if (schema.additionalProperties === false && Object.keys(row).some(key => !Object.hasOwn(properties, key))) invalid();
    for (const [key, child] of Object.entries(properties)) if (Object.hasOwn(row, key)) validateAiSchema(row[key], child, depth + 1);
  }
}

export type AiTaskRow = { id: string; workflow_id: string; actor_id: string; household_id: string; operation: "assistant" | "chef" | "plan"; token_hash: string; request_hash: string; kitchen_revision: number; input_json: string; transcript_json: string; status: string; expires_at: string; output_hash: string | null; response_json: string | null; response_status: number | null };
export async function loadAiTask(context: HouseholdContext, taskId: string, token: string, cancelling = false): Promise<AiTaskRow> {
  const row = await (await householdDb()).prepare("SELECT * FROM ai_model_tasks WHERE id = ? AND actor_id = ? AND household_id = ?").bind(taskId, context.userId, context.householdId).first<AiTaskRow>();
  if (!row || await aiHash(token) !== row.token_hash) throw new AiError("This model task is unavailable.", "task_not_found", 404);
  if (cancelling) return row;
  if (row.status === "cancelled") throw new AiError("Request cancelled.", "cancelled", 409);
  if (row.expires_at <= new Date().toISOString()) throw new AiError("This model task expired. Prepare a new request.", "task_expired", 409);
  if (context.mode === "hosted" && !context.assistantEnabled) throw new AiError("The household assistant is not enabled.", "assistant_disabled", 403);
  if (row.status !== "completed" && (await getKitchenDocument(context)).revision !== row.kitchen_revision) throw new AiError("Your household kitchen changed. Prepare a new request.", "kitchen_changed", 409);
  return row;
}
