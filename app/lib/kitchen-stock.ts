import type { KitchenState, PantryStock } from "./kitchen-types";
import { canonicalIngredient, parseMeasure } from "./quantities";

/** Names remain uncertain when amounts are unknown; known zero stock is absent. */
export function availablePantryNames(pantry: PantryStock[]): string[] {
  return [...new Map(pantry.filter((stock) => parseMeasure(stock.measure)?.quantity !== 0)
    .map((stock) => [canonicalIngredient(stock.name), stock.name])).values()];
}

export function removePantryStock(state: KitchenState, id: string): KitchenState {
  return { ...state, pantry: state.pantry.filter((stock) => stock.id !== id) };
}
