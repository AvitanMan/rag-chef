import { DEFAULT_COOKING_PROFILE, type KitchenState, type PantryStock, type PlannedMeal } from "./kitchen-types";

export type KitchenChangeRow = Readonly<{
  id: string;
  category: "Pantry" | "Dinners" | "Cooking preferences" | "Shopping" | "Favorites" | "Personal amounts" | "History";
  label: string;
  before: string | null;
  after: string | null;
  kind: "added" | "removed" | "changed";
}>;
export type KitchenChangePreview = Readonly<{ rows: readonly KitchenChangeRow[]; hasChanges: boolean }>;

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
}
function same(before: unknown, after: unknown): boolean { return canonical(before) === canonical(after); }
function list(values: readonly string[], empty = "None entered"): string { return values.join(", ") || empty; }
function pantryValue(stock: PantryStock | undefined): string | null {
  return stock ? `${stock.name} · ${stock.measure.trim() || "Amount unknown"} · ${stock.useBy ? `Use by ${stock.useBy}` : "No use-by date"}` : null;
}
function mealValue(meal: PlannedMeal | undefined): string | null {
  if (!meal) return null;
  const portions = meal.servings !== null ? `${meal.servings} serving${meal.servings === 1 ? "" : "s"}` : `${meal.batches} recipe batch${meal.batches === 1 ? "" : "es"}`;
  const amounts = Object.entries(meal.ingredientOverrides).sort(([left], [right]) => Number(left) - Number(right)).map(([index, amount]) => {
    const ingredient = (meal.planningIngredients ?? meal.recipe?.ingredients ?? [])[Number(index)];
    return `${ingredient?.name ?? `Ingredient ${Number(index) + 1}`}: ${amount.trim() || "Amount unknown"}`;
  });
  return `${meal.title} · ${portions} · ${meal.status === "cooked" ? "Cooked" : "Planned"} · ${meal.locked ? "Locked" : "Unlocked"}${amounts.length ? ` · Custom amounts: ${amounts.join("; ")}` : ""}`;
}
function recipeValue(meal: PlannedMeal): string {
  const recipe = meal.recipe;
  if (!recipe) return "Recipe details unavailable";
  return `${recipe.title} · ${recipe.source.name} · ${recipe.ingredients.length} ingredients · ${recipe.instructions.length} directions`;
}
function plural(count: number, singular: string, multiple = `${singular}s`): string { return `${count} ${count === 1 ? singular : multiple}`; }

/** Presentation only: neither input is mutated, and no quantities are inferred. */
export function buildKitchenChangePreview(before: KitchenState, after: KitchenState): KitchenChangePreview {
  const rows: KitchenChangeRow[] = [];
  const add = (id: string, category: KitchenChangeRow["category"], label: string, left: string | null, right: string | null) => {
    rows.push(Object.freeze({ id, category, label, before: left, after: right, kind: left === null ? "added" : right === null ? "removed" : "changed" }));
  };
  const pantryBefore = new Map(before.pantry.map(stock => [stock.id, stock]));
  const pantryAfter = new Map(after.pantry.map(stock => [stock.id, stock]));
  for (const id of [...new Set([...pantryBefore.keys(), ...pantryAfter.keys()])].sort()) {
    const left = pantryBefore.get(id), right = pantryAfter.get(id);
    if (!same(left, right)) add(`pantry:${id}`, "Pantry", right?.name ?? left!.name, pantryValue(left), pantryValue(right));
  }
  for (const date of [...new Set([...Object.keys(before.meals), ...Object.keys(after.meals)])].sort()) {
    const left = before.meals[date], right = after.meals[date];
    if (same(left, right)) continue;
    if (!left || !right) { add(`dinner:${date}`, "Dinners", date, mealValue(left), mealValue(right)); continue; }
    const leftValue = mealValue(left), rightValue = mealValue(right);
    if (leftValue !== rightValue) add(`dinner:${date}`, "Dinners", date, leftValue, rightValue);
    if (!same(left.recipe, right.recipe) || left.recipeId !== right.recipeId) {
      const previous = recipeValue(left), next = recipeValue(right);
      add(`dinner:${date}:recipe`, "Dinners", `${date} · Recipe details`, previous, previous === next ? `${next} · Content changed` : next);
    }
    if (!same(left.planningIngredients, right.planningIngredients)) {
      const describe = (meal: PlannedMeal) => (meal.planningIngredients ?? meal.recipe?.ingredients ?? []).map(ingredient => `${ingredient.name}: ${ingredient.measure.trim() || "Amount unknown"}`).join("; ") || "No ingredients recorded";
      add(`dinner:${date}:ingredients`, "Dinners", `${date} · Planning ingredients`, describe(left), describe(right));
    }
    if (left.baseServings !== right.baseServings) add(`dinner:${date}:yield`, "Dinners", `${date} · Recipe yield`, left.baseServings === null ? "Unknown yield" : `${left.baseServings} servings per batch`, right.baseServings === null ? "Unknown yield" : `${right.baseServings} servings per batch`);
    if (!same(left.completion, right.completion)) {
      const describe = (meal: PlannedMeal) => meal.completion ? `Cooked ${meal.completion.at} · ${plural(meal.completion.deductions.length, "pantry deduction")}` : null;
      const previous = describe(left), next = describe(right);
      add(`dinner:${date}:completion`, "Dinners", `${date} · Cooking record`, previous, next !== null && previous === next ? `${next} · Deductions changed` : next);
    }
    if (!same(left.personalAmountIndices ?? [], right.personalAmountIndices ?? [])) add(`dinner:${date}:personal`, "Dinners", `${date} · Personal amounts`, plural(left.personalAmountIndices?.length ?? 0, "ingredient with a personal amount", "ingredients with personal amounts"), `${plural(right.personalAmountIndices?.length ?? 0, "ingredient with a personal amount", "ingredients with personal amounts")} · Selection changed`);
    if (left.id !== right.id && !rows.some(row => row.id === `dinner:${date}`)) add(`dinner:${date}:entry`, "Dinners", date, leftValue, `${rightValue} · Dinner entry replaced`);
  }
  const previousProfile = before.cookingProfile ?? DEFAULT_COOKING_PROFILE, nextProfile = after.cookingProfile ?? DEFAULT_COOKING_PROFILE;
  const profileFields = [
    ["allergies", "Allergies"], ["diet", "Diet"], ["equipment", "Equipment"], ["dislikes", "Dislikes"], ["skillLevel", "Cooking confidence"], ["budget", "Budget"],
  ] as const;
  for (const [key, label] of profileFields) {
    const previous = previousProfile[key], next = nextProfile[key];
    const normalized = (value: string | string[]) => Array.isArray(value) ? [...value].sort() : value;
    if (!same(normalized(previous), normalized(next))) add(`profile:${key}`, "Cooking preferences", label, Array.isArray(previous) ? list(previous) : previous, Array.isArray(next) ? list(next) : next);
  }
  const boughtBefore = Object.keys(before.shoppingChecked).filter(key => before.shoppingChecked[key]).sort(), boughtAfter = Object.keys(after.shoppingChecked).filter(key => after.shoppingChecked[key]).sort();
  if (!same(boughtBefore, boughtAfter)) add("shopping:checked", "Shopping", "Shopping checklist", plural(boughtBefore.length, "item marked bought", "items marked bought"), `${plural(boughtAfter.length, "item marked bought", "items marked bought")}${boughtBefore.length === boughtAfter.length ? " · Different items" : ""}`);
  if (!same(before.shoppingCycles ?? {}, after.shoppingCycles ?? {})) add("shopping:cycles", "Shopping", "Purchase tracking", plural(Object.keys(before.shoppingCycles ?? {}).length, "tracked item"), `${plural(Object.keys(after.shoppingCycles ?? {}).length, "tracked item")} · Tracking changed`);
  if (!same(before.shoppingPurchases ?? [], after.shoppingPurchases ?? [])) add("shopping:purchases", "Shopping", "Purchases added to pantry", plural(before.shoppingPurchases?.length ?? 0, "purchase"), `${plural(after.shoppingPurchases?.length ?? 0, "purchase")}${before.shoppingPurchases?.length === after.shoppingPurchases?.length ? " · Purchase details changed" : ""}`);
  const favoritesBefore = [...(before.favoriteRecipeIds ?? [])].sort(), favoritesAfter = [...(after.favoriteRecipeIds ?? [])].sort();
  if (!same(favoritesBefore, favoritesAfter)) add("favorites", "Favorites", "Favorite recipes", plural(favoritesBefore.length, "favorite"), `${plural(favoritesAfter.length, "favorite")}${favoritesBefore.length === favoritesAfter.length ? " · Different recipes" : ""}`);
  if (!same(before.personalRecipeAmounts ?? {}, after.personalRecipeAmounts ?? {})) add("personal-amounts", "Personal amounts", "Personal recipe amounts", plural(Object.keys(before.personalRecipeAmounts ?? {}).length, "recipe with personal amounts", "recipes with personal amounts"), `${plural(Object.keys(after.personalRecipeAmounts ?? {}).length, "recipe with personal amounts", "recipes with personal amounts")} · Ingredient quantities or recipe version changed`);
  if (!same(before.tastePreferences ?? [], after.tastePreferences ?? [])) add("history:tastes", "History", "Recipe feedback", plural(before.tastePreferences?.length ?? 0, "preference"), `${plural(after.tastePreferences?.length ?? 0, "preference")} · Feedback changed`);
  if (!same(before.recentActionReceipts ?? [], after.recentActionReceipts ?? [])) add("history:actions", "History", "Applied kitchen actions", plural(before.recentActionReceipts?.length ?? 0, "saved action"), `${plural(after.recentActionReceipts?.length ?? 0, "saved action")} · History changed`);
  return Object.freeze({ rows: Object.freeze(rows), hasChanges: rows.length > 0 });
}
