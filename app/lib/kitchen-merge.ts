import type { KitchenState } from "./kitchen-types";

export interface KitchenMergeConflict { path: string; browser: unknown; saved: unknown }
/** Merge independent edits; a shared row is resolved only by the review choice. */
export function mergeKitchenDraft(base: KitchenState | null, browser: KitchenState, saved: KitchenState, preferBrowser = false): { state: KitchenState; conflicts: KitchenMergeConflict[] } {
  const conflicts: KitchenMergeConflict[] = [];
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const choose = <T,>(path: string, original: T | undefined, mine: T | undefined, theirs: T | undefined): T | undefined => {
    if (equal(mine, theirs)) return theirs;
    if (base && equal(mine, original)) return theirs;
    if (base && equal(theirs, original)) return mine;
    conflicts.push({ path, browser: mine, saved: theirs });
    // A newly locked or cooked dinner stays protected during conflict recovery.
    const protectedDinner = path.startsWith("Dinner.") && theirs && typeof theirs === "object" && ("locked" in theirs && theirs.locked || "status" in theirs && theirs.status === "cooked");
    return preferBrowser && !protectedDinner ? mine : theirs;
  };
  const record = <T,>(path: string, original: Record<string, T>, mine: Record<string, T>, theirs: Record<string, T>): Record<string, T> => Object.fromEntries(
    [...new Set([...Object.keys(original), ...Object.keys(mine), ...Object.keys(theirs)])].flatMap(key => {
      const value = choose(`${path}.${key}`, original[key], mine[key], theirs[key]);
      return value === undefined ? [] : [[key, value]];
    }),
  );
  const array = <T,>(path: string, original: T[], mine: T[], theirs: T[], identity: (value: T) => string) => Object.values(record(path,
    Object.fromEntries(original.map(item => [identity(item), item])), Object.fromEntries(mine.map(item => [identity(item), item])), Object.fromEntries(theirs.map(item => [identity(item), item]))));
  const state: KitchenState = {
    ...saved,
    pantry: array("Pantry", base?.pantry ?? [], browser.pantry, saved.pantry, item => item.id),
    meals: record("Dinner", base?.meals ?? {}, browser.meals, saved.meals),
    shoppingChecked: record("Shopping checks", base?.shoppingChecked ?? {}, browser.shoppingChecked, saved.shoppingChecked),
    shoppingCycles: record("Shopping purchases", base?.shoppingCycles ?? {}, browser.shoppingCycles ?? {}, saved.shoppingCycles ?? {}),
    shoppingPurchases: array("Purchase", base?.shoppingPurchases ?? [], browser.shoppingPurchases ?? [], saved.shoppingPurchases ?? [], item => item.id),
    favoriteRecipeIds: array("Favorite", base?.favoriteRecipeIds ?? [], browser.favoriteRecipeIds ?? [], saved.favoriteRecipeIds ?? [], item => item),
    personalRecipeAmounts: record("Recipe amounts", base?.personalRecipeAmounts ?? {}, browser.personalRecipeAmounts ?? {}, saved.personalRecipeAmounts ?? {}),
    cookingProfile: choose("Household requirements", base?.cookingProfile, browser.cookingProfile, saved.cookingProfile),
    // These are server-controlled action records, never restored from an old tab.
    tastePreferences: saved.tastePreferences,
    recentActionReceipts: saved.recentActionReceipts,
  };
  return { state, conflicts };
}
