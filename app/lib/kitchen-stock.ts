import type { PantryStock } from "./kitchen-types";
import { canonicalIngredient, parseMeasure } from "./quantities";
import { localDate } from "./kitchen-state";

/** Names remain uncertain when amounts are unknown; known zero stock is absent. */
export function availablePantryNames(pantry: PantryStock[], date = localDate()): string[] {
  return [...new Map(pantry.filter((stock) => parseMeasure(stock.measure)?.quantity !== 0 && (!stock.useBy || stock.useBy >= date))
    .map((stock) => [canonicalIngredient(stock.name), stock.name])).values()];
}
