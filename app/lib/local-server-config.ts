import { hostedMode, householdSetting, standaloneLanOrigins, secureLanMode } from "./household";
import { DEFAULT_OLLAMA_CHAT_MODEL, DEFAULT_OPENAI_MODEL } from "./chef-schema";
import type { AISelection } from "./browser-ai";

/** Only connection labels and model IDs are public. Keys and model endpoints stay server-side. */
export function publicLocalServerConfig(): { origins: string[]; requiresPassword: boolean; aiDefaults: AISelection } | undefined {
  if (hostedMode()) return undefined;
  const configured = householdSetting("RAG_CHEF_AI_PROVIDER");
  const provider = configured === "lmstudio" || configured === "openai" ? configured : "ollama";
  return {
    requiresPassword: secureLanMode(),
    origins: standaloneLanOrigins(householdSetting("RAG_CHEF_LAN_ORIGINS")),
    aiDefaults: {
      provider,
      ollamaModel: householdSetting("OLLAMA_CHAT_MODEL") || DEFAULT_OLLAMA_CHAT_MODEL,
      openaiModel: householdSetting("OPENAI_MODEL") || DEFAULT_OPENAI_MODEL,
      lmstudioModel: householdSetting("LMSTUDIO_MODEL"),
    },
  };
}
