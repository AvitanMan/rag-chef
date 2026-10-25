import type { Recipe } from "./recipe-types";
import type { PlannedMeal } from "./kitchen-types";
import type { ChefDinnerContext } from "./chef-schema";

/** Preview explicit planning changes without changing stored amounts or cooking. */
export function chefMealPreview(meal: PlannedMeal, context: ChefDinnerContext): PlannedMeal {
  if (context.purpose === "cooking") return meal;
  return { ...meal, date: context.targetDate ?? meal.date,
    ...(meal.baseServings && context.servings !== undefined ? { servings: context.servings } : {}),
    ...(!meal.baseServings && context.batches !== undefined ? { batches: context.batches } : {}),
  };
}

export async function chefRecipeHash(recipe: Recipe): Promise<string> {
  const text = JSON.stringify([recipe.id, recipe.title, recipe.ingredients, recipe.instructions, recipe.servings ?? null, recipe.sourceUrl]);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function recipeEvidence(recipe: Recipe) {
  return [...recipe.ingredients.map((item, i) => ({ evidenceId: `I${i + 1}`, text: [item.measure, item.name].filter(Boolean).join(" ") })),
    ...recipe.instructions.map((text, i) => ({ evidenceId: `S${i + 1}`, text }))];
}

/** Keep original IDs and whole source steps. Missing context is explicit. */
export function selectQuestionEvidence(recipe: Recipe, query: string, stepId?: string) {
  const all = recipeEvidence(recipe);
  if (!stepId && (all.length <= 12 || /\b(?:full|complete|all)\s+(?:directions|instructions|method)|\bhow\b.*\b(?:make|cook|prepare)\b/i.test(query))) return all;
  const forms: Record<string, string> = { baking: "bake", baked: "bake", boiling: "boil", boiled: "boil", frying: "fry", fried: "fry", simmering: "simmer", simmered: "simmer", melting: "melt", melted: "melt", mixing: "mix", mixed: "mix", draining: "drain", drained: "drain", cooling: "cool", cooled: "cool", stirring: "stir", stirred: "stir" };
  const words = (text: string) => (text.toLowerCase().match(/[a-z]{3,}/g) ?? []).map((word) => forms[word] ?? word);
  const terms = new Set(words(query).filter((term) => !["what", "which", "does", "this", "that", "with", "recipe", "source", "step", "please", "explain", "mentions"].includes(term)));
  const selected = new Set(recipe.ingredients.map((_, index) => `I${index + 1}`));
  const current = stepId ? Number(stepId.slice(1)) - 1 : -1;
  if (current >= 0) for (const index of [current - 1, current, current + 1]) if (recipe.instructions[index]) selected.add(`S${index + 1}`);
  const scored = recipe.instructions.map((text, index) => ({ index, score: [...terms].filter((term) => words(text).includes(term)).length }));
  for (const item of scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 6)) {
    for (const index of [item.index - 1, item.index, item.index + 1]) if (recipe.instructions[index]) selected.add(`S${index + 1}`);
  }
  return all.filter((item) => selected.has(item.evidenceId));
}

/** Ordered matching works for old sessions and multiple source methods. */
export function cookingSourceStep(recipe: Recipe, instructions: string[], step: number): string | undefined {
  const n = instructions.length, m = recipe.instructions.length;
  if (step < 0 || step >= n) return undefined;
  const prefix = Array.from({ length: n + 1 }, () => Array<boolean>(m + 1).fill(false));
  const suffix = Array.from({ length: n + 1 }, () => Array<boolean>(m + 1).fill(false));
  prefix[0].fill(true); suffix[n].fill(true);
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) prefix[i][j] = prefix[i][j - 1] || instructions[i - 1] === recipe.instructions[j - 1] && prefix[i - 1][j - 1];
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) suffix[i][j] = suffix[i][j + 1] || instructions[i] === recipe.instructions[j] && suffix[i + 1][j + 1];
  const matches = recipe.instructions.flatMap((text, index) => text === instructions[step] && prefix[step][index] && suffix[step + 1][index + 1] ? [index] : []);
  return matches.length === 1 ? `S${matches[0] + 1}` : undefined;
}

export async function chefMealHash(meal: import("./kitchen-types").PlannedMeal): Promise<string> {
  const text = JSON.stringify([meal.id, meal.recipeId, meal.recipe, meal.planningIngredients ?? null, meal.baseServings, meal.servings, meal.batches, meal.ingredientOverrides]);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
