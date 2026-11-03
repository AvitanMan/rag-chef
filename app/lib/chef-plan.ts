import type { ChefPlanCatalog, ChefPlanDraft, ChefPlanInput, ChefPlanIntent, ChefPlanChange } from "./chef-plan-types";
import type { KitchenState, PlannedMeal } from "./kitchen-types";
import { DEFAULT_COOKING_PROFILE, DINNER_AMOUNT_LIMITS } from "./kitchen-types";
import type { Recipe, Diet } from "./recipe-types";
import { addDateDays, createPlannedMeal, weekStart } from "./kitchen-state";
import { normalizeConstraints, evaluateRecipeConstraints } from "./recipe-constraints";
import { allocateMealStock, allocateStockForMeals, mealReadiness } from "./quantities";
import { shoppingForWeek } from "./shopping-purchases";
import { chefRecipeHash } from "./chef-context";
import { validateKitchenState } from "./kitchen-validation";
import { bm25Scores, retrievalTerms } from "./retrieval-ranking";

export class ChefPlanError extends Error {
  constructor(message: string, public code = "invalid_plan", public status = 400) { super(message); this.name = "ChefPlanError"; }
}
function changed(message = "This plan changed. Review a new preview before applying."): never { throw new ChefPlanError(message, "plan_changed", 409); }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const dietValues: Diet[] = ["vegetarian", "vegan", "gluten_free", "low_carb"];
function date(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}
function stringList(value: unknown, limit = 100): string[] {
  if (!Array.isArray(value) || value.length > limit || value.some(item => typeof item !== "string" || !item.trim() || item.length > 120 || /[\x00-\x1f]/.test(item))) throw new ChefPlanError("Check the plan's list of requirements.");
  return [...new Set(value.map(item => item.trim()))];
}
function amount(value: unknown, kind: "servings" | "batches"): number | null {
  if (value == null) return null;
  const limits = DINNER_AMOUNT_LIMITS[kind];
  if (typeof value !== "number" || !Number.isFinite(value) || value < limits.min || value > limits.max || !Number.isInteger(value / limits.step)) throw new ChefPlanError(`Check ${kind} in the planning request.`);
  return value;
}
export function validatePlanIntent(value: unknown): ChefPlanIntent {
  const keys = ["week", "today", "count", "recipeQuery", "dates", "servings", "batches", "excludedIngredients", "diets", "excludedEquipment", "maxTotalMinutes", "priority", "allowRepeats", "replaceDates", "authorizedReplacementDates", "keepDates", "perDate"];
  if (!record(value) || Object.keys(value).some(key => !keys.includes(key)) || !date(value.week) || weekStart(value.week) !== value.week || !date(value.today)) throw new ChefPlanError("Choose a valid planning week and today's date.");
  if (!Number.isInteger(value.count) || Number(value.count) < 1 || Number(value.count) > 7) throw new ChefPlanError("Plan between one and seven dinners.");
  const week = value.week, today = value.today;
  if (value.recipeQuery !== undefined && (typeof value.recipeQuery !== "string" || !value.recipeQuery.trim() || value.recipeQuery.length > 200)) throw new ChefPlanError("Choose a dish, cuisine or ingredient query of 1–200 characters.");
  const dates = (input: unknown) => stringList(input, 7).map(item => {
    if (!date(item) || item < week || item >= addDateDays(week, 7) || item < today) throw new ChefPlanError("Choose upcoming dates within the selected week.");
    return item;
  }).sort();
  const selected = dates(value.dates), keepDates = dates(value.keepDates), replaceDates = dates(value.replaceDates), authorizedReplacementDates = dates(value.authorizedReplacementDates ?? []);
  if (keepDates.some(day => replaceDates.includes(day))) throw new ChefPlanError("A dinner cannot be kept and replaced in the same request.");
  if (!record(value.perDate) || Object.keys(value.perDate).length > 7) throw new ChefPlanError("Check the individual dinner preferences.");
  const perDate: ChefPlanIntent["perDate"] = {};
  for (const [day, row] of Object.entries(value.perDate)) {
    dates([day]);
    if (!record(row) || Object.keys(row).some(key => !["diet", "servings", "batches", "recipeId"].includes(key)) || row.diet !== undefined && !dietValues.includes(row.diet as Diet)
      || row.recipeId !== undefined && (typeof row.recipeId !== "string" || !row.recipeId || row.recipeId.length > 200)) throw new ChefPlanError("Check the individual dinner preferences.");
    const servings = amount(row.servings, "servings"), batches = amount(row.batches, "batches");
    if (servings !== null && batches !== null) throw new ChefPlanError("Choose servings or recipe batches for each dinner.");
    perDate[day] = { ...(row.diet ? { diet: row.diet as Diet } : {}), ...(servings !== null ? { servings } : {}), ...(batches !== null ? { batches } : {}), ...(row.recipeId ? { recipeId: row.recipeId as string } : {}) };
  }
  const diets = stringList(value.diets);
  if (diets.some(diet => !dietValues.includes(diet as Diet)) || !["use_soon", "fewer_groceries", "variety"].includes(String(value.priority)) || typeof value.allowRepeats !== "boolean") throw new ChefPlanError("Choose supported planning preferences.");
  if (value.maxTotalMinutes !== undefined && (!Number.isInteger(value.maxTotalMinutes) || Number(value.maxTotalMinutes) < 1 || Number(value.maxTotalMinutes) > 1440)) throw new ChefPlanError("Choose a verified time limit between 1 and 1440 minutes.");
  const servings = amount(value.servings, "servings"), batches = amount(value.batches, "batches");
  if (servings !== null && batches !== null) throw new ChefPlanError("Choose servings or recipe batches.");
  return { week, today, count: Number(value.count), ...(value.recipeQuery ? { recipeQuery: String(value.recipeQuery).trim() } : {}), dates: selected, servings, batches, excludedIngredients: stringList(value.excludedIngredients), diets: diets as Diet[], excludedEquipment: stringList(value.excludedEquipment), ...(value.maxTotalMinutes !== undefined ? { maxTotalMinutes: Number(value.maxTotalMinutes) } : {}), priority: value.priority as ChefPlanIntent["priority"], allowRepeats: value.allowRepeats, replaceDates, ...(value.authorizedReplacementDates !== undefined ? { authorizedReplacementDates } : {}), keepDates, perDate };
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function reviewHash(draft: ChefPlanDraft, catalog: ChefPlanCatalog): Promise<string> {
  const bytes = new TextEncoder().encode(stable({ version: draft.version, kitchenRevision: draft.kitchenRevision, intent: draft.intent, changes: draft.changes, shopping: draft.shopping, beforeShopping: draft.beforeShopping, unresolved: draft.unresolved, warnings: draft.warnings,
    metadata: draft.changes.map(change => ({ id: change.meal.recipeId, metadata: catalog.metadata[change.meal.recipeId] ?? null, contentHash: catalog.contentHashes[change.meal.recipeId] ?? null })) }));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
function weekMeals(kitchen: KitchenState, intent: ChefPlanIntent): PlannedMeal[] {
  return Object.values(kitchen.meals).filter(meal => meal.date >= intent.week && meal.date < addDateDays(intent.week, 7));
}
function planMeal(recipe: Recipe, day: string, input: ChefPlanInput): PlannedMeal | null {
  const { intent, catalog, kitchen } = input;
  const specific = intent.perDate[day];
  const batches = specific?.batches ?? (specific?.servings === undefined ? intent.batches : null);
  const servings = specific?.servings ?? (specific?.batches === undefined ? intent.servings : null);
  if (!recipe.servings && servings !== null && batches === null) return null;
  const meal = createPlannedMeal(day, recipe, true, { amounts: kitchen.personalRecipeAmounts?.[recipe.id], contentHash: catalog.contentHashes[recipe.id] });
  meal.id = `chef-plan:${input.revision}:${day}`;
  if (meal.baseServings) {
    const scaled = batches !== null ? meal.baseServings * batches : servings ?? meal.servings;
    if (batches !== null && (scaled === null || !Number.isInteger(scaled) || scaled < DINNER_AMOUNT_LIMITS.servings.min || scaled > DINNER_AMOUNT_LIMITS.servings.max)) return null;
    meal.servings = scaled;
  }
  else meal.batches = batches ?? 1;
  return meal;
}
function constraintsForDay(input: ChefPlanInput, day: string) {
  const profile = input.kitchen.cookingProfile ?? DEFAULT_COOKING_PROFILE;
  const base = normalizeConstraints(profile);
  return normalizeConstraints({ ...base, diets: [...base.diets, ...input.intent.diets, ...(input.intent.perDate[day]?.diet ? [input.intent.perDate[day].diet!] : [])], excludedIngredients: input.intent.excludedIngredients, excludedEquipment: input.intent.excludedEquipment, maxTotalMinutes: input.intent.maxTotalMinutes });
}
/** A planner may use leftover stock, but must not take an existing dinner's reservation. */
function preservesReservations(meals: PlannedMeal[], preserved: PlannedMeal[], input: ChefPlanInput): boolean {
  const baseline = allocateStockForMeals(preserved, input.kitchen.pantry, input.intent.today).allocations;
  const next = allocateStockForMeals(meals, input.kitchen.pantry, input.intent.today).allocations;
  return baseline.every(allocation => {
    const after = next.find(item => item.mealId === allocation.mealId);
    return after && [...allocation.coveredByGroup].every(([key, covered]) => (after.coveredByGroup.get(key) ?? 0) + 1e-8 >= covered);
  });
}
function matchingRecipeIds(catalog: ChefPlanCatalog, intent: ChefPlanIntent, constraints: ReturnType<typeof normalizeConstraints>): Set<string> | null {
  if (!intent.recipeQuery) return null;
  const query = intent.recipeQuery, terms = retrievalTerms(query);
  const documents = catalog.recipes.map(recipe => ({ id: recipe.id, title: recipe.title, ingredients: recipe.ingredients.map(row => row.name).join(" "), other: [recipe.cuisine, recipe.category, ...recipe.tags].join(" ") }));
  const scores = bm25Scores(documents, query);
  return new Set(documents.filter(document => {
    const recipe = catalog.recipes.find(row => row.id === document.id)!;
    const words = new Set(retrievalTerms([document.title, document.ingredients, document.other].join(" ")));
    return evaluateRecipeConstraints(recipe, catalog.metadata[recipe.id], constraints).eligible && (scores.get(document.id) ?? 0) > 0 && terms.every(term => words.has(term));
  }).map(document => document.id));
}
function reasons(readiness: ChefPlanChange["readiness"]): string {
  return `${readiness.useSoonCoverage > 0 ? "Uses measured stock before its entered use-by date. " : ""}Pantry fully covers ${readiness.coveredCount} ingredients; ${readiness.partialCount + readiness.missingCount} need shopping${readiness.reviewCount ? `; ${readiness.reviewCount} amounts need review` : ""}.`;
}
export async function buildChefPlanDraft(raw: ChefPlanInput): Promise<ChefPlanDraft> {
  const input = { ...raw, intent: validatePlanIntent(raw.intent) };
  const { kitchen, revision, catalog, intent, previousDraft } = input;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new ChefPlanError("Invalid kitchen revision.");
  if (previousDraft && (previousDraft.version !== 1 || previousDraft.kitchenRevision !== revision || previousDraft.intent.week !== intent.week)) changed("Your kitchen or selected week changed. Start a new plan.");
  const swappedDates = new Set(intent.replaceDates);
  // Keep freezes a reviewed recipe in the intent used by Apply. Releasing Keep
  // removes that generated pin so subsequent constraints can select a new dinner.
  for (const day of previousDraft?.intent.keepDates ?? []) {
    if (!intent.keepDates.includes(day) && intent.perDate[day]?.recipeId === previousDraft?.changes.find(change => change.date === day)?.meal.recipeId) delete intent.perDate[day].recipeId;
  }
  // Authorization for already reviewed saved replacements survives another turn;
  // only this turn's replacement dates choose a different recipe again.
  if (previousDraft && intent.authorizedReplacementDates === undefined) intent.authorizedReplacementDates = [...new Set([...(intent.authorizedReplacementDates ?? []), ...previousDraft.changes.filter(change => change.expectedMealId !== null).map(change => change.date)])].sort();
  const availableDates = Array.from({ length: 7 }, (_, index) => addDateDays(intent.week, index)).filter(day => day >= intent.today);
  const previous = new Map((previousDraft?.changes ?? []).map(change => [change.date, change]));
  const explicit = [...new Set([...intent.dates, ...intent.replaceDates, ...Object.keys(intent.perDate), ...intent.keepDates])].sort();
  const expanding = previousDraft && !intent.dates.length && intent.count > previousDraft.intent.dates.length;
  const retainedDates = expanding ? [...new Set([...previousDraft.intent.dates, ...explicit])].sort() : [];
  // Increasing the count clears dates in the interpreter, but keeps scoped
  // controls. Retain the prior targets before filling remaining empty dates.
  const dates = expanding ? [...retainedDates, ...availableDates.filter(day => !kitchen.meals[day] && !retainedDates.includes(day))].slice(0, Math.max(intent.count, retainedDates.length)).sort()
    : explicit.length ? explicit : [...new Set([...previous.keys(), ...availableDates.filter(day => !kitchen.meals[day])])].sort().slice(0, intent.count);
  intent.dates = [...dates]; // Expose the resolved dates in the editable interpretation.
  const unresolved: string[] = [];
  if (dates.length < intent.count) unresolved.push(`Only ${dates.length} requested or empty upcoming dates are available in this week.`);
  const replaceable = dates.filter(day => (intent.replaceDates.includes(day) || intent.authorizedReplacementDates?.includes(day)) && !kitchen.meals[day]?.locked && kitchen.meals[day]?.status !== "cooked");
  const meals: Record<string, PlannedMeal> = { ...kitchen.meals };
  const changes: ChefPlanChange[] = [];
  const warnings = new Set<string>();
  const used = new Set(weekMeals(kitchen, intent).map(meal => meal.recipeId));
  const preservedDraftIds = new Map([...previous].filter(([day]) => dates.includes(day) && !swappedDates.has(day) && !intent.perDate[day]?.recipeId).map(([day, change]) => [day, change.meal.recipeId]));
  const recipes = [...new Map(catalog.recipes.map(recipe => [recipe.id, recipe])).values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const day of dates) {
    const saved = kitchen.meals[day];
    if (saved && (saved.locked || saved.status === "cooked" || !replaceable.includes(day))) {
      unresolved.push(`${day}: the saved dinner is ${saved.locked || saved.status === "cooked" ? "protected" : "preserved; explicitly request replacement to change it"}.`); continue;
    }
    const prior = previous.get(day);
    if (saved && !Object.values(meals).some(meal => meal.date !== day && meal.recipeId === saved.recipeId)) used.delete(saved.recipeId);
    if (intent.keepDates.includes(day) && prior) {
      intent.perDate[day] = { ...intent.perDate[day], recipeId: prior.meal.recipeId, ...(prior.meal.baseServings ? { servings: prior.meal.servings!, batches: undefined } : { batches: prior.meal.batches, servings: undefined }) };
    }
    let selectedId = intent.perDate[day]?.recipeId ?? preservedDraftIds.get(day);
    const constraints = constraintsForDay(input, day);
    const matching = matchingRecipeIds(catalog, intent, constraints);
    if (selectedId && !intent.perDate[day]?.recipeId && !intent.keepDates.includes(day)) {
      const pinned = recipes.find(recipe => recipe.id === selectedId);
      if (pinned && (!evaluateRecipeConstraints(pinned, catalog.metadata[pinned.id], constraints).eligible || !planMeal(pinned, day, input) || matching && !matching.has(pinned.id))) {
        selectedId = undefined;
        preservedDraftIds.delete(day);
      }
    }
    const existingMeals = weekMeals({ ...kitchen, meals }, intent);
    const candidates = recipes.flatMap(recipe => {
      if (matching && !matching.has(recipe.id)) return [];
      if (selectedId && recipe.id !== selectedId || !intent.allowRepeats && (used.has(recipe.id) || [...preservedDraftIds].some(([otherDay, id]) => otherDay !== day && id === recipe.id))) return [];
      if (!selectedId && swappedDates.has(day) && recipe.id === (prior?.meal.recipeId ?? saved?.recipeId)) return [];
      const eligibility = evaluateRecipeConstraints(recipe, catalog.metadata[recipe.id], constraints);
      if (!eligibility.eligible) return [];
      const meal = planMeal(recipe, day, input);
      if (!meal) return [];
      const proposedMeals = [...existingMeals.filter(item => item.date !== day), meal];
      const reserved = weekMeals(kitchen, intent).filter(item => item.date !== day && !changes.some(change => change.date === item.date));
      if (!preservesReservations(proposedMeals, reserved, input)) return [];
      const earlier = proposedMeals.filter(item => item.date < day);
      const remaining = allocateStockForMeals(earlier, kitchen.pantry, intent.today).pantry;
      const readiness = mealReadiness(meal, remaining, intent.today);
      const shopping = shoppingForWeek({ ...kitchen, meals: { ...meals, [day]: meal } }, intent.week, intent.today);
      const role = catalog.metadata[recipe.id]?.dinnerRole;
      return [{ recipe, meal, readiness, eligibility, shoppingRows: shopping.length, reviewedMain: catalog.metadata[recipe.id]?.coreDinner || role === "main", nonDinner: Boolean(role && role !== "main" && role !== "unknown"), taste: (kitchen.tastePreferences ?? []).filter(item => item.recipeId === recipe.id).reduce((score, item) => score + (item.preference === "cook_again" ? 1 : -1), 0), favorite: kitchen.favoriteRecipeIds?.includes(recipe.id) ?? false }];
    });
    const dinnerPool = selectedId ? candidates : candidates.some(item => item.reviewedMain) ? candidates.filter(item => item.reviewedMain) : candidates.filter(item => !item.nonDinner);
    dinnerPool.sort((a, b) => {
      const waste = b.readiness.useSoonCoverage - a.readiness.useSoonCoverage;
      const shopping = a.shoppingRows - b.shoppingRows;
      const variety = Number(used.has(a.recipe.id)) - Number(used.has(b.recipe.id));
      const priority = intent.priority === "fewer_groceries" ? shopping || waste || variety : intent.priority === "variety" ? variety || waste || shopping : waste || shopping || variety;
      return priority || b.taste - a.taste || a.eligibility.dislikedIngredients.length - b.eligibility.dislikedIngredients.length || Number(b.favorite) - Number(a.favorite) || a.recipe.id.localeCompare(b.recipe.id);
    });
    const selected = dinnerPool[0];
    if (!selected) {
      const considered = recipes.filter(recipe => !selectedId || recipe.id === selectedId);
      const blockedReasons = [...(intent.recipeQuery ? [`Requested dish, cuisine or ingredient: ${intent.recipeQuery}.`] : []), ...new Set(considered.flatMap(recipe => evaluateRecipeConstraints(recipe, catalog.metadata[recipe.id], constraints).reasons))].sort().slice(0, 3);
      const needsYield = considered.some(recipe => !recipe.servings && !planMeal(recipe, day, input));
      unresolved.push(`${day}: no eligible ${selectedId ? "selected" : "different"} dinner fits the requirements and saved stock reservations.${needsYield ? " Recipes with unknown yield need an explicit batch amount." : ""}${blockedReasons.length ? ` Catalog checks: ${blockedReasons.join(" ")}` : ""}`);
      // A failed replacement never deletes its saved dinner.
      if (saved) { meals[day] = saved; used.add(saved.recipeId); }
      continue;
    }
    if (prior && selectedId === prior.meal.recipeId && prior.recipeHash !== await chefRecipeHash(selected.recipe)) changed("A recipe in this draft changed. Start a new plan from its current source.");
    if (selected.eligibility.dietUnknowns.length) warnings.add(`${selected.recipe.title}: ${selected.eligibility.dietUnknowns.join(", ").replaceAll("_", " ")} suitability is not verified.`);
    meals[day] = selected.meal; used.add(selected.recipe.id);
    changes.push({ date: day, expectedMealId: saved?.id ?? null, recipeHash: await chefRecipeHash(selected.recipe), meal: selected.meal, reason: reasons(selected.readiness), readiness: selected.readiness });
  }
  // Recompute each card with the same complete chronological allocation as shopping.
  let remaining = kitchen.pantry;
  for (const meal of weekMeals({ ...kitchen, meals }, intent).filter(item => item.status !== "cooked").sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    const change = changes.find(item => item.date === meal.date);
    if (change) { change.readiness = mealReadiness(meal, remaining, intent.today); change.reason = reasons(change.readiness); }
    remaining = allocateMealStock(meal, remaining, intent.today).pantry;
  }
  if (constraintsForDay(input, dates[0] ?? intent.week).allergies.length) warnings.add("Ingredient filtering cannot establish allergy safety or cross-contact conditions; check product labels.");
  const draft: ChefPlanDraft = { version: 1, kitchenRevision: revision, intent, changes, beforeShopping: shoppingForWeek(kitchen, intent.week, intent.today), shopping: shoppingForWeek({ ...kitchen, meals }, intent.week, intent.today), unresolved, warnings: [...warnings], reviewHash: "", interpretation: "rules" };
  draft.reviewHash = await reviewHash(draft, catalog);
  return draft;
}

/** Validate the exact reviewed dinners, then return a new state for a single revision-checked write. */
export async function applyChefPlanDraft({ kitchen, revision, catalog, draft }: { kitchen: KitchenState; revision: number; catalog: ChefPlanCatalog; draft: ChefPlanDraft }): Promise<KitchenState> {
  if (!record(draft) || draft.version !== 1 || draft.kitchenRevision !== revision) changed("Your kitchen changed. Review a fresh plan before applying.");
  const intent = validatePlanIntent(draft.intent);
  if (!Array.isArray(draft.changes) || !draft.changes.length || draft.changes.length > 7 || typeof draft.reviewHash !== "string" || !/^[a-f0-9]{64}$/.test(draft.reviewHash)) throw new ChefPlanError("Review at least one dinner before applying a plan.");
  if (!Array.isArray(draft.shopping) || !Array.isArray(draft.beforeShopping) || !Array.isArray(draft.unresolved) || !Array.isArray(draft.warnings)
    || [...draft.unresolved, ...draft.warnings].some(text => typeof text !== "string" || text.length > 2000)
    || draft.changes.some(change => !record(change) || !date(change.date) || !record(change.meal) || typeof change.meal.recipeId !== "string" || !record(change.readiness) || typeof change.recipeHash !== "string" || change.expectedMealId !== null && typeof change.expectedMealId !== "string")) throw new ChefPlanError("The plan preview is incomplete. Generate a new preview.");
  if (draft.reviewHash !== await reviewHash(draft, catalog)) changed();
  const next = structuredClone(kitchen), seen = new Set<string>();
  const preserved = weekMeals(kitchen, intent).filter(meal => !draft.changes.some(change => change.date === meal.date));
  const used = new Set(preserved.map(meal => meal.recipeId));
  for (const change of draft.changes) {
    if (!record(change) || !date(change.date) || !intent.dates.includes(change.date) || change.date < intent.week || change.date >= addDateDays(intent.week, 7) || change.date < intent.today || seen.has(change.date) || !record(change.meal)) changed();
    seen.add(change.date);
    const saved = kitchen.meals[change.date];
    if ((saved?.id ?? null) !== change.expectedMealId || saved && (saved.locked || saved.status === "cooked" || !intent.replaceDates.includes(change.date) && !intent.authorizedReplacementDates?.includes(change.date))) changed("A dinner in this plan is protected or changed. Review a fresh plan.");
    const recipe = catalog.recipes.find(item => item.id === change.meal.recipeId);
    if (!recipe || await chefRecipeHash(recipe) !== change.recipeHash || !evaluateRecipeConstraints(recipe, catalog.metadata[recipe.id], constraintsForDay({ kitchen, revision, catalog, intent }, change.date)).eligible) changed("A recipe or its requirements changed. Review a fresh plan.");
    if (intent.perDate[change.date]?.recipeId && intent.perDate[change.date].recipeId !== recipe.id) changed("A selected or kept dinner differs from the reviewed request. Review a fresh plan.");
    const matching = matchingRecipeIds(catalog, intent, constraintsForDay({ kitchen, revision, catalog, intent }, change.date));
    if (matching && !matching.has(recipe.id)) changed("The recipe no longer matches the requested dish, cuisine or ingredient.");
    if (!intent.allowRepeats && used.has(recipe.id)) changed("This plan repeats a recipe. Review its repeat preference.");
    const canonical = planMeal(recipe, change.date, { kitchen, revision, catalog, intent });
    if (!canonical || stable(canonical) !== stable(change.meal)) changed("Dinner quantities differ from the reviewed plan. Review a fresh preview.");
    next.meals[change.date] = canonical; used.add(recipe.id);
  }
  const meals = weekMeals(next, intent);
  if (!preservesReservations(meals, preserved, { kitchen, revision, catalog, intent })) changed("The draft would use stock reserved for saved dinners.");
  if (stable(shoppingForWeek(kitchen, intent.week, intent.today)) !== stable(draft.beforeShopping) || stable(shoppingForWeek(next, intent.week, intent.today)) !== stable(draft.shopping)) changed("Shopping needs changed. Review a fresh preview.");
  let remaining = kitchen.pantry;
  for (const meal of meals.filter(item => item.status !== "cooked").sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    const change = draft.changes.find(item => item.date === meal.date);
    if (change && stable(mealReadiness(meal, remaining, intent.today)) !== stable(change.readiness)) changed("Pantry coverage changed. Review a fresh preview.");
    remaining = allocateMealStock(meal, remaining, intent.today).pantry;
  }
  validateKitchenState(next);
  return next;
}
