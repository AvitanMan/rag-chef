import { requireHousehold } from "@/app/lib/household";
import { getKitchenDocument, KitchenConflictError, readCatalogRevision, saveKitchenDocument } from "@/app/lib/kitchen-store";
import { EMPTY_KITCHEN } from "@/app/lib/kitchen-types";
import { loadPlanCatalog, planFailure, planJson, PlanHttpError, readPlanRequest } from "@/app/lib/chef-plan-http";
import { applyKitchenActionDraft, assistantToday } from "@/app/lib/assistant-engine";
import type { KitchenActionDraft } from "@/app/lib/assistant-types";
import { recordAssistantMetric } from "@/app/lib/assistant-metrics";

async function applyAssistant(request: Request, outcome: (result: "applied" | "replay") => void): Promise<Response> {
  try {
    const context = await requireHousehold(request);
    if (context.mode === "hosted" && !context.assistantEnabled) throw new PlanHttpError("The household assistant has not been enabled for this beta.", "assistant_disabled", 403);
    const input = await readPlanRequest(request);
    if (Object.keys(input).some(key => key !== "draft") || !input.draft || typeof input.draft !== "object" || Array.isArray(input.draft)) throw new PlanHttpError("Review a draft before applying it.", "invalid_request", 400);
    const draft = input.draft as KitchenActionDraft;
    const document = await getKitchenDocument(context);
    // Capture before reading recipes; the kitchen CAS verifies this same token.
    const catalogRevision = await readCatalogRevision();
    const catalog = await loadPlanCatalog();
    const prepared = await applyKitchenActionDraft({ actor: context, kitchen: document.state ?? structuredClone(EMPTY_KITCHEN), revision: document.revision, catalog, draft, today: context.mode === "hosted" ? assistantToday(context.timezone) : draft.today });
    if (prepared.alreadyApplied) { outcome("replay"); return planJson({ document, alreadyApplied: true, receipt: document.state?.recentActionReceipts?.find(row => row.id === draft.id) }); }
    if (request.signal.aborted) throw new PlanHttpError("Applying this draft was cancelled.", "cancelled", 499);
    try {
      const saved = await saveKitchenDocument(document.revision, prepared.state, context, { assistantAction: true, catalogRevision });
      outcome("applied");
      return planJson({ document: saved, alreadyApplied: false, receipt: saved.state?.recentActionReceipts?.find(row => row.id === draft.id) });
    } catch (error) {
      if (error instanceof KitchenConflictError) {
        const receipt = error.current.state?.recentActionReceipts?.find(row => row.id === draft.id && row.reviewHash === draft.reviewHash && row.memberId === context.userId);
        if (receipt) { outcome("replay"); return planJson({ document: error.current, alreadyApplied: true, receipt }); }
        return planJson({ error: { code: "action_changed", message: "Another member saved changes. Refresh and review a new draft." }, document: error.current }, 409);
      }
      throw error;
    }
  } catch (error) { return planFailure(error); }
}
export async function POST(request: Request): Promise<Response> {
  let result: "applied" | "replay" | undefined;
  const started = performance.now(), response = await applyAssistant(request, outcome => { result = outcome; });
  recordAssistantMetric({ operation: "apply", status: response.status, durationMs: performance.now() - started, result });
  return response;
}
