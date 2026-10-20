import {
  DEFAULT_CHEF_PROVIDER,
  DEFAULT_OLLAMA_CHAT_MODEL,
  DEFAULT_OLLAMA_EMBED_MODEL,
  DEFAULT_OPENAI_MODEL,
  type ChefProvider,
} from "@/app/lib/chef-schema";

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const HEALTH_TIMEOUT_MS = 5_000;

type ProviderHealth = {
  ok: boolean;
  configured: boolean;
  reachable: boolean;
  model: string;
  message: string;
};

type OllamaHealth = ProviderHealth & {
  baseUrl: string;
  embedModel: string;
  chatModelInstalled: boolean;
  embedModelInstalled: boolean;
};

export async function GET(request: Request): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;
  const requestedProvider = searchParams.get("provider");
  const requestedModel = searchParams.get("model")?.trim() ?? "";
  if (
    requestedProvider &&
    requestedProvider !== "ollama" &&
    requestedProvider !== "openai"
  ) {
    return Response.json(
      {
        error: {
          code: "invalid_provider",
          message: 'provider must be either "ollama" or "openai".',
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

  const [ollama, openai] = await Promise.all([
    checkOllama(requestedProvider === "ollama" ? requestedModel : ""),
    checkOpenAI(requestedProvider === "openai" ? requestedModel : ""),
  ]);
  const requested = requestedProvider as ChefProvider | null;
  const requestedOk = requested
    ? requested === "ollama"
      ? ollama.ok
      : openai.ok
    : ollama.ok || openai.ok;
  const message = requested
    ? requested === "ollama"
      ? ollama.message
      : openai.message
    : requestedOk
      ? "At least one chef provider is ready."
      : "No chef provider is currently ready.";

  return Response.json(
    {
      ok: requestedOk,
      status: requestedOk ? "ok" : "degraded",
      message,
      ...(!requestedOk ? { error: message } : {}),
      defaultProvider: DEFAULT_CHEF_PROVIDER,
      requestedProvider: requested,
      providers: { ollama, openai },
      checkedAt: new Date().toISOString(),
    },
    {
      status: requested && !requestedOk ? 503 : 200,
      headers: { "cache-control": "no-store" },
    },
  );
}

async function checkOllama(requestedModel = ""): Promise<OllamaHealth> {
  const baseUrl = env("OLLAMA_BASE_URL", DEFAULT_OLLAMA_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const model = requestedModel || env("OLLAMA_CHAT_MODEL", DEFAULT_OLLAMA_CHAT_MODEL);
  const embedModel = env("OLLAMA_EMBED_MODEL", DEFAULT_OLLAMA_EMBED_MODEL);

  try {
    const response = await fetchWithTimeout(`${baseUrl}/api/tags`, {
      headers: { accept: "application/json" },
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
      (!requested.includes(":") && name.startsWith(`${requested}:`)),
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
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
