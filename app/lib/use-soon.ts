import type { KitchenState, PantryStock, PlannedMeal } from "./kitchen-types";
import type { Recipe, RecipeConstraints, RecipeMetadataMap } from "./recipe-types";
import { addDateDays, weekStart } from "./kitchen-state";
import { evaluateRecipeConstraints } from "./recipe-constraints";
import { allocateMealStock, allocateStockForMeals, canonicalIngredient, formatMeasure, mealReadiness, normalizePlanningIngredient, parseMeasure } from "./quantities";

export type PantryFilter = "all" | "soon" | "past";

export function pantryDateGroups(pantry: PantryStock[], today: string) {
  const dated = pantry.filter(item => item.useBy && parseMeasure(item.measure)?.quantity !== 0)
    .slice().sort((a, b) => a.useBy!.localeCompare(b.useBy!) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return {
    all: pantry,
    soon: dated.filter(item => item.useBy! >= today && item.useBy! <= addDateDays(today, 3)),
    past: dated.filter(item => item.useBy! < today),
  };
}

/** Estimates share the planner's inventory and never mutate kitchen or source data. */
export function rankUseSoonDinners({ kitchen, selectedId, today, date, portions, recipes, metadata, constraints }: {
  kitchen: KitchenState; selectedId: string; today: string; date: string; portions: number | null;
  recipes: Recipe[]; metadata: RecipeMetadataMap; constraints: RecipeConstraints;
}) {
  const selected = pantryDateGroups(kitchen.pantry, today).soon.find(item => item.id === selectedId);
  const saved = Object.values(kitchen.meals).filter(meal => meal.date !== date && weekStart(meal.date) === weekStart(date));
  const remaining = allocateStockForMeals(saved, kitchen.pantry, today).pantry;
  const stock = remaining.find(item => item.id === selectedId);
  const status = !selected || !stock ? "missing" : selected.useBy! < date ? "past_dinner"
    : parseMeasure(stock.measure)?.quantity === 0 ? "reserved" : "ready";
  const candidates = status !== "ready" ? [] : recipes.flatMap(recipe => {
    const eligibility = evaluateRecipeConstraints(recipe, metadata[recipe.id], constraints);
    if (!eligibility.eligible) return [];
    const meal: PlannedMeal = {
      id: `use-soon:${recipe.id}`, date, recipeId: recipe.id, recipe, title: recipe.title,
      baseServings: recipe.servings && recipe.servings > 0 ? recipe.servings : null,
      servings: recipe.servings ? portions ?? recipe.servings : null, batches: 1,
      locked: false, status: "planned", ingredientOverrides: {},
      planningIngredients: recipe.ingredients.map(normalizePlanningIngredient),
    };
    const allocation = allocateMealStock(meal, remaining, today);
    if (!allocation.ingredientIdentities.includes(canonicalIngredient(selected!.name))) return [];
    const deductions = allocation.deductions.filter(item => item.pantryId === selectedId);
    const used = deductions.reduce((sum, item) => sum + (parseMeasure(item.before)?.quantity ?? 0) - (parseMeasure(item.after)?.quantity ?? 0), 0);
    const unit = parseMeasure(stock!.measure)?.unit;
    return [{ recipe, eligibility, readiness: mealReadiness(meal, remaining, today),
      usesSelected: used > 0, usedMeasure: used > 0 && unit !== undefined ? formatMeasure(used, unit) : null }];
  }).sort((a, b) => Number(b.usesSelected) - Number(a.usesSelected)
    || Number(Boolean(metadata[b.recipe.id]?.coreDinner || metadata[b.recipe.id]?.dinnerRole === "main")) - Number(Boolean(metadata[a.recipe.id]?.coreDinner || metadata[a.recipe.id]?.dinnerRole === "main"))
    || b.readiness.coverage - a.readiness.coverage || a.recipe.title.localeCompare(b.recipe.title) || a.recipe.id.localeCompare(b.recipe.id));
  return { selected, stock, status, candidates };
}
