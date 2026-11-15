import { DEMO_RECIPES, DEMO_SOURCE } from "./demo-recipes";
import type { Recipe } from "./recipe-types";

/** A named collection of bundled originals, not a quality claim about imported recipes. */
export const EVERYDAY_RECIPES = DEMO_RECIPES.filter(recipe => recipe.tags.includes("everyday"));

export function isEverydayRecipe(recipe: Recipe): boolean {
  return EVERYDAY_RECIPES.some(original => recipe.id === `${DEMO_SOURCE.id}:${original.id}`
    && recipe.sourceUrl === original.sourceUrl);
}

export function missingEverydayRecipeCount(recipes: readonly Recipe[]): number {
  const ids = new Set(recipes.filter(isEverydayRecipe).map(recipe => recipe.id));
  return EVERYDAY_RECIPES.filter(recipe => !ids.has(`${DEMO_SOURCE.id}:${recipe.id}`)).length;
}

/** Display an authored introduction, never generate an unsupported description. */
export function recipeIntroduction(recipe: Recipe): string | undefined {
  const prefix = "About this dish: ";
  return recipe.sourceNotes?.find(note => note.startsWith(prefix))?.slice(prefix.length);
}
