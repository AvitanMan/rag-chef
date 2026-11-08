import { requireHousehold } from "@/app/lib/household";
import { deleteOpenAIConnection, redactedAiConnections, saveOpenAIConnection } from "@/app/lib/ai-connections";
import { aiJson, aiWorkflowResponse } from "@/app/lib/ai-inference";
export async function GET(request: Request) { try { return aiJson(await redactedAiConnections(await requireHousehold(request))); } catch (error) { return aiWorkflowResponse(error) ?? aiJson({ error: { code: "connection_unavailable", message: "AI connections are unavailable." } }, 503); } }
export async function PUT(request: Request) {
  try {
    const context = await requireHousehold(request), text = await request.text();
    if (text.length > 2048) return aiJson({ error: { code: "invalid_request", message: "Connection request is too large." } }, 413);
    const input = JSON.parse(text);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["apiKey", "model"].includes(key))) return aiJson({ error: { code: "invalid_request", message: "Enter your personal OpenAI key and model." } }, 400);
    return aiJson(await saveOpenAIConnection(context, input.apiKey, input.model));
  } catch (error) { return aiWorkflowResponse(error) ?? aiJson({ error: { code: "connection_unavailable", message: "The connection could not be saved. Check your key or contact the household owner if encrypted storage is unavailable." } }, 400); }
}
export async function DELETE(request: Request) { try { return aiJson(await deleteOpenAIConnection(await requireHousehold(request))); } catch (error) { return aiWorkflowResponse(error) ?? aiJson({ error: { code: "connection_unavailable", message: "The connection could not be removed." } }, 503); } }
