import type { ChefPlanDraft, ChefPlanIntent } from "./chef-plan-types";
import type { PantryStock, RecipeTastePreference, PlannedMeal, KitchenDocument } from "./kitchen-types";
import type { ShoppingItem } from "./quantities";

export interface PantryAction {
  kind: "add" | "set" | "subtract" | "set_use_by" | "remove";
  name: string;
  stockId?: string;
  measure?: string;
  /** Explicit user date; null removes the date. Never inferred from food type. */
  useBy?: string | null;
}
export interface TasteAction { recipeId: string; preference: "cook_again" | "less_often" | "clear" }
export interface AssistantIntent {
  pantry: PantryAction[];
  planning?: ChefPlanIntent;
  tastes: TasteAction[];
  completion?: { date: string; deductStock: boolean };
}
export interface AssistantIssue {
  id: string;
  message: string;
  blocking: boolean;
  actionIndex?: number;
  choices?: Array<{ label: string; stockId?: string; value?: string }>;
}
export interface KitchenActionDraft {
  version: 1;
  id: string;
  householdId: string;
  memberId: string;
  kitchenRevision: number;
  week: string;
  today: string;
  createdAt: string;
  intent: AssistantIntent;
  pantryChanges: Array<{ actionIndex: number; before: PantryStock | null; after: PantryStock | null }>;
  tasteChanges: Array<{ before: RecipeTastePreference | null; after: RecipeTastePreference | null }>;
  completionChange?: { before: PlannedMeal; after: PlannedMeal };
  planDraft?: ChefPlanDraft;
  beforeShopping: ShoppingItem[];
  shopping: ShoppingItem[];
  unresolved: AssistantIssue[];
  summary: string[];
  reviewHash: string;
}
export interface AssistantResponse {
  draft?: KitchenActionDraft;
  clarification?: string;
  issues?: AssistantIssue[];
  document?: KitchenDocument;
  alreadyApplied?: boolean;
  error?: { code: string; message: string };
}
