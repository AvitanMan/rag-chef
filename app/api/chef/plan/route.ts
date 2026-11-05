import { buildChefPlanDraft, validatePlanIntent } from "@/app/lib/chef-plan";
import { defaultPlanIntent, requestChefPlanIntent } from "@/app/lib/chef-plan-intent";
import { loadPlanCatalog, planFailure, planJson, PlanHttpError, readPlanRequest } from "@/app/lib/chef-plan-http";
import { getKitchenDocument } from "@/app/lib/kitchen-store";
import { EMPTY_KITCHEN } from "@/app/lib/kitchen-types";
import type { ChefPlanDraft } from "@/app/lib/chef-plan-types";
import { requireHousehold, HouseholdAuthError, householdError } from "@/app/lib/household";
import { createAiWorkflow, aiWorkflowResponse, type AiResume } from "@/app/lib/ai-inference";
import { assistantToday } from "@/app/lib/assistant-engine";

export const POST = (request: Request) => executePlan(request);
export async function executePlan(request: Request, resume?: AiResume): Promise<Response> {
  const started = performance.now();
  try {
    const context = await requireHousehold(request);
    if (context.mode === "hosted" && !context.assistantEnabled) throw new PlanHttpError("The household assistant has not been enabled for this beta.", "assistant_disabled", 403);
    const input = await readPlanRequest(request);
    if (Object.keys(input).some(key => !["query", "week", "today", "kitchenRevision", "previousDraft", "intent", "provider", "model", "ai"].includes(key)) || typeof input.week !== "string" || typeof input.today !== "string" || !Number.isSafeInteger(input.kitchenRevision) || Number(input.kitchenRevision) < 0 || (input.model !== undefined && typeof input.model !== "string")) throw new PlanHttpError("Check the selected week and saved kitchen revision.", "invalid_request", 400);
    if (input.provider !== undefined && !["ollama", "openai", "lmstudio"].includes(String(input.provider))) throw new PlanHttpError("Choose a supported AI provider.", "invalid_request", 400);
    validatePlanIntent(defaultPlanIntent(input.week, input.today));
    if (context.mode === "hosted" && input.today !== assistantToday(context.timezone)) throw new PlanHttpError("The household date changed. Refresh before preparing another plan.", "plan_changed", 409);
    const kitchen = await getKitchenDocument(context);
    if (kitchen.revision !== input.kitchenRevision) throw new PlanHttpError("Your saved kitchen changed. Refresh it before preparing another draft.", "plan_changed", 409);
    const previousDraft = input.previousDraft as ChefPlanDraft | undefined;
    if (previousDraft && (previousDraft.version !== 1 || previousDraft.kitchenRevision !== kitchen.revision || !Array.isArray(previousDraft.changes) || previousDraft.changes.length > 7 || !previousDraft.intent)) throw new PlanHttpError("The previous draft changed. Start a new plan.", "plan_changed", 409);
    if (previousDraft) {
      validatePlanIntent(previousDraft.intent);
      if (previousDraft.changes.some(change => !change || typeof change !== "object" || typeof change.date !== "string" || !change.meal || typeof change.meal.recipeId !== "string" || typeof change.recipeHash !== "string" || change.expectedMealId !== null && typeof change.expectedMealId !== "string")) throw new PlanHttpError("The previous draft is malformed. Start a new plan.", "invalid_request", 400);
    }
    const catalog = await loadPlanCatalog();
    const workflow = input.intent === undefined ? await createAiWorkflow(request, context, { operation: "plan", input, kitchenRevision: kitchen.revision }, resume) : undefined;
    const interpreted = input.intent !== undefined ? { intent: validatePlanIntent(input.intent) } : await requestChefPlanIntent({ query: typeof input.query === "string" ? input.query : "", week: input.week, today: input.today, previousDraft, model: input.model as string | undefined, signal: request.signal, infer: workflow?.infer, catalog });
    if (interpreted.clarification) return planJson({ clarification: interpreted.clarification });
    if (!interpreted.intent || interpreted.intent.week !== input.week || interpreted.intent.today !== input.today) throw new PlanHttpError("The interpretation belongs to another week. Review the planning controls.", "invalid_request", 400);
    const draft = await buildChefPlanDraft({ kitchen: kitchen.state ?? structuredClone(EMPTY_KITCHEN), revision: kitchen.revision, catalog, intent: interpreted.intent, previousDraft });
    if ((await getKitchenDocument(context)).revision !== kitchen.revision) throw new PlanHttpError("Your kitchen changed while planning. Refresh it and prepare a new draft.", "plan_changed", 409);
    if (request.signal.aborted) throw new PlanHttpError("Planning request cancelled.", "cancelled", 499);
    return planJson({ draft: { ...draft, interpretation: input.intent !== undefined ? "manual" : workflow?.provider === "openai" ? "openai" : workflow?.provider === "browser_lmstudio" || workflow?.provider === "server_lmstudio" ? "lmstudio" : "ollama", timings: { totalMs: Math.round(performance.now() - started) } } });
  } catch (error) { return aiWorkflowResponse(error) ?? (error instanceof HouseholdAuthError ? householdError(error) : planFailure(error)); }
}
