import { fillEmptyDays, planningRandom } from "./kitchen-planning";
import { DEFAULT_COOKING_PROFILE, type KitchenState, type PlannedMeal } from "./kitchen-types";
import { shoppingListDelta, type MealReadiness, type ShoppingDelta } from "./quantities";
import { evaluateRecipeConstraints, normalizeConstraints } from "./recipe-constraints";
import type { Recipe, RecipeMetadataMap } from "./recipe-types";
import { mealsForShoppingWeek } from "./shopping-purchases";

export interface FillEmptyDaysPreview {
  additions: PlannedMeal[];
  reasons: Record<string, string>;
  readinessByDate: Record<string, MealReadiness>;
  shoppingDelta: ShoppingDelta[];
}

interface FillEmptyDaysInputs {
  state: KitchenState;
  recipes: Recipe[];
  metadataByRecipeId: RecipeMetadataMap;
  contentHashesByRecipeId: Record<string, string>;
  week: string;
  today: string;
  seed: number;
  preferReviewedMains: boolean;
}

/** Replaying the same approved catalog, kitchen, date and seed returns the exact reviewed snapshots. */
export function buildFillEmptyDaysPreview({ state, recipes, metadataByRecipeId, contentHashesByRecipeId,
  week, today, seed, preferReviewedMains }: FillEmptyDaysInputs): FillEmptyDaysPreview {
  const constraints = normalizeConstraints(state.cookingProfile ?? DEFAULT_COOKING_PROFILE);
  const eligible = recipes.filter(recipe => evaluateRecipeConstraints(recipe, metadataByRecipeId[recipe.id], constraints).eligible);
  const savedIds = new Set(Object.values(state.meals).map(meal => meal.id));
  const plan = fillEmptyDays(eligible, state.pantry, week, state.meals, today, planningRandom(seed), {
    metadataByRecipeId, contentHashesByRecipeId, personalRecipeAmounts: state.personalRecipeAmounts, preferReviewedMains,
    mealIdForDate(date) {
      const base = `fill-${date}-${seed >>> 0}`;
      let id = base;
      for (let suffix = 1; savedIds.has(id); suffix++) id = `${base}-${suffix}`;
      return id;
    },
  });
  return { additions: plan.additions, reasons: plan.reasons, readinessByDate: plan.readinessByDate,
    shoppingDelta: plan.additions.length ? shoppingListDelta(mealsForShoppingWeek(state.meals, week),
      mealsForShoppingWeek(plan.meals, week), state.pantry, today) : [] };
}
