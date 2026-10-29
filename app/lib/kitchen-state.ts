import type { KitchenState, PlannedMeal } from "./kitchen-types";
import type { Recipe } from "./recipe-types";
import { normalizePlanningIngredient } from "./quantities";

export const LEGACY_STORAGE_KEY = "rag-chef-prototype-v1";
export const KITCHEN_CACHE_KEY = "rag-chef-kitchen-v2";
export const WEEK_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function localDate(value = new Date()): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

export function addDateDays(date: string, count: number): string {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + count);
  return localDate(value);
}

export function weekStart(date = localDate()): string {
  const day = new Date(`${date}T12:00:00`).getDay();
  return addDateDays(date, -((day + 6) % 7));
}

export function createPlannedMeal(date: string, recipe: Recipe, normalizeIngredients = true): PlannedMeal {
  const baseServings = recipe.servings && recipe.servings > 0 ? recipe.servings : null;
  return {
    id: crypto.randomUUID(), date, recipeId: recipe.id,
    recipe: structuredClone(recipe), title: recipe.title,
    baseServings, servings: baseServings, batches: 1, locked: false,
    status: "planned", ingredientOverrides: {},
    ...(normalizeIngredients ? { planningIngredients: recipe.ingredients.map(normalizePlanningIngredient) } : {}),
  };
}

export function dinnerSelectionStatus(meals: Record<string, PlannedMeal>, date: string, expectedId: string | null): "available" | "protected" | "changed" {
  const current = meals[date];
  if (current?.locked || current?.status === "cooked") return "protected";
  return (current?.id ?? null) === expectedId ? "available" : "changed";
}

export function placePlannedDinner(state: KitchenState, date: string, recipe: Recipe, expectedId: string | null, template?: PlannedMeal): KitchenState {
  if (dinnerSelectionStatus(state.meals, date, expectedId) !== "available") return state;
  const fresh = createPlannedMeal(date, recipe);
  const meal = template ? { ...structuredClone(template), planningIngredients: structuredClone(template.planningIngredients ?? fresh.planningIngredients), id: fresh.id, date, locked: false, status: "planned" as const } : fresh;
  delete meal.completion;
  return { ...state, meals: { ...state.meals, [date]: meal } };
}

export function migrateLegacyKitchen(
  legacy: Record<string, unknown> | null,
  recipes: Recipe[],
  start = weekStart(),
): KitchenState {
  const pantry = Array.isArray(legacy?.pantry)
    ? legacy.pantry.filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
    : [];
  const state: KitchenState = {
    schemaVersion: 2,
    pantry: [...new Set(pantry)].map((name) => ({ id: crypto.randomUUID(), name, measure: "" })),
    meals: {}, shoppingChecked: {}, migratedLegacy: true,
  };
  if (legacy?.plan && typeof legacy.plan === "object") {
    for (const [index, day] of WEEK_DAYS.entries()) {
      const id = (legacy.plan as Record<string, unknown>)[day];
      if (typeof id !== "string" || !id) continue;
      const date = addDateDays(start, index);
      const recipe = recipes.find((item) => item.id === id || item.id.endsWith(`:${id}`));
      state.meals[date] = recipe ? createPlannedMeal(date, recipe, false) : {
        id: crypto.randomUUID(), date, recipeId: id, recipe: null,
        title: `Saved recipe (${id})`, baseServings: null, servings: null,
        batches: 1, locked: false, status: "planned", ingredientOverrides: {},
      };
    }
  }
  return state;
}
