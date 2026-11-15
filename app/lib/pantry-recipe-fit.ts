import type { Recipe } from "./recipe-types";
import { canonicalIngredient, normalizePlanningIngredient } from "./quantities";

// A small ranking convention, not a substitution or an assumption about stock.
// Keep exact identities: pepper could mean a vegetable; butter, stock, sauces,
// herbs and unfamiliar labels still count as food ingredients at full weight.
const BASIC_SEASONINGS = new Set([
  "salt", "black pepper", "water", "oil", "olive oil", "vegetable oil",
  "sunflower oil", "canola oil", "rapeseed oil",
]);

/** Ranking-only convention; classification never assumes the ingredient is owned. */
export function isBasicSeasoning(name: string): boolean {
  return BASIC_SEASONINGS.has(canonicalIngredient(normalizePlanningIngredient({ name, measure: "" }).name));
}

export interface PantryRecipeFit {
  /** Unique ingredient identities, retaining the first original source label. */
  matched: string[];
  missing: string[];
  matchedFood: string[];
  missingFood: string[];
  matchedSeasonings: string[];
  missingSeasonings: string[];
  /** Unselected frozen matches remain missing for ranking, and are displayed separately. */
  inFreezer: string[];
  total: number;
  coverage: number;
  foodTotal: number;
  foodCoverage: number;
}

/** Name fit only. Every missing ingredient stays visible; amounts are not checked. */
export function pantryRecipeFit(recipe: Recipe, pantry: readonly string[], freezer: readonly string[] = []): PantryRecipeFit {
  const stock = new Set(pantry.map(canonicalIngredient).filter(Boolean));
  const frozen = new Set(freezer.map(canonicalIngredient).filter(Boolean));
  const seen = new Set<string>();
  const matched: string[] = [], missing: string[] = [];
  const matchedFood: string[] = [], missingFood: string[] = [];
  const matchedSeasonings: string[] = [], missingSeasonings: string[] = [];
  const inFreezer: string[] = [];
  for (const ingredient of recipe.ingredients) {
    const key = canonicalIngredient(normalizePlanningIngredient(ingredient).name);
    if (seen.has(key)) continue;
    seen.add(key);
    const available = Boolean(key) && stock.has(key);
    if (!available && frozen.has(key)) inFreezer.push(ingredient.name);
    const seasoning = isBasicSeasoning(key);
    (available ? matched : missing).push(ingredient.name);
    (seasoning ? available ? matchedSeasonings : missingSeasonings
      : available ? matchedFood : missingFood).push(ingredient.name);
  }
  const total = matched.length + missing.length;
  const foodTotal = matchedFood.length + missingFood.length;
  return {
    matched, missing, matchedFood, missingFood, matchedSeasonings, missingSeasonings, inFreezer,
    total, coverage: total ? matched.length / total : 0,
    foodTotal, foodCoverage: foodTotal ? matchedFood.length / foodTotal : 0,
  };
}

/** Prefer meals using saved food, then fewer missing foods; seasoning-only dishes come last. */
export function comparePantryRecipeFit(a: PantryRecipeFit, b: PantryRecipeFit): number {
  return Number(a.foodTotal === 0) - Number(b.foodTotal === 0)
    || Number(b.matchedFood.length > 0) - Number(a.matchedFood.length > 0)
    || a.missingFood.length - b.missingFood.length
    || b.foodCoverage - a.foodCoverage
    || b.coverage - a.coverage;
}
