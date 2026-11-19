import type { KitchenState, PantryStock, PlannedMeal, ShoppingPurchase } from "./kitchen-types";
import { parseMeasure, undoMeal } from "./quantities";
import { validateKitchenState, validateKitchenWrite } from "./kitchen-validation";

type CombineResult = { state: KitchenState; reason?: never } | { reason: string; state?: never };
type Rows<T> = Map<string, T>;
type ThreeVersions<T> = readonly [base: T, draft: T, saved: T];
type Completion = NonNullable<PlannedMeal["completion"]>;
type ShoppingRow = { checked?: boolean; cycle?: string };
type Purchase = {
  receipt: { id: string; week: string; at: string };
  item: ShoppingPurchase["items"][number];
  stock: PantryStock | undefined;
};

// Kitchen data is validated JSON. Field insertion order can differ after storage.
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const entries = Object.entries(left);
  const other = right as Record<string, unknown>;
  return entries.length === Object.keys(other).length && entries.every(([key, value]) => Object.hasOwn(other, key) && equal(value, other[key]));
}

function select<T>(label: string, base: T, draft: T, saved: T): T {
  if (equal(draft, saved) || equal(draft, base)) return saved;
  if (equal(saved, base)) return draft;
  throw new Error(`Both versions changed ${label}.`);
}

function mergeRows<T>(base: Rows<T>, draft: Rows<T>, saved: Rows<T>,
  choose: (key: string, original?: T, mine?: T, theirs?: T) => T | undefined): Rows<T> {
  const result = new Map<string, T>();
  for (const key of new Set([...saved.keys(), ...draft.keys(), ...base.keys()])) {
    const value = choose(key, base.get(key), draft.get(key), saved.get(key));
    if (value !== undefined) result.set(key, value);
  }
  return result;
}

function byId<T extends { id: string }>(items: T[]): Rows<T> {
  return new Map(items.map(item => [item.id, item]));
}

function purchaseRows(state: KitchenState, pantry: Rows<PantryStock>, owners: Rows<string>): Rows<Purchase> {
  const rows = new Map<string, Purchase>();
  for (const { id, week, at, items } of state.shoppingPurchases ?? []) {
    for (const item of items) {
      const key = JSON.stringify([item.key, item.cycleId ?? null]);
      const stockId = item.pantry.id;
      if (owners.has(stockId) && owners.get(stockId) !== key) throw new Error("Different purchases refer to the same pantry batch.");
      owners.set(stockId, key);
      rows.set(key, { receipt: { id, week, at }, item, stock: pantry.get(stockId) });
    }
  }
  return rows;
}

function stockFields(stock: PantryStock) {
  return [stock.name, stock.measure, stock.useBy, stock.location];
}

function protectedDinnerChange(saved: PlannedMeal, candidate?: PlannedMeal) {
  if (!candidate) return false;
  // These are the existing lock, completion and Undo transitions. The
  // dinner's identity, ingredients and reviewed portions must stay intact.
  if (saved.status === "cooked") {
    const undone = { ...saved, status: "planned" };
    delete undone.completion;
    return equal(candidate, undone);
  }
  if (candidate.status === "cooked") return equal(candidate, { ...saved, status: "cooked", completion: candidate.completion });
  return equal(candidate, { ...saved, locked: false });
}

function changedDeductions(base: KitchenState, branch: KitchenState) {
  const changes = new Map<string, Rows<Completion | null>>();
  for (const date of new Set([...Object.keys(base.meals), ...Object.keys(branch.meals)])) {
    const before = base.meals[date]?.completion, after = branch.meals[date]?.completion;
    if (equal(before, after)) continue;
    const stockIds = new Set([...(before?.deductions ?? []), ...(after?.deductions ?? [])].map(deduction => deduction.pantryId));
    for (const id of stockIds) {
      const dates = changes.get(id) ?? new Map<string, Completion | null>();
      dates.set(date, after ?? null);
      changes.set(id, dates);
    }
  }
  return changes;
}

function shoppingRows(state: KitchenState): Rows<ShoppingRow> {
  const checked = new Map(Object.entries(state.shoppingChecked));
  const cycles = new Map(Object.entries(state.shoppingCycles ?? {}));
  const rows = new Map<string, ShoppingRow>();
  for (const key of new Set([...checked.keys(), ...cycles.keys()])) {
    rows.set(key, { checked: checked.get(key), cycle: cycles.get(key) });
  }
  return rows;
}

function checkCookingOverlap(base: KitchenState, draft: KitchenState, saved: KitchenState, stocks: ThreeVersions<Rows<PantryStock>>) {
  const mine = changedDeductions(base, draft);
  const theirs = changedDeductions(base, saved);
  const [originalStock, draftStock, savedStock] = stocks;
  const sharedUndos = new Set<string>();
  // Two dinners can each reduce 100 g to 50 g. Equal remaining stock alone
  // would lose a deduction and let both dinners add it back during Undo.
  for (const id of new Set([...mine.keys(), ...theirs.keys()])) {
    const local = mine.get(id);
    const remote = theirs.get(id);
    if (local && remote) {
      const sameCompletions = local.size === remote.size
        && [...local].every(([date, change]) => remote.has(date) && equal(change, remote.get(date)));
      if (!sameCompletions || !equal(draftStock.get(id), savedStock.get(id))) {
        throw new Error("Both versions used the same pantry batch while cooking.");
      }
      for (const [date, completion] of local) {
        if (completion === null) sharedUndos.add(date);
      }
    } else if (!equal(originalStock.get(id), (local ? savedStock : draftStock).get(id))) {
      throw new Error("A cooking deduction overlaps another change to the same pantry batch.");
    }
  }

  if (sharedUndos.size) {
    // An Undo can restore a missing batch under a new ID. Replay the shared
    // restorations so equal, partially used batches cannot hide two uses.
    let restored = base;
    for (const date of sharedUndos) {
      const next = undoMeal(restored, date);
      if (next === restored) throw new Error("The shared cooking Undo could not restore its pantry stock.");
      restored = next;
    }
    for (const batch of restored.pantry) {
      if (!equal(originalStock.get(batch.id), batch)
        && (!equal(draftStock.get(batch.id), batch) || !equal(savedStock.get(batch.id), batch))) {
        throw new Error("A shared cooking Undo overlaps another change to its restored pantry batch.");
      }
    }
  }

  for (const [id, batch] of originalStock) {
    const local = draftStock.get(id);
    const remote = savedStock.get(id);
    if (!local || !remote || local.measure === batch.measure || local.measure !== remote.measure) continue;
    const before = parseMeasure(batch.measure), after = parseMeasure(local.measure);
    if (!before || !after || before.dimension !== after.dimension || after.quantity >= before.quantity) continue;
    // The same final level can represent two independent uses. Accept a
    // single matching completion only when it accounts for the full delta.
    const changes = mine.get(id);
    const [date, completion] = changes?.size === 1 ? [...changes][0] : [];
    const deduction = completion?.deductions.find(row => row.pantryId === id);
    if (!date || base.meals[date]?.completion || !theirs.get(id)?.has(date)
      || !deduction || !equal(parseMeasure(deduction.before), before) || !equal(parseMeasure(deduction.after), after)) {
      throw new Error("Both versions reduced the same pantry batch.");
    }
  }
}

function receiptDetails(receipt?: ShoppingPurchase) {
  if (!receipt) return undefined;
  const items = receipt.items.map(item => JSON.stringify([item.key, item.cycleId ?? null])).sort();
  return { week: receipt.week, at: receipt.at, items };
}

function checkReceiptIds(base: KitchenState, draft: KitchenState, saved: KitchenState) {
  const originals = byId(base.shoppingPurchases ?? []);
  const savedReceipts = byId(saved.shoppingPurchases ?? []);
  for (const receipt of draft.shoppingPurchases ?? []) {
    const remote = savedReceipts.get(receipt.id);
    if (remote) select("the same purchase receipt", receiptDetails(originals.get(receipt.id)), receiptDetails(receipt), receiptDetails(remote));
  }
}

function selectPurchase(checks: ThreeVersions<Rows<ShoppingRow>>, referenced: Set<string>,
  original?: Purchase, local?: Purchase, remote?: Purchase) {
  const key = (original ?? local ?? remote)!.item.key;
  const [baseChecks, localChecks, remoteChecks] = checks;
  const baseRow = baseChecks.get(key), localRow = localChecks.get(key), remoteRow = remoteChecks.get(key);

  // A purchase review is tied to the shopping item's checked flag and cycle.
  if (!equal(localRow, remoteRow)) {
    const draftChangedShopping = !equal(localRow, baseRow);
    const savedChangedShopping = !equal(remoteRow, baseRow);
    if (draftChangedShopping && !equal(remote?.item, original?.item) || savedChangedShopping && !equal(local?.item, original?.item)) {
      throw new Error("A shopping change overlaps a purchase for the same item.");
    }
  }
  if (!original && local && remote) {
    // Matching balances can hide two independent uses after the purchase.
    if (!equal(local.stock, local.item.pantry) || !equal(remote.stock, remote.item.pantry)) {
      throw new Error("A pantry batch changed after both versions recorded the same purchase.");
    }
    if (!equal(stockFields(local.item.pantry), stockFields(remote.item.pantry))) {
      throw new Error("Both versions recorded different stock for the same purchase.");
    }
    if (local.item.pantry.id !== remote.item.pantry.id && referenced.has(local.item.pantry.id)) {
      throw new Error("A cooked dinner still refers to the other purchase batch.");
    }
    return remote;
  }
  return select("the same purchase or its pantry stock", original, local, remote);
}

// Purchased stock and its receipt form one unit for merging. Ordinary pantry
// rows can be reconciled by batch ID once all purchase owners are known.
function combinePantryAndShopping(base: KitchenState, draft: KitchenState, saved: KitchenState, meals: Rows<PlannedMeal>) {
  const stocks = [byId(base.pantry), byId(draft.pantry), byId(saved.pantry)] as const;
  checkCookingOverlap(base, draft, saved, stocks);
  checkReceiptIds(base, draft, saved);

  const owners = new Map<string, string>();
  const history = [
    purchaseRows(base, stocks[0], owners),
    purchaseRows(draft, stocks[1], owners),
    purchaseRows(saved, stocks[2], owners),
  ] as const;
  for (const [index, purchases] of history.entries()) {
    const owned = new Set([...purchases.values()].map(purchase => purchase.item.pantry.id));
    for (const id of stocks[index].keys()) {
      if (owners.has(id) && !owned.has(id)) throw new Error("A purchased pantry batch has been reused outside its receipt.");
    }
  }

  const checks = [shoppingRows(base), shoppingRows(draft), shoppingRows(saved)] as const;
  const referenced = new Set([...meals.values()].flatMap(meal => meal.completion?.deductions.map(deduction => deduction.pantryId) ?? []));
  const purchases = mergeRows(...history, (_key, original, local, remote) => selectPurchase(checks, referenced, original, local, remote));
  const receipts = new Map<string, ShoppingPurchase>();
  const live = new Map<string, PantryStock>();
  for (const { receipt, item, stock } of purchases.values()) {
    const group = receipts.get(receipt.id);
    if (group && (group.week !== receipt.week || group.at !== receipt.at)) throw new Error("A purchase receipt has conflicting details.");
    if (group) group.items.push(item);
    else receipts.set(receipt.id, { ...receipt, items: [item] });
    if (stock) live.set(stock.id, stock);
  }

  const pantry = mergeRows(...stocks, (id, original, local, remote) =>
    owners.has(id) ? live.get(id) : select("the same pantry batch", original, local, remote));
  const mergedChecks = mergeRows(...checks, (_key, original, local, remote) => select("the same shopping item", original, local, remote));
  const checked = new Map<string, boolean>();
  const cycles = new Map<string, string>();
  for (const [key, row] of mergedChecks) {
    if (row.checked !== undefined) checked.set(key, row.checked);
    if (row.cycle !== undefined) cycles.set(key, row.cycle);
  }
  return {
    pantry: [...pantry.values()],
    shoppingChecked: Object.fromEntries(checked),
    ...(cycles.size || saved.shoppingCycles ? { shoppingCycles: Object.fromEntries(cycles) } : {}),
    ...(receipts.size || saved.shoppingPurchases ? { shoppingPurchases: [...receipts.values()] } : {}),
  };
}

export function combineKitchenEdits(base: KitchenState, draft: KitchenState, saved: KitchenState, canEditProfile: boolean, revision = 0): CombineResult {
  try {
    for (const state of [base, draft, saved]) validateKitchenState(state);
    if (!canEditProfile && !equal(draft.cookingProfile, base.cookingProfile) && !equal(draft.cookingProfile, saved.cookingProfile)) {
      return { reason: "Only the household owner can change cooking preferences." };
    }
    const profile = select("cooking preferences", base.cookingProfile, draft.cookingProfile, saved.cookingProfile);
    const merged: KitchenState = { ...saved, migratedLegacy: select("the legacy import", base.migratedLegacy, draft.migratedLegacy, saved.migratedLegacy) };
    if (profile) merged.cookingProfile = profile;
    else delete merged.cookingProfile;

    const meals = mergeRows(new Map(Object.entries(base.meals)), new Map(Object.entries(draft.meals)), new Map(Object.entries(saved.meals)),
      (date, original, mine, theirs) => {
        const chosen = select(`the dinner on ${date}`, original, mine, theirs);
        if ((theirs?.locked || theirs?.status === "cooked") && !equal(chosen, theirs) && !protectedDinnerChange(theirs, chosen)) throw new Error(`The saved dinner on ${date} is locked or cooked.`);
        return chosen;
      });
    merged.meals = Object.fromEntries(meals);

    Object.assign(merged, combinePantryAndShopping(base, draft, saved, meals));

    const favorites = (state: KitchenState) => new Map((state.favoriteRecipeIds ?? []).map(id => [id, true]));
    const chosen = mergeRows(favorites(base), favorites(draft), favorites(saved),
      (_id, original, local, remote) => select("the same favorite", original, local, remote));
    if (chosen.size || saved.favoriteRecipeIds) merged.favoriteRecipeIds = [...chosen.keys()];
    const amounts = (state: KitchenState) => new Map(Object.entries(state.personalRecipeAmounts ?? {}));
    const personal = mergeRows(amounts(base), amounts(draft), amounts(saved),
      (_id, original, local, remote) => select("personal amounts for the same recipe", original, local, remote));
    if (personal.size || saved.personalRecipeAmounts) merged.personalRecipeAmounts = Object.fromEntries(personal);

    validateKitchenWrite({ revision, state: merged });
    return { state: equal(merged, saved) ? saved : merged };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : "The combined kitchen could not be validated." };
  }
}
