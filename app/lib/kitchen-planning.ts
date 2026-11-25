import type { KitchenState, PantryStock, PlannedMeal } from "./kitchen-types";
import type { Recipe, RecipeMetadataMap } from "./recipe-types";
import { addDateDays, createPlannedMeal, localDate } from "./kitchen-state";
import { allocateMealStock, canonicalIngredient, createPantryIngredientSelector, mealAllocationsInOrder, mealReadiness, savedCoverageGuard, type MealReadiness, type SavedMealReservation } from "./quantities";

export interface FilledWeeklyPlan {
  meals: KitchenState["meals"];
  additions: PlannedMeal[];
  reasons: Record<string, string>;
  readinessByDate: Record<string, MealReadiness>;
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

interface FillOptions {
  metadataByRecipeId?: RecipeMetadataMap;
  preferReviewedMains?: boolean;
  personalRecipeAmounts?: KitchenState["personalRecipeAmounts"];
  contentHashesByRecipeId?: Record<string, string>;
  mealIdForDate?: (date: string) => string;
}

/** Saved dinners reserve stock before new suggestions; no real state is changed. */
export function fillEmptyDays(recipes: Recipe[], pantry: PantryStock[], week: string, meals: KitchenState["meals"], today = localDate(), random: () => number = Math.random, options: FillOptions = {}): FilledWeeklyPlan {
  const dates = Array.from({ length: 7 }, (_, index) => addDateDays(week, index));
  const firstOpen = dates.find(date => date >= today && !meals[date]);
  if (!firstOpen) return { meals: { ...meals }, additions: [], reasons: {}, readinessByDate: {} };
  const allSaved = Object.values(meals);
  const saved = allSaved.filter((meal) => dates.includes(meal.date));
  const used = new Set(saved.map((meal) => meal.recipeId));
  const identities = new Set(saved.flatMap((meal) => (meal.planningIngredients ?? meal.recipe?.ingredients ?? []).map((item) => canonicalIngredient(item.name))));
  // Keep measured requirements for future reservations, and only the two pantry
  // snapshots needed to rank candidates and insert them in calendar order.
  const reservations: SavedMealReservation[] = [];
  let beforeDate = pantry, virtualPantry = pantry;
  for (const allocation of mealAllocationsInOrder(allSaved, pantry, today)) {
    virtualPantry = allocation.pantry;
    if (allocation.date < firstOpen) beforeDate = allocation.pantry;
    else reservations.push({ date: allocation.date, requiredByGroup: allocation.requiredByGroup, coveredByGroup: allocation.coveredByGroup });
  }
  const candidates = [...new Map(recipes.map((recipe) => [recipe.id, recipe])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const additions: PlannedMeal[] = [];
  const reasons: Record<string, string> = {};
  const readinessByDate: Record<string, MealReadiness> = {};
  for (const date of dates.filter(day => day >= firstOpen)) {
    const current = meals[date];
    if (current) {
      if (current.status !== "cooked") beforeDate = allocateMealStock(current, beforeDate, today).pantry;
      continue;
    }
    const later = reservations.filter(allocation => allocation.date > date);
    const keepsSavedCoverage = savedCoverageGuard(beforeDate, date, later);
    const mealId = options.mealIdForDate?.(date);
    const relevantStock = createPantryIngredientSelector(virtualPantry);
    const choices = candidates.filter(recipe => !used.has(recipe.id)).flatMap((recipe) => {
      const meal = createPlannedMeal(date, recipe, true, { amounts: options.personalRecipeAmounts?.[recipe.id], contentHash: options.contentHashesByRecipeId?.[recipe.id], id: mealId });
      const allocation = allocateMealStock(meal, relevantStock(meal.planningIngredients!.map(ingredient => ingredient.name)), today);
      if (!keepsSavedCoverage(allocation.requiredByGroup)) return [];
      const reuse = allocation.ingredientIdentities.filter((identity) => identities.has(identity)).length;
      return [{ recipe, meal, allocation, reuse }];
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
    if (!chosen) continue; // A later empty date may follow the saved reservation.
    const readiness = mealReadiness(chosen.meal, virtualPantry, today);
    const pantrySummary = `Pantry covers ${readiness.coveredCount} ingredient${readiness.coveredCount === 1 ? "" : "s"}; ${readiness.missingCount + readiness.partialCount} still to buy${readiness.reviewCount ? `; ${readiness.reviewCount} amounts to review` : ""}.`;
    readinessByDate[date] = readiness;
    additions.push(chosen.meal);
    used.add(chosen.recipe.id);
    for (const identity of chosen.allocation.ingredientIdentities) identities.add(identity);
    virtualPantry = allocateMealStock(chosen.meal, virtualPantry, today).pantry;
    if (later.length) beforeDate = allocateMealStock(chosen.meal, beforeDate, today).pantry;
    reasons[date] = chosen.allocation.useSoonCoverage > 0 ? "Uses measured stock due within three days; quantities reserved for this dinner."
      : chosen.allocation.coverage > 0 ? "Uses remaining measured pantry stock after saved dinners are reserved."
      : chosen.reuse > 0 ? "Shares ingredients with this week’s dinners; additional stock may be needed."
      : "Adds a different eligible dinner; check the shopping list for its ingredients.";
    const role = metadata[chosen.recipe.id];
    const roleLabel = role?.coreDinner || role?.dinnerRole === "main" ? "Reviewed main. " : role && role.dinnerRole !== "unknown" ? `Reviewed ${role.dinnerRole}. ` : "Dinner role not reviewed. ";
    reasons[date] = `${roleLabel}${reasons[date]} ${pantrySummary}`;
  }
  return { meals: { ...meals, ...Object.fromEntries(additions.map((meal) => [meal.date, meal])) }, additions, reasons, readinessByDate };
}
