import type { KitchenState, PantryStock, PlannedMeal } from "./kitchen-types";
import type { Recipe, RecipeMetadataMap } from "./recipe-types";
import { addDateDays, createPlannedMeal, localDate } from "./kitchen-state";
import { allocateMealStock, allocateStockForMeals, canonicalIngredient, mealReadiness } from "./quantities";

export interface FilledWeeklyPlan {
  meals: KitchenState["meals"];
  additions: PlannedMeal[];
  reasons: Record<string, string>;
}

/** A click gets a fresh seed; replaying its state update keeps the same draw. */
export function planningRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Saved dinners reserve stock before new suggestions; no real state is changed. */
export function fillEmptyDays(recipes: Recipe[], pantry: PantryStock[], week: string, meals: KitchenState["meals"], today = localDate(), random: () => number = Math.random, options: { metadataByRecipeId?: RecipeMetadataMap; preferReviewedMains?: boolean } = {}): FilledWeeklyPlan {
  const dates = Array.from({ length: 7 }, (_, index) => addDateDays(week, index));
  const saved = Object.values(meals).filter((meal) => dates.includes(meal.date));
  const used = new Set(saved.map((meal) => meal.recipeId));
  const identities = new Set(saved.flatMap((meal) => (meal.planningIngredients ?? meal.recipe?.ingredients ?? []).map((item) => canonicalIngredient(item.name))));
  let virtualPantry = allocateStockForMeals(saved, pantry, today).pantry;
  const additions: PlannedMeal[] = [];
  const reasons: Record<string, string> = {};
  for (const date of dates.filter((day) => day >= today && !meals[day])) {
    const choices = [...new Map(recipes.map((recipe) => [recipe.id, recipe])).values()].filter((recipe) => !used.has(recipe.id)).sort((a, b) => a.id.localeCompare(b.id)).map((recipe) => {
      const meal = createPlannedMeal(date, recipe);
      const allocation = allocateMealStock(meal, virtualPantry, today);
      const reuse = allocation.ingredientIdentities.filter((identity) => identities.has(identity)).length;
      return { recipe, meal, allocation, reuse };
    });
    // Preserve the waste and stock priorities, but sample broadly within each
    // available tier rather than always picking the same highest-scoring meal.
    const metadata = options.metadataByRecipeId ?? {};
    const mains = choices.filter(({ recipe }) => metadata[recipe.id]?.coreDinner || metadata[recipe.id]?.dinnerRole === "main");
    const dinnerChoices = options.preferReviewedMains === false ? choices : mains.length ? mains
      : choices.filter(({ recipe }) => !metadata[recipe.id] || metadata[recipe.id].dinnerRole === "unknown");
    const urgent = dinnerChoices.filter((choice) => choice.allocation.useSoonCoverage > 0);
    const covered = dinnerChoices.filter((choice) => choice.allocation.coverage > 0);
    const pool = urgent.length ? urgent : covered.length ? covered : dinnerChoices;
    const weighted = pool.map((choice) => ({ choice, weight: 1 + choice.allocation.useSoonCoverage * 4 + choice.allocation.coverage * 3 + Math.min(choice.reuse, 3) * 0.5 }));
    let draw = random() * weighted.reduce((sum, item) => sum + item.weight, 0);
    const chosen = weighted.find((item) => { draw -= item.weight; return draw < 0; })?.choice ?? weighted.at(-1)?.choice;
    if (!chosen) break;
    const readiness = mealReadiness(chosen.meal, virtualPantry, today);
    const pantrySummary = `Pantry covers ${readiness.coveredCount} ingredient${readiness.coveredCount === 1 ? "" : "s"}; ${readiness.missingCount + readiness.partialCount} still to buy${readiness.reviewCount ? `; ${readiness.reviewCount} amounts to review` : ""}.`;
    additions.push(chosen.meal);
    used.add(chosen.recipe.id);
    for (const identity of chosen.allocation.ingredientIdentities) identities.add(identity);
    virtualPantry = chosen.allocation.pantry;
    reasons[date] = chosen.allocation.useSoonCoverage > 0 ? "Uses measured stock due within three days; quantities reserved for this dinner."
      : chosen.allocation.coverage > 0 ? "Uses remaining measured pantry stock after saved dinners are reserved."
      : chosen.reuse > 0 ? "Shares ingredients with this week’s dinners; additional stock may be needed."
      : "Adds a different eligible dinner; check the shopping list for its ingredients.";
    const role = metadata[chosen.recipe.id];
    const roleLabel = role?.coreDinner || role?.dinnerRole === "main" ? "Reviewed main. " : role && role.dinnerRole !== "unknown" ? `Reviewed ${role.dinnerRole}. ` : "Dinner role not reviewed. ";
    reasons[date] = `${roleLabel}${reasons[date]} ${pantrySummary}`;
  }
  return { meals: { ...meals, ...Object.fromEntries(additions.map((meal) => [meal.date, meal])) }, additions, reasons };
}
