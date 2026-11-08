import {
  DEFAULT_CHEF_PROVIDER,
  DEFAULT_OPENAI_MODEL,
  type ChefProvider,
} from "@/app/lib/chef-schema";

import { checkLMStudioReadiness } from "@/app/lib/lmstudio";
import { checkOllamaReadiness, verificationCapability } from "@/app/lib/provider-readiness";
import { hostedMode, requireHousehold, householdError, initializeHouseholdRuntime, requireLocalRequest, requireSecureLanAccess, householdSetting } from "@/app/lib/household";
import { redactedAiConnections } from "@/app/lib/ai-connections";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const HEALTH_TIMEOUT_MS = 5_000;

type ProviderHealth = {
  ok: boolean;
  configured: boolean;
  reachable: boolean;
  model: string;
  message: string;
};

export async function GET(request: Request): Promise<Response> {
  await initializeHouseholdRuntime();
  try { await requireSecureLanAccess(request); requireLocalRequest(request); } catch (error) { return householdError(error); }
  if (hostedMode()) {
    try {
      const context = await requireHousehold(request), connections = await redactedAiConnections(context);
      return Response.json({ ok: true, status: "ok", mode: "hosted", assistantEnabled: context.assistantEnabled, connections, message: "Recipe search is ready. Generation and verification use your personal AI connection.", capabilities: { embeddings: { ready: false, model: "", message: "Hosted recipe search uses keywords and pantry matches." } } }, { headers: { "cache-control": "no-store" } });
    } catch (error) { return householdError(error); }
  }
  const searchParams = new URL(request.url).searchParams;
  const requestedProvider = searchParams.get("provider");
  const requestedModel = searchParams.get("model")?.trim() ?? "";
  if (
    requestedProvider &&
    requestedProvider !== "ollama" &&
    requestedProvider !== "openai" &&
    requestedProvider !== "lmstudio"
  ) {
    return Response.json(
      {
        error: {
          code: "invalid_provider",
          message: 'provider must be "ollama", "openai", or "lmstudio".',
        },
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  if (requestedModel.length > 120) {
    return Response.json(
      {
        error: {
          code: "invalid_model",
          message: "model must be 120 characters or fewer.",
        },
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const [ollama, openai, lmstudio] = await Promise.all([
    checkOllamaReadiness(requestedProvider === "ollama" ? requestedModel : "", request.signal),
    checkOpenAI(requestedProvider === "openai" ? requestedModel : ""),
    requestedProvider === "lmstudio" || householdSetting("LMSTUDIO_MODEL")
      ? checkLMStudioReadiness(requestedProvider === "lmstudio" ? requestedModel : "", request.signal)
      : Promise.resolve({ ok: false, configured: false, reachable: false, model: "", message: "Select LM Studio and enter its model identifier to check the connection." }),
  ]);
  const requested = requestedProvider as ChefProvider | null;
  const selected = requested ?? DEFAULT_CHEF_PROVIDER;
  const selectedGeneration = selected === "ollama" ? ollama : selected === "lmstudio" ? lmstudio : openai;
  const verification = selected === "lmstudio" ? { ready: lmstudio.ok, model: lmstudio.model, message: "Answer verification uses your selected LM Studio model." } : selected === "openai" ? { ready: openai.ok, model: openai.model, message: "Answer verification uses your OpenAI connection." } : verificationCapability(ollama);
  const capabilities = {
    generation: { ready: selectedGeneration.ok, model: selectedGeneration.model, message: selectedGeneration.message },
    embeddings: { ready: ollama.embedModelInstalled, model: ollama.embedModel, message: ollama.embedModelInstalled
      ? "Semantic recipe search is ready." : "Semantic search is unavailable; recipe search still works with words and pantry matches." },
    verification,
  };
  const requestedOk = (requested ? selectedGeneration.ok : ollama.ok || openai.ok || lmstudio.ok) && verification.ready;
  const message = !selectedGeneration.ok ? selectedGeneration.message
    : !verification.ready ? `${selected === "openai" ? "OpenAI generation" : "Generation"} is available. ${verification.message} Browsing and calculated dinner amounts still work.`
    : selected === "lmstudio" ? "Chef generation and answer verification are ready through LM Studio." : selected === "openai" ? "Chef generation and answer verification are ready through OpenAI." : "Chef generation and local answer verification are ready.";

  return Response.json(
    {
      ok: requestedOk,
      status: requestedOk ? "ok" : "degraded",
      message,
      ...(!requestedOk ? { error: message } : {}),
      defaultProvider: DEFAULT_CHEF_PROVIDER,
      requestedProvider: requested,
      providers: { ollama, openai, lmstudio },
      capabilities,
      checkedAt: new Date().toISOString(),
    },
    {
      status: requested && !requestedOk ? 503 : 200,
      headers: { "cache-control": "no-store" },
    },
  );
}

async function checkOpenAI(requestedModel = ""): Promise<ProviderHealth> {
  const apiKey = env("OPENAI_API_KEY");
  const model = requestedModel || env("OPENAI_MODEL", DEFAULT_OPENAI_MODEL);
  if (!apiKey) {
    return {
      ok: false,
      configured: false,
      reachable: false,
      model,
      message: "OPENAI_API_KEY is not configured on the server.",
    };
  }

  const baseUrl = env("OPENAI_BASE_URL", DEFAULT_OPENAI_BASE_URL).replace(
    /\/+$/,
    "",
  );
  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/models/${encodeURIComponent(model)}`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
        },
      },
    );
    return {
      ok: response.ok,
      configured: true,
      reachable: true,
      model,
      message: response.ok
        ? "OpenAI credentials and model access are ready."
        : response.status === 401 || response.status === 403
          ? "OpenAI rejected the configured credentials."
          : response.status === 404
            ? `OpenAI model ${model} is not available to this project.`
            : `OpenAI responded with HTTP ${response.status}.`,
    };
  } catch {
    return {
      ok: false,
      configured: true,
      reachable: false,
      model,
      message: "OpenAI is not reachable from the server.",
    };
  }
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
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
