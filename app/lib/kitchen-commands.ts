import type { CookingProfile, KitchenState, PantryStock, PersonalRecipeAmounts, PlannedMeal } from "./kitchen-types";
import { dinnerSelectionStatus } from "./kitchen-state";
import { plannedDinnerFingerprint } from "./cooking-session";
import { completeMeal, undoMeal } from "./quantities";
import { applyBoughtItems, beginShoppingPurchaseCycle, setShoppingItemBought, undoPurchase, type PurchaseDraft, type ShoppingPurchaseSelection } from "./shopping-purchases";
import { replacePantryBatch, samePantryBatch, undoPantryBatch, type PantryBatchChange } from "./pantry-browser";
import { pantryInputProblem } from "./pantry-input";
import { validateKitchenState } from "./kitchen-validation";

export type DinnerAmountsPatch = Partial<Pick<PlannedMeal, "baseServings" | "servings" | "batches" | "ingredientOverrides">>;
export type KitchenCommandInput =
  | { type: "ChangeDinnerAmounts"; date: string; expectedMealId: string; patch: DinnerAmountsPatch }
  | { type: "SetDinnerLocked"; date: string; expectedMealId: string; locked: boolean }
  | { type: "PlaceDinner"; meal: PlannedMeal; expectedMealId: string | null }
  | { type: "CompleteDinner"; date: string; expectedMealId: string; expectedFingerprint: string; deductStock: boolean; occurredAt: string; today: string }
  | { type: "UndoDinner"; date: string; expectedMealId: string; expectedCompletionId: string | null }
  | { type: "RecordPurchase"; week: string; today: string; drafts: PurchaseDraft[]; occurredAt: string }
  | { type: "UndoPurchase"; purchaseId: string }
  | { type: "ReplacePantryBatch"; snapshot: PantryStock; replacement: PantryStock }
  | { type: "UndoPantryBatch"; change: PantryBatchChange }
  | { type: "AddPantryBatches"; batches: PantryStock[] }
  | { type: "RemovePantryBatch"; snapshot: PantryStock }
  | { type: "RemoveDinners"; dinners: Array<{ date: string; expectedMealId: string }> }
  | { type: "RestoreRemoved"; pantry: PantryStock[]; meals: PlannedMeal[] }
  | { type: "SetFavorite"; recipeId: string; favorite: boolean }
  | { type: "SetCookingProfile"; profile: CookingProfile }
  | { type: "SetPersonalRecipeAmounts"; recipeId: string; amounts?: PersonalRecipeAmounts }
  | { type: "SetShoppingBought"; key: string; bought: boolean }
  | { type: "BeginPurchaseCycle"; previous: ShoppingPurchaseSelection; bought: boolean }
  | { type: "UncheckShoppingWeek"; week: string };

export type KitchenCommand = KitchenCommandInput & { commandId: string; expectedRevision: number };
export type KitchenCommandSender = (command: KitchenCommandInput) => void;

const amountKeys = new Set(["baseServings", "servings", "batches", "ingredientOverrides"]);
const validId = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= 200;
function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Apply one domain intent to an immutable snapshot. IDs, dates and timestamps
 * come from the caller; this reducer reads no clock, storage, network or random
 * source. A stale/invalid/protected command returns the original object.
 *
 * expectedRevision is a snapshot precondition, not a durable replay ledger.
 * The server must still compare-and-swap its write after reducing the command.
 */
export function applyKitchenCommand(state: KitchenState, command: KitchenCommand, context: { revision: number; canEditProfile?: boolean }): KitchenState {
  try {
    if (!command || !validId(command.commandId) || !Number.isSafeInteger(command.expectedRevision)
      || command.expectedRevision < 0 || command.expectedRevision >= Number.MAX_SAFE_INTEGER || command.expectedRevision !== context.revision) return state;
    const next = reduceKitchenCommand(state, command, context);
    if (next === state) return state;
    validateKitchenState(next);
    return JSON.stringify(next) === JSON.stringify(state) ? state : next;
  } catch {
    // Validation and malformed payloads cannot partially apply an operation.
    return state;
  }
}

function reduceKitchenCommand(state: KitchenState, command: KitchenCommand, context: { canEditProfile?: boolean }): KitchenState {
  switch (command.type) {
    case "ChangeDinnerAmounts": {
      const meal = state.meals[command.date];
      if (!meal || meal.id !== command.expectedMealId || meal.locked || meal.status === "cooked"
        || !command.patch || Array.isArray(command.patch) || Object.keys(command.patch).some(key => !amountKeys.has(key))) return state;
      return { ...state, meals: { ...state.meals, [command.date]: { ...meal, ...structuredClone(command.patch) } } };
    }
    case "SetDinnerLocked": {
      const meal = state.meals[command.date];
      if (!meal || meal.id !== command.expectedMealId || meal.status === "cooked" || typeof command.locked !== "boolean" || meal.locked === command.locked) return state;
      return { ...state, meals: { ...state.meals, [command.date]: { ...meal, locked: command.locked } } };
    }
    case "PlaceDinner": {
      const meal = structuredClone(command.meal);
      if (!validId(meal.id) || !validDate(meal.date) || meal.id === command.expectedMealId
        || dinnerSelectionStatus(state.meals, meal.date, command.expectedMealId) !== "available") return state;
      meal.status = "planned"; meal.locked = false; delete meal.completion;
      return { ...state, meals: { ...state.meals, [meal.date]: meal } };
    }
    case "CompleteDinner": {
      const meal = state.meals[command.date];
      if (!meal || meal.id !== command.expectedMealId || meal.status === "cooked" || typeof command.deductStock !== "boolean"
        || !validDate(command.today) || !validTimestamp(command.occurredAt) || plannedDinnerFingerprint(meal) !== command.expectedFingerprint) return state;
      const next = completeMeal(state, command.date, command.deductStock, command.occurredAt, command.today);
      const completed = next.meals[command.date];
      // A second cooking after Undo is a distinct completion. Keep imported
      // retained receipts intact, but give each new command its own identity.
      if (next === state || meal.completion || !completed.completion) return next;
      return { ...next, meals: { ...next.meals, [command.date]: { ...completed, completion: { ...completed.completion, id: command.commandId } } } };
    }
    case "UndoDinner": {
      const meal = state.meals[command.date];
      if (!meal || meal.id !== command.expectedMealId || (meal.completion?.id ?? null) !== command.expectedCompletionId) return state;
      return undoMeal(state, command.date);
    }
    case "RecordPurchase":
      if (!validDate(command.week) || !validDate(command.today) || !validTimestamp(command.occurredAt)) return state;
      return applyBoughtItems(state, command.week, command.today, command.drafts, command.commandId, command.occurredAt);
    case "UndoPurchase": return undoPurchase(state, command.purchaseId);
    case "ReplacePantryBatch": return replacePantryBatch(state, command.snapshot, command.replacement);
    case "UndoPantryBatch": return undoPantryBatch(state, command.change);
    case "AddPantryBatches":
      if (!Array.isArray(command.batches) || !command.batches.length || pantryInputProblem(command.batches, state.pantry)) return state;
      return { ...state, pantry: [...state.pantry, ...structuredClone(command.batches)] };
    case "RemovePantryBatch":
      if (!samePantryBatch(state.pantry.find(stock => stock.id === command.snapshot.id), command.snapshot)) return state;
      return { ...state, pantry: state.pantry.filter(stock => stock.id !== command.snapshot.id) };
    case "RemoveDinners": {
      const eligible = new Map(command.dinners.map(dinner => [dinner.date, dinner.expectedMealId]));
      return { ...state, meals: Object.fromEntries(Object.entries(state.meals).filter(([date, meal]) => eligible.get(date) !== meal.id || meal.locked || meal.status === "cooked")) };
    }
    case "RestoreRemoved": {
      const pantry = command.pantry.filter(stock => !state.pantry.some(current => current.id === stock.id));
      const meals = command.meals.filter(meal => !state.meals[meal.date]);
      return { ...state, pantry: [...state.pantry, ...structuredClone(pantry)], meals: { ...state.meals, ...Object.fromEntries(structuredClone(meals).map(meal => [meal.date, meal])) } };
    }
    case "SetFavorite": {
      if (!validId(command.recipeId) || typeof command.favorite !== "boolean") return state;
      const favorites = state.favoriteRecipeIds ?? [];
      return { ...state, favoriteRecipeIds: command.favorite ? [...new Set([...favorites, command.recipeId])] : favorites.filter(id => id !== command.recipeId) };
    }
    case "SetCookingProfile":
      if (context.canEditProfile === false) return state;
      return { ...state, cookingProfile: structuredClone(command.profile) };
    case "SetPersonalRecipeAmounts": {
      if (!validId(command.recipeId)) return state;
      const personalRecipeAmounts = { ...state.personalRecipeAmounts };
      if (command.amounts) personalRecipeAmounts[command.recipeId] = structuredClone(command.amounts);
      else delete personalRecipeAmounts[command.recipeId];
      return { ...state, personalRecipeAmounts };
    }
    case "SetShoppingBought":
      if (typeof command.key !== "string" || !command.key.trim() || command.key.length > 500 || typeof command.bought !== "boolean") return state;
      return setShoppingItemBought(state, command.key, command.bought, command.commandId);
    case "BeginPurchaseCycle":
      if (typeof command.bought !== "boolean") return state;
      return beginShoppingPurchaseCycle(state, command.previous, command.commandId, command.bought);
    case "UncheckShoppingWeek":
      if (!validDate(command.week)) return state;
      return { ...state, shoppingChecked: Object.fromEntries(Object.entries(state.shoppingChecked).filter(([key]) => !key.startsWith(`${command.week}:`))) };
    default: return state;
  }
}
