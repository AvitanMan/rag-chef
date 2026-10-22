import type { KitchenState, PantryStock, PlannedMeal } from "./kitchen-types";
import type { Recipe } from "./recipe-types";
import { addDateDays, createPlannedMeal, localDate } from "./kitchen-state";
import { allocateMealStock, allocateStockForMeals, canonicalIngredient } from "./quantities";

export interface FilledWeeklyPlan {
  meals: KitchenState["meals"];
  additions: PlannedMeal[];
  reasons: Record<string, string>;
}

function weeklyTie(week: string, recipeId: string): number {
  let hash = 2166136261;
  for (const character of `${week}:${recipeId}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/** Saved dinners reserve stock before new suggestions; no real state is changed. */
export function fillEmptyDays(recipes: Recipe[], pantry: PantryStock[], week: string, meals: KitchenState["meals"], today = localDate()): FilledWeeklyPlan {
  const dates = Array.from({ length: 7 }, (_, index) => addDateDays(week, index));
  const saved = Object.values(meals).filter((meal) => dates.includes(meal.date));
  const used = new Set(saved.map((meal) => meal.recipeId));
  const identities = new Set(saved.flatMap((meal) => (meal.planningIngredients ?? meal.recipe?.ingredients ?? []).map((item) => canonicalIngredient(item.name))));
  let virtualPantry = allocateStockForMeals(saved, pantry, today).pantry;
  const additions: PlannedMeal[] = [];
  const reasons: Record<string, string> = {};
  for (const date of dates.filter((day) => day >= today && !meals[day])) {
    const choices = [...new Map(recipes.map((recipe) => [recipe.id, recipe])).values()].filter((recipe) => !used.has(recipe.id)).map((recipe) => {
      const meal = createPlannedMeal(date, recipe);
      const allocation = allocateMealStock(meal, virtualPantry, today);
      const reuse = allocation.ingredientIdentities.filter((identity) => identities.has(identity)).length;
      return { recipe, meal, allocation, reuse, tie: weeklyTie(week, recipe.id) };
    }).sort((a, b) => b.allocation.useSoonCoverage - a.allocation.useSoonCoverage || b.allocation.coverage - a.allocation.coverage || b.reuse - a.reuse || a.tie - b.tie || a.recipe.id.localeCompare(b.recipe.id));
    const chosen = choices[0];
    if (!chosen) break;
    additions.push(chosen.meal);
    used.add(chosen.recipe.id);
    for (const identity of chosen.allocation.ingredientIdentities) identities.add(identity);
    virtualPantry = chosen.allocation.pantry;
    reasons[date] = chosen.allocation.useSoonCoverage > 0 ? "Uses measured stock due within three days; quantities reserved for this dinner."
      : chosen.allocation.coverage > 0 ? "Uses remaining measured pantry stock after saved dinners are reserved."
      : chosen.reuse > 0 ? "Shares ingredients with this week’s dinners; additional stock may be needed."
      : "Adds a different eligible dinner; check the shopping list for its ingredients.";
  }
  return { meals: { ...meals, ...Object.fromEntries(additions.map((meal) => [meal.date, meal])) }, additions, reasons };
}
