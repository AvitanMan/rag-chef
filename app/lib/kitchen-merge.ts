import type { KitchenState, PantryStock, ShoppingPurchase } from "./kitchen-types";

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
  // Receipt IDs identify a preview, not a purchase: two tabs can review the same
  // key/cycle with different receipt and stock IDs. Resolve its live stock with
  // the history item, never by restoring the immutable receipt snapshot.
  type PurchaseItem = ShoppingPurchase["items"][number];
  type Purchase = { receiptId: string; item: PurchaseItem; stock: PantryStock | undefined };
  const stockOwners = new Map<string, string>();
  const purchases = (source: KitchenState | null): Record<string, Purchase> => {
    const result: Record<string, Purchase> = {};
    const receiptIds = new Set<string>();
    for (const receipt of source?.shoppingPurchases ?? []) {
      if (receiptIds.has(receipt.id)) throw new Error("Cannot merge duplicate purchase receipt IDs.");
      receiptIds.add(receipt.id);
      for (const item of receipt.items) {
        const key = JSON.stringify([item.key, item.cycleId ?? null]);
        if (result[key]) throw new Error("Cannot merge duplicate purchase cycles.");
        const owner = stockOwners.get(item.pantry.id);
        if (owner !== undefined && owner !== key) throw new Error("Cannot merge pantry stock shared by different purchases.");
        stockOwners.set(item.pantry.id, key);
        result[key] = { receiptId: receipt.id, item, stock: source?.pantry.find(stock => stock.id === item.pantry.id) };
      }
    }
    return result;
  };
  const originalPurchases = purchases(base), browserPurchases = purchases(browser), savedPurchases = purchases(saved);
  // A stock ID detached from its history may be unrelated/reused data. Do not
  // silently delete it while resolving another tab's purchase.
  for (const source of [base, browser, saved]) {
    const owned = new Set(source?.shoppingPurchases?.flatMap(receipt => receipt.items.map(item => item.pantry.id)));
    if (source?.pantry.some(stock => stockOwners.has(stock.id) && !owned.has(stock.id))) {
      throw new Error("Cannot merge purchased stock detached from its purchase history.");
    }
  }
  const selectedPurchases = [...new Set([...Object.keys(originalPurchases), ...Object.keys(browserPurchases), ...Object.keys(savedPurchases)])].flatMap(key => {
    const original = originalPurchases[key], mine = browserPurchases[key], theirs = savedPurchases[key];
    // Even without a common base, a purchase present on only one side is
    // independent, not evidence of an undo on the other side.
    const selected = !original && (!mine || !theirs) ? mine ?? theirs : choose(`Purchase cycle.${key}`, original, mine, theirs);
    return selected ? [selected] : [];
  });
  const shoppingPurchases: ShoppingPurchase[] = [];
  const selectedStockIds = new Set<string>();
  for (const purchase of selectedPurchases) {
    if (selectedStockIds.has(purchase.item.pantry.id)) throw new Error("Cannot merge duplicate purchased stock IDs.");
    selectedStockIds.add(purchase.item.pantry.id);
    let receipt = shoppingPurchases.find(receipt => receipt.id === purchase.receiptId);
    if (!receipt) {
      const header = (source: KitchenState | null) => {
        const value = source?.shoppingPurchases?.find(receipt => receipt.id === purchase.receiptId);
        return value && { id: value.id, week: value.week, at: value.at };
      };
      const mine = header(browser), theirs = header(saved);
      const metadata = mine && theirs ? choose(`Purchase receipt.${purchase.receiptId}`, header(base), mine, theirs) : mine ?? theirs;
      if (!metadata) throw new Error("Cannot merge a deleted receipt with retained purchase items.");
      receipt = { ...metadata, items: [] };
      shoppingPurchases.push(receipt);
    }
    if (!purchase.item.key.startsWith(`${receipt.week}:`)) throw new Error("Cannot merge purchase items from incompatible receipt weeks.");
    receipt.items.push(purchase.item);
  }
  const independentPantry = (source: KitchenState | null) => source?.pantry.filter(stock => !stockOwners.has(stock.id)) ?? [];
  const state: KitchenState = {
    ...saved,
    pantry: [...array("Pantry", independentPantry(base), independentPantry(browser), independentPantry(saved), item => item.id),
      ...selectedPurchases.flatMap(purchase => purchase.stock ? [purchase.stock] : [])],
    meals: record("Dinner", base?.meals ?? {}, browser.meals, saved.meals),
    shoppingChecked: record("Shopping checks", base?.shoppingChecked ?? {}, browser.shoppingChecked, saved.shoppingChecked),
    shoppingCycles: record("Shopping purchases", base?.shoppingCycles ?? {}, browser.shoppingCycles ?? {}, saved.shoppingCycles ?? {}),
    shoppingPurchases,
    favoriteRecipeIds: array("Favorite", base?.favoriteRecipeIds ?? [], browser.favoriteRecipeIds ?? [], saved.favoriteRecipeIds ?? [], item => item),
    personalRecipeAmounts: record("Recipe amounts", base?.personalRecipeAmounts ?? {}, browser.personalRecipeAmounts ?? {}, saved.personalRecipeAmounts ?? {}),
    cookingProfile: choose("Household requirements", base?.cookingProfile, browser.cookingProfile, saved.cookingProfile),
    // These are server-controlled action records, never restored from an old tab.
    tastePreferences: saved.tastePreferences,
    recentActionReceipts: saved.recentActionReceipts,
  };
  // Optional fields must be absent, rather than own properties with undefined,
  // for direct validation before the recovery draft is adopted.
  if (state.cookingProfile === undefined) delete state.cookingProfile;
  if (state.tastePreferences === undefined) delete state.tastePreferences;
  if (state.recentActionReceipts === undefined) delete state.recentActionReceipts;
  return { state, conflicts };
}
