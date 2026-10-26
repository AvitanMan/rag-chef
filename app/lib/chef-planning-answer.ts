import type { PlannedMeal } from "./kitchen-types";
import type { ChefPlanningFact } from "./chef-schema";
import { canonicalIngredient, resolvedMealIngredients } from "./quantities";

/** Quantity-only requests: source wording and cooking advice keep their own path. */
export function isPlanningQuantityQuestion(query: string): boolean {
  // The shortcut answers the whole request. A second question or instruction
  // needs source evidence even when the first clause asks about an amount.
  const request = query.trim().replace(/[?.!]+$/, "");
  const extraRequest = /[?!;]|[.:]\s+\S|(?:\b(?:and|or|also|but|then|plus)\s+|,\s*)(?:how|why|what|when|where|whether|should|can|could|would|will|do|does|is|are|must|explain|describe|show|tell)\b/i.test(request);
  const quantityTail = request.match(/\b(?:(?:do|will|would|should|must)\s+(?:i|we|you)\s+(?:need|use|require)|(?:does|will|would)\s+(?:this|the|my|our)\s+(?:dinner|meal|recipe)\s+(?:need|use|require)|(?:is|are)\s+(?:needed|required|planned|saved))\b([\s\S]*)$/i)?.[1];
  // Only a dinner scope or polite closing may follow the quantity request.
  // Otherwise the ingredient parser would stop early and drop the rest.
  const unexpectedTail = quantityTail !== undefined && !/^\s*(?:(?:(?:for|in)\s+(?:(?:this|the|my|our)\s+)?(?:(?:saved|planned)\s+)?(?:dinner|meal|recipe|batch))|(?:(?:for\s+)?(?:tonight|today|tomorrow)))?\s*(?:,?\s*please)?\s*$/i.test(quantityTail);
  return /\bhow (?:much|many)\b|\b(?:ingredient amounts?|quantities)\b|\bwhat (?:are )?(?:the )?amounts?\b/i.test(query)
    && !extraRequest
    && !unexpectedTail
    && !/\b(?:cook|prepare|drain|stir|rinse|mix|whisk|chop|slice|dice|grate|serve|store|reheat)\b/i.test(query)
    && !/\b(?:original|source|servings?|yield|minutes?|seconds?|hours?|time|temperature|degrees?|calories?|kcal|protein|carbs?|fat|sodium|nutrition|why|when|bake|boil|fry|warm|heat|method|technique|substitut\w*|swap\w*|instead)\b|\b(?:can|should|could) i\b/i.test(query);
}

function requestedIngredients(query: string): string[] {
  const subject = query.match(/\bhow (?:much|many)\s+(.+?)(?=\s+(?:do|will|would|should|must)\s+(?:i|we|you)\b|\s+(?:does|will|would)\s+(?:this|the|my|our)\s+(?:dinner|meal|recipe)\b|\s+(?:is|are)\s+(?:needed|required|planned|saved|in|for)\b|[?.!]|$)/i)?.[1]
    ?? query.match(/\b(?:amounts?|quantities)\s+(?:of|for)\s+(.+?)(?=[?.!]|$)/i)?.[1];
  return subject?.replace(/,\s*(cooked|uncooked|raw|dry|dried)\b/gi, " $1").split(/,|\band\b/i).map(part => part.trim()
    .replace(/^(?:(?:of|the|a|an|some)\s+)+/i, "")
    .replace(/^(?:grams?|g|millilitres?|milliliters?|ml|cups?|tablespoons?|teaspoons?)\s+(?:of\s+)?/i, "")
    .replace(/^(?:the\s+)?/i, "").replace(/\s+for\s+.+$/i, "").trim()).filter(Boolean) ?? [];
}

export function planningQuantityAnswer(meal: PlannedMeal, query: string) {
  const amounts = resolvedMealIngredients(meal);
  const selected = new Set<number>();
  const identities = amounts.map(row => canonicalIngredient(row.name));
  const requested = requestedIngredients(query);
  const all = /\b(?:all|every|each)\b.*\b(?:ingredients?|amounts?|quantities)\b|\b(?:amounts?|quantities)\b.*\b(?:all|everything)\b|^what (?:are )?(?:the )?ingredient amounts?[? .]*$/i.test(query.trim());
  const unmatched = all ? [] : requested.filter(part => !identities.includes(canonicalIngredient(part)));
  if (all) amounts.forEach((_, index) => selected.add(index));
  else if (requested.length) {
    // Match complete requested names: cooked rice and rice vinegar cannot become rice.
    requested.forEach(part => identities.forEach((identity, index) => {
      if (canonicalIngredient(part) === identity) selected.add(index);
    }));
  }
  const ambiguous = !all && [...selected].some(index => identities.filter(value => value === identities[index]).length > 1);
  const planningFacts: ChefPlanningFact[] = [...selected].sort((a, b) => a - b).map(index => ({
    recipeId: meal.recipeId, ingredientIndex: index, sourceEvidenceId: `I${index + 1}`,
    name: amounts[index].name, measure: amounts[index].measure, needsReview: amounts[index].needsReview,
    basis: Object.hasOwn(meal.ingredientOverrides, String(index)) ? "saved_override" : "source_scaled",
  }));
  const clarify = !planningFacts.length || unmatched.length > 0 || ambiguous || planningFacts.some(row => row.needsReview);
  const yieldLabel = meal.baseServings ? `${meal.servings} servings` : `${meal.batches} recipe ${meal.batches === 1 ? "batch" : "batches"}`;
  const followUp = ambiguous ? " Several saved entries match; which one do you mean?" : unmatched.length ? " Which saved ingredient do you mean for the other amount?" : "";
  return {
    planningFacts, answerStatus: clarify ? "needs_clarification" as const : "answered" as const,
    answer: planningFacts.length
      ? `For your dinner (${yieldLabel}): ${planningFacts.map(row => `${row.name}: ${row.needsReview ? "amount needs review" : row.measure}`).join("; ")}.${followUp}`
      : "Which saved ingredient's amount would you like?",
  };
}
