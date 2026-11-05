import type { AssistantIntent, AssistantIssue, KitchenActionDraft, PantryAction, TasteAction } from "./assistant-types";
import type { ChefPlanCatalog } from "./chef-plan-types";
import type { KitchenState, PantryStock } from "./kitchen-types";
import { canonicalIngredient, completeMeal, consumptionPreview, formatMeasure, parseMeasure } from "./quantities";
import { shoppingForWeek } from "./shopping-purchases";
import { applyChefPlanDraft, buildChefPlanDraft, ChefPlanError, validatePlanIntent } from "./chef-plan";
import { validateKitchenState } from "./kitchen-validation";
import { weekStart } from "./kitchen-state";

export interface AssistantActor { householdId: string; userId: string }
export interface AssistantBuildInput {
  actor: AssistantActor; kitchen: KitchenState; revision: number; catalog: ChefPlanCatalog;
  intent: AssistantIntent; week: string; today: string; previousDraft?: KitchenActionDraft;
  id?: string; createdAt?: string;
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown, maximum = 200) => typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
export const validAssistantDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
export function assistantToday(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
}
export function validateAssistantIntent(value: unknown): AssistantIntent {
  if (!record(value) || Object.keys(value).some(key => !["pantry", "planning", "tastes", "completion"].includes(key)) || !Array.isArray(value.pantry) || value.pantry.length > 30 || !Array.isArray(value.tastes) || value.tastes.length > 20) throw new ChefPlanError("Review a bounded list of pantry, dinner and taste changes.");
  const pantry: PantryAction[] = value.pantry.map(row => {
    if (!record(row) || Object.keys(row).some(key => !["kind", "name", "stockId", "measure", "useBy"].includes(key)) || !["add", "set", "subtract", "set_use_by", "remove"].includes(String(row.kind)) || !text(row.name) || row.stockId !== undefined && !text(row.stockId) || row.measure !== undefined && (typeof row.measure !== "string" || row.measure.length > 160) || row.useBy !== undefined && row.useBy !== null && !validAssistantDate(row.useBy)) throw new ChefPlanError("Check the pantry action, ingredient name, amount and explicit date.");
    return { kind: row.kind as PantryAction["kind"], name: String(row.name).trim(), ...(row.stockId ? { stockId: String(row.stockId) } : {}), ...(row.measure !== undefined ? { measure: String(row.measure).trim() } : {}), ...(row.useBy !== undefined ? { useBy: row.useBy as string | null } : {}) };
  });
  const tastes: TasteAction[] = value.tastes.map(row => {
    if (!record(row) || Object.keys(row).some(key => !["recipeId", "preference"].includes(key)) || !text(row.recipeId) || !["cook_again", "less_often", "clear"].includes(String(row.preference))) throw new ChefPlanError("Choose a recipe and an explicit taste preference.");
    return { recipeId: String(row.recipeId), preference: row.preference as TasteAction["preference"] };
  });
  if (new Set(tastes.map(row => row.recipeId)).size !== tastes.length) throw new ChefPlanError("Choose one taste preference per recipe.");
  let completion: AssistantIntent["completion"];
  if (value.completion !== undefined) {
    const row = value.completion;
    if (!record(row) || Object.keys(row).some(key => !["date", "deductStock"].includes(key)) || !validAssistantDate(row.date) || typeof row.deductStock !== "boolean") throw new ChefPlanError("Choose a saved dinner date and whether to deduct reviewed pantry amounts.");
    completion = { date: row.date, deductStock: row.deductStock };
  }
  return { pantry, tastes, ...(value.planning !== undefined ? { planning: validatePlanIntent(value.planning) } : {}), ...(completion ? { completion } : {}) };
}
export function assistantStable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(assistantStable).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${assistantStable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function assistantHash(value: unknown): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(assistantStable(value)))), byte => byte.toString(16).padStart(2, "0")).join("");
}
function hashedDraft(draft: KitchenActionDraft) {
  const { reviewHash: _reviewHash, ...reviewed } = draft;
  void _reviewHash;
  return reviewed;
}
function issue(id: string, message: string, actionIndex?: number, choices?: AssistantIssue["choices"]): AssistantIssue {
  return { id, message, blocking: true, ...(actionIndex !== undefined ? { actionIndex } : {}), ...(choices?.length ? { choices } : {}) };
}
async function calculate(input: AssistantBuildInput): Promise<{ draft: KitchenActionDraft; state: KitchenState }> {
  const { actor, revision, catalog, week, today } = input;
  if (!text(actor.householdId) || !text(actor.userId) || !Number.isSafeInteger(revision) || revision < 0 || !validAssistantDate(week) || weekStart(week) !== week || !validAssistantDate(today)) throw new ChefPlanError("Choose a valid household, saved revision and planning week.");
  const intent = validateAssistantIntent(input.intent);
  const id = input.id ?? input.previousDraft?.id ?? crypto.randomUUID(), createdAt = input.createdAt ?? new Date().toISOString();
  if (!text(id, 100) || !Number.isFinite(Date.parse(createdAt))) throw new ChefPlanError("Invalid draft identity.");
  if (intent.planning && (intent.planning.week !== week || intent.planning.today !== today)) throw new ChefPlanError("The dinner request belongs to another week or date.");
  if (input.previousDraft && (input.previousDraft.kitchenRevision !== revision || input.previousDraft.householdId !== actor.householdId || input.previousDraft.memberId !== actor.userId)) throw new ChefPlanError("This draft belongs to a different saved kitchen or member.", "action_changed", 409);
  let state = structuredClone(input.kitchen);
  const pantryChanges: KitchenActionDraft["pantryChanges"] = [], tasteChanges: KitchenActionDraft["tasteChanges"] = [], unresolved: AssistantIssue[] = [], summary: string[] = [];
  const proposedBatches = new Map<string, number>();
  for (const [index, action] of intent.pantry.entries()) {
    const parsed = action.measure !== undefined ? parseMeasure(action.measure) : null;
    if (["add", "set", "subtract"].includes(action.kind) && (!parsed || parsed.quantity === 0 && action.kind !== "set")) {
      unresolved.push(issue(`pantry:${index}:amount`, `Enter an explicit ${action.kind === "set" ? "nonnegative" : "positive"} amount for ${action.name}; package sizes and missing amounts are not assumed.`, index)); continue;
    }
    const matches = state.pantry.filter(stock => action.stockId ? stock.id === action.stockId && canonicalIngredient(stock.name) === canonicalIngredient(action.name) : canonicalIngredient(stock.name) === canonicalIngredient(action.name));
    if (action.kind !== "add" && matches.length !== 1) {
      unresolved.push(issue(`pantry:${index}:batch`, matches.length ? `Choose which ${action.name} batch to change.` : `No matching ${action.name} batch was found. Choose an existing batch or add new stock.`, index,
        matches.map(stock => ({ label: `${stock.name}: ${stock.measure || "unknown amount"}${stock.useBy ? ` · use by ${stock.useBy}` : " · no entered date"}`, stockId: stock.id })))); continue;
    }
    if (action.kind === "set_use_by" && action.useBy === undefined) { unresolved.push(issue(`pantry:${index}:date`, `Enter a use-by date for ${action.name}, or explicitly clear the date.`, index)); continue; }
    const before = action.kind === "add" ? null : structuredClone(matches[0]);
    let after: PantryStock | null = structuredClone(before);
    if (action.kind === "add") {
      const measure = formatMeasure(parsed!.quantity, parsed!.unit);
      const identity = (await assistantHash({ name: canonicalIngredient(action.name), measure, useBy: action.useBy ?? null })).slice(0, 32);
      const occurrence = proposedBatches.get(identity) ?? 0;
      proposedBatches.set(identity, occurrence + 1);
      // Reviewed batch choices survive a new preview and removal/reordering of
      // unrelated actions. Editing this batch's contents invalidates its choice.
      after = { id: `${id}:pantry:${identity}:${occurrence}`, name: action.name, measure };
    }
    if (action.kind === "set") after!.measure = formatMeasure(parsed!.quantity, parsed!.unit);
    if (action.kind === "subtract") {
      const current = parseMeasure(before!.measure);
      if (!current || current.dimension !== parsed!.dimension) { unresolved.push(issue(`pantry:${index}:units`, `The ${action.name} batch amount cannot be subtracted in those units. Enter compatible measured amounts.`, index)); continue; }
      if (parsed!.quantity > current.quantity) { unresolved.push(issue(`pantry:${index}:stock`, `The requested ${action.measure} exceeds the ${before!.measure} recorded for ${action.name}.`, index)); continue; }
      after!.measure = formatMeasure(current.quantity - parsed!.quantity, current.unit);
    }
    if (action.kind === "remove") after = null;
    if (after && action.useBy !== undefined) { if (action.useBy === null) delete after.useBy; else after.useBy = action.useBy; }
    if (before) state.pantry = state.pantry.filter(stock => stock.id !== before.id);
    if (after) state.pantry.push(after);
    pantryChanges.push({ actionIndex: index, before, after });
    summary.push(`${action.kind === "add" ? "Add" : action.kind === "remove" ? "Remove" : "Update"} ${action.name}${after ? `: ${after.measure}${after.useBy ? `, use by ${after.useBy}` : ""}` : ""}.`);
  }
  for (const action of intent.tastes) {
    const recipe = catalog.recipes.find(row => row.id === action.recipeId);
    const before = state.tastePreferences?.find(row => row.memberId === actor.userId && row.recipeId === action.recipeId) ?? null;
    if (!recipe && (action.preference !== "clear" || !before)) { unresolved.push(issue(`taste:${action.recipeId}`, "Choose a currently approved recipe for the taste preference.")); continue; }
    const after = action.preference === "clear" ? null : { memberId: actor.userId, recipeId: action.recipeId, preference: action.preference, updatedAt: createdAt };
    state.tastePreferences = (state.tastePreferences ?? []).filter(row => row.memberId !== actor.userId || row.recipeId !== action.recipeId);
    if (after) state.tastePreferences.push(after);
    tasteChanges.push({ before, after });
    summary.push(`${action.preference === "clear" ? "Clear my preference for" : action.preference === "cook_again" ? "I would cook again:" : "I prefer less often:"} ${recipe?.title ?? action.recipeId}. Shared with the household.`);
  }
  let completionChange: KitchenActionDraft["completionChange"];
  if (intent.completion) {
    const before = state.meals[intent.completion.date];
    if (!before || before.status === "cooked" || before.completion) unresolved.push(issue("completion:meal", "Choose a saved dinner that has not already been completed."));
    else {
      if (intent.completion.deductStock) for (const note of consumptionPreview(before, state.pantry, today).notes) unresolved.push({ id: `completion:note:${unresolved.length}`, message: note, blocking: false });
      const completed = completeMeal(state, before.date, intent.completion.deductStock, `${today}T12:00:00`);
      completed.meals[before.date].completion!.at = createdAt;
      completionChange = { before: structuredClone(before), after: structuredClone(completed.meals[before.date]) };
      const previousPantry = state.pantry;
      for (const stock of completed.pantry) {
        const prior = previousPantry.find(item => item.id === stock.id)!;
        if (assistantStable(prior) !== assistantStable(stock)) pantryChanges.push({ actionIndex: -1, before: prior, after: stock });
      }
      state = completed;
      summary.push(`Mark ${before.title} cooked${intent.completion.deductStock ? " and deduct the reviewed measured pantry amounts" : ""}.`);
    }
  }
  let planDraft: KitchenActionDraft["planDraft"];
  if (intent.planning && !unresolved.some(item => item.blocking)) {
    planDraft = await buildChefPlanDraft({ kitchen: state, revision, catalog, intent: intent.planning, previousDraft: input.previousDraft?.planDraft });
    intent.planning = planDraft.intent;
    unresolved.push(...planDraft.unresolved.map((message, index) => ({ id: `plan:${index}`, message, blocking: false })), ...planDraft.warnings.map((message, index) => ({ id: `plan:warning:${index}`, message, blocking: false })));
    if (planDraft.changes.length) {
      state = await applyChefPlanDraft({ kitchen: state, revision, catalog, draft: planDraft });
      summary.push(`Save ${planDraft.changes.length} reviewed dinner${planDraft.changes.length === 1 ? "" : "s"}.`);
    }
  }
  try { validateKitchenState(state); } catch (error) { throw new ChefPlanError(error instanceof Error ? error.message : "Check the proposed kitchen changes."); }
  const draft: KitchenActionDraft = { version: 1, id, householdId: actor.householdId, memberId: actor.userId, kitchenRevision: revision, week, today, createdAt, intent,
    pantryChanges, tasteChanges, ...(completionChange ? { completionChange } : {}), ...(planDraft ? { planDraft } : {}), beforeShopping: shoppingForWeek(input.kitchen, week, today), shopping: shoppingForWeek(state, week, today), unresolved, summary, reviewHash: "" };
  draft.reviewHash = await assistantHash(hashedDraft(draft));
  return { draft, state };
}
export async function buildKitchenActionDraft(input: AssistantBuildInput): Promise<KitchenActionDraft> { return (await calculate(input)).draft; }
export async function applyKitchenActionDraft(input: { actor: AssistantActor; kitchen: KitchenState; revision: number; catalog: ChefPlanCatalog; draft: KitchenActionDraft; today: string }): Promise<{ state: KitchenState; alreadyApplied: boolean }> {
  const draft = input.draft;
  if (!record(draft) || draft.version !== 1 || !text(draft.id, 100) || !text(draft.reviewHash) || draft.householdId !== input.actor.householdId || draft.memberId !== input.actor.userId) throw new ChefPlanError("This draft does not belong to the current household and member.", "action_changed", 409);
  const receipt = input.kitchen.recentActionReceipts?.find(row => row.id === draft.id);
  if (receipt) {
    if (receipt.reviewHash !== draft.reviewHash || receipt.memberId !== input.actor.userId) throw new ChefPlanError("An action with that identity was already used for another preview.", "action_changed", 409);
    return { state: input.kitchen, alreadyApplied: true };
  }
  if (!Array.isArray(draft.unresolved) || draft.unresolved.length > 100 || draft.unresolved.some(row => !record(row) || typeof row.blocking !== "boolean" || !text(row.message, 2000))
    || !Array.isArray(draft.pantryChanges) || draft.pantryChanges.length > 1000 || !Array.isArray(draft.tasteChanges) || draft.tasteChanges.length > 20
    || !Array.isArray(draft.shopping) || !Array.isArray(draft.beforeShopping) || !Array.isArray(draft.summary) || draft.summary.length > 60 || draft.summary.some(row => !text(row, 1000))
    || draft.planDraft !== undefined && (!record(draft.planDraft) || !Array.isArray(draft.planDraft.changes))) throw new ChefPlanError("The action preview is incomplete. Generate a new preview.");
  if (draft.kitchenRevision !== input.revision || draft.today !== input.today || await assistantHash(hashedDraft(draft)) !== draft.reviewHash) throw new ChefPlanError("The kitchen, date or preview changed. Review a fresh draft.", "action_changed", 409);
  if (draft.unresolved.some(row => row.blocking)) throw new ChefPlanError("Resolve the highlighted amounts and batch choices before applying.");
  // Rebuild pantry and taste changes canonically, then validate the exact reviewed
  // dinner selections rather than reranking recipes after a model response.
  const basic = await calculate({ actor: input.actor, kitchen: input.kitchen, revision: input.revision, catalog: input.catalog, intent: { ...validateAssistantIntent(draft.intent), planning: undefined }, week: draft.week, today: input.today, id: draft.id, createdAt: draft.createdAt });
  let state = basic.state;
  if (assistantStable(basic.draft.pantryChanges) !== assistantStable(draft.pantryChanges) || assistantStable(basic.draft.tasteChanges) !== assistantStable(draft.tasteChanges) || assistantStable(basic.draft.completionChange) !== assistantStable(draft.completionChange) || basic.draft.unresolved.some(row => row.blocking)) throw new ChefPlanError("The reviewed action no longer matches your kitchen.", "action_changed", 409);
  if (Boolean(draft.intent.planning) !== Boolean(draft.planDraft)) throw new ChefPlanError("The dinner portion of this combined preview is missing or changed.", "action_changed", 409);
  if (draft.planDraft?.changes.length) {
    if (assistantStable(draft.intent.planning) !== assistantStable(draft.planDraft.intent)) throw new ChefPlanError("The reviewed dinner request changed.", "action_changed", 409);
    state = await applyChefPlanDraft({ kitchen: state, revision: input.revision, catalog: input.catalog, draft: draft.planDraft });
  }
  const expectedSummary = [...basic.draft.summary, ...(draft.planDraft?.changes.length ? [`Save ${draft.planDraft.changes.length} reviewed dinner${draft.planDraft.changes.length === 1 ? "" : "s"}.`] : [])];
  if (assistantStable(expectedSummary) !== assistantStable(draft.summary)) throw new ChefPlanError("The reviewed action summary changed. Review a fresh preview.", "action_changed", 409);
  if (assistantStable(shoppingForWeek(state, draft.week, draft.today)) !== assistantStable(draft.shopping) || assistantStable(shoppingForWeek(input.kitchen, draft.week, draft.today)) !== assistantStable(draft.beforeShopping)) throw new ChefPlanError("Shopping needs changed. Review a new preview.", "action_changed", 409);
  if (!draft.pantryChanges.length && !draft.tasteChanges.length && !draft.completionChange && !draft.planDraft?.changes.length) throw new ChefPlanError("There are no reviewed changes to apply.");
  state = { ...state, recentActionReceipts: [...(state.recentActionReceipts ?? []).slice(-99), { id: draft.id, reviewHash: draft.reviewHash, memberId: input.actor.userId, appliedRevision: input.revision + 1, appliedAt: new Date().toISOString(), summary: draft.summary }] };
  try { validateKitchenState(state); } catch (error) { throw new ChefPlanError(error instanceof Error ? error.message : "Check the proposed kitchen changes."); }
  return { state, alreadyApplied: false };
}
