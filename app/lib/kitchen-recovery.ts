import type { KitchenState } from "./kitchen-types";
import { KITCHEN_CACHE_KEY } from "./kitchen-state";
import { validateKitchenWrite } from "./kitchen-validation";

export type DraftReason = "edit" | "before-restore" | "before-recovery";
export interface CachedKitchen {
  revision: number;
  state: KitchenState;
  dirty: boolean;
  updatedAt?: string;
  reason?: DraftReason;
}
export interface KitchenDifferences {
  pantryAdded: number; pantryRemoved: number; pantryChanged: number;
  mealsAdded: number; mealsRemoved: number; mealsChanged: number;
  shoppingChanged: number;
}
export interface RecoveryCandidate {
  id: string;
  revision: number;
  updatedAt: string | null;
  reason: DraftReason;
  pantryCount: number;
  mealCount: number;
  differences: KitchenDifferences;
}
export interface RecoveryEntry { summary: RecoveryCandidate; cached: CachedKitchen; serialized: string }

export function parseCachedKitchen(text: string | null): CachedKitchen | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || typeof value.dirty !== "boolean") return null;
    validateKitchenWrite({ revision: value.revision, state: value.state });
    if (value.updatedAt !== undefined && (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) || new Date(value.updatedAt).toISOString() !== value.updatedAt)) return null;
    if (value.reason !== undefined && !["edit", "before-restore", "before-recovery"].includes(value.reason)) return null;
    return value as CachedKitchen;
  } catch { return null; }
}

export function compareKitchens(current: KitchenState, candidate: KitchenState): KitchenDifferences {
  const changes = <T,>(before: Record<string, T>, after: Record<string, T>) => {
    const added = Object.keys(after).filter((key) => !Object.hasOwn(before, key)).length;
    const removed = Object.keys(before).filter((key) => !Object.hasOwn(after, key)).length;
    const changed = Object.keys(after).filter((key) => Object.hasOwn(before, key) && JSON.stringify(before[key]) !== JSON.stringify(after[key])).length;
    return { added, removed, changed };
  };
  const pantry = changes(Object.fromEntries(current.pantry.map((stock) => [stock.id, stock])), Object.fromEntries(candidate.pantry.map((stock) => [stock.id, stock])));
  const meals = changes(current.meals, candidate.meals);
  const shopping = new Set([...Object.keys(current.shoppingChecked), ...Object.keys(candidate.shoppingChecked)]);
  return { pantryAdded: pantry.added, pantryRemoved: pantry.removed, pantryChanged: pantry.changed,
    mealsAdded: meals.added, mealsRemoved: meals.removed, mealsChanged: meals.changed,
    shoppingChanged: [...shopping].filter((key) => Boolean(current.shoppingChecked[key]) !== Boolean(candidate.shoppingChecked[key])).length };
}

/** Every record is parsed independently; damaged records never hide usable ones. */
export function readRecoveryDrafts(storage: Pick<Storage, "length" | "key" | "getItem">, current: KitchenState, excludedId = ""): RecoveryEntry[] {
  const entries: RecoveryEntry[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const id = storage.key(index);
    if (!id?.startsWith(`${KITCHEN_CACHE_KEY}:draft:`) || id === excludedId) continue;
    try {
      const serialized = storage.getItem(id);
      const cached = parseCachedKitchen(serialized);
      if (!cached?.dirty || !serialized || JSON.stringify(cached.state) === JSON.stringify(current)) continue;
      entries.push({ serialized, cached, summary: { id, revision: cached.revision, updatedAt: cached.updatedAt ?? null,
        reason: cached.reason ?? "edit", pantryCount: cached.state.pantry.length, mealCount: Object.keys(cached.state.meals).length,
        differences: compareKitchens(current, cached.state) } });
    } catch { /* A single inaccessible draft must not mask the remaining records. */ }
  }
  return entries.sort((a, b) => (b.summary.updatedAt ?? "").localeCompare(a.summary.updatedAt ?? "") || a.summary.id.localeCompare(b.summary.id));
}
