import type { ChefProvider } from "./chef-schema";
import { runModelOperation, type ModelAdmission } from "./model-admission";
import { checkLocalVerifier, type ProviderCapability } from "./provider-readiness";
import { embedTextsWithOllama } from "./recipe-embeddings";
import { verifyChefAnswer } from "./chef-verification";
import { hostedMode, initializeHouseholdRuntime } from "./household";
import { readProviderText } from "./provider-response";

export interface ChefGenerationRequest {
  provider: ChefProvider;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  schema: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ChefModelTransport {
  generate(request: ChefGenerationRequest): Promise<unknown>;
  checkVerifier(signal?: AbortSignal): Promise<ProviderCapability>;
  embed(text: string, model: string, signal?: AbortSignal): Promise<number[] | null>;
  verify: typeof verifyChefAnswer;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly status = 502, public readonly code = "provider_error") {
    super(message);
    this.name = "ProviderError";
  }
}

/** Model I/O only; the Chef service owns evidence and semantic answer validation. */
export function createChefModelTransport(options: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  checkVerifier?: ChefModelTransport["checkVerifier"];
  admission?: ModelAdmission;
} = {}): ChefModelTransport {
  // Resolve the global implementation at call time so local tests and runtimes
  // can replace transport without changing application policy.
  const fetchImpl: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  return {
    checkVerifier: async signal => {
      await requireLocalModelAccess();
      return (options.checkVerifier ?? checkLocalVerifier)(signal);
    },
    embed: async (text, model, signal) => {
      await requireLocalModelAccess();
      return (await embedTextsWithOllama([text], { model, timeoutMs: 8_000, signal, fetchImpl, admission: options.admission })).vectors[0] ?? null;
    },
    verify: async (answer, evidence, verification) => {
      await requireLocalModelAccess();
      return runModelOperation(options.admission, "ollama", "verification", signal => verifyChefAnswer(answer, evidence, { ...verification, signal, fetchImpl }),
        { signal: verification.signal, timeoutMs: verification.timeoutMs ?? 30_000 });
    },
    async generate(request) {
      await requireLocalModelAccess();
      const { provider, model, systemPrompt, userPrompt, schema } = request;
      const timeoutMs = options.timeoutMs ?? generationTimeoutMs();
      const apiKey = setting("OPENAI_API_KEY");
      if (provider === "openai" && !apiKey) throw new ProviderError("OpenAI is not configured. Add OPENAI_API_KEY to the server environment.", 503, "provider_not_configured");
      return runModelOperation(options.admission, provider, "generation", async signal => {
        const baseUrl = setting(provider === "openai" ? "OPENAI_BASE_URL" : "OLLAMA_BASE_URL", provider === "openai" ? "https://api.openai.com/v1" : "http://127.0.0.1:11434").replace(/\/+$/, "");
        const messages = [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }];
        const body = provider === "openai"
          ? { model, store: false, max_output_tokens: 2_500, input: messages, text: { format: { type: "json_schema", name: "rag_chef_answer", strict: true, schema } } }
          : { model, stream: false, think: false, format: schema, options: { temperature: 0, num_ctx: 16384, num_predict: 1600 }, messages };
        let response: { ok: boolean; status: number; payload: unknown };
        try {
          response = await providerJson(fetchImpl, `${baseUrl}/${provider === "openai" ? "responses" : "api/chat"}`, {
            method: "POST", signal,
            headers: { "content-type": "application/json", ...(provider === "openai" ? { authorization: `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify(body),
          }, timeoutMs);
        } catch (error) {
          if (error instanceof ProviderError) throw error;
          throw new ProviderError(provider === "openai" ? "OpenAI is currently unreachable." : `Ollama is unavailable at ${baseUrl}. Start Ollama and pull ${model}.`, 503, "provider_unavailable");
        }
        if (!response.ok) {
          const details = providerErrorMessage(response.payload);
          const unavailable = provider === "openai" ? response.status === 401 || response.status === 403 : response.status === 404;
          throw new ProviderError(
            `${provider === "openai" ? "OpenAI" : "Ollama"} returned ${response.status}${details ? `: ${details}` : "."}`,
            unavailable ? 503 : 502,
            provider === "openai" ? "openai_error" : "ollama_error",
          );
        }
        const payload = response.payload;
        if (provider === "openai") {
          if (isRecord(payload) && payload.status === "incomplete") throw new ProviderError("The AI answer was incomplete.", 502, "invalid_provider_response");
          const text = extractOpenAIOutputText(payload);
          if (!text) throw new ProviderError("OpenAI returned no structured text output.", 502, "invalid_provider_response");
          return parseJsonText(text);
        }
        if (isRecord(payload) && payload.done_reason === "length") throw new ProviderError("The AI answer exceeded its output budget.", 502, "invalid_provider_response");
        const content = isRecord(payload) && isRecord(payload.message) ? payload.message.content : undefined;
        if (typeof content !== "string" || !content.trim()) throw new ProviderError("Ollama returned an empty response.", 502, "invalid_provider_response");
        return parseJsonText(content);
      }, { signal: request.signal, timeoutMs });
    },
  };
}

async function requireLocalModelAccess(): Promise<void> {
  await initializeHouseholdRuntime();
  if (hostedMode()) throw new ProviderError("Hosted AI connections are not enabled yet. Recipe browsing, saved directions, and calculated dinner amounts remain available.", 503, "hosted_ai_unavailable");
}

async function providerJson(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  try {
    const response = await fetchImpl(url, { ...init, signal });
    // fetch resolves at headers. Keep the deadline active while consuming the
    // complete body, including error responses, so a stalled body cannot hang.
    const text = await readProviderText(response, signal);
    let payload: unknown;
    try { payload = JSON.parse(text); } catch {
      if (response.ok) throw new ProviderError("The provider returned malformed JSON.", 502, "invalid_provider_response");
    }
    return { ok: response.ok, status: response.status, payload };
  } finally {
    clearTimeout(timeout);
  }
}

function extractOpenAIOutputText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.output_text === "string" && value.output_text.trim()) return value.output_text;
  if (!Array.isArray(value.output)) return null;
  const textParts: string[] = [];
  for (const outputItem of value.output) {
    if (!isRecord(outputItem) || !Array.isArray(outputItem.content)) continue;
    for (const item of outputItem.content) {
      if (isRecord(item) && item.type === "output_text" && typeof item.text === "string") textParts.push(item.text);
    }
  }
  return textParts.length ? textParts.join("\n") : null;
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {
    const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    try { return JSON.parse(unfenced); } catch {
      const start = unfenced.indexOf("{"), end = unfenced.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { return JSON.parse(unfenced.slice(start, end + 1)); } catch { /* Normalize malformed provider output below. */ }
      }
    }
  }
  throw new ProviderError("The provider returned malformed JSON.", 502, "invalid_provider_response");
}

function providerErrorMessage(payload: unknown): string {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") return payload.error.message.slice(0, 400);
  if (isRecord(payload) && typeof payload.error === "string") return payload.error.slice(0, 400);
  return "";
}

function generationTimeoutMs(): number {
  const parsed = Number(setting("CHEF_PROVIDER_TIMEOUT_MS", "120000"));
  return Number.isFinite(parsed) ? Math.floor(Math.min(300_000, Math.max(5_000, parsed))) : 120_000;
}

function setting(name: string, fallback = ""): string {
  return (typeof process !== "undefined" ? process.env?.[name]?.trim() : undefined) || fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
