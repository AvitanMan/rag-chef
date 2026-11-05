import { DEFAULT_OLLAMA_CHAT_MODEL, DEFAULT_OLLAMA_EMBED_MODEL } from "./chef-schema";
import { hostedMode } from "./household";

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const HEALTH_TIMEOUT_MS = 5_000;
export type ProviderCapability = { ready: boolean; model: string; message: string };
export type OllamaHealth = {
  ok: boolean; configured: boolean; reachable: boolean; model: string; message: string;
  baseUrl: string; embedModel: string; chatModelInstalled: boolean; embedModelInstalled: boolean;
};

function isLoopback(baseUrl: string): boolean {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname); }
  catch { return false; }
}

export function verificationCapability(ollama: OllamaHealth): ProviderCapability {
  const local = isLoopback(ollama.baseUrl);
  return { ready: local && ollama.ok, model: ollama.model, message: !local
    ? "Answer verification requires Ollama on this Mac. Configure a loopback Ollama address."
    : ollama.ok ? `Local answer verification is ready (${ollama.model}).`
    : `Answer verification is unavailable. Start local Ollama and install ${ollama.model}.` };
}

/** A capability probe, not a generation call; never forwards credentials. */
export async function checkLocalVerifier(signal?: AbortSignal): Promise<ProviderCapability> {
  if (hostedMode()) return { ready: false, model: "", message: "Choose your personal AI connection. Verification uses the same connection as generation." };
  const baseUrl = env("OLLAMA_BASE_URL", DEFAULT_OLLAMA_BASE_URL);
  const model = env("OLLAMA_CHAT_MODEL", DEFAULT_OLLAMA_CHAT_MODEL);
  if (!isLoopback(baseUrl)) return { ready: false, model, message: "Answer verification requires Ollama on this Mac. Configure a loopback Ollama address." };
  return verificationCapability(await checkOllamaReadiness(model, signal));
}

export async function checkOllamaReadiness(requestedModel = "", signal?: AbortSignal): Promise<OllamaHealth> {
  if (hostedMode()) return { ok: false, configured: false, reachable: false, model: requestedModel || DEFAULT_OLLAMA_CHAT_MODEL, embedModel: "", baseUrl: "", chatModelInstalled: false, embedModelInstalled: false, message: "Local Ollama runs in your browser on this computer. Hosted search uses recipe keywords." };
  const baseUrl = env("OLLAMA_BASE_URL", DEFAULT_OLLAMA_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const model = requestedModel || env("OLLAMA_CHAT_MODEL", DEFAULT_OLLAMA_CHAT_MODEL);
  const embedModel = env("OLLAMA_EMBED_MODEL", DEFAULT_OLLAMA_EMBED_MODEL);

  try {
    const response = await fetchWithTimeout(`${baseUrl}/api/tags`, {
      headers: { accept: "application/json" }, signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        configured: true,
        reachable: true,
        model,
        embedModel,
        baseUrl,
        chatModelInstalled: false,
        embedModelInstalled: false,
        message: `Ollama responded with HTTP ${response.status}.`,
      };
    }

    const payload: unknown = await response.json();
    const installed = modelNames(payload);
    const chatModelInstalled = hasModel(installed, model);
    const embedModelInstalled = hasModel(installed, embedModel);
    const missing = [
      ...(!chatModelInstalled ? [model] : []),
      ...(!embedModelInstalled ? [embedModel] : []),
    ];

    return {
      ok: chatModelInstalled,
      configured: true,
      reachable: true,
      model,
      embedModel,
      baseUrl,
      chatModelInstalled,
      embedModelInstalled,
      message: missing.length
        ? `Ollama is running; pull missing model${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Embedding retrieval falls back to pantry scoring when its model is unavailable.`
        : "Ollama chat and embedding models are ready.",
    };
  } catch {
    return {
      ok: false,
      configured: true,
      reachable: false,
      model,
      embedModel,
      baseUrl,
      chatModelInstalled: false,
      embedModelInstalled: false,
      message: "Ollama is not reachable. Start the local Ollama service.",
    };
  }
}

function modelNames(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.models)) return [];
  return value.models.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== "string") return [];
    return [item.name];
  });
}

function hasModel(installed: string[], requested: string): boolean {
  return installed.some(
    (name) =>
      name === requested ||
      (!requested.includes(":") && name === `${requested}:latest`),
  );
}

function env(name: string, fallback = ""): string {
  const value =
    typeof process !== "undefined" && process.env
      ? process.env[name]
      : undefined;
  return value?.trim() || fallback;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
