import type { KitchenState, PantryStock, ShoppingPurchase } from "./kitchen-types";
import { buildShoppingList, parseMeasure, type ShoppingItem } from "./quantities";
import { addDateDays } from "./kitchen-state";
import { measureInputProblem } from "./kitchen-validation";

export interface PurchaseDraft { key: string; cycleId?: string; name: string; measure: string; useBy?: string; pantryId: string }

export interface ShoppingPurchaseSelection { purchaseId: string; key: string; cycleId?: string; pantryId: string }

export function shoppingForWeek(state: KitchenState, week: string, today: string): ShoppingItem[] {
  const end = addDateDays(week, 7);
  return buildShoppingList(Object.values(state.meals).filter((meal) => meal.date >= week && meal.date < end), state.pantry, today)
    .map((item) => ({ ...item, key: `${week}:${item.key}` }));
}

export function unappliedBoughtItems(state: KitchenState, items: ShoppingItem[]): ShoppingItem[] {
  const applied = new Set(state.shoppingPurchases?.flatMap((purchase) => purchase.items.map((item) => purchaseIdentity(item.key, item.cycleId))));
  return items.filter((item) => state.shoppingChecked[item.key] && !applied.has(purchaseIdentity(item.key, state.shoppingCycles?.[item.key])));
}

function purchaseIdentity(key: string, cycleId?: string): string {
  return JSON.stringify([key, cycleId ?? null]);
}

/** Retried events keep their identity; marking an item bought again starts a new purchase. */
export function setShoppingItemBought(state: KitchenState, key: string, bought: boolean, cycleId: string): KitchenState {
  if (Boolean(state.shoppingChecked[key]) === bought) return state;
  return { ...state, shoppingChecked: { ...state.shoppingChecked, [key]: bought },
    ...(bought ? { shoppingCycles: { ...state.shoppingCycles, [key]: cycleId } } : {}) };
}

/** Select the displayed receipt/batch, not whichever cycle is current when a stale event runs. */
export function beginShoppingPurchaseCycle(state: KitchenState, previous: ShoppingPurchaseSelection, cycleId: string, bought: boolean): KitchenState {
  if (!state.shoppingChecked[previous.key] || state.shoppingCycles?.[previous.key] !== previous.cycleId
    || !cycleId.trim() || cycleId.length > 200 || cycleId === previous.cycleId) return state;
  const receipt = state.shoppingPurchases?.find((purchase) => purchase.id === previous.purchaseId);
  if (!receipt?.items.some((item) => item.key === previous.key && item.cycleId === previous.cycleId && item.pantry.id === previous.pantryId)
    || state.shoppingPurchases?.some((purchase) => purchase.items.some((item) => item.key === previous.key && item.cycleId === cycleId))) return state;
  return { ...state, shoppingChecked: { ...state.shoppingChecked, [previous.key]: bought },
    shoppingCycles: { ...state.shoppingCycles, [previous.key]: cycleId } };
}

export function purchaseDraftProblems(draft: Pick<PurchaseDraft, "measure" | "useBy">): { measure: string; useBy: string } {
  const measure = measureInputProblem(draft.measure)
    || (parseMeasure(draft.measure)?.quantity === 0 ? "Enter a positive purchased amount, or leave an unknown amount blank." : "");
  let useBy = "";
  if (draft.useBy !== undefined && draft.useBy !== "") {
    const date = new Date(`${draft.useBy}T00:00:00.000Z`);
    if (typeof draft.useBy !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(draft.useBy) || Number(draft.useBy.slice(0, 4)) < 1
      || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== draft.useBy) useBy = "Enter a valid use-by date in YYYY-MM-DD format, or leave it blank.";
  }
  return { measure, useBy };
}

export function purchasePreviewProblem(state: KitchenState, week: string, today: string, drafts: PurchaseDraft[]): string {
  if (!drafts.length) return "Choose bought items to add.";
  if (state.pantry.length + drafts.length > 500) return "Make room in your pantry before adding these purchases.";
  if ((state.shoppingPurchases?.length ?? 0) >= 500 || (state.shoppingPurchases?.reduce((sum, p) => sum + p.items.length, 0) ?? 0) + drafts.length > 3_000) return "Export a backup and review your purchase history before adding more purchases.";
  const available = new Map(unappliedBoughtItems(state, shoppingForWeek(state, week, today)).map((item) => [item.key, item]));
  const keys = new Set<string>(), ids = new Set([...state.pantry.map((item) => item.id), ...(state.shoppingPurchases?.flatMap((purchase) => purchase.items.map((item) => item.pantry.id)) ?? [])]);
  for (const draft of drafts) {
    const source = available.get(draft.key);
    if (!source || source.name !== draft.name || draft.cycleId !== state.shoppingCycles?.[draft.key] || keys.has(draft.key) || ids.has(draft.pantryId)) return "Shopping or pantry changed. Close this preview and review the current bought items.";
    keys.add(draft.key); ids.add(draft.pantryId);
    const problems = purchaseDraftProblems(draft);
    if (problems.measure || problems.useBy) return problems.measure || problems.useBy;
  }
  return "";
}

/** Add separate batches: never merge an unknown amount, preparation or expiry. */
export function applyBoughtItems(state: KitchenState, week: string, today: string, drafts: PurchaseDraft[], id: string, at: string): KitchenState {
  if (state.shoppingPurchases?.some((purchase) => purchase.id === id) || purchasePreviewProblem(state, week, today, drafts)) return state;
  const items = drafts.map((draft) => ({ key: draft.key, ...(draft.cycleId ? { cycleId: draft.cycleId } : {}),
    pantry: { id: draft.pantryId, name: draft.name, measure: draft.measure.trim(), ...(draft.useBy ? { useBy: draft.useBy } : {}) } }));
  return { ...state, pantry: [...state.pantry, ...items.map((item) => item.pantry)],
    shoppingPurchases: [...(state.shoppingPurchases ?? []), { id, week, at, items }] };
}

function sameStock(current: PantryStock | undefined, original: PantryStock): boolean {
  if (!current || current.name !== original.name || current.useBy !== original.useBy) return false;
  if (current.measure === original.measure) return true;
  const amount = parseMeasure(current.measure), purchased = parseMeasure(original.measure);
  // Cooking undo can normalize units. Unknown notes must still match verbatim.
  return Boolean(amount && purchased && amount.dimension === purchased.dimension && amount.unit === purchased.unit
    && amount.quantity === purchased.quantity);
}

export function purchaseUndoProblem(state: KitchenState, purchase: ShoppingPurchase): string {
  const recorded = state.shoppingPurchases?.find((item) => item.id === purchase.id);
  if (!recorded) return "This purchase has already been undone.";
  if (recorded.items.some((item) => !sameStock(state.pantry.find((stock) => stock.id === item.pantry.id), item.pantry))) return "Purchased stock has been edited, removed or used. Adjust it in Pantry to keep later changes.";
  return "";
}

export function undoPurchase(state: KitchenState, id: string): KitchenState {
  const purchase = state.shoppingPurchases?.find((item) => item.id === id);
  if (!purchase || purchaseUndoProblem(state, purchase)) return state;
  const ids = new Set(purchase.items.map((item) => item.pantry.id));
  return { ...state, pantry: state.pantry.filter((stock) => !ids.has(stock.id)), shoppingPurchases: state.shoppingPurchases!.filter((item) => item.id !== id) };
}
