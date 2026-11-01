import type { KitchenState, PantryStock, ShoppingPurchase } from "./kitchen-types";
import { buildShoppingList, parseMeasure, type ShoppingItem } from "./quantities";
import { addDateDays } from "./kitchen-state";
import { measureInputProblem } from "./kitchen-validation";

export interface PurchaseDraft { key: string; cycleId?: string; name: string; measure: string; pantryId: string }

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
    const problem = measureInputProblem(draft.measure);
    if (problem) return problem;
    if (parseMeasure(draft.measure)?.quantity === 0) return "Enter a positive purchased amount, or leave an unknown amount blank.";
  }
  return "";
}

/** Add separate batches: never merge an unknown amount, preparation or expiry. */
export function applyBoughtItems(state: KitchenState, week: string, today: string, drafts: PurchaseDraft[], id: string, at: string): KitchenState {
  if (state.shoppingPurchases?.some((purchase) => purchase.id === id) || purchasePreviewProblem(state, week, today, drafts)) return state;
  const items = drafts.map((draft) => ({ key: draft.key, ...(draft.cycleId ? { cycleId: draft.cycleId } : {}), pantry: { id: draft.pantryId, name: draft.name, measure: draft.measure.trim() } }));
  return { ...state, pantry: [...state.pantry, ...items.map((item) => item.pantry)],
    shoppingPurchases: [...(state.shoppingPurchases ?? []), { id, week, at, items }] };
}

function sameStock(current: PantryStock | undefined, original: PantryStock): boolean {
  return Boolean(current && current.name === original.name && current.measure === original.measure && current.useBy === original.useBy);
}

export function purchaseUndoProblem(state: KitchenState, purchase: ShoppingPurchase): string {
  if (!state.shoppingPurchases?.some((item) => item.id === purchase.id)) return "This purchase has already been undone.";
  if (purchase.items.some((item) => !sameStock(state.pantry.find((stock) => stock.id === item.pantry.id), item.pantry))) return "Purchased stock has been edited, removed or used. Adjust it in Pantry to keep later changes.";
  return "";
}

export function undoPurchase(state: KitchenState, id: string): KitchenState {
  const purchase = state.shoppingPurchases?.find((item) => item.id === id);
  if (!purchase || purchaseUndoProblem(state, purchase)) return state;
  const ids = new Set(purchase.items.map((item) => item.pantry.id));
  return { ...state, pantry: state.pantry.filter((stock) => !ids.has(stock.id)), shoppingPurchases: state.shoppingPurchases!.filter((item) => item.id !== id) };
}
