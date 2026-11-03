import type { KitchenState, PlannedMeal } from "./kitchen-types";
import type { Recipe, RecipeMetadataMap, Diet } from "./recipe-types";
import type { MealReadiness, ShoppingItem } from "./quantities";

export type ChefPlanPriority = "use_soon" | "fewer_groceries" | "variety";
export interface ChefPlanIntent {
  week: string;
  today: string;
  count: number;
  /** Positive dish, cuisine or ingredient query, distinct from exclusions. */
  recipeQuery?: string;
  dates: string[];
  servings: number | null;
  batches: number | null;
  excludedIngredients: string[];
  diets: Diet[];
  excludedEquipment: string[];
  maxTotalMinutes?: number;
  priority: ChefPlanPriority;
  allowRepeats: boolean;
  replaceDates: string[];
  /** Saved dinner replacements already authorized in an earlier reviewed draft. */
  authorizedReplacementDates?: string[];
  keepDates: string[];
  perDate: Record<string, { diet?: Diet; servings?: number; batches?: number; recipeId?: string }>;
}
export interface ChefPlanChange {
  date: string;
  expectedMealId: string | null;
  recipeHash: string;
  meal: PlannedMeal;
  reason: string;
  readiness: MealReadiness;
}
export interface ChefPlanDraft {
  version: 1;
  kitchenRevision: number;
  intent: ChefPlanIntent;
  changes: ChefPlanChange[];
  shopping: ShoppingItem[];
  beforeShopping: ShoppingItem[];
  unresolved: string[];
  warnings: string[];
  reviewHash: string;
  interpretation: "ollama" | "openai" | "manual" | "rules";
  timings?: { totalMs: number };
}
export interface ChefPlanCatalog {
  recipes: Recipe[];
  metadata: RecipeMetadataMap;
  contentHashes: Record<string, string>;
}
export interface ChefPlanInput {
  kitchen: KitchenState;
  revision: number;
  catalog: ChefPlanCatalog;
  intent: ChefPlanIntent;
  previousDraft?: ChefPlanDraft;
}
export interface ChefPlanResponse {
  draft?: ChefPlanDraft;
  clarification?: string;
  error?: { code: string; message: string };
}
