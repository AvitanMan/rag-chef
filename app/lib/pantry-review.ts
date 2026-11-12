import { weekStart } from "./kitchen-state";
import type { PantryStock, PlannedMeal } from "./kitchen-types";
import { pantryAmountDetails, pantryUnitMismatches } from "./quantities";

export interface PantryReviewReason {
  kind: "unknown" | "past" | "incompatible";
  message: string;
}

export interface PantryReviewTask {
  pantryId: string;
  reasons: PantryReviewReason[];
}

/** Derived from the full pantry; neither review nor virtual reservations change saved batches. */
export function pantryReviewTasks(pantry: PantryStock[], meals: PlannedMeal[], week: string, today: string): PantryReviewTask[] {
  const tasks = new Map<string, PantryReviewTask>();
  for (const stock of pantry) {
    const amount = pantryAmountDetails(stock.measure);
    const reasons: PantryReviewReason[] = [];
    if (amount.kind !== "empty") {
      if (amount.kind === "unknown") reasons.push({ kind: "unknown",
        message: "Amount is unknown. Enter a measured amount to include this batch in quantity planning." });
      if (stock.useBy && stock.useBy < today) reasons.push({ kind: "past",
        message: `Entered planning date ${stock.useBy} is before today (${today}). Check this batch’s entered date.` });
    }
    // Match allocator deduplication: first position, last value for a repeated batch ID.
    tasks.set(stock.id, { pantryId: stock.id, reasons });
  }
  const selectedWeek = weekStart(week);
  const selected = meals.filter(meal => meal.status !== "cooked" && weekStart(meal.date) === selectedWeek);
  for (const mismatch of pantryUnitMismatches(selected, pantry, today)) {
    const task = tasks.get(mismatch.pantryId);
    if (!task) continue;
    const unit = mismatch.requiredUnit === "count" ? "pieces"
      : mismatch.requiredUnit === "g" || mismatch.requiredUnit === "ml" ? mismatch.requiredUnit : `${mismatch.requiredUnit} counts`;
    const message = `${mismatch.title} (${mismatch.date}) has an uncovered ${mismatch.ingredient} requirement measured in ${unit}. This batch’s units are incompatible; no automatic conversion is applied.`;
    if (!task.reasons.some(reason => reason.kind === "incompatible" && reason.message === message)) {
      task.reasons.push({ kind: "incompatible", message });
    }
  }
  return [...tasks.values()].filter(task => task.reasons.length > 0);
}
