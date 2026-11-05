import { requireHousehold } from "@/app/lib/household";
import { getKitchenDocument } from "@/app/lib/kitchen-store";
import { EMPTY_KITCHEN } from "@/app/lib/kitchen-types";
import { loadPlanCatalog, planFailure, planJson, PlanHttpError, readPlanRequest } from "@/app/lib/chef-plan-http";
import { aiWorkflowResponse, createAiWorkflow, type AiResume } from "@/app/lib/ai-inference";
import { assistantToday, buildKitchenActionDraft, validateAssistantIntent } from "@/app/lib/assistant-engine";
import { interpretAssistantRequest } from "@/app/lib/assistant-interpretation";
import type { KitchenActionDraft } from "@/app/lib/assistant-types";
import { recordAssistantMetric } from "@/app/lib/assistant-metrics";

async function prepareAssistant(request: Request, resume: AiResume | undefined, outcome: (result: "draft" | "clarification") => void): Promise<Response> {
  try {
    const context = await requireHousehold(request);
    if (context.mode === "hosted" && !context.assistantEnabled) throw new PlanHttpError("The household assistant has not been enabled for this beta.", "assistant_disabled", 403);
    const input = await readPlanRequest(request);
    if (Object.keys(input).some(key => !["query", "intent", "week", "today", "kitchenRevision", "previousDraft", "ai", "provider", "model"].includes(key)) || typeof input.week !== "string" || typeof input.today !== "string" || !Number.isSafeInteger(input.kitchenRevision) || Number(input.kitchenRevision) < 0) throw new PlanHttpError("Choose a planning week and saved kitchen revision.", "invalid_request", 400);
    if (input.provider !== undefined && !["ollama", "openai", "lmstudio"].includes(String(input.provider)) || input.model !== undefined && (typeof input.model !== "string" || !/^[\w./:-]{1,120}$/.test(input.model))) throw new PlanHttpError("Choose a supported AI provider and model.", "invalid_request", 400);
    const today = context.mode === "hosted" ? assistantToday(context.timezone) : input.today;
    if (input.today !== today) throw new PlanHttpError(`The household date is ${today}. Refresh the kitchen before preparing a draft.`, "action_changed", 409);
    const document = await getKitchenDocument(context);
    if (document.revision !== input.kitchenRevision) throw new PlanHttpError("The household kitchen changed. Refresh before preparing a draft.", "action_changed", 409);
    const previousDraft = input.previousDraft as KitchenActionDraft | undefined;
    if (previousDraft) {
      if (previousDraft.version !== 1 || previousDraft.householdId !== context.householdId || previousDraft.memberId !== context.userId || previousDraft.kitchenRevision !== document.revision || previousDraft.today !== today || previousDraft.week !== input.week || !Array.isArray(previousDraft.pantryChanges) || !Array.isArray(previousDraft.tasteChanges) || !Array.isArray(previousDraft.unresolved)) throw new PlanHttpError("The previous draft belongs to another kitchen, member or date. Prepare a new draft.", "action_changed", 409);
      validateAssistantIntent(previousDraft.intent);
      if (previousDraft.planDraft && (!Array.isArray(previousDraft.planDraft.changes) || previousDraft.planDraft.changes.some(row => !row || typeof row.date !== "string" || !row.meal || typeof row.meal.recipeId !== "string"))) throw new PlanHttpError("The prior dinner preview is invalid.", "invalid_request", 400);
    }
    const kitchen = document.state ?? structuredClone(EMPTY_KITCHEN), catalog = await loadPlanCatalog();
    const interpreted = input.intent !== undefined ? { intent: validateAssistantIntent(input.intent) } : await interpretAssistantRequest({ query: typeof input.query === "string" ? input.query : "", week: input.week, today, kitchen, catalog, previousDraft,
      infer: (await createAiWorkflow(request, context, { operation: "assistant", input, kitchenRevision: document.revision }, resume)).infer, signal: request.signal });
    if (interpreted.clarification) { outcome("clarification"); return planJson({ clarification: interpreted.clarification }); }
    if (!interpreted.intent) throw new PlanHttpError("Review an assistant request before preparing a draft.", "invalid_request", 400);
    const draft = await buildKitchenActionDraft({ actor: context, kitchen, revision: document.revision, catalog, intent: interpreted.intent, week: input.week, today, previousDraft });
    if ((await getKitchenDocument(context)).revision !== document.revision) throw new PlanHttpError("The household kitchen changed while preparing this draft. Refresh and try again.", "action_changed", 409);
    if (request.signal.aborted) throw new PlanHttpError("Preparing this draft was cancelled.", "cancelled", 499);
    outcome("draft"); return planJson({ draft });
  } catch (error) { return aiWorkflowResponse(error) ?? planFailure(error); }
}
export async function executeAssistant(request: Request, resume?: AiResume): Promise<Response> {
  let result: "draft" | "clarification" | undefined;
  const started = performance.now(), response = await prepareAssistant(request, resume, outcome => { result = outcome; });
  recordAssistantMetric({ operation: "prepare", status: response.status, durationMs: performance.now() - started, resumed: Boolean(resume), result });
  return response;
}
export async function POST(request: Request): Promise<Response> { return executeAssistant(request); }
