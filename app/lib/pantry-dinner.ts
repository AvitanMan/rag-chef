import type { PantryStock } from "./kitchen-types";
import { isEverydayRecipe } from "./everyday-collection";
import { canonicalIngredient, normalizePlanningIngredient, pantryStockEligibility } from "./quantities";
import { isBasicSeasoning, pantryRecipeFit } from "./pantry-recipe-fit";
import { evaluateRecipeConstraints, normalizeConstraints } from "./recipe-constraints";
import type { Recipe, RecipeConstraints, RecipeMetadataMap } from "./recipe-types";

export interface PantryDinnerIngredient {
  key: string;
  name: string;
}

export interface PantryPick extends PantryDinnerIngredient {
  available: boolean;
}

export interface PantryDinnerMatch {
  recipe: Recipe;
  usesPicks: PantryDinnerIngredient[];
  frozenPicks: PantryDinnerIngredient[];
}

export interface PantryDinnerResults {
  picks: PantryPick[];
  matches: PantryDinnerMatch[];
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
): PantryDinnerResults {
  const picks = pantryDinnerPicks(pantry, today, selectedKeys);
  const availablePicks = picks.filter(pick => pick.available);
  const foodPicks = availablePicks.filter(pick => !isBasicSeasoning(pick.key));
  if (!foodPicks.length) return { picks, matches: [] };

  const pantryNames = availableTonightIngredients(tonightSuggestionPantry(pantry, today, availablePicks.map(pick => pick.key)), today).map(ingredient => ingredient.name);
  const frozenByKey = new Map(availableTonightIngredients(pantry.filter(stock => stock.location === "freezer"), today)
    .map(ingredient => [ingredient.key, ingredient]));
  const dinnerPriority = (recipe: Recipe) => {
    const role = metadata[recipe.id]?.dinnerRole ?? (isEverydayRecipe(recipe) ? "main" : "unknown");
    return role === "main" ? 0 : !role || role === "unknown" ? 1 : 2;
  };
  const matches = recipes.flatMap(recipe => {
    const eligibility = evaluateRecipeConstraints(recipe, metadata[recipe.id], constraints);
    if (!eligibility.eligible) return [];
    const ingredients = new Set(recipe.ingredients.map(ingredient => canonicalIngredient(normalizePlanningIngredient(ingredient).name)));
    const selectedFoodOverlap = foodPicks.filter(pick => ingredients.has(pick.key)).length;
    if (!selectedFoodOverlap) return [];
    const usesPicks = availablePicks.filter(pick => ingredients.has(pick.key)).map(({ key, name }) => ({ key, name }));
    const frozenPicks = usesPicks.flatMap(pick => frozenByKey.has(pick.key) ? [frozenByKey.get(pick.key)!] : []);
    return [{ recipe, usesPicks, frozenPicks, selectedFoodOverlap,
      dislikes: eligibility.dislikedIngredients.length, fit: pantryRecipeFit(recipe, pantryNames) }];
  });
  matches.sort((a, b) => dinnerPriority(a.recipe) - dinnerPriority(b.recipe)
    || a.dislikes - b.dislikes
    || a.fit.missingFood.length - b.fit.missingFood.length
    || b.selectedFoodOverlap - a.selectedFoodOverlap
    || b.fit.foodCoverage - a.fit.foodCoverage
    || b.fit.coverage - a.fit.coverage
    || a.recipe.title.localeCompare(b.recipe.title, "en", { sensitivity: "base" })
    || a.recipe.id.localeCompare(b.recipe.id));
  return { picks, matches: matches.map(({ recipe, usesPicks, frozenPicks }) => ({ recipe, usesPicks, frozenPicks })) };
}
