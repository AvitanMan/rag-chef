import type { Diet, Recipe, RecipeConstraints, RecipeMetadata } from "./recipe-types";
import { matchedRecipeAllergies, matchedRecipeIngredientExclusions, normalizeIngredientText, containsIngredientTerm } from "./recipe-safety";

type ConstraintInput = {
  allergies?: string[];
  excludedIngredients?: string[];
  diet?: string | string[];
  diets?: string[];
  dislikes?: string[];
  equipment?: string[];
  equipmentSpecified?: boolean;
  excludedEquipment?: string[];
  maxTotalMinutes?: number;
};

const DIETS: Record<string, Diet> = { vegan: "vegan", vegetarian: "vegetarian", "gluten free": "gluten_free", "low carb": "low_carb" };
const MEAT_TERMS = ["meat", "beef", "veal", "pork", "bacon", "ham", "chicken", "turkey", "duck", "lamb", "mutton", "sausage", "chorizo", "pepperoni", "lard", "suet", "gelatin", "gelatine", "fish", "salmon", "tuna", "cod", "anchovy", "anchovies", "sardine", "sardines", "trout", "haddock", "shrimp", "prawn", "prawns", "crab", "lobster", "clam", "clams", "mussel", "mussels", "oyster", "oysters", "scallop", "scallops", "squid", "octopus", "worcestershire"];
const DAIRY_TERMS = ["milk", "cream", "butter", "cheese", "whey", "casein", "yogurt", "yoghurt", "ghee", "lactose", "mozzarella", "parmesan", "parmigiano", "pecorino", "feta", "ricotta", "cheddar", "paneer", "buttermilk", "mascarpone", "brie", "gorgonzola"];
const GLUTEN_TERMS = ["gluten", "wheat", "flour", "barley", "rye", "spelt", "semolina", "couscous", "breadcrumbs", "bread crumbs", "bread", "pasta", "farfalle", "ziti", "penne", "macaroni", "spaghetti", "fettuccine", "lasagne", "lasagna", "orzo", "soy sauce", "seitan", "bulgur", "udon"];

export function normalizeEquipmentName(value: string): string {
  const name = normalizeIngredientText(value);
  return /^(?:stove|stove top|hob)$/.test(name) ? "stovetop" : name;
}

export function normalizeConstraints(input: ConstraintInput = {}): RecipeConstraints {
  const diets = input.diets ?? (typeof input.diet === "string" ? [input.diet] : input.diet ?? []);
  const excludedEquipment = [...new Set((input.excludedEquipment ?? []).map(normalizeEquipmentName).filter(Boolean))];
  return {
    allergies: [...new Set((input.allergies ?? []).map((x) => x.trim()).filter(Boolean))],
    excludedIngredients: [...new Set((input.excludedIngredients ?? []).map(normalizeIngredientText).filter(Boolean))],
    diets: [...new Set(diets.map((x) => DIETS[normalizeIngredientText(x)]).filter((x): x is Diet => Boolean(x)))],
    dislikes: [...new Set((input.dislikes ?? []).map(normalizeIngredientText).filter(Boolean))],
    equipment: [...new Set((input.equipment ?? []).map(normalizeEquipmentName).filter(Boolean))],
    equipmentSpecified: input.equipmentSpecified ?? Object.hasOwn(input, "equipment"),
    ...(excludedEquipment.length ? { excludedEquipment } : {}),
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
    const plantBinderContext = /\b(?:(?:flax(?:seed)?|chia(?: seed)?) eggs?|plant (?:based )?binders?)\b/.test(text);
    const dairyText = (plantBinderContext ? text.replace(/\b(?:commercial )?egg replacers?\b/g, "") : text)
      .replace(/\b(?:flax(?:seed)?|chia(?: seed)?|vegan|plant based) eggs?\b/g, "")
      .replace(/\b(?:coconut|soy|soya|oat|almond|rice|cashew|plant based) (?:milk|cream)\b/g, "")
      .replace(/\b(?:peanut|almond|cashew|apple|cocoa|vegan|plant based) butter\b/g, "")
      .replace(/\b(?:vegan|dairy free|plant based) (?:cheese|yogurt|yoghurt|cream|milk)\b/g, "");
    return [...DAIRY_TERMS, "egg", "eggs", "mayonnaise", "meringue", "albumen", "honey"].some((term) => containsIngredientTerm(dairyText, term));
  }
  const glutenText = text.replace(/\bgluten free (?:flour|bread|pasta|noodles|soy sauce|spaghetti|penne|lasagne|lasagna)\b/g, "")
    .replace(/\b(?:rice|corn|maize|chickpea|gram|almond|coconut|buckwheat|tapioca|potato) flour\b/g, "");
  return GLUTEN_TERMS.some((term) => containsIngredientTerm(glutenText, term));
}

const ADVICE_ACTIONS = "add|use|keep|retain|include|serve|top|finish|stir|mix|blend|fold|sprinkle|drizzle|combine|replace|swap|substitute|omit|remove|skip|leave|avoid|do not|don't";

function adviceClauses(text: string): string[] {
  // Split only at actual action boundaries, not ingredient lists or decimals.
  return text.replace(new RegExp(`(?:,\\s*|\\s+(?:and|but|then|however)\\s+)(?=(?:(?:also|then)\\s+)?(?:${ADVICE_ACTIONS})\\b)`, "gi"), "\n")
    .split(/[;!?\n]|\.(?=\s|$)/).map(part => part.trim().replace(/^(?:also|then)\s+/i, "")).filter(Boolean);
}

function removedIngredientPhrase(text: string): boolean {
  // Only clearly bounded noun phrases may be excluded from conflict checks.
  // Conditions, negated replacements and nested directions stay conservative.
  if (!text.trim() || new RegExp(`\\b(?:${ADVICE_ACTIONS}|adding|using|keeping|retaining|including|serving|mixing|stirring|blending|folding|sprinkling|drizzling|kept|retained|added|included|served|mixed|topped|not|unless|if|because|since|but|then|with|instead|for|while|plus|alongside|together|optionally|which|that|who|still|unchanged|intact)\\b`, "i").test(text)) return false;
  // A participle after an ingredient can introduce an unpunctuated clause
  // ("cheese leaving butter ..."). Leading modifiers such as "whipping cream"
  // are allowed, but uncertain trailing prose must not disappear from checks.
  return text.split(/\s+and\s+/i).every(part => {
    const words = part.trim().replace(/^(?:(?:the|any|all|remaining|\d+(?:\.\d+)?|g|grams?|kg|ml|cups?|tablespoons?|teaspoons?)\s+)+/i, "").split(/\s+/);
    return !words.slice(1).some(word => /^[a-z]+(?:ing|ed)$/i.test(word));
  });
}

function removalObject(text: string): { ingredient: string; tail: string } | undefined {
  // An open-ended removal object must stop before a new clause or exception.
  // Keep the tail verbatim, even when its verb is unfamiliar. Comma-only lists
  // are intentionally ambiguous here; "cheese and butter" is unambiguous.
  const tailAt = text.search(/[,()[\]:]|\s[—–]\s|\b(?:except(?:ing)?|excluding|apart from|other than|save for)\b/i);
  const ingredient = (tailAt < 0 ? text : text.slice(0, tailAt)).trim();
  if (!removedIngredientPhrase(ingredient)) return undefined;
  return { ingredient, tail: tailAt < 0 ? "" : text.slice(tailAt).trim() };
}

function adaptationParts(text: string): { retained: string[]; removed: string[] } {
  const retained: string[] = [], removed: string[] = [];
  for (const clause of adviceClauses(text)) {
    const action = clause.replace(/^(?:please\s+)?(?:you\s+(?:can|could|should)\s+)?/i, "");
    const replacement = action.match(/^(?:replace|swap)\s+(.+?)\s+(?:with|for)\s+(.+)$/i)
      ?? action.match(/^substitute\s+(.+?)\s+with\s+(.+)$/i);
    const reverse = action.match(/^(?:use|try|choose)\s+(.+?)\s+(?:instead of|in place of|rather than)\s+(.+)$/i)
      ?? action.match(/^substitute\s+(.+?)\s+for\s+(.+)$/i);
    const omission = action.match(/^(?:omit|remove|skip|leave out|avoid|do not add|don['’]t add)\s+(.+)$/i)
      ?? action.match(/^leave\s+(.+?)\s+out$/i);
    const old = replacement?.[1] ?? reverse?.[2] ?? omission?.[1];
    const object = old ? removalObject(old) : undefined;
    if (!object) { retained.push(clause); continue; }
    removed.push(...object.ingredient.split(/\s+and\s+/i).map(part => normalizeIngredientText(part)
      .replace(/^(?:the|any|all|remaining)\s+/, "").replace(/^\d+(?:\s+\d+)*\s+/, "")
      .replace(/^(?:g|grams?|kg|ml|cups?|tablespoons?|teaspoons?)\s+/, "")));
    const next = replacement?.[2] ?? reverse?.[1];
    if (next) retained.push(next);
    if (object.tail) retained.push(object.tail);
  }
  return { retained, removed: removed.filter(Boolean) };
}

/** Advisory prose still has to respect exclusions; removed ingredients are not additions. */
export function proposedChangeConflicts(text: string, constraints: RecipeConstraints, reason = ""): boolean {
  const change = adaptationParts(text), explanation = adaptationParts(reason);
  const removed = [...change.removed, ...explanation.removed];
  const rationale = explanation.retained.map(clause => {
    // Explanations may name the original ingredient. Keep every instruction,
    // retained-ingredient statement and ambiguous reintroduction in scope.
    let checkedClause = clause.replace(/\b(?:keep|keeping|retain|retaining|maintain|maintaining|preserve|preserving)\s+(?:(?:the|a|similar|original|same|creamy)\s+)*(?:texture|consistency|creaminess|richness|moisture|flavo[u]?r)\b/gi, "");
    for (const name of removed) checkedClause = checkedClause.replace(new RegExp(`^to replace\\s+(?:the\\s+)?${name}\\b`, "i"), "");
    if (/\b(?:add|adding|added|use|using|used|keep|keeping|kept|retain|retaining|retained|maintain|maintaining|preserve|preserving|include|including|included|serve|served|top|topped|finish|stir|mix|mixed|blend|fold|sprinkle|sprinkled|drizzle|combine|replace|swap|substitute)\b/i.test(checkedClause)) return checkedClause;
    const description = normalizeIngredientText(clause).match(/^(.+?)\s+(?:is|are|provides?|contributes?|adds?)\s+(.+)$/);
    const originalSubject = description && removed.reduce((subject, name) => subject.replace(new RegExp(`\\b${name}\\b`, "g"), " "), description[1])
      .replace(/\b(?:the|and|or)\b/g, " ").trim() === "";
    const discussesRemoval = originalSubject || /\b(?:original|removed|removing|removes?|omitted|omitting|omits?|replaces?|replaced|replacing|instead of|without|avoids?|avoiding)\b/i.test(clause)
      || /\bsimilar\b.*\b(?:to|as)\b/i.test(clause);
    if (!discussesRemoval) return clause;
    let value = normalizeIngredientText(checkedClause);
    for (const name of removed) {
      // Names are normalized to ASCII letters, numbers and spaces above.
      if (new RegExp(`\\b(?:with|contains?|includes?|has|have|keeps?|retains?)\\s+(?:(?:the|some|any|a little|a bit of|a small amount of|\\d+(?:\\s+(?:g|grams?|ml|cups?|tsp|tbsp))?)\\s+)*${name}\\b|\\b${name}\\s+(?:(?:is|will|can|should|must|still|also|be)\\s+)*(?:remains?|stays?|retained|included|added|used|optional|part of)\\b`).test(value)) continue;
      value = value.replace(new RegExp(`\\b${name}\\b`, "g"), " ");
    }
    return value;
  });
  const proposed = { ingredients: [...change.retained, ...rationale].map(name => ({ name, measure: "" })) };
  // A claimed safe/free-from label still cannot certify a named allergen away.
  return matchedRecipeAllergies(proposed, constraints.allergies).length > 0
    || matchedRecipeIngredientExclusions(proposed, constraints.excludedIngredients ?? []).length > 0
    || constraints.diets.some(diet => ingredientDietConflicts(proposed, diet));
}

export interface RecipeEligibility {
  eligible: boolean;
  allergyMatches: string[];
  excludedIngredientMatches: string[];
  dietConflicts: Diet[];
  dietUnknowns: Diet[];
  dislikedIngredients: string[];
  equipmentMissing: string[];
  reasons: string[];
}

export function evaluateRecipeConstraints(recipe: Recipe, metadata: RecipeMetadata | undefined, constraints: RecipeConstraints): RecipeEligibility {
  const allergyMatches = matchedRecipeAllergies(recipe, constraints.allergies);
  const excludedIngredientMatches = matchedRecipeIngredientExclusions(recipe, constraints.excludedIngredients ?? []);
  const dietConflicts = constraints.diets.filter((diet) => ingredientDietConflicts(recipe, diet) || metadata?.diets[diet] === "conflicts");
  const dietUnknowns = constraints.diets.filter((diet) => !dietConflicts.includes(diet) && metadata?.diets[diet] !== "fits");
  const dislikedIngredients = recipe.ingredients.filter((ingredient) => constraints.dislikes.some((term) => containsIngredientTerm(normalizeIngredientText(ingredient.name), term))).map((x) => x.name);
  const equipmentMissing = metadata?.equipment?.filter((item) => constraints.equipmentSpecified && !constraints.equipment.includes(normalizeEquipmentName(item)) || constraints.excludedEquipment?.includes(normalizeEquipmentName(item))) ?? [];
  const establishedTotal = metadata?.totalMinutes != null && metadata.provenance.totalMinutes?.basis === "source" ? metadata.totalMinutes : null;
  const reasons = [
    ...allergyMatches.map((x) => `Excluded ingredient allergy: ${x}.`),
    ...excludedIngredientMatches.map((x) => `Contains an ingredient excluded by this request: ${x}.`),
    ...dietConflicts.map((x) => `Known conflict with ${x.replaceAll("_", " ")} diet.`),
    ...equipmentMissing.map((x) => `Requires unavailable equipment: ${x}.`),
    ...(constraints.excludedEquipment?.length && metadata?.equipment == null ? ["A complete equipment list is not verified for this request."] : []),
    ...(constraints.maxTotalMinutes !== undefined && (establishedTotal === null || establishedTotal > constraints.maxTotalMinutes)
      ? [establishedTotal === null ? "A complete source total time is not verified." : `Total time exceeds ${constraints.maxTotalMinutes} minutes.`] : []),
  ];
  return { eligible: !reasons.length, allergyMatches, excludedIngredientMatches, dietConflicts, dietUnknowns, dislikedIngredients, equipmentMissing, reasons };
}
