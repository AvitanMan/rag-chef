import type { ShoppingItem } from "./quantities";
import { addDateDays } from "./kitchen-state";

export interface ShoppingDinner { title: string; date: string }

/** Uses the displayed shortages; never recalculates amounts or records purchases. */
export function shoppingListText(items: ShoppingItem[], week: string, dinner?: ShoppingDinner): string {
  const lines = items.map(item => {
    const warnings = [item.preparationNote, item.needsReview ? (item.preparationNote ? "Review preparation" : "Review amount") : "", ...item.notes].filter(Boolean);
    if (dinner && item.mealDates.length > 1) warnings.push(`Shared weekly total for ${item.mealDates.join(", ")}`);
    return `- ${item.name}: ${item.measure || "Amount unknown"}${warnings.length ? `\n  ${[...new Set(warnings)].join(" · ")}` : ""}`;
  });
  const heading = [`Shopping list · ${week} – ${addDateDays(week, 6)}`];
  if (dinner) heading.push(`For this dinner · ${dinner.title} · ${dinner.date}`, "Weekly totals for items used by this dinner");
  return [...heading, "Unchecked items only", "", ...lines].join("\n");
}
