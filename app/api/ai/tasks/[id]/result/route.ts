import { requireHousehold, householdDb } from "@/app/lib/household";
import { AiError, aiHash, aiJson, aiWorkflowResponse, loadAiTask, type AiResume } from "@/app/lib/ai-inference";
export async function POST(request: Request, route: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const context = await requireHousehold(request), { id } = await route.params;
    const text = await request.text(); if (text.length > 100_000) throw new AiError("Model result is too large.", "invalid_result", 413);
    const input = JSON.parse(text);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["token", "rawOutput"].includes(key)) || typeof input.token !== "string" || input.token.length > 100 || typeof input.rawOutput !== "string" || input.rawOutput.length > 80_000) throw new AiError("Submit the task token and local model output.", "invalid_result", 400);
    const task = await loadAiTask(context, id, input.token), hash = await aiHash(input.rawOutput), db = await householdDb();
    if (task.status === "completed") {
      if (task.output_hash !== hash) throw new AiError("This task already received a different result.", "task_conflict", 409);
      return new Response(task.response_json, { status: task.response_status ?? 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    const claim = await db.prepare("UPDATE ai_model_tasks SET status='processing', output_hash=? WHERE id=? AND actor_id=? AND household_id=? AND status='pending' RETURNING id").bind(hash, id, context.userId, context.householdId).first();
    if (!claim) throw new AiError("This model task is already being processed. Retry the same result shortly.", "task_processing", 409);
    const resume: AiResume = { workflowId: task.workflow_id, transcript: [...JSON.parse(task.transcript_json), { requestHash: task.request_hash, rawOutput: input.rawOutput }] };
    const path = task.operation === "assistant" ? "/api/assistant" : task.operation === "plan" ? "/api/chef/plan" : "/api/chef";
    const continued = new Request(new URL(path, request.url), { method: "POST", headers: request.headers, body: task.input_json, signal: request.signal });
    let response: Response;
    try {
      if (task.operation === "assistant") response = await (await import("@/app/api/assistant/route")).executeAssistant(continued, resume);
      else if (task.operation === "plan") response = await (await import("@/app/api/chef/plan/route")).executePlan(continued, resume);
      else response = await (await import("@/app/api/chef/route")).executeChef(continued, resume);
    } catch (error) { response = aiWorkflowResponse(error) ?? aiJson({ error: { code: "ai_unavailable", message: "The model result could not be validated. Retry or use manual controls." } }, 502); }
    const payload = await response.text();
    const completed = await db.prepare("UPDATE ai_model_tasks SET status='completed', response_json=?, response_status=? WHERE id=? AND status='processing' RETURNING id").bind(payload, response.status, id).first();
    if (!completed) throw new AiError("Request cancelled.", "cancelled", 409);
    return new Response(payload, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch (error) { return aiWorkflowResponse(error) ?? aiJson({ error: { code: "invalid_result", message: "The model result could not be accepted." } }, 400); }
}
