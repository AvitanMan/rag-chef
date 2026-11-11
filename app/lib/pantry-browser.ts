import { EMPTY_KITCHEN, type KitchenState, type PantryStock, type PlannedMeal } from "./kitchen-types";
import { weekStart } from "./kitchen-state";
import { measureInputProblem, validateKitchenState } from "./kitchen-validation";
import { allocateStockForMeals, canonicalIngredient, formatMeasure, pantryAmountDetails, pantryStockEligibility, parseMeasure, type ParsedMeasure } from "./quantities";
import { normalizeRecipeSearch } from "./recipe-browser";

export type PantrySort = "current" | "name" | "useBy";

/** Display-only filtering and sorting; stock batches retain their identities. */
export function browsePantry(items: PantryStock[], query: string, sort: PantrySort): PantryStock[] {
  const words = normalizeRecipeSearch(query).split(" ").filter(Boolean);
  const matches = items.filter(item => words.every(word => normalizeRecipeSearch(item.name).includes(word)));
  if (sort === "current") return matches;
  return matches.sort((a, b) => (sort === "useBy" ? (a.useBy || "9999-99-99").localeCompare(b.useBy || "9999-99-99") : 0)
    || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

export interface PantryIngredientGroup {
  key: string;
  name: string;
  batches: PantryStock[];
  onHand: ParsedMeasure[];
  unknownCount: number;
  emptyCount: number;
}

/** Units are already normalized by parseMeasure; unlike dimensions never combine. */
export function compatiblePantryTotals(amounts: Array<ParsedMeasure | null>): ParsedMeasure[] {
  const totals = new Map<string, ParsedMeasure>();
  for (const amount of amounts) {
    if (!amount) continue;
    const key = JSON.stringify([amount.dimension, amount.unit]);
    const previous = totals.get(key);
    totals.set(key, { ...amount, quantity: (previous?.quantity ?? 0) + amount.quantity });
  }
  return [...totals.values()];
}

/** Visual groups only: original batch objects, names, amounts, dates and IDs survive. */
export function groupPantryBatches(pantry: PantryStock[]): PantryIngredientGroup[] {
  const groups = new Map<string, PantryIngredientGroup>();
  for (const stock of pantry) {
    const key = canonicalIngredient(stock.name);
    let group = groups.get(key);
    if (!group) {
      group = { key, name: stock.name, batches: [], onHand: [], unknownCount: 0, emptyCount: 0 };
      groups.set(key, group);
    }
    group.batches.push(stock);
    const amount = pantryAmountDetails(stock.measure);
    if (amount.kind === "unknown") group.unknownCount++;
    else if (amount.kind === "empty") group.emptyCount++;
  }
  for (const group of groups.values()) group.onHand = compatiblePantryTotals(group.batches.map(stock => parseMeasure(stock.measure)));
  return [...groups.values()];
}

export type PantryReservation = {
  mealId: string;
  date: string;
  title: string;
  measure: string;
};

export interface PantryBatchPlanning {
  reserved: ParsedMeasure | null;
  available: ParsedMeasure | null;
  reservations: PantryReservation[];
}

/** Allocate the full pantry once, before any browser filter or search is applied. */
export function pantryWeekReservations(pantry: PantryStock[], meals: PlannedMeal[], week: string, today: string) {
  const selected = meals.filter(meal => meal.status !== "cooked" && weekStart(meal.date) === weekStart(week));
  const allocation = allocateStockForMeals(selected, pantry, today);
  const remaining = new Map(allocation.pantry.map(stock => [stock.id, stock]));
  const byId = new Map<string, PantryBatchPlanning>();
  for (const stock of pantry) {
    const onHand = parseMeasure(stock.measure);
    const after = parseMeasure(remaining.get(stock.id)?.measure ?? "");
    byId.set(stock.id, {
      reserved: onHand && after ? { ...onHand, quantity: Math.max(0, onHand.quantity - after.quantity) } : null,
      available: onHand && after ? { ...after, quantity: pantryStockEligibility(stock, today).eligible ? after.quantity : 0 } : null,
      reservations: [],
    });
  }
  const mealsById = new Map(selected.map(meal => [meal.id, meal]));
  for (const allocated of allocation.allocations) {
    const amounts = new Map<string, ParsedMeasure>();
    for (const deduction of allocated.deductions) {
      const before = parseMeasure(deduction.before);
      const after = parseMeasure(deduction.after);
      const batch = byId.get(deduction.pantryId)?.reserved;
      if (!batch || !before || !after || before.dimension !== batch.dimension || after.dimension !== batch.dimension
        || before.unit !== batch.unit || after.unit !== batch.unit || before.quantity <= after.quantity) continue;
      // Sum actual deductions before formatting; ingredient names cannot identify a batch.
      const quantity = before.quantity - after.quantity;
      amounts.set(deduction.pantryId, { ...before, quantity: (amounts.get(deduction.pantryId)?.quantity ?? 0) + quantity });
    }
    const meal = mealsById.get(allocated.mealId);
    for (const [pantryId, amount] of amounts) {
      byId.get(pantryId)!.reservations.push({
        mealId: allocated.mealId, date: allocated.date, title: meal?.title || meal?.recipe?.title || "Untitled meal",
        measure: formatMeasure(amount.quantity, amount.unit),
      });
    }
  }
  return { byId, mealCount: selected.length };
}

export function pantryDateInputProblem(value: string): string {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00.000Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0, 4)) > 0
    && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? "" : "Enter a valid calendar date, or clear the date if it is unknown.";
}

export function pantryBatchProblem(stock: PantryStock): string {
  try {
    validateKitchenState({ ...EMPTY_KITCHEN, pantry: [stock] });
    return "";
  } catch (error) {
    return error instanceof Error ? error.message.replace(/state\.pantry\[0\]\.(name|measure|useBy)/g,
      (_, field: string) => field === "name" ? "Ingredient name / form" : field === "measure" ? "Amount on hand" : "Entered planning date")
      : "Check this batch’s name, amount and date.";
  }
}

export function samePantryBatch(current: PantryStock | undefined, snapshot: PantryStock): boolean {
  return Boolean(current && current.id === snapshot.id && current.name === snapshot.name
    && current.measure === snapshot.measure && current.useBy === snapshot.useBy);
}

/** Call inside the parent's functional update, not just against rendered props. */
export function replacePantryBatch(state: KitchenState, snapshot: PantryStock, replacement: PantryStock): KitchenState {
  if (snapshot.id !== replacement.id || pantryBatchProblem(replacement)
    || !samePantryBatch(state.pantry.find(stock => stock.id === snapshot.id), snapshot)
    || samePantryBatch(snapshot, replacement)) return state;
  return { ...state, pantry: state.pantry.map(stock => stock.id === snapshot.id ? { ...replacement } : stock) };
}

export interface PantryBatchChange {
  before: PantryStock;
  after: PantryStock;
}

export function pantryBatchUndoProblem(pantry: PantryStock[], change: PantryBatchChange): string {
  if (pantryBatchProblem(change.before) || pantryBatchProblem(change.after)) return "This pantry change has invalid snapshots and cannot be undone.";
  if (change.before.id !== change.after.id) return "Both snapshots must belong to the same batch to undo this change.";
  if (samePantryBatch(change.before, change.after)) return "There is no batch change to undo.";
  const current = pantry.find(stock => stock.id === change.after.id);
  if (!current) return "This batch has been removed. Undo will not recreate it.";
  if (!samePantryBatch(current, change.after)) return "This batch has been edited or used since this change. Undo would overwrite later changes.";
  return "";
}

/** Recheck the live pantry inside the parent's functional update, not only in the undo preview. */
export function undoPantryBatch(state: KitchenState, change: PantryBatchChange): KitchenState {
  if (pantryBatchUndoProblem(state.pantry, change)) return state;
  return replacePantryBatch(state, change.after, change.before);
}

export function pantryUsagePreview(stock: PantryStock, measure: string): { stock: PantryStock | null; problem: string } {
  const onHand = parseMeasure(stock.measure);
  const used = parseMeasure(measure);
  const invalid = measureInputProblem(measure);
  if (invalid) return { stock: null, problem: invalid };
  if (!onHand) return { stock: null, problem: "The amount on hand is unknown. Correct it to a measured amount first, or mark the batch finished." };
  if (!used || used.quantity <= 0) return { stock: null, problem: "Enter a known amount greater than zero to subtract." };
  if (used.dimension !== onHand.dimension) return { stock: null, problem: "Use compatible units for this batch. Weight, volume, pieces and package counts cannot be converted automatically." };
  if (used.quantity > onHand.quantity) return { stock: null, problem: "Usage cannot exceed this batch’s physical amount on hand." };
  const next = { ...stock, measure: formatMeasure(onHand.quantity - used.quantity, onHand.unit) };
  const problem = pantryBatchProblem(next);
  return { stock: problem ? null : next, problem };
}
