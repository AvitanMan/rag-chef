import type { ShoppingItem } from "./quantities";
import { addDateDays } from "./kitchen-state";

/** Uses the displayed shortages; never recalculates amounts or records purchases. */
export function shoppingListText(items: ShoppingItem[], week: string): string {
  const lines = items.map(item => {
    const warnings = [item.preparationNote, item.needsReview ? (item.preparationNote ? "Review preparation" : "Review amount") : "", ...item.notes].filter(Boolean);
    return `- ${item.name}: ${item.measure || "Amount unknown"}${warnings.length ? `\n  ${[...new Set(warnings)].join(" · ")}` : ""}`;
  });
  return [`Shopping list · ${week} – ${addDateDays(week, 6)}`, "Unchecked items only", "", ...lines].join("\n");
}
