import type { Recipe } from "./recipe-types";
import { canonicalIngredient, normalizePlanningIngredient, parseMeasure } from "./quantities";

export const RECIPE_PAGE_SIZE = 24;

export function recipeCompleteness(recipe: Recipe) {
  return {
    knownServings: Boolean(recipe.servings),
    amountReviewCount: recipe.ingredients.filter((ingredient) => !parseMeasure(normalizePlanningIngredient(ingredient).measure)).length,
  };
}

export function normalizeRecipeSearch(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/** Name coverage only: this never claims that pantry quantities cover a dinner. */
export function recipePantryDetails(recipe: Recipe, pantry: string[]) {
  const identity = (name: string) => canonicalIngredient(normalizeRecipeSearch(name));
  const stock = new Set(pantry.map(identity).filter(Boolean));
  const matched: string[] = [];
  const missing: string[] = [];
  for (const ingredient of recipe.ingredients) {
    const name = identity(ingredient.name);
    (name && stock.has(name) ? matched : missing).push(ingredient.name);
  }
  const total = recipe.ingredients.length;
  return { matched, missing, total, coverage: total ? matched.length / total : 0 };
}

/** Local catalog browsing only; never calls an AI provider or changes recipes. */
export function browseRecipes(recipes: Recipe[], query: string, pantry: string[]): Recipe[] {
  const search = normalizeRecipeSearch(query);
  const words = search.split(" ").filter(Boolean);
  return recipes.map((recipe) => {
    const title = normalizeRecipeSearch(recipe.title);
    const names = recipe.ingredients.map((item) => normalizeRecipeSearch(item.name));
    const haystack = [title, ...names].join(" ");
    const coverage = recipePantryDetails(recipe, pantry).coverage;
    return { recipe, matches: words.every((word) => haystack.includes(word)), exact: Boolean(search) && title === search, coverage };
  }).filter((item) => item.matches)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.coverage - a.coverage
      || a.recipe.title.localeCompare(b.recipe.title, "en", { sensitivity: "base" })
      || a.recipe.id.localeCompare(b.recipe.id))
    .map((item) => item.recipe);
}
