import { mealScale } from "./kitchen-types";
import type { Recipe, RecipeIngredient } from "./recipe-types";
import type {
  KitchenState,
  PantryDeduction,
  PantryStock,
  PlannedMeal,
  PersonalRecipeAmounts,
} from "./kitchen-types";

export interface ParsedMeasure {
  quantity: number;
  unit: string;
  dimension: string;
}

export interface ShoppingItem {
  key: string;
  name: string;
  measure: string;
  requiredMeasure: string;
  pantryMeasure: string;
  needsReview: boolean;
  preparationNote?: string;
  notes: string[];
  recipeTitles: string[];
  mealDates: string[];
}

// Deliberately exact: related ingredients (for example rice and rice vinegar)
// are not interchangeable, and plural stemming would create false matches.
const INGREDIENT_ALIASES: Record<string, string> = {
  tomatoes: "tomato",
  onions: "onion",
  "red onions": "red onion",
  "white onions": "white onion",
  "yellow onions": "yellow onion",
  "spring onions": "spring onion",
  scallion: "spring onion",
  scallions: "spring onion",
  "green onion": "spring onion",
  "green onions": "spring onion",
  potatoes: "potato",
  carrots: "carrot",
  eggs: "egg",
  lemons: "lemon",
  limes: "lime",
  cucumbers: "cucumber",
  mushrooms: "mushroom",
  "bell peppers": "bell pepper",
  "chicken breasts": "chicken breast",
  chickpeas: "chickpea",
  courgette: "zucchini",
  courgettes: "zucchini",
  zucchinis: "zucchini",
  "any small pasta": "pasta",
};

// Only reviewed, non-transforming descriptions of these foods are equivalent.
// Keep heat treatment, preservation, alternatives and different products intact.
const PREPARABLE_FOODS = new Set(["onion", "red onion", "white onion", "yellow onion", "spring onion", "carrot", "potato", "zucchini", "tomato", "cucumber", "mushroom", "bell pepper", "garlic", "cheese"]);
const SIZED_PRODUCE = new Set(["onion", "red onion", "white onion", "yellow onion", "carrot", "potato", "zucchini", "tomato", "cucumber", "bell pepper", "lemon", "lime"]);

function ingredientLabel(name: string): string {
  const normalized = name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ");
  const alias = (value: string) => INGREDIENT_ALIASES[value] ?? value;
  const sized = (value: string) => {
    const match = value.match(/^(?:small|medium|large) (.+)$/);
    const food = alias(match?.[1] ?? value);
    return match && SIZED_PRODUCE.has(food) ? food : alias(value);
  };
  const preparation = normalized.match(/^(.+?), (?:(?:finely|coarsely|roughly|thinly|freshly) )?(?:chopped|diced|minced|sliced|grated|shredded)$/);
  if (preparation) {
    const food = sized(preparation[1]);
    if (PREPARABLE_FOODS.has(food)) return food;
  }
  return sized(normalized);
}

// These pantry staples conventionally mean the uncooked form. Keep this list
// explicit: dried fruit, herbs, mushrooms, canned beans, etc. are different foods.
const UNCOOKED_STAPLES = /^(?:(?:(?:white|brown|basmati|jasmine|arborio|long[- ]grain|short[- ]grain) )?rice|(?:whole wheat |penne |fusilli |rigatoni |farfalle |macaroni |tagliatelle |fettuccine |linguine )?pasta|spaghetti|penne|fusilli|rigatoni|macaroni|couscous|quinoa|bulgur|barley|lentils?|(?:red |green |brown )lentils?|chickpea|(?:black |white |kidney |pinto |navy |cannellini )?beans?)$/;

function ingredientIdentity(name: string) {
  const normalized = ingredientLabel(name);
  // Accept only a standalone prefix/suffix; alternatives and preparation prose
  // remain exact names, so "cooked or raw rice" cannot silently lose its choice.
  const prefix = normalized.match(/^(cooked|uncooked|raw|dry|dried)\s+(.+)$/);
  const suffix = normalized.match(/^(.+?)(?:\s*,\s*|\s+)(cooked|uncooked|raw|dry|dried)$/)
    ?? normalized.match(/^(.+?)\s*\((cooked|uncooked|raw|dry|dried)\)$/);
  const state = prefix?.[1] ?? suffix?.[2];
  const base = ingredientLabel(prefix?.[2] ?? suffix?.[1] ?? normalized);
  if (/\b(?:cooked|uncooked|raw|dry|dried|or|and)\b/.test(base)) return { base: normalized, preparation: "unspecified", key: normalized };
  const staple = UNCOOKED_STAPLES.test(base);
  if ((state === "dry" || state === "dried") && !staple) return { base: normalized, preparation: "unspecified", key: normalized };
  const preparation = state === "cooked" ? "cooked" : state !== undefined || staple ? "uncooked" : "unspecified";
  const key = preparation === "cooked" ? `cooked ${base}` : preparation === "uncooked" && !staple ? `uncooked ${base}` : base;
  return { base, preparation, key };
}

export function canonicalIngredient(name: string): string {
  return ingredientIdentity(name).key;
}

function preparationNotes(name: string, pantry: PantryStock[], date: string): string[] {
  const required = ingredientIdentity(name);
  const different = pantry.filter((stock) => {
    const available = ingredientIdentity(stock.name);
    return available.base === required.base && available.preparation !== required.preparation
      && pantryStockEligibility(stock, date).eligible;
  });
  return different.length ? [`Pantry has ${[...new Set(different.map((stock) => stock.name))].join(", ")}; dinner needs ${name}. Cooked and uncooked amounts are kept separate. Review preparation; no automatic conversion is applied.`] : [];
}

type UnitDefinition = { unit: string; dimension: string; factor: number };
const UNITS: Record<string, UnitDefinition> = {};

function addUnits(names: string[], unit: string, dimension: string, factor = 1) {
  for (const name of names) UNITS[name] = { unit, dimension, factor };
}

addUnits(["g", "gr", "gram", "grams", "gramme", "grammes"], "g", "mass");
addUnits(["kg", "kilogram", "kilograms", "kilogramme", "kilogrammes"], "g", "mass", 1000);
addUnits(["mg", "milligram", "milligrams"], "g", "mass", 0.001);
addUnits(["oz", "ounce", "ounces"], "g", "mass", 28.349523125);
addUnits(["lb", "lbs", "pound", "pounds"], "g", "mass", 453.59237);
addUnits(["ml", "milliliter", "milliliters", "millilitre", "millilitres"], "ml", "volume");
addUnits(["l", "liter", "liters", "litre", "litres"], "ml", "volume", 1000);
// Explicit culinary volume conventions; no density-based volume/mass conversion.
addUnits(["tsp", "teaspoon", "teaspoons"], "ml", "volume", 5);
addUnits(["tbsp", "tbs", "tablespoon", "tablespoons"], "ml", "volume", 15);
addUnits(["cup", "cups"], "ml", "volume", 240);
addUnits(["fl oz", "fluid ounce", "fluid ounces"], "ml", "volume", 29.5735295625);
addUnits(["", "count", "unit", "units", "piece", "pieces", "item", "items", "whole"], "count", "count");

const COUNT_UNITS = ["can", "clove", "slice", "bunch", "packet", "jar", "bottle", "stalk", "sprig", "head", "pinch", "egg"];
for (const unit of COUNT_UNITS) {
  const plural = unit === "bunch" ? "bunches" : unit === "pinch" ? "pinches" : `${unit}s`;
  addUnits([unit, plural], unit, `count:${unit}`);
}

const FRACTIONS: Record<string, string> = {
  "¼": "1/4", "½": "1/2", "¾": "3/4", "⅐": "1/7", "⅑": "1/9", "⅒": "1/10",
  "⅓": "1/3", "⅔": "2/3", "⅕": "1/5", "⅖": "2/5", "⅗": "3/5", "⅘": "4/5",
  "⅙": "1/6", "⅚": "5/6", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8",
};

function cleanNumber(value: number): number {
  return Math.abs(value) < 1e12 ? Math.round(value * 1e9) / 1e9 : value;
}

function fraction(text: string): number {
  const [numerator, denominator] = text.split("/").map(Number);
  return denominator > 0 ? numerator / denominator : NaN;
}

export function parseMeasure(text: string): ParsedMeasure | null {
  const normalized = text
    .replace(/[¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, (part) => ` ${FRACTIONS[part]}`)
    .normalize("NFKC")
    .replace(/⁄/g, "/")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  const match = normalized.match(/^(?:(\d+)\s+(\d+\s*\/\s*\d+)|(\d+\s*\/\s*\d+)|(\d+(?:\.\d+)?|\.\d+))\s*([a-z ]*\.?)$/);
  if (!match) return null;
  const quantity = match[1] !== undefined
    ? Number(match[1]) + fraction(match[2])
    : match[3] !== undefined ? fraction(match[3]) : Number(match[4]);
  const definition = UNITS[match[5].replace(/\.$/, "").trim()];
  if (!definition || !Number.isFinite(quantity) || quantity < 0) return null;
  const normalizedQuantity = quantity * definition.factor;
  if (!Number.isFinite(normalizedQuantity)) return null;
  return { quantity: cleanNumber(normalizedQuantity), unit: definition.unit, dimension: definition.dimension };
}

/** Derived only: package counts stay separate, and notes are never guessed quantities. */
export function pantryAmountDetails(measure: string): { kind: "known" | "unknown" | "empty"; parsed: ParsedMeasure | null; explanation: string } {
  const parsed = parseMeasure(measure);
  if (!parsed) return { kind: "unknown", parsed: null,
    explanation: `${measure.trim() ? `Pantry amount “${measure.trim()}” is unknown` : "Pantry amount is missing"}; enter a measured amount, such as 200 g or 2 cans, before any quantity can be deducted.` };
  if (parsed.quantity === 0) return { kind: "empty", parsed,
    explanation: "Pantry amount is zero; empty stock is excluded. Update the amount if stock has been replenished." };
  const packageCount = ["can", "packet", "jar", "bottle"].includes(parsed.unit);
  return { kind: "known", parsed, explanation: packageCount
    ? `Known package count (${formatMeasure(parsed.quantity, parsed.unit)}); only matching ${parsed.unit} counts can be compared. Package contents are not converted to weight, volume or other counts.`
    : `Known amount (${formatMeasure(parsed.quantity, parsed.unit)}); only compatible ${parsed.dimension === "count" || parsed.dimension.startsWith("count:") ? `${parsed.unit} counts` : parsed.dimension} can be compared.` };
}

/** Eligibility permits name matching, not quantity coverage. Use-by dates are inclusive. */
export function pantryStockEligibility(stock: PantryStock, date: string): { eligible: boolean; reason: string | null } {
  const amount = pantryAmountDetails(stock.measure);
  if (amount.kind === "empty") return { eligible: false, reason: amount.explanation };
  if (stock.useBy && stock.useBy < date) return { eligible: false,
    reason: `Stock dated ${stock.useBy} is past its entered use-by date for ${date}; excluded. Check the entered date or use other stock.` };
  return { eligible: true, reason: null };
}

function displayQuantity(quantity: number): string {
  return String(Number(Math.max(0, quantity).toFixed(6)));
}

export function formatMeasure(quantity: number, unit: string): string {
  const amount = displayQuantity(Number.isFinite(quantity) ? quantity : 0);
  if (unit === "count") return amount;
  if (unit === "g" || unit === "ml") return `${amount} ${unit}`;
  const plural = unit === "bunch" ? "bunches" : unit === "pinch" ? "pinches" : `${unit}s`;
  return `${amount} ${Number(amount) === 1 ? unit : plural}`;
}

/** A planning-only copy: never rewrite the attributed source ingredient. */
export function normalizePlanningIngredient(ingredient: RecipeIngredient): RecipeIngredient {
  const original = { ...ingredient };
  if (ingredient.measure.trim()) return original;
  const text = ingredient.name.trim();
  const amount = "(?:\\d+\\s+\\d+/\\d+|\\d+/\\d+|\\d+(?:\\.\\d+)?(?:\\s*[¼½¾⅓⅔⅛⅜⅝⅞])?|[¼½¾⅓⅔⅛⅜⅝⅞])";
  const dual = text.match(new RegExp(`^(${amount}\\s+[a-zA-Z ]+)\\s*\\((${amount}\\s*(?:g|kg|ml|l))\\)\\s+(.+)$`, "i"));
  if (dual) {
    const first = parseMeasure(dual[1]);
    const metric = parseMeasure(dual[2]);
    // Only comparable equivalents can be checked; never assume food density.
    if (!first || !metric || first.quantity <= 0 || first.dimension !== metric.dimension || Math.abs(first.quantity - metric.quantity) / first.quantity > 0.05 || /\b(?:or|and)\b|[()]/i.test(dual[3])) return original;
    return { name: ingredientLabel(dual[3]), measure: formatMeasure(metric.quantity, metric.unit) };
  }
  // Anything parenthesized or expressed as a range/alternative needs review.
  if (/[()–—]|\d\s*-\s*\d|\b(?:to|or|and|of|approximately|about)\b/i.test(text)) return original;
  const leading = text.match(new RegExp(`^(${amount})(?:\\s*([a-zA-Z]+))?\\s+(.+)$`));
  if (!leading) return original;
  const withUnit = parseMeasure(`${leading[1]} ${leading[2] ?? ""}`);
  if (withUnit) return { name: ingredientLabel(leading[3]), measure: formatMeasure(withUnit.quantity, withUnit.unit) };
  if (leading[2]) return original;
  // No unit: accept a simple count, retaining the complete ingredient name.
  const count = text.match(new RegExp(`^(${amount})\\s+(.+)$`));
  const parsed = count && parseMeasure(count[1]);
  return parsed ? { name: ingredientLabel(count![2]), measure: formatMeasure(parsed.quantity, parsed.unit) } : original;
}

/** Blank means inherit; saved personal quantities must be measurable and positive. */
export function personalAmountInputProblem(value: string): string {
  if (!value.trim()) return "";
  const parsed = parseMeasure(value);
  return value.length <= 160 && parsed && parsed.quantity > 0 && parsed.quantity <= 1_000_000_000
    ? "" : "Enter a positive measured amount, such as 300 g, 1 cup, or 2.";
}

export function personalAmountsMatch(recipe: Recipe, amounts: PersonalRecipeAmounts | undefined, contentHash: string | undefined): boolean {
  return Boolean(amounts && contentHash && amounts.contentHash === contentHash
    && amounts.referenceServings === (recipe.servings ?? null)
    && amounts.amounts.every(item => recipe.ingredients[item.ingredientIndex]?.name === item.originalName));
}

/** Shared by selection and every stock preview. Only the planning copy changes. */
export function applyPersonalRecipeAmounts(meal: PlannedMeal, amounts: PersonalRecipeAmounts | undefined, contentHash: string | undefined): PlannedMeal {
  if (!meal.recipe || !amounts || !personalAmountsMatch(meal.recipe, amounts, contentHash)) return meal;
  const ingredients = meal.recipe.ingredients.map(normalizePlanningIngredient);
  for (const item of amounts.amounts) ingredients[item.ingredientIndex].measure = item.measure;
  return { ...meal, planningIngredients: ingredients, personalAmountIndices: amounts.amounts.map(item => item.ingredientIndex) };
}

export function mealAmountBasis(meal: PlannedMeal, index: number): "saved_override" | "personal_scaled" | "source_scaled" {
  return Object.hasOwn(meal.ingredientOverrides, String(index)) ? "saved_override"
    : meal.personalAmountIndices?.includes(index) ? "personal_scaled" : "source_scaled";
}

export function mealAmountLabel(meal: PlannedMeal, index: number): string {
  const basis = mealAmountBasis(meal, index);
  return basis === "saved_override" ? "Dinner override" : basis === "personal_scaled" ? "Personal amount · scaled for this dinner" : "Scaled from source";
}

interface Requirement {
  identity: string;
  name: string;
  parsed: ParsedMeasure | null;
  raw: string;
  quantity: number;
  occurrences: number;
  scales: number[];
  descriptions: string[];
  recipeTitles: Set<string>;
  mealDates: Set<string>;
  needsReview: boolean;
}

function requirementsFor(meals: PlannedMeal[]): Requirement[] {
  const groups = new Map<string, Requirement>();
  for (const meal of meals) {
    if (meal.status === "cooked") continue;
    const title = meal.title || meal.recipe?.title || "Untitled meal";
    const requestedScale = mealScale(meal);
    const validScale = Number.isFinite(requestedScale) && requestedScale > 0;
    const scale = validScale ? requestedScale : 1;
    const ingredients = meal.planningIngredients ?? meal.recipe?.ingredients ?? [{ name: `Ingredients for ${title}`, measure: "Recipe ingredients unavailable" }];
    for (const [index, ingredient] of ingredients.entries()) {
      const name = ingredient.name.trim() || "Unnamed ingredient";
      const identity = canonicalIngredient(name);
      const overridden = Object.prototype.hasOwnProperty.call(meal.ingredientOverrides, String(index));
      const raw = (overridden ? meal.ingredientOverrides[String(index)] : ingredient.measure).trim();
      // An override is the final amount for this particular planned meal.
      const effectiveScale = overridden ? 1 : scale;
      const parsed = plannedIngredientMeasure(meal, index, ingredient);
      const quantity = parsed ? cleanNumber(parsed.quantity * effectiveScale) : 0;
      if (parsed && quantity === 0) continue;
      const groupKey = JSON.stringify([identity, parsed?.dimension ?? "review", parsed ? "" : raw.toLowerCase()]);
      let group = groups.get(groupKey);
      if (!group) {
        group = { identity, name, parsed, raw, quantity: 0, occurrences: 0, scales: [], descriptions: [], recipeTitles: new Set(), mealDates: new Set(), needsReview: !parsed || (!overridden && !validScale) };
        groups.set(groupKey, group);
      }
      group.quantity = cleanNumber(group.quantity + quantity);
      group.occurrences += 1;
      group.scales.push(effectiveScale);
      group.recipeTitles.add(title);
      group.mealDates.add(meal.date);
      group.needsReview ||= !overridden && !validScale;
      group.descriptions.push(`${title} (${meal.date}): ${raw || "amount missing"}${overridden ? " (custom amount for this meal)" : `${meal.personalAmountIndices?.includes(index) ? " (personal amount)" : ""} × ${displayQuantity(effectiveScale)}`}${!overridden && !validScale ? " (invalid portions; check amount)" : ""}`);
    }
  }
  return [...groups.values()].sort((a, b) => a.identity.localeCompare(b.identity) || (a.parsed?.dimension ?? a.raw).localeCompare(b.parsed?.dimension ?? b.raw));
}

/** Ambiguous ingredient choices need review even when their amount is numeric.
 * Older snapshots deliberately retain their original calculation behavior. */
export function plannedIngredientMeasure(meal: PlannedMeal, index: number, ingredient: RecipeIngredient): ParsedMeasure | null {
  const overridden = Object.prototype.hasOwnProperty.call(meal.ingredientOverrides, String(index));
  if (meal.planningIngredients && !overridden && /\b(?:or|and)\b/i.test(ingredient.name)) return null;
  return parseMeasure(overridden ? meal.ingredientOverrides[String(index)] : ingredient.measure);
}

function uniquePantry(pantry: PantryStock[]): PantryStock[] {
  return [...new Map(pantry.map((stock) => [stock.id, stock])).values()];
}

function matchingStock(requirement: Requirement, pantry: PantryStock[]) {
  return pantry.filter((stock) => canonicalIngredient(stock.name) === requirement.identity).map((stock) => ({ stock, ...pantryAmountDetails(stock.measure) }));
}

function pantryComparisonNotes(requirement: Requirement, pantry: PantryStock[], date: string): string[] {
  // Two unparsed amounts are not comparable just because both dimensions are absent.
  if (!requirement.parsed) return [];
  const notes: string[] = [];
  for (const match of matchingStock(requirement, pantry)) {
    if (!pantryStockEligibility(match.stock, date).eligible) continue;
    if (!match.parsed) notes.push(`${requirement.name}: ${match.explanation}`);
    else if (match.parsed.dimension !== requirement.parsed.dimension) {
      notes.push(`${requirement.name}: pantry amount “${match.stock.measure}” cannot be compared with the required ${formatMeasure(requirement.quantity, requirement.parsed.unit)}. Measure pantry stock in ${requirement.parsed.unit} or enter a reviewed dinner amount in matching units; no automatic conversion is applied.`);
    }
  }
  return [...new Set(notes)];
}

export interface ResolvedMealIngredient {
  name: string;
  measure: string;
  needsReview: boolean;
}

/** The same final amounts are used in details, cooking and quantity allocation. */
export function resolvedMealIngredients(meal: PlannedMeal): ResolvedMealIngredient[] {
  return (meal.planningIngredients ?? meal.recipe?.ingredients ?? []).map((ingredient, index) => {
    const overridden = Object.prototype.hasOwnProperty.call(meal.ingredientOverrides, String(index));
    const parsed = plannedIngredientMeasure(meal, index, ingredient);
    const scale = overridden ? 1 : mealScale(meal);
    const validScale = Number.isFinite(scale) && scale > 0;
    return { name: ingredient.name,
      measure: parsed && validScale ? formatMeasure(parsed.quantity * scale, parsed.unit) : meal.ingredientOverrides[String(index)] ?? ingredient.measure,
      needsReview: !parsed || !validScale };
  });
}

export interface MealStockAllocation {
  mealId: string;
  date: string;
  pantry: PantryStock[];
  deductions: PantryDeduction[];
  notes: string[];
  /** Fractions of required amounts, averaged across ingredient requirements. */
  coverage: number;
  useSoonCoverage: number;
  ingredientIdentities: string[];
  coveredByGroup: Map<string, number>;
}

export interface MealReadiness {
  personalAmountsApplied?: boolean;
  coveredCount: number;
  partialCount: number;
  missingCount: number;
  reviewCount: number;
  coverage: number;
  useSoonCoverage: number;
  shopping: Array<Pick<ShoppingItem, "name" | "measure" | "needsReview" | "preparationNote" | "notes">>;
}

export function mealReadiness(meal: PlannedMeal, pantry: PantryStock[], today = currentLocalDate()): MealReadiness {
  const allocation = allocateMealStock(meal, pantry, today);
  const stock = uniquePantry(pantry);
  const stockDate = meal.date > today ? meal.date : today;
  const summary = { coveredCount: 0, partialCount: 0, missingCount: 0, reviewCount: 0 };
  for (const requirement of requirementsFor([meal])) {
    const covered = allocation.coveredByGroup.get(requirementKey(requirement)) ?? 0;
    if (!requirement.parsed || requirement.needsReview) summary.reviewCount++;
    else if (covered >= requirement.quantity) summary.coveredCount++;
    else if (pantryComparisonNotes(requirement, stock, stockDate).length) summary.reviewCount++;
    else if (covered > 0) summary.partialCount++;
    else summary.missingCount++;
  }
  return { ...summary, coverage: allocation.coverage, useSoonCoverage: allocation.useSoonCoverage,
    ...(meal.personalAmountIndices?.some(index => mealAmountBasis(meal, index) === "personal_scaled") ? { personalAmountsApplied: true } : {}),
    shopping: buildShoppingList([meal], pantry, today).map(({ name, measure, needsReview, preparationNote, notes }) => ({ name, measure, needsReview, notes, ...(preparationNote ? { preparationNote } : {}) })) };
}

function requirementKey(requirement: Requirement): string {
  return JSON.stringify([requirement.identity, requirement.parsed?.dimension ?? "review", requirement.parsed ? "" : requirement.raw.toLowerCase()]);
}

function dateAfter(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function currentLocalDate(value = new Date()): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

/** Allocate compatible known amounts only. This never changes real pantry stock. */
export function allocateMealStock(meal: PlannedMeal, pantry: PantryStock[], today = currentLocalDate()): MealStockAllocation {
  const stock = uniquePantry(pantry).map((item) => ({ ...item }));
  const deductions: PantryDeduction[] = [];
  const notes: string[] = [];
  const coveredByGroup = new Map<string, number>();
  const requirements = requirementsFor([meal]);
  let coverage = 0;
  let useSoonCoverage = 0;
  const stockDate = meal.date > today ? meal.date : today;
  const soon = dateAfter(stockDate, 3);
  for (const requirement of requirements) {
    if (!requirement.parsed) {
      notes.push(...preparationNotes(requirement.name, stock, stockDate));
      notes.push(`${requirement.name}: required amount needs review; enter a measured dinner amount before subtracting pantry stock. No stock deducted.`, ...requirement.descriptions);
      continue;
    }
    let remaining = requirement.quantity;
    let usedSoon = 0;
    const matches = matchingStock(requirement, stock).sort((a, b) => (a.stock.useBy ?? "9999-12-31").localeCompare(b.stock.useBy ?? "9999-12-31") || a.stock.id.localeCompare(b.stock.id));
    for (const match of matches) {
      const eligibility = pantryStockEligibility(match.stock, stockDate);
      if (!eligibility.eligible) {
        notes.push(`${requirement.name}: ${eligibility.reason} Not deducted.`);
        continue;
      }
      if (!match.parsed || match.parsed.dimension !== requirement.parsed.dimension || remaining <= 0) continue;
      const consumed = Math.min(remaining, match.parsed.quantity);
      remaining = cleanNumber(remaining - consumed);
      if (match.stock.useBy && match.stock.useBy <= soon) usedSoon = cleanNumber(usedSoon + consumed);
      const before = match.stock.measure;
      const after = formatMeasure(cleanNumber(match.parsed.quantity - consumed), match.parsed.unit);
      deductions.push({ pantryId: match.stock.id, name: match.stock.name, before, after,
        ...(match.stock.useBy ? { useBy: match.stock.useBy } : {}) });
      match.stock.measure = after;
    }
    const covered = cleanNumber(requirement.quantity - remaining);
    coveredByGroup.set(requirementKey(requirement), covered);
    if (requirement.quantity > 0) {
      coverage += covered / requirement.quantity;
      useSoonCoverage += usedSoon / requirement.quantity;
    }
    if (remaining > 0) notes.push(...preparationNotes(requirement.name, stock, stockDate), ...pantryComparisonNotes(requirement, stock, stockDate), `${requirement.name}: ${formatMeasure(remaining, requirement.parsed.unit)} not covered by quantified, compatible pantry stock; not deducted.`);
    if (requirement.needsReview) notes.push(...requirement.descriptions);
  }
  const denominator = requirements.length;
  return { mealId: meal.id, date: meal.date, pantry: stock, deductions, notes,
    coverage: denominator ? coverage / denominator : 0, useSoonCoverage: denominator ? useSoonCoverage / denominator : 0,
    ingredientIdentities: [...new Set(requirements.map((item) => item.identity))], coveredByGroup };
}

/** A single virtual inventory prevents later dinners from spending the same stock. */
export function allocateStockForMeals(meals: PlannedMeal[], pantry: PantryStock[], today = currentLocalDate()): { pantry: PantryStock[]; allocations: MealStockAllocation[] } {
  let remaining = uniquePantry(pantry).map((stock) => ({ ...stock }));
  const allocations: MealStockAllocation[] = [];
  for (const meal of meals.filter((item) => item.status !== "cooked").slice().sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    const allocation = allocateMealStock(meal, remaining, today);
    allocations.push(allocation);
    remaining = allocation.pantry;
  }
  return { pantry: remaining, allocations };
}

export interface PantryUnitMismatch {
  pantryId: string;
  mealId: string;
  date: string;
  title: string;
  ingredient: string;
  requiredUnit: string;
}

/** Structured review evidence from the same grouped requirements and sequential allocation. */
export function pantryUnitMismatches(meals: PlannedMeal[], pantry: PantryStock[], today: string): PantryUnitMismatch[] {
  const mealsById = new Map(meals.map(meal => [meal.id, meal]));
  const { allocations } = allocateStockForMeals(meals, pantry, today);
  const mismatches: PantryUnitMismatch[] = [];
  for (const allocation of allocations) {
    const meal = mealsById.get(allocation.mealId)!;
    const stockDate = meal.date > today ? meal.date : today;
    for (const requirement of requirementsFor([meal])) {
      const required = requirement.parsed;
      if (!required || requirement.needsReview
        || (allocation.coveredByGroup.get(requirementKey(requirement)) ?? 0) >= requirement.quantity) continue;
      // Use this dinner's remaining stock, not batches already spent by it or earlier dinners.
      for (const match of matchingStock(requirement, allocation.pantry)) {
        if (match.kind !== "known" || !match.parsed || match.parsed.dimension === required.dimension
          || !pantryStockEligibility(match.stock, stockDate).eligible) continue;
        mismatches.push({ pantryId: match.stock.id, mealId: meal.id, date: meal.date,
          title: meal.title || meal.recipe?.title || "Untitled meal", ingredient: requirement.name, requiredUnit: required.unit });
      }
    }
  }
  return mismatches;
}

export function buildShoppingList(meals: PlannedMeal[], pantry: PantryStock[], today = currentLocalDate()): ShoppingItem[] {
  const stock = uniquePantry(pantry);
  const allocation = allocateStockForMeals(meals, stock, today);
  const covered = new Map<string, number>();
  for (const meal of allocation.allocations) {
    for (const [key, quantity] of meal.coveredByGroup) covered.set(key, cleanNumber((covered.get(key) ?? 0) + quantity));
  }
  const items: ShoppingItem[] = [];
  for (const requirement of requirementsFor(meals)) {
    const matches = matchingStock(requirement, stock);
    const recipeTitles = [...requirement.recipeTitles].sort();
    const mealDates = [...requirement.mealDates].sort();
    const stockDates = [...new Set(mealDates.map((date) => date > today ? date : today))];
    const preparation = [...new Set(stockDates.flatMap((date) => preparationNotes(requirement.name, stock, date)))];
    const comparison = [...new Set(stockDates.flatMap((date) => pantryComparisonNotes(requirement, stock, date)))];
    const exclusions = [...new Set(matches.flatMap(({ stock: entry }) => stockDates.flatMap((date) => {
      const eligibility = pantryStockEligibility(entry, date);
      return eligibility.eligible ? [] : [`${requirement.name}: ${eligibility.reason}`];
    })))];
    const notes = [...requirement.descriptions].sort().concat(preparation, comparison, exclusions);
    if (!requirement.parsed) {
      notes.push(`${requirement.name}: required amount is not quantified; enter a measured dinner amount before subtracting pantry stock.`);
      const measure = `${requirement.raw || "Amount missing"}${requirement.occurrences > 1 ? ` · ${requirement.occurrences} occurrences` : ""}`;
      items.push({
        key: JSON.stringify([requirement.identity, "review", requirement.raw.toLowerCase(), requirement.scales.slice().sort((a, b) => a - b)]),
        name: requirement.name,
        measure,
        requiredMeasure: measure,
        pantryMeasure: matches.filter(({ stock: entry }) => stockDates.some((date) => pantryStockEligibility(entry, date).eligible)).map(({ stock: entry }) => entry.measure || "Unknown amount").join(" + ") || "0",
        needsReview: true,
        ...(preparation.length ? { preparationNote: preparation[0] } : {}),
        notes,
        recipeTitles,
        mealDates,
      });
      continue;
    }
    const { unit, dimension } = requirement.parsed;
    const available = covered.get(requirementKey(requirement)) ?? 0;
    const needsReview = requirement.needsReview || preparation.length > 0 || comparison.length > 0;
    const missing = cleanNumber(Math.max(0, requirement.quantity - available));
    if (missing === 0) continue;
    items.push({
      key: JSON.stringify([requirement.identity, dimension, requirement.quantity, missing]),
      name: requirement.name,
      measure: formatMeasure(missing, unit),
      requiredMeasure: formatMeasure(requirement.quantity, unit),
      pantryMeasure: formatMeasure(available, unit),
      needsReview,
      ...(preparation.length ? { preparationNote: preparation[0] } : {}),
      notes,
      recipeTitles,
      mealDates,
    });
  }
  return items;
}

export function consumptionPreview(meal: PlannedMeal, pantry: PantryStock[], today = currentLocalDate()): { deductions: PantryDeduction[]; notes: string[] } {
  // Cooking happens now even when a dinner was originally planned for another day.
  const { deductions, notes } = allocateMealStock({ ...meal, date: today }, pantry, today);
  return { deductions, notes };
}

export function completeMeal(state: KitchenState, date: string, deduct: boolean, now = new Date().toISOString(), today = currentLocalDate(new Date(now))): KitchenState {
  const meal = state.meals[date];
  if (!meal || meal.status === "cooked") return state;
  // A retained completion record is also an idempotency guard for imported data.
  if (meal.completion) return { ...state, meals: { ...state.meals, [date]: { ...meal, status: "cooked" } } };
  const deductions = deduct ? consumptionPreview(meal, state.pantry, today).deductions : [];
  const afterById = new Map(deductions.map((deduction) => [deduction.pantryId, deduction.after]));
  return {
    ...state,
    pantry: state.pantry.map((stock) => afterById.has(stock.id) ? { ...stock, measure: afterById.get(stock.id)! } : stock),
    meals: {
      ...state.meals,
      [date]: { ...meal, status: "cooked", completion: { id: `${date}:${meal.id}`, at: now, deductions } },
    },
  };
}

function previewMealUndo(state: KitchenState, date: string): { state: KitchenState; problem: string } {
  const meal = state.meals[date];
  if (!meal || (meal.status === "planned" && !meal.completion)) return { state, problem: "" };
  const pantry = state.pantry.slice();
  const existingIds = new Set(pantry.map((stock) => stock.id));
  const legacyRequirements = requirementsFor([{ ...meal, status: "planned" }]);
  for (const deduction of meal.completion?.deductions ?? []) {
    const before = parseMeasure(deduction.before);
    const after = parseMeasure(deduction.after);
    if (!before || !after || before.dimension !== after.dimension) continue;
    const quantity = cleanNumber(before.quantity - after.quantity);
    if (quantity <= 0) continue;
    // Old records did not store ingredient names. Only infer one when the
    // recipe has exactly one matching identity in that measurement dimension.
    const candidates = legacyRequirements.filter((requirement) => requirement.parsed?.dimension === before.dimension);
    const identities = new Set(candidates.map((requirement) => requirement.identity));
    const name = deduction.name?.trim() || (identities.size === 1 ? candidates[0]?.name : undefined);
    if (!name) continue;
    const index = pantry.findIndex((stock) => stock.id === deduction.pantryId);
    const currentStock = index >= 0 ? pantry[index] : undefined;
    const current = currentStock ? parseMeasure(currentStock.measure) : null;
    if (currentStock && current && current.dimension === before.dimension && canonicalIngredient(currentStock.name) === canonicalIngredient(name)) {
      pantry[index] = { ...currentStock, measure: formatMeasure(cleanNumber(current.quantity + quantity), current.unit) };
      continue;
    }
    // A deleted row restores only the consumed delta, not the stock the user
    // subsequently deleted. Incompatible edits stay intact in their own row.
    let id = deduction.pantryId;
    if (existingIds.has(id)) {
      let hash = 2166136261;
      for (const character of `${meal.completion?.id}:${deduction.pantryId}:${name}:${before.dimension}`) {
        hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
      }
      const base = `undo:${(hash >>> 0).toString(36)}`;
      id = base;
      for (let suffix = 2; existingIds.has(id); suffix += 1) id = `${base}:${suffix}`;
    }
    existingIds.add(id);
    pantry.push({ id, name, measure: formatMeasure(quantity, before.unit), ...(deduction.useBy ? { useBy: deduction.useBy } : {}) });
  }
  // Check the complete restoration before changing either stock or completion.
  // Restoring into existing rows is still allowed when the pantry is full.
  if (pantry.length > 500) {
    const excess = pantry.length - 500;
    return { state, problem: `Make room in your pantry before undoing this dinner. Remove ${excess} pantry ${excess === 1 ? "row" : "rows"} so the restored stock fits within the 500-row limit.` };
  }
  const plannedMeal = { ...meal };
  delete plannedMeal.completion;
  return {
    state: {
      ...state,
      pantry,
      meals: { ...state.meals, [date]: { ...plannedMeal, status: "planned" } },
    },
    problem: "",
  };
}

/** Explain a blocked undo without changing the dinner or its pantry deductions. */
export function undoMealProblem(state: KitchenState, date: string): string {
  return previewMealUndo(state, date).problem;
}

export function undoMeal(state: KitchenState, date: string): KitchenState {
  return previewMealUndo(state, date).state;
}
