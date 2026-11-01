import type { Recipe, RecipeIngredient } from "./recipe-types";

export interface CookingProfile {
  version: 1;
  allergies: string[];
  diet: string;
  dislikes: string[];
  skillLevel: string;
  budget: string;
  equipment: string[];
}

export const DEFAULT_COOKING_PROFILE: CookingProfile = {
  version: 1, allergies: [], diet: "No restriction", dislikes: [],
  skillLevel: "Confident beginner", budget: "Medium", equipment: ["Oven", "Stovetop"],
};

export interface PantryStock {
  id: string;
  name: string;
  measure: string;
  /** User-entered planning date, inclusive; absence means the date is unknown. */
  useBy?: string;
}

export interface PantryDeduction {
  pantryId: string;
  name?: string;
  before: string;
  after: string;
  useBy?: string;
}

/** Personal planning quantities for exactly one version of a source recipe. */
export interface PersonalRecipeAmounts {
  contentHash: string;
  referenceServings: number | null;
  amounts: Array<{ ingredientIndex: number; originalName: string; measure: string }>;
}

export interface PlannedMeal {
  id: string;
  date: string;
  recipeId: string;
  recipe: Recipe | null;
  title: string;
  baseServings: number | null;
  servings: number | null;
  batches: number;
  locked: boolean;
  status: "planned" | "cooked";
  ingredientOverrides: Record<string, string>;
  planningIngredients?: RecipeIngredient[];
  /** Frozen with the dinner; later edits to personal defaults do not affect it. */
  personalAmountIndices?: number[];
  completion?: {
    id: string;
    at: string;
    deductions: PantryDeduction[];
  };
}

export interface KitchenState {
  schemaVersion: 2;
  pantry: PantryStock[];
  meals: Record<string, PlannedMeal>;
  shoppingChecked: Record<string, boolean>;
  /** A new ID each time an unchecked item is marked bought again. */
  shoppingCycles?: Record<string, string>;
  /** Reviewed purchases, retained independently of changing shopping totals. */
  shoppingPurchases?: ShoppingPurchase[];
  /** Recipe identities only; current catalog permissions and exclusions still apply. */
  favoriteRecipeIds?: string[];
  /** Optional for older kitchens; new edits and backups preserve the shared profile. */
  cookingProfile?: CookingProfile;
  personalRecipeAmounts?: Record<string, PersonalRecipeAmounts>;
  migratedLegacy: boolean;
}

export interface ShoppingPurchase {
  id: string;
  week: string;
  at: string;
  items: Array<{ key: string; cycleId?: string; pantry: PantryStock }>;
}

export interface KitchenDocument {
  revision: number;
  state: KitchenState | null;
  updatedAt: string | null;
}

export const EMPTY_KITCHEN: KitchenState = {
  schemaVersion: 2,
  pantry: [],
  meals: {},
  shoppingChecked: {},
  migratedLegacy: false,
};

export function mealScale(meal: PlannedMeal): number {
  return meal.baseServings && meal.servings
    ? meal.servings / meal.baseServings
    : meal.batches;
}
