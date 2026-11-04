import { hostedMode, householdSetting } from "./household";
import type { StructuredInferenceRequest } from "./ai-inference";

const DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
export function lmStudioBaseUrl(): string {
  const url = new URL(householdSetting("LMSTUDIO_BASE_URL") || DEFAULT_BASE_URL);
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || !["/", "/v1", "/v1/"].includes(url.pathname)) throw new Error("Use a loopback LM Studio address, for example http://127.0.0.1:1234/v1.");
  return `${url.origin}/v1`;
}

async function lmStudioJson(path: string, body: unknown, signal?: AbortSignal, timeoutMs = 60_000): Promise<unknown> {
  if (hostedMode()) throw new Error("Hosted LM Studio requests run on your device.");
  const baseUrl = lmStudioBaseUrl(), apiKey = householdSetting("LMSTUDIO_API_KEY");
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${baseUrl}${path}`, { method: body ? "POST" : "GET", redirect: "error", cache: "no-store", credentials: "omit",
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "LM Studio rejected its configured API token." : `LM Studio returned HTTP ${response.status}. Check its local server and selected model.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("LM Studio returned an empty response.");
  let text = "", size = 0; const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 256_000) { await reader.cancel(); throw new Error("LM Studio returned too much output."); }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

export async function runLMStudioInference(model: string, inference: StructuredInferenceRequest, signal?: AbortSignal): Promise<unknown> {
  if (!/^[\w./:-]{1,120}$/.test(model)) throw new Error("Choose a model identifier from LM Studio or configure LMSTUDIO_MODEL.");
  const result = await lmStudioJson("/chat/completions", { model, messages: inference.messages, stream: false, temperature: 0,
    max_tokens: inference.maxOutputTokens ?? 1400,
    response_format: { type: "json_schema", json_schema: { name: "rag_chef_response", strict: true, schema: inference.schema } },
  }, signal) as { error?: unknown; choices?: Array<{ finish_reason?: string; message?: { content?: string; refusal?: unknown } }> };
  const choice = result?.choices?.[0];
  if (result?.error || choice?.finish_reason !== "stop" || choice.message?.refusal || typeof choice.message?.content !== "string" || !choice.message.content) throw new Error("LM Studio returned an incomplete structured answer. Choose a model with structured output support.");
  return JSON.parse(choice.message.content);
}

export async function checkLMStudioReadiness(requestedModel = "", signal?: AbortSignal) {
  const model = requestedModel || householdSetting("LMSTUDIO_MODEL");
  const base = { configured: true, model };
  if (hostedMode()) return { ...base, ok: false, reachable: false, message: "Connect to LM Studio in this browser's AI settings." };
  try {
    const payload = await lmStudioJson("/models", undefined, signal, 5_000) as { data?: Array<{ id?: string }> };
    const available = Array.isArray(payload?.data) ? payload.data.flatMap(item => typeof item?.id === "string" ? [item.id] : []) : [];
    const ok = Boolean(model && available.includes(model));
    return { ...base, ok, reachable: true, message: !model ? "Enter the model identifier shown in LM Studio, or configure LMSTUDIO_MODEL." : ok ? "LM Studio is reachable and the selected model is available. Generation and verification use this model." : `LM Studio is running, but ${model} is unavailable. Choose a model listed by its server.` };
  } catch { return { ...base, ok: false, reachable: false, message: "LM Studio is unavailable. Start its local server, check LMSTUDIO_BASE_URL and any API token, then retry." }; }
}
