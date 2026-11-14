import type { KitchenCommand } from "./kitchen-commands";
import { EMPTY_KITCHEN } from "./kitchen-types";
import { KitchenValidationError, MAX_KITCHEN_BODY_BYTES, measureInputProblem, validateCookingProfile, validateKitchenState } from "./kitchen-validation";

export const MAX_KITCHEN_COMMAND_BYTES = MAX_KITCHEN_BODY_BYTES;
type Entry = Record<string, unknown>;
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);

export class KitchenCommandValidationError extends Error {
  constructor(message: string) { super(message); this.name = "KitchenCommandValidationError"; }
}
function invalid(message: string): never { throw new KitchenCommandValidationError(message); }
function object(value: unknown): Entry {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid("Expected an object.");
  const entry = value as Entry;
  if (Object.keys(entry).some(key => unsafeKeys.has(key))) invalid("Unsafe field name.");
  return entry;
}
function fields(value: Entry, required: string[], optional: string[] = []) {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) invalid("Missing or unknown command field.");
}
function text(value: unknown, maximum = 200, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid("Invalid command text.");
}
function id(value: unknown) { text(value); if (unsafeKeys.has(value)) invalid("Unsafe identifier."); }
function nullableId(value: unknown) { if (value !== null) id(value); }
function bool(value: unknown) { if (typeof value !== "boolean") invalid("Expected a boolean."); }
function positive(value: unknown, maximum: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) invalid("Command amount is outside its allowed range.");
}
function date(value: unknown): asserts value is string {
  text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) invalid("Expected a calendar date.");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid("Invalid calendar date.");
}
function timestamp(value: unknown) {
  text(value, 24);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) invalid("Expected a UTC ISO timestamp.");
  date(value.slice(0, 10));
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid("Invalid timestamp.");
}
function list(value: unknown, maximum: number, nonempty = true): unknown[] {
  if (!Array.isArray(value) || value.length > maximum || nonempty && !value.length) invalid("Invalid command list size.");
  return value;
}
function amount(value: unknown) {
  text(value, 160, true);
  const problem = measureInputProblem(value); if (problem) invalid(problem);
}
function pantry(value: unknown) { validateKitchenState({ ...EMPTY_KITCHEN, pantry: [value] }); }
function meals(value: unknown[]) {
  const entries = value.map(value => { const entry = object(value); date(entry.date); return [entry.date, entry] as const; });
  if (new Set(entries.map(([day]) => day)).size !== entries.length) invalid("Duplicate dinner date.");
  validateKitchenState({ ...EMPTY_KITCHEN, meals: Object.fromEntries(entries) });
}

/** Validate the public intent before consulting state or the durable retry ledger. */
export function parseKitchenCommand(value: unknown): KitchenCommand {
  try {
    const command = object(value);
    id(command.commandId);
    if (typeof command.expectedRevision !== "number" || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 || command.expectedRevision >= Number.MAX_SAFE_INTEGER) invalid("expectedRevision must be a nonnegative safe integer.");
    const shape = (required: string[], optional: string[] = []) => fields(command, ["commandId", "expectedRevision", "type", ...required], optional);
    switch (command.type) {
      case "ChangeDinnerAmounts": {
        shape(["date", "expectedMealId", "patch"]); date(command.date); id(command.expectedMealId);
        const patch = object(command.patch);
        fields(patch, [], ["baseServings", "servings", "batches", "ingredientOverrides"]);
        if (!Object.keys(patch).length) invalid("An amount change is required.");
        for (const key of ["baseServings", "servings"] as const) if (Object.hasOwn(patch, key) && patch[key] !== null) positive(patch[key], 10_000);
        if (Object.hasOwn(patch, "batches")) positive(patch.batches, 1_000);
        if (Object.hasOwn(patch, "ingredientOverrides")) {
          const overrides = object(patch.ingredientOverrides);
          if (Object.keys(overrides).length > 200) invalid("Too many ingredient overrides.");
          for (const [key, value] of Object.entries(overrides)) { text(key); amount(value); }
        }
        break;
      }
      case "SetDinnerLocked": shape(["date", "expectedMealId", "locked"]); date(command.date); id(command.expectedMealId); bool(command.locked); break;
      case "PlaceDinner": shape(["meal", "expectedMealId"]); nullableId(command.expectedMealId); meals([command.meal]); break;
      case "CompleteDinner":
        shape(["date", "expectedMealId", "expectedFingerprint", "deductStock", "occurredAt", "today"]);
        date(command.date); id(command.expectedMealId); text(command.expectedFingerprint, MAX_KITCHEN_COMMAND_BYTES); bool(command.deductStock); timestamp(command.occurredAt); date(command.today); break;
      case "UndoDinner": shape(["date", "expectedMealId", "expectedCompletionId"]); date(command.date); id(command.expectedMealId); nullableId(command.expectedCompletionId); break;
      case "RecordPurchase": {
        shape(["week", "today", "drafts", "occurredAt"]); date(command.week); date(command.today); timestamp(command.occurredAt);
        const drafts = list(command.drafts, 500); const ids = new Set(), keys = new Set();
        for (const value of drafts) {
          const draft = object(value); fields(draft, ["key", "name", "measure", "pantryId"], ["useBy", "cycleId"]);
          text(draft.key, 500); text(draft.name); amount(draft.measure); id(draft.pantryId);
          if (!draft.key.startsWith(`${command.week}:`) || ids.has(draft.pantryId) || keys.has(draft.key)) invalid("Invalid or duplicate purchase item.");
          ids.add(draft.pantryId); keys.add(draft.key);
          if (Object.hasOwn(draft, "useBy") && draft.useBy !== "") date(draft.useBy);
          if (Object.hasOwn(draft, "cycleId")) id(draft.cycleId);
        }
        break;
      }
      case "UndoPurchase": shape(["purchaseId"]); id(command.purchaseId); break;
      case "ReplacePantryBatch": shape(["snapshot", "replacement"]); pantry(command.snapshot); pantry(command.replacement); if (object(command.snapshot).id !== object(command.replacement).id) invalid("A correction must retain the batch ID."); break;
      case "UndoPantryBatch": {
        shape(["change"]); const change = object(command.change); fields(change, ["before", "after"]); pantry(change.before); pantry(change.after);
        if (object(change.before).id !== object(change.after).id) invalid("An undo must retain the batch ID."); break;
      }
      case "AddPantryBatches": shape(["batches"]); list(command.batches, 500); validateKitchenState({ ...EMPTY_KITCHEN, pantry: command.batches }); break;
      case "RemovePantryBatch": shape(["snapshot"]); pantry(command.snapshot); break;
      case "RemoveDinners": {
        shape(["dinners"]); const days = new Set();
        for (const value of list(command.dinners, 2_000)) {
          const dinner = object(value); fields(dinner, ["date", "expectedMealId"]); date(dinner.date); id(dinner.expectedMealId);
          if (days.has(dinner.date)) invalid("Duplicate dinner date."); days.add(dinner.date);
        }
        break;
      }
      case "RestoreRemoved": shape(["pantry", "meals"]); list(command.pantry, 500, false); validateKitchenState({ ...EMPTY_KITCHEN, pantry: command.pantry }); meals(list(command.meals, 2_000, false)); break;
      case "SetFavorite": shape(["recipeId", "favorite"]); id(command.recipeId); bool(command.favorite); break;
      case "SetCookingProfile": shape(["profile"]); validateCookingProfile(command.profile); break;
      case "SetPersonalRecipeAmounts":
        shape(["recipeId"], ["amounts"]); id(command.recipeId);
        if (Object.hasOwn(command, "amounts")) validateKitchenState({ ...EMPTY_KITCHEN, personalRecipeAmounts: { [command.recipeId as string]: command.amounts } }); break;
      case "SetShoppingBought": shape(["key", "bought"]); text(command.key, 500); bool(command.bought); break;
      case "BeginPurchaseCycle": {
        shape(["previous", "bought"]); bool(command.bought);
        const previous = object(command.previous); fields(previous, ["purchaseId", "key", "pantryId"], ["cycleId"]);
        id(previous.purchaseId); text(previous.key, 500); id(previous.pantryId); if (Object.hasOwn(previous, "cycleId")) id(previous.cycleId); break;
      }
      case "UncheckShoppingWeek": shape(["week"]); date(command.week); break;
      default: invalid("Unknown kitchen command type.");
    }
    if (new TextEncoder().encode(JSON.stringify(command)).byteLength > MAX_KITCHEN_COMMAND_BYTES) invalid("The command exceeds the storage limit.");
    return structuredClone(command) as KitchenCommand;
  } catch (error) {
    if (error instanceof KitchenValidationError) throw new KitchenCommandValidationError(error.message);
    throw error;
  }
}

/** Stable across JSON object-key order; arrays and every precondition retain identity. */
export async function kitchenCommandHash(command: KitchenCommand): Promise<string> {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, canonical(value)]));
    return value;
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(command))));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
