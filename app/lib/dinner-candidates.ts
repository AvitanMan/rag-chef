import type { KitchenState, PlannedMeal } from "./kitchen-types";
import type { Recipe, RecipeConstraints, RecipeMetadataMap } from "./recipe-types";
import { addDateDays, weekStart } from "./kitchen-state";
import { chefMealPreview } from "./chef-context";
import { isEverydayRecipe } from "./everyday-collection";
import { isBasicSeasoning } from "./pantry-recipe-fit";
import { evaluateRecipeConstraints } from "./recipe-constraints";
import {
  allocateMealStock, allocateStockForMeals, applyPersonalRecipeAmounts, canonicalIngredient,
  createPantryIngredientSelector, formatMeasure, mealReadiness, normalizePlanningIngredient, pantryStockEligibility, parseMeasure,
  type MealReadiness, type MealStockAllocation,
} from "./quantities";

export interface DinnerCandidate {
  recipe: Recipe;
  /** The exact planning amounts to carry through selection and replacement review. */
  meal: PlannedMeal;
  /** Physical stock, including frozen stock, after the other saved dinners reserve it. */
  readiness: MealReadiness;
  reason: string | null;
  frozenCoverage: string[];
  /** Discovery scores exclude unselected frozen stock; they are not a shopping quote. */
  rank: {
    role: number;
    dislikes: number;
    usesSoon: boolean;
    unresolvedFood: number;
    uncertainFood: number;
    pickedFood: number;
    coverage: number;
  };
}

export interface DinnerCandidateOptions {
  recipes: readonly Recipe[];
  kitchen: KitchenState;
  today: string;
  date: string;
  portions: number | null;
  metadata: RecipeMetadataMap;
  constraints: RecipeConstraints;
  /** Omit for general browsing; an explicit selection requires a matching available food. */
  selectedKeys?: readonly string[];
  contentHashesByRecipeId?: Record<string, string>;
}

export function compareDinnerCandidates(a: DinnerCandidate, b: DinnerCandidate): number {
  return a.rank.role - b.rank.role
    || a.rank.dislikes - b.rank.dislikes
    || Number(b.rank.usesSoon) - Number(a.rank.usesSoon)
    || a.rank.unresolvedFood - b.rank.unresolvedFood
    || a.rank.uncertainFood - b.rank.uncertainFood
    || b.rank.pickedFood - a.rank.pickedFood
    || b.rank.coverage - a.rank.coverage
    || a.recipe.title.localeCompare(b.recipe.title, "en", { sensitivity: "base" })
    || a.recipe.id.localeCompare(b.recipe.id);
}

function usedAmount(deduction: MealStockAllocation["deductions"][number]): number {
  return Math.max(0, (parseMeasure(deduction.before)?.quantity ?? 0) - (parseMeasure(deduction.after)?.quantity ?? 0));
}

function frozenAmounts(allocation: MealStockAllocation): string[] {
  const groups = new Map<string, { name: string; amount: number; unit: string }>();
  for (const deduction of allocation.deductions) {
    if (deduction.location !== "freezer" || !deduction.name) continue;
    const parsed = parseMeasure(deduction.before), amount = usedAmount(deduction);
    if (!parsed || amount <= 0) continue;
    const key = JSON.stringify([canonicalIngredient(deduction.name), parsed.unit]);
    const previous = groups.get(key);
    groups.set(key, { name: previous?.name ?? deduction.name, amount: (previous?.amount ?? 0) + amount, unit: parsed.unit });
  }
  return [...groups.values()].map(({ name, amount, unit }) => `${name}: ${formatMeasure(amount, unit)}`);
}

/** Compare independent dinner previews against one reserved inventory, without writes or model calls. */
export function evaluateDinnerCandidates({ recipes, kitchen, today, date, portions, metadata, constraints,
  selectedKeys, contentHashesByRecipeId = {} }: DinnerCandidateOptions): DinnerCandidate[] {
  const stockDate = date > today ? date : today;
  const selected = new Set(selectedKeys?.map(canonicalIngredient).filter(Boolean));
  const availableSelected = new Set(kitchen.pantry.filter(stock => pantryStockEligibility(stock, stockDate).eligible)
    .map(stock => canonicalIngredient(stock.name)).filter(key => selected.has(key)));
  const pickedFood = new Set([...availableSelected].filter(key => !isBasicSeasoning(key)));
  if (selectedKeys !== undefined && !pickedFood.size) return [];

  const saved = Object.values(kitchen.meals).filter(meal => meal.date !== date && weekStart(meal.date) === weekStart(date));
  // Reserve against all physical stock before applying discovery's freezer preference.
  const remaining = allocateStockForMeals(saved, kitchen.pantry, today).pantry;
  const relevantPantry = createPantryIngredientSelector(remaining);
  const soonEnd = addDateDays(today, 3);
  const validPortions = portions !== null && Number.isInteger(portions) && portions >= 1 && portions <= 100;

  return recipes.flatMap(recipe => {
    const eligibility = evaluateRecipeConstraints(recipe, metadata[recipe.id], constraints);
    if (!eligibility.eligible) return [];
    const identities = new Set(recipe.ingredients.map(ingredient => canonicalIngredient(normalizePlanningIngredient(ingredient).name)));
    const selectedFoodOverlap = [...pickedFood].filter(key => identities.has(key)).length;
    if (selectedKeys !== undefined && !selectedFoodOverlap) return [];
    const baseServings = recipe.servings && recipe.servings > 0 ? recipe.servings : null;
    const original: PlannedMeal = {
      id: `candidate:${date}:${recipe.id}`, date, recipeId: recipe.id, recipe: structuredClone(recipe), title: recipe.title,
      baseServings, servings: baseServings, batches: 1, locked: false, status: "planned", ingredientOverrides: {},
      planningIngredients: recipe.ingredients.map(normalizePlanningIngredient),
    };
    const personal = applyPersonalRecipeAmounts(original, kitchen.personalRecipeAmounts?.[recipe.id], contentHashesByRecipeId[recipe.id]);
    const meal = chefMealPreview(personal, { purpose: "planning", targetDate: date, ...(validPortions ? { servings: portions } : {}) });
    // Unrelated ingredients cannot cover this meal or contribute preparation warnings.
    const mealStock = relevantPantry((meal.planningIngredients ?? recipe.ingredients).map(ingredient => ingredient.name));
    const discoveryStock = mealStock.filter(stock => stock.location !== "freezer" || availableSelected.has(canonicalIngredient(stock.name)));
    const sameStock = discoveryStock.length === mealStock.length;
    const allocation = allocateMealStock(meal, discoveryStock, today);
    const discoveryReadiness = mealReadiness(meal, discoveryStock, today);
    const readiness = sameStock ? discoveryReadiness : mealReadiness(meal, mealStock, today);
    const unresolved = discoveryReadiness.shopping.filter(item => !isBasicSeasoning(item.name));
    const unresolvedFood = new Set(unresolved.map(item => canonicalIngredient(item.name))).size;
    const uncertainFood = new Set(unresolved.filter(item => item.needsReview).map(item => canonicalIngredient(item.name))).size;
    const urgent = [...new Set(allocation.deductions.filter(item => item.name && !isBasicSeasoning(item.name)
      && item.useBy && item.useBy >= today && item.useBy <= soonEnd && usedAmount(item) > 0).map(item => item.name!))];
    const role = metadata[recipe.id]?.dinnerRole ?? (isEverydayRecipe(recipe) ? "main" : "unknown");
    return [{ recipe, meal, readiness,
      reason: urgent.length ? `Uses ${urgent.join(", ")} due soon.`
        : unresolvedFood ? `${unresolvedFood} food ingredient${unresolvedFood === 1 ? "" : "s"} still need${unresolvedFood === 1 ? "s" : ""} checking.`
        : identities.size ? "Food amounts are covered by available stock." : null,
      frozenCoverage: mealStock.some(stock => stock.location === "freezer")
        ? frozenAmounts(sameStock ? allocation : allocateMealStock(meal, mealStock, today)) : [],
      rank: { role: role === "main" ? 0 : role === "unknown" ? 1 : 2,
        dislikes: eligibility.dislikedIngredients.length, usesSoon: urgent.length > 0, unresolvedFood, uncertainFood,
        pickedFood: selectedFoodOverlap, coverage: allocation.coverage },
    }];
  }).sort(compareDinnerCandidates);
}
