import type { KitchenState, PantryStock } from "./kitchen-types";
import { evaluateDinnerCandidates, type DinnerCandidate } from "./dinner-candidates";
import { canonicalIngredient, normalizePlanningIngredient, pantryStockEligibility } from "./quantities";
import { isBasicSeasoning } from "./pantry-recipe-fit";
import { normalizeConstraints } from "./recipe-constraints";
import type { Recipe, RecipeConstraints, RecipeMetadataMap } from "./recipe-types";

export interface PantryDinnerIngredient {
  key: string;
  name: string;
}

export interface PantryPick extends PantryDinnerIngredient {
  available: boolean;
}

export interface PantryDinnerMatch extends DinnerCandidate {
  usesPicks: PantryDinnerIngredient[];
  frozenPicks: PantryDinnerIngredient[];
}

export interface PantryDinnerResults {
  picks: PantryPick[];
  matches: PantryDinnerMatch[];
}

export interface PantryDinnerOptions {
  date?: string;
  portions?: number | null;
  meals?: KitchenState["meals"];
  personalRecipeAmounts?: KitchenState["personalRecipeAmounts"];
  contentHashesByRecipeId?: Record<string, string>;
}

/** Discovery only: frozen entries count tonight when that ingredient was explicitly selected. */
export function tonightSuggestionPantry(pantry: readonly PantryStock[], today: string, selectedKeys: readonly string[] = []): PantryStock[] {
  const selected = new Set(selectedKeys);
  return pantry.filter(stock => pantryStockEligibility(stock, today).eligible
    && (stock.location !== "freezer" || selected.has(canonicalIngredient(stock.name))));
}

/** Physical pantry names only: unknown amounts can match, but never prove quantity coverage. */
export function availableTonightIngredients(pantry: readonly PantryStock[], today: string): PantryDinnerIngredient[] {
  const ingredients = new Map<string, PantryDinnerIngredient>();
  for (const stock of pantry) {
    if (!pantryStockEligibility(stock, today).eligible) continue;
    const key = canonicalIngredient(stock.name);
    if (key && !ingredients.has(key)) ingredients.set(key, { key, name: stock.name });
  }
  return [...ingredients.values()];
}

/** Keep selected identities visible when stock is removed, finished or past its entered date. */
export function pantryDinnerPicks(pantry: readonly PantryStock[], today: string, selectedKeys: readonly string[]): PantryPick[] {
  const names = new Map<string, string>();
  for (const stock of pantry) {
    const key = canonicalIngredient(stock.name);
    if (key && !names.has(key)) names.set(key, stock.name);
  }
  const available = new Set(availableTonightIngredients(pantry, today).map(ingredient => ingredient.key));
  return [...new Set(selectedKeys.map(canonicalIngredient).filter(Boolean))]
    .map(key => ({ key, name: names.get(key) ?? key, available: available.has(key) }));
}

/** Offer meals using any selected available food; other saved food can support the fit. */
export function findPantryDinners(
  recipes: readonly Recipe[],
  selectedKeys: readonly string[],
  pantry: readonly PantryStock[],
  today: string,
  metadata: RecipeMetadataMap = {},
  constraints: RecipeConstraints = normalizeConstraints(),
  options: PantryDinnerOptions = {},
): PantryDinnerResults {
  const date = options.date ?? today;
  const stockDate = date > today ? date : today;
  const picks = pantryDinnerPicks(pantry, stockDate, selectedKeys);
  const availablePicks = picks.filter(pick => pick.available);
  const foodPicks = availablePicks.filter(pick => !isBasicSeasoning(pick.key));
  if (!foodPicks.length) return { picks, matches: [] };

  const frozenByKey = new Map(availableTonightIngredients(pantry.filter(stock => stock.location === "freezer"), stockDate)
    .map(ingredient => [ingredient.key, ingredient]));
  const kitchen: KitchenState = { schemaVersion: 2, pantry: [...pantry], meals: options.meals ?? {},
    shoppingChecked: {}, migratedLegacy: true, personalRecipeAmounts: options.personalRecipeAmounts };
  const matches = evaluateDinnerCandidates({ recipes, kitchen, today, date, portions: options.portions ?? null, metadata, constraints,
    selectedKeys, contentHashesByRecipeId: options.contentHashesByRecipeId }).map(candidate => {
    const { recipe } = candidate;
    const ingredients = new Set(recipe.ingredients.map(ingredient => canonicalIngredient(normalizePlanningIngredient(ingredient).name)));
    const usesPicks = availablePicks.filter(pick => ingredients.has(pick.key)).map(({ key, name }) => ({ key, name }));
    const frozenPicks = usesPicks.flatMap(pick => frozenByKey.has(pick.key) ? [frozenByKey.get(pick.key)!] : []);
    return { ...candidate, usesPicks, frozenPicks };
  });
  return { picks, matches };
}
