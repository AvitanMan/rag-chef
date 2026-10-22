import type { Diet, Recipe, RecipeConstraints, RecipeMetadata } from "./recipe-types";
import { matchedRecipeAllergies, normalizeIngredientText, containsIngredientTerm } from "./recipe-safety";

type ConstraintInput = {
  allergies?: string[];
  diet?: string | string[];
  diets?: string[];
  dislikes?: string[];
  equipment?: string[];
  equipmentSpecified?: boolean;
  maxTotalMinutes?: number;
};

const DIETS: Record<string, Diet> = { vegan: "vegan", vegetarian: "vegetarian", "gluten free": "gluten_free", "low carb": "low_carb" };
const MEAT_TERMS = ["meat", "beef", "veal", "pork", "bacon", "ham", "chicken", "turkey", "duck", "lamb", "mutton", "sausage", "chorizo", "pepperoni", "lard", "suet", "gelatin", "gelatine", "fish", "salmon", "tuna", "cod", "anchovy", "anchovies", "sardine", "sardines", "trout", "haddock", "shrimp", "prawn", "prawns", "crab", "lobster", "clam", "clams", "mussel", "mussels", "oyster", "oysters", "scallop", "scallops", "squid", "octopus", "worcestershire"];
const DAIRY_TERMS = ["milk", "cream", "butter", "cheese", "whey", "casein", "yogurt", "yoghurt", "ghee", "lactose", "mozzarella", "parmesan", "parmigiano", "pecorino", "feta", "ricotta", "cheddar", "paneer", "buttermilk", "mascarpone", "brie", "gorgonzola"];
const GLUTEN_TERMS = ["gluten", "wheat", "flour", "barley", "rye", "spelt", "semolina", "couscous", "breadcrumbs", "bread crumbs", "bread", "pasta", "farfalle", "ziti", "penne", "macaroni", "spaghetti", "fettuccine", "lasagne", "lasagna", "orzo", "soy sauce", "seitan", "bulgur", "udon"];

export function normalizeConstraints(input: ConstraintInput = {}): RecipeConstraints {
  const diets = input.diets ?? (typeof input.diet === "string" ? [input.diet] : input.diet ?? []);
  return {
    allergies: [...new Set((input.allergies ?? []).map((x) => x.trim()).filter(Boolean))],
    diets: [...new Set(diets.map((x) => DIETS[normalizeIngredientText(x)]).filter((x): x is Diet => Boolean(x)))],
    dislikes: [...new Set((input.dislikes ?? []).map(normalizeIngredientText).filter(Boolean))],
    equipment: [...new Set((input.equipment ?? []).map((x) => normalizeIngredientText(x).replace(/^stove top$|^hob$/, "stovetop")).filter(Boolean))],
    equipmentSpecified: input.equipmentSpecified ?? Object.hasOwn(input, "equipment"),
    ...(Number.isFinite(input.maxTotalMinutes) && input.maxTotalMinutes! > 0 ? { maxTotalMinutes: input.maxTotalMinutes } : {}),
  };
}

/** Negative evidence can exclude a recipe; absence of a match never certifies it. */
export function ingredientDietConflicts(recipe: Pick<Recipe, "ingredients">, diet: Diet): boolean {
  if (diet === "low_carb") return false;
  const text = normalizeIngredientText(recipe.ingredients.map((x) => x.name).join(" | "));
  const animalText = text.replace(/\b(?:vegan|vegetarian|plant based|meat free) (?:chicken|beef|pork|sausage|bacon|ham|meat)\b/g, "");
  if (diet === "vegetarian" || diet === "vegan") {
    if (MEAT_TERMS.some((term) => containsIngredientTerm(animalText, term))) return true;
    if (diet === "vegetarian") return false;
    const dairyText = text.replace(/\b(?:coconut|soy|soya|oat|almond|rice|cashew|plant based) (?:milk|cream)\b/g, "")
      .replace(/\b(?:peanut|almond|cashew|apple|cocoa|vegan|plant based) butter\b/g, "")
      .replace(/\b(?:vegan|dairy free|plant based) (?:cheese|yogurt|yoghurt|cream|milk)\b/g, "");
    return [...DAIRY_TERMS, "egg", "eggs", "mayonnaise", "meringue", "albumen", "honey"].some((term) => containsIngredientTerm(dairyText, term));
  }
  const glutenText = text.replace(/\bgluten free (?:flour|bread|pasta|noodles|soy sauce|spaghetti|penne|lasagne|lasagna)\b/g, "")
    .replace(/\b(?:rice|corn|maize|chickpea|gram|almond|coconut|buckwheat|tapioca|potato) flour\b/g, "");
  return GLUTEN_TERMS.some((term) => containsIngredientTerm(glutenText, term));
}

export interface RecipeEligibility {
  eligible: boolean;
  allergyMatches: string[];
  dietConflicts: Diet[];
  dietUnknowns: Diet[];
  dislikedIngredients: string[];
  equipmentMissing: string[];
  reasons: string[];
}

export function evaluateRecipeConstraints(recipe: Recipe, metadata: RecipeMetadata | undefined, constraints: RecipeConstraints): RecipeEligibility {
  const allergyMatches = matchedRecipeAllergies(recipe, constraints.allergies);
  const dietConflicts = constraints.diets.filter((diet) => ingredientDietConflicts(recipe, diet) || metadata?.diets[diet] === "conflicts");
  const dietUnknowns = constraints.diets.filter((diet) => !dietConflicts.includes(diet) && metadata?.diets[diet] !== "fits");
  const dislikedIngredients = recipe.ingredients.filter((ingredient) => constraints.dislikes.some((term) => containsIngredientTerm(normalizeIngredientText(ingredient.name), term))).map((x) => x.name);
  const equipmentMissing = constraints.equipmentSpecified && metadata?.equipment ? metadata.equipment.filter((item) => !constraints.equipment.includes(normalizeIngredientText(item))) : [];
  const establishedTotal = metadata?.totalMinutes != null && metadata.provenance.totalMinutes?.basis === "source" ? metadata.totalMinutes : null;
  const reasons = [
    ...allergyMatches.map((x) => `Excluded ingredient allergy: ${x}.`),
    ...dietConflicts.map((x) => `Known conflict with ${x.replaceAll("_", " ")} diet.`),
    ...equipmentMissing.map((x) => `Requires unavailable equipment: ${x}.`),
    ...(constraints.maxTotalMinutes !== undefined && (establishedTotal === null || establishedTotal > constraints.maxTotalMinutes)
      ? [establishedTotal === null ? "A complete source total time is not verified." : `Total time exceeds ${constraints.maxTotalMinutes} minutes.`] : []),
  ];
  return { eligible: !reasons.length, allergyMatches, dietConflicts, dietUnknowns, dislikedIngredients, equipmentMissing, reasons };
}
