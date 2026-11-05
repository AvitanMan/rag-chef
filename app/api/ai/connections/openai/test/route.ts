import { requireHousehold } from "@/app/lib/household";
import { readOpenAIConnection, runOpenAIInference } from "@/app/lib/ai-connections";
import { AiError, aiJson, aiWorkflowResponse } from "@/app/lib/ai-inference";
export async function POST(request: Request) {
  try {
    const context = await requireHousehold(request), connection = await readOpenAIConnection(context);
    if (!connection) throw new AiError("Add your own OpenAI key first.", "ai_connection_required", 400);
    const text = await request.text(); if (text.length > 1024) throw new AiError("Connection test request is too large.", "invalid_request", 400);
    const input = text ? JSON.parse(text) : {};
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "model") || input.model !== undefined && (typeof input.model !== "string" || !/^[\w.:-]{1,120}$/.test(input.model))) throw new AiError("Choose a valid model to test.", "invalid_request", 400);
    const model = input.model ?? connection.model;
    const value = await runOpenAIInference(connection, model, { operation: "connection_test", messages: [{ role: "user", content: "Return {\"ok\":true}." }], schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", enum: [true] } }, required: ["ok"] }, maxOutputTokens: 64 }, request.signal);
    if (!value || typeof value !== "object" || (value as { ok?: unknown }).ok !== true) throw new Error("Invalid test response.");
    return aiJson({ ok: true, model });
  } catch (error) { return aiWorkflowResponse(error) ?? aiJson({ error: { code: "connection_test_failed", message: "The OpenAI connection test failed. Check your key, model access, and account quota." } }, 502); }
}
