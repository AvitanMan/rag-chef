import { DEFAULT_CHEF_PROVIDER, DEFAULT_OLLAMA_CHAT_MODEL, DEFAULT_OPENAI_MODEL, type ChefProvider } from "./chef-schema";
import { checkOllamaReadiness, fetchProviderHealth, verificationCapability } from "./provider-readiness";
import type { HouseholdContext } from "./household";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
type ProviderHealth = { ok: boolean; configured: boolean; reachable: boolean; model: string; message: string };
export interface ChefHealthQuery { provider: string | null; model: string }
export interface ChefHealthResult { status: number; body: Record<string, unknown> }

/** Capability checks only; authorization and HTTP serialization belong to the Worker. */
export async function checkChefHealth(
  query: ChefHealthQuery,
  context: { household: HouseholdContext; signal?: AbortSignal },
  dependencies: { checkOllama?: typeof checkOllamaReadiness; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ChefHealthResult> {
  context.signal?.throwIfAborted();
  if (context.household.mode === "hosted") {
    const message = "Hosted AI connections are not enabled yet. Recipe browsing, saved directions, and calculated dinner amounts remain available.";
    const unavailable = { ready: false, model: "", message };
    return { status: 503, body: { ok: false, status: "degraded", message,
      capabilities: { generation: unavailable, embeddings: { ready: false, model: "", message: "Hosted search uses recipe names, ingredients, and pantry matches." }, verification: unavailable }, checkedAt: new Date().toISOString() } };
  }
  const requestedProvider = query.provider;
  const requestedModel = query.model.trim();
  if (requestedProvider && requestedProvider !== "ollama" && requestedProvider !== "openai") {
    return { status: 400, body: { error: { code: "invalid_provider", message: 'provider must be either "ollama" or "openai".' } } };
  }
  if (requestedModel.length > 120) return { status: 400, body: { error: { code: "invalid_model", message: "model must be 120 characters or fewer." } } };

  const checkOllama = dependencies.checkOllama ?? checkOllamaReadiness;
  const verifierModel = env("OLLAMA_CHAT_MODEL", DEFAULT_OLLAMA_CHAT_MODEL);
  const generationModel = requestedProvider === "ollama" ? requestedModel : "";
  const [ollama, openai, separateVerifier] = await Promise.all([
    checkOllama(generationModel, context.signal, dependencies),
    checkOpenAI(requestedProvider === "openai" ? requestedModel : "", context.signal, dependencies),
    // Verification always uses the configured local model, even when the user
    // selects another installed model for generation.
    generationModel && generationModel !== verifierModel ? checkOllama(verifierModel, context.signal, dependencies) : undefined,
  ]);
  context.signal?.throwIfAborted();
  const requested = requestedProvider as ChefProvider | null;
  const selected = requested ?? DEFAULT_CHEF_PROVIDER;
  const selectedGeneration = selected === "ollama" ? ollama : openai;
  const verification = verificationCapability(separateVerifier ?? ollama);
  const capabilities = {
    generation: { ready: selectedGeneration.ok, model: selectedGeneration.model, message: selectedGeneration.message },
    embeddings: { ready: ollama.embedModelInstalled, model: ollama.embedModel, message: ollama.embedModelInstalled
      ? "Semantic recipe search is ready." : "Semantic search is unavailable; recipe search still works with words and pantry matches." },
    verification,
  };
  const requestedOk = (requested ? selectedGeneration.ok : ollama.ok || openai.ok) && verification.ready;
  const message = !selectedGeneration.ok ? selectedGeneration.message
    : !verification.ready ? `${selected === "openai" ? "OpenAI generation" : "Generation"} is available. ${verification.message} Browsing and calculated dinner amounts still work.`
    : "Chef generation and local answer verification are ready.";
  return { status: requested && !requestedOk ? 503 : 200, body: {
    ok: requestedOk, status: requestedOk ? "ok" : "degraded", message,
    ...(!requestedOk ? { error: message } : {}), defaultProvider: DEFAULT_CHEF_PROVIDER,
    requestedProvider: requested, providers: { ollama, openai }, capabilities, checkedAt: new Date().toISOString(),
  } };
}

async function checkOpenAI(requestedModel: string, signal?: AbortSignal, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<ProviderHealth> {
  const apiKey = env("OPENAI_API_KEY");
  const model = requestedModel || env("OPENAI_MODEL", DEFAULT_OPENAI_MODEL);
  if (!apiKey) return { ok: false, configured: false, reachable: false, model, message: "OPENAI_API_KEY is not configured on the server." };
  const baseUrl = env("OPENAI_BASE_URL", DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  try {
    const response = await fetchProviderHealth(`${baseUrl}/models/${encodeURIComponent(model)}`, {
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` }, signal,
    }, options);
    return { ok: response.ok, configured: true, reachable: true, model,
      message: response.ok ? "OpenAI credentials and model access are ready."
        : response.status === 401 || response.status === 403 ? "OpenAI rejected the configured credentials."
          : response.status === 404 ? `OpenAI model ${model} is not available to this project.`
            : `OpenAI responded with HTTP ${response.status}.`,
    };
  } catch {
    return { ok: false, configured: true, reachable: false, model, message: "OpenAI is not reachable from the server." };
  }
}

function env(name: string, fallback = ""): string {
  return (typeof process !== "undefined" ? process.env?.[name]?.trim() : undefined) || fallback;
}
