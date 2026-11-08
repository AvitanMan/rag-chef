import type { HouseholdContext } from "./household";
import { householdDb, householdSetting } from "./household";
import type { StructuredInferenceRequest } from "./ai-inference";

type ConnectionRow = { user_id: string; cipher_text: string; iv: string; key_version: string; last_four: string; model: string; updated_at: string };
export type OpenAIConnection = { apiKey: string; model: string };
const bytes = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const encoded = (value: Uint8Array) => btoa(String.fromCharCode(...value));
async function secret(name: string): Promise<string> {
  return householdSetting(name);
}
async function encryptionKey(version: string): Promise<CryptoKey> {
  if (!/^v[1-9]\d*$/.test(version)) throw new Error("AI credential encryption version is invalid.");
  const value = await secret(`AI_CREDENTIALS_ENCRYPTION_KEY_${version.toUpperCase()}`);
  let decoded: Uint8Array<ArrayBuffer>; try { decoded = bytes(value); } catch { throw new Error("AI credential encryption is unavailable."); }
  if (decoded.length !== 32) throw new Error("AI credential encryption is unavailable.");
  return crypto.subtle.importKey("raw", decoded, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptAiCredential(apiKey: string, userId: string, version: string): Promise<{ cipherText: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`openai:${userId}:${version}`) }, await encryptionKey(version), new TextEncoder().encode(apiKey));
  return { cipherText: encoded(new Uint8Array(cipher)), iv: encoded(iv) };
}
export async function decryptAiCredential(cipherText: string, iv: string, userId: string, version: string): Promise<string> {
  const result = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(iv), additionalData: new TextEncoder().encode(`openai:${userId}:${version}`) }, await encryptionKey(version), bytes(cipherText));
  return new TextDecoder().decode(result);
}
async function rowFor(context: HouseholdContext): Promise<ConnectionRow | null> { return (await householdDb()).prepare("SELECT * FROM ai_connections WHERE user_id = ? AND provider = 'openai'").bind(context.userId).first<ConnectionRow>(); }
export async function redactedAiConnections(context: HouseholdContext) {
  const row = await rowFor(context);
  return { openai: { configured: Boolean(row), model: row?.model ?? "gpt-4.1-mini", ...(row ? { lastFour: row.last_four, updatedAt: row.updated_at } : {}) }, availableProviders: ["openai", "browser_ollama", "browser_lmstudio"] };
}
export async function saveOpenAIConnection(context: HouseholdContext, apiKey: unknown, model: unknown) {
  if (typeof apiKey !== "string" || !/^sk-[A-Za-z0-9_-]{20,509}$/.test(apiKey) || model !== undefined && (typeof model !== "string" || !/^[\w.:-]{1,120}$/.test(model))) throw new Error("Enter a valid OpenAI API key and model.");
  const version = await secret("AI_CREDENTIALS_KEY_VERSION") || "v1";
  const encrypted = await encryptAiCredential(apiKey, context.userId, version);
  await (await householdDb()).prepare("INSERT INTO ai_connections (user_id, provider, cipher_text, iv, key_version, last_four, model, updated_at) VALUES (?, 'openai', ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, provider) DO UPDATE SET cipher_text=excluded.cipher_text, iv=excluded.iv, key_version=excluded.key_version, last_four=excluded.last_four, model=excluded.model, updated_at=excluded.updated_at").bind(context.userId, encrypted.cipherText, encrypted.iv, version, apiKey.slice(-4), model ?? "gpt-4.1-mini", new Date().toISOString()).run();
  return redactedAiConnections(context);
}
export async function deleteOpenAIConnection(context: HouseholdContext) { await (await householdDb()).prepare("DELETE FROM ai_connections WHERE user_id = ? AND provider = 'openai'").bind(context.userId).run(); return redactedAiConnections(context); }
export async function readOpenAIConnection(context: HouseholdContext): Promise<OpenAIConnection | undefined> {
  const row = await rowFor(context); if (!row) return undefined;
  return { apiKey: await decryptAiCredential(row.cipher_text, row.iv, context.userId, row.key_version), model: row.model };
}
export async function runOpenAIInference(connection: OpenAIConnection, model: string, inference: StructuredInferenceRequest, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", redirect: "manual", headers: { authorization: `Bearer ${connection.apiKey}`, "content-type": "application/json" }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000), body: JSON.stringify({ model, store: false, input: inference.messages, max_output_tokens: inference.maxOutputTokens ?? 1400, text: { format: { type: "json_schema", name: "rag_chef_response", strict: true, schema: inference.schema } } }) });
  if (!response.ok) throw new Error(response.status === 401 ? "Your OpenAI key was rejected. Update your personal connection." : response.status === 429 ? "Your OpenAI connection reached its usage limit. Check your account or retry later." : "Your OpenAI connection is unavailable. Retry or use manual controls.");
  const text = await response.text(); if (text.length > 200_000) throw new Error("OpenAI returned an oversized response.");
  const result = JSON.parse(text);
  if (result.status === "incomplete" || result.error) throw new Error("OpenAI did not complete the response.");
  const content = result.output?.flatMap((item: { content?: Array<{ type?: string; text?: string }> }) => item.content ?? []).filter((part: { type?: string }) => part.type === "output_text").map((part: { text?: string }) => part.text ?? "").join("");
  if (typeof content !== "string" || !content) throw new Error("OpenAI returned no structured answer.");
  return JSON.parse(content);
}
