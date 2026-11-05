import { requireHousehold, householdDb } from "@/app/lib/household";
import { AiError, aiJson, aiWorkflowResponse, loadAiTask } from "@/app/lib/ai-inference";
export async function DELETE(request: Request, route: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireHousehold(request), { id } = await route.params;
    const text = await request.text(); if (text.length > 1024) throw new AiError("Invalid cancellation request.", "invalid_request", 400);
    const input = JSON.parse(text); if (typeof input?.token !== "string") throw new AiError("Provide the task token.", "invalid_request", 400);
    const task = await loadAiTask(context, id, input.token, true);
    await (await householdDb()).prepare("UPDATE ai_model_tasks SET status='cancelled', response_json=NULL, transcript_json='[]', input_json='{}' WHERE workflow_id=? AND actor_id=? AND household_id=?").bind(task.workflow_id, context.userId, context.householdId).run();
    return aiJson({ cancelled: true });
  } catch (error) { return aiWorkflowResponse(error) ?? aiJson({ error: { code: "cancel_failed", message: "The model task could not be cancelled." } }, 400); }
}
