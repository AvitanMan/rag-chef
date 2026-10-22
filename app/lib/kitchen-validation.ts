import type { KitchenState, PlannedMeal } from "./kitchen-types";
import type { Recipe } from "./recipe-types";

export const MAX_KITCHEN_BODY_BYTES = 2_000_000;
const MAX_MEALS = 2_000;
const MAX_PANTRY_ITEMS = 500;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

type RecordValue = Record<string, unknown>;
export class KitchenValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KitchenValidationError";
  }
}

function invalid(path: string, description: string): never {
  throw new KitchenValidationError(`${path} ${description}.`);
}

function record(value: unknown, path: string): RecordValue {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    invalid(path, "must be an object");
  }
  const result = value as RecordValue;
  for (const key of Object.keys(result)) {
    if (FORBIDDEN_KEYS.has(key)) invalid(path, "contains an unsafe field");
  }
  return result;
}

function fields(
  value: RecordValue,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    invalid(path, "contains an unknown field");
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    invalid(path, "is missing a required field");
  }
}

function string(
  value: unknown,
  path: string,
  maxLength: number,
  allowEmpty = false,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    (!allowEmpty && !value.trim()) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    invalid(path, `must be ${allowEmpty ? "a" : "a nonempty"} string of at most ${maxLength} characters`);
  }
}

function boolean(value: unknown, path: string): void {
  if (typeof value !== "boolean") invalid(path, "must be a boolean");
}

function positiveNumber(value: unknown, path: string, maximum: number): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > maximum
  ) {
    invalid(path, `must be a finite positive number no greater than ${maximum}`);
  }
}

function array(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    invalid(path, `must be an array of at most ${maximum} items`);
  }
  return value;
}

function date(value: unknown, path: string): asserts value is string {
  string(value, path, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    invalid(path, "must be a calendar date in YYYY-MM-DD format");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value ||
    Number(value.slice(0, 4)) < 1
  ) {
    invalid(path, "must be a valid calendar date");
  }
}

function timestamp(value: unknown, path: string): void {
  string(value, path, 24);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    invalid(path, "must be a UTC ISO timestamp");
  }
  date(value.slice(0, 10), path);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    invalid(path, "must be a valid UTC timestamp");
  }
}

function url(value: unknown, path: string): void {
  string(value, path, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalid(path, "must be an absolute HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    invalid(path, "must be an HTTP(S) URL without credentials");
  }
}

/** Preserve useful free text ("to taste") but reject unsafe numeric quantities. */
function measure(value: unknown, path: string): void {
  string(value, path, 160, true);
  const normalized = value.trim().replaceAll("−", "-");
  if (
    /\b(?:nan|infinity|infinite)\b/i.test(normalized) ||
    /^-\s*(?:\d|\.)/.test(normalized)
  ) {
    invalid(path, "contains an invalid quantity");
  }
  for (const fraction of normalized.matchAll(/\d+(?:\.\d+)?\s*\/\s*([+-]?\d+(?:\.\d+)?)/g)) {
    if (Number(fraction[1]) <= 0) invalid(path, "contains an invalid fraction denominator");
  }
  // Covers decimals, fractional numerators, ranges, and scientific notation.
  // A bounded numeric token is checked even if followed by a free-text unit.
  for (const token of normalized.match(/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? []) {
    const amount = Number(token);
    if (!Number.isFinite(amount) || amount > 1_000_000_000) {
      invalid(path, "contains an out-of-range quantity");
    }
  }
}

export function validateRecipeSnapshot(value: unknown, path = "recipe"): asserts value is Recipe {
  const item = record(value, path);
  fields(
    item,
    ["id", "title", "image", "category", "cuisine", "source", "sourceUrl", "ingredients", "instructions", "tags"],
    ["servings"],
    path,
  );
  string(item.id, `${path}.id`, 200);
  string(item.title, `${path}.title`, 300);
  if (item.image !== null && item.image !== "") url(item.image, `${path}.image`);
  string(item.category, `${path}.category`, 120, true);
  string(item.cuisine, `${path}.cuisine`, 120, true);
  const source = record(item.source, `${path}.source`);
  fields(source, ["name", "url"], ["licenseId", "licenseUrl", "attributionText"], `${path}.source`);
  string(source.name, `${path}.source.name`, 200);
  if (Object.hasOwn(source, "licenseId")) string(source.licenseId, `${path}.source.licenseId`, 120);
  if (Object.hasOwn(source, "licenseUrl")) url(source.licenseUrl, `${path}.source.licenseUrl`);
  if (Object.hasOwn(source, "attributionText")) string(source.attributionText, `${path}.source.attributionText`, 2_000);
  const localStarter = source.name === "Local starter" && source.url === "#source-note" && item.sourceUrl === "#source-note";
  if (!localStarter) {
    url(source.url, `${path}.source.url`);
    url(item.sourceUrl, `${path}.sourceUrl`);
  }
  array(item.ingredients, `${path}.ingredients`, 200).forEach((ingredient, index) => {
    const ingredientPath = `${path}.ingredients[${index}]`;
    const entry = record(ingredient, ingredientPath);
    fields(entry, ["name", "measure"], [], ingredientPath);
    string(entry.name, `${ingredientPath}.name`, 200);
    measure(entry.measure, `${ingredientPath}.measure`);
  });
  array(item.instructions, `${path}.instructions`, 300).forEach((step, index) => {
    string(step, `${path}.instructions[${index}]`, 4_000);
  });
  array(item.tags, `${path}.tags`, 40).forEach((tag, index) => {
    string(tag, `${path}.tags[${index}]`, 120);
  });
  if (Object.hasOwn(item, "servings")) {
    positiveNumber(item.servings, `${path}.servings`, 10_000);
  }
}

function meal(value: unknown, path: string, day: string): asserts value is PlannedMeal {
  const item = record(value, path);
  fields(
    item,
    ["id", "date", "recipeId", "recipe", "title", "baseServings", "servings", "batches", "locked", "status", "ingredientOverrides"],
    ["completion", "planningIngredients"],
    path,
  );
  string(item.id, `${path}.id`, 200);
  date(item.date, `${path}.date`);
  if (item.date !== day) invalid(path, "must match its calendar date key");
  string(item.recipeId, `${path}.recipeId`, 200);
  string(item.title, `${path}.title`, 300);
  if (item.recipe !== null) {
    validateRecipeSnapshot(item.recipe, `${path}.recipe`);
    if (item.recipe.id !== item.recipeId) {
      invalid(path, "has a recipe snapshot with a mismatched id");
    }
  }
  if (item.baseServings !== null) positiveNumber(item.baseServings, `${path}.baseServings`, 10_000);
  if (Object.hasOwn(item, "planningIngredients")) {
    const ingredients = array(item.planningIngredients, `${path}.planningIngredients`, 200);
    if (item.recipe === null || ingredients.length !== (item.recipe as Recipe).ingredients.length) invalid(path, "has mismatched planning ingredients");
    ingredients.forEach((value, index) => {
      const entry = record(value, `${path}.planningIngredients[${index}]`);
      fields(entry, ["name", "measure"], [], path);
      string(entry.name, `${path}.planningIngredients[${index}].name`, 200);
      measure(entry.measure, `${path}.planningIngredients[${index}].measure`);
    });
  }
  if (item.servings !== null) positiveNumber(item.servings, `${path}.servings`, 10_000);
  if ((item.baseServings === null) !== (item.servings === null)) {
    invalid(path, "must provide both baseServings and servings, or neither");
  }
  if (typeof item.baseServings === "number" && typeof item.servings === "number") {
    positiveNumber(item.servings / item.baseServings, `${path}.servingScale`, 1_000);
  }
  positiveNumber(item.batches, `${path}.batches`, 1_000);
  boolean(item.locked, `${path}.locked`);
  if (item.status !== "planned" && item.status !== "cooked") {
    invalid(`${path}.status`, "must be planned or cooked");
  }
  const overrides = record(item.ingredientOverrides, `${path}.ingredientOverrides`);
  if (Object.keys(overrides).length > 200) invalid(path, "has too many ingredient overrides");
  for (const [key, value] of Object.entries(overrides)) {
    string(key, `${path}.ingredientOverrides key`, 200);
    measure(value, `${path}.ingredientOverrides.${key}`);
  }
  if (item.status === "cooked") {
    const completion = record(item.completion, `${path}.completion`);
    fields(completion, ["id", "at", "deductions"], [], `${path}.completion`);
    string(completion.id, `${path}.completion.id`, 200);
    timestamp(completion.at, `${path}.completion.at`);
    const pantryIds = new Set<string>();
    array(completion.deductions, `${path}.completion.deductions`, MAX_PANTRY_ITEMS)
      .forEach((deduction, index) => {
        const deductionPath = `${path}.completion.deductions[${index}]`;
        const entry = record(deduction, deductionPath);
        fields(entry, ["pantryId", "before", "after"], ["name", "useBy"], deductionPath);
        string(entry.pantryId, `${deductionPath}.pantryId`, 200);
        if (Object.hasOwn(entry, "name")) string(entry.name, `${deductionPath}.name`, 200);
        if (Object.hasOwn(entry, "useBy")) date(entry.useBy, `${deductionPath}.useBy`);
        if (pantryIds.has(entry.pantryId)) invalid(deductionPath, "duplicates a pantry deduction");
        pantryIds.add(entry.pantryId);
        measure(entry.before, `${deductionPath}.before`);
        measure(entry.after, `${deductionPath}.after`);
      });
  } else if (Object.hasOwn(item, "completion")) {
    invalid(path, "cannot contain a completion before it is cooked");
  }
}

export function validateKitchenState(value: unknown): asserts value is KitchenState {
  const state = record(value, "state");
  fields(state, ["schemaVersion", "pantry", "meals", "shoppingChecked", "migratedLegacy"], [], "state");
  if (state.schemaVersion !== 2) invalid("state.schemaVersion", "must be 2");
  boolean(state.migratedLegacy, "state.migratedLegacy");
  const pantryIds = new Set<string>();
  array(state.pantry, "state.pantry", MAX_PANTRY_ITEMS).forEach((stock, index) => {
    const path = `state.pantry[${index}]`;
    const item = record(stock, path);
    fields(item, ["id", "name", "measure"], ["useBy"], path);
    string(item.id, `${path}.id`, 200);
    if (pantryIds.has(item.id)) invalid(path, "duplicates a pantry id");
    pantryIds.add(item.id);
    string(item.name, `${path}.name`, 200);
    measure(item.measure, `${path}.measure`);
    if (Object.hasOwn(item, "useBy")) date(item.useBy, `${path}.useBy`);
  });
  const meals = record(state.meals, "state.meals");
  if (Object.keys(meals).length > MAX_MEALS) invalid("state.meals", `accepts at most ${MAX_MEALS} meals`);
  const mealIds = new Set<string>();
  const completionIds = new Set<string>();
  for (const [day, value] of Object.entries(meals)) {
    date(day, "state.meals key");
    meal(value, `state.meals.${day}`, day);
    if (mealIds.has(value.id)) invalid("state.meals", "contains duplicate meal ids");
    mealIds.add(value.id);
    if (value.completion) {
      if (completionIds.has(value.completion.id)) invalid("state.meals", "contains duplicate completion ids");
      completionIds.add(value.completion.id);
    }
  }
  const checked = record(state.shoppingChecked, "state.shoppingChecked");
  if (Object.keys(checked).length > 3_000) invalid("state.shoppingChecked", "has too many checked items");
  for (const [key, value] of Object.entries(checked)) {
    string(key, "state.shoppingChecked key", 500);
    boolean(value, `state.shoppingChecked.${key}`);
  }
}

export function validateKitchenWrite(value: unknown): {
  revision: number;
  state: KitchenState;
} {
  const input = record(value, "body");
  fields(input, ["revision", "state"], [], "body");
  if (
    typeof input.revision !== "number" ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    input.revision >= Number.MAX_SAFE_INTEGER
  ) {
    invalid("revision", "must be a nonnegative safe integer");
  }
  validateKitchenState(input.state);
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > MAX_KITCHEN_BODY_BYTES) {
    invalid("body", "exceeds the kitchen storage limit");
  }
  return { revision: input.revision, state: input.state };
}
