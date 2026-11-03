import type { AssistantIntent, KitchenActionDraft } from "./assistant-types";
import type { ChefPlanIntent } from "./chef-plan-types";

/** Swaps are commands for one turn. Keep permission for reviewed saved-dinner
 * replacements separately, so changing quantities never repeats the swap. */
export function editableAssistantIntent(draft: KitchenActionDraft): AssistantIntent {
  const intent = structuredClone(draft.intent);
  if (intent.planning && draft.planDraft) intent.planning = { ...intent.planning, replaceDates: [], authorizedReplacementDates: [...new Set([
    ...(intent.planning.authorizedReplacementDates ?? []), ...draft.planDraft.changes.filter(change => change.expectedMealId !== null).map(change => change.date),
  ])].sort() };
  return intent;
}
export function assistantReplacement(intent: ChefPlanIntent, date: string, selected: boolean): ChefPlanIntent {
  return { ...intent, replaceDates: selected ? [...new Set([...intent.replaceDates, date])] : intent.replaceDates.filter(value => value !== date),
    authorizedReplacementDates: selected ? intent.authorizedReplacementDates ?? [] : (intent.authorizedReplacementDates ?? []).filter(value => value !== date),
    keepDates: selected ? intent.keepDates.filter(value => value !== date) : intent.keepDates };
}
export function assistantKeep(intent: ChefPlanIntent, date: string, selected: boolean, saved: boolean): ChefPlanIntent {
  return { ...intent, keepDates: selected ? [...new Set([...intent.keepDates, date])] : intent.keepDates.filter(value => value !== date),
    replaceDates: selected ? intent.replaceDates.filter(value => value !== date) : intent.replaceDates,
    authorizedReplacementDates: selected && saved ? [...new Set([...(intent.authorizedReplacementDates ?? []), date])] : intent.authorizedReplacementDates ?? [] };
}
export function assistantDinnerCount(intent: ChefPlanIntent, count: number): ChefPlanIntent {
  return { ...intent, count, dates: [], replaceDates: [], authorizedReplacementDates: [], keepDates: [], perDate: {} };
}
