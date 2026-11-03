import { applyChefPlanDraft } from "@/app/lib/chef-plan";
import { loadPlanCatalog, planFailure, planJson, PlanHttpError, readPlanRequest } from "@/app/lib/chef-plan-http";
import { getKitchenDocument, KitchenConflictError, readCatalogRevision, saveKitchenDocument } from "@/app/lib/kitchen-store";
import { EMPTY_KITCHEN } from "@/app/lib/kitchen-types";
import type { ChefPlanDraft } from "@/app/lib/chef-plan-types";
import { requireHousehold, HouseholdAuthError, householdError } from "@/app/lib/household";
import { assistantToday } from "@/app/lib/assistant-engine";

export async function POST(request: Request): Promise<Response> {
  try {
    const context = await requireHousehold(request);
    if (context.mode === "hosted" && !context.assistantEnabled) throw new PlanHttpError("The household assistant has not been enabled for this beta.", "assistant_disabled", 403);
    const input = await readPlanRequest(request);
    if (Object.keys(input).some(key => key !== "draft") || !input.draft || typeof input.draft !== "object" || Array.isArray(input.draft)) throw new PlanHttpError("Review a plan before applying it.", "invalid_request", 400);
    const draft = input.draft as ChefPlanDraft;
    if (context.mode === "hosted" && draft.intent?.today !== assistantToday(context.timezone)) throw new PlanHttpError("The household date changed. Review a new plan before applying.", "plan_changed", 409);
    const kitchen = await getKitchenDocument(context);
    if (kitchen.revision !== draft.kitchenRevision) throw new PlanHttpError("Your kitchen changed or this plan was already applied. Refresh before applying another draft.", "plan_changed", 409);
    const catalogRevision = await readCatalogRevision();
    const catalog = await loadPlanCatalog();
    const state = await applyChefPlanDraft({ kitchen: kitchen.state ?? structuredClone(EMPTY_KITCHEN), revision: kitchen.revision, catalog, draft });
    if (request.signal.aborted) throw new PlanHttpError("Applying the plan was cancelled.", "cancelled", 499);
    return planJson(await saveKitchenDocument(kitchen.revision, state, context, { catalogRevision }));
  } catch (error) {
    if (error instanceof KitchenConflictError) return planJson({ error: { code: "plan_changed", message: "Another tab saved changes. Refresh the kitchen and review a new draft." }, current: error.current }, 409);
    return error instanceof HouseholdAuthError ? householdError(error) : planFailure(error);
  }
}
