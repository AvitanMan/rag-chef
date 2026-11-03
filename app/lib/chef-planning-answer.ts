import type { PlannedMeal } from "./kitchen-types";
import type { ChefPlanningFact } from "./chef-schema";
import type { Recipe } from "./recipe-types";
import { mealAmountBasis, canonicalIngredient, resolvedMealIngredients } from "./quantities";

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
    basis: mealAmountBasis(meal, index),
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

// These complete names are known varieties, not arbitrary foods containing a
// word such as "milk" (milk chocolate) or "flour" (flour tortillas).
const INGREDIENT_VARIETIES: Record<string, RegExp> = {
  sugar: /^(?:granulated|white|brown|caster|powdered|icing|confectioners'?|light brown|dark brown) sugar$/,
  salt: /^(?:table|sea|fine sea|coarse sea|kosher) salt$/,
  oil: /^(?:olive|extra virgin olive|vegetable|sunflower|canola|rapeseed|peanut|sesame|coconut) oil$/,
  milk: /^(?:whole|skim|skimmed|semi-skimmed|low-fat|low fat) milk$/,
  butter: /^(?:salted|unsalted|sweet cream|unsalted sweet cream) butter$/,
  flour: /^(?:plain|all-purpose|all purpose|self-raising|self raising|self-rising|self rising|bread|whole wheat) flour$/,
};
const DIFFERENT_FOODS: Record<string, RegExp> = {
  sugar: /^sugar snap peas?$/,
  milk: /^milk chocolate$/,
  flour: /^flour tortillas?$/,
};

function ingredientNameMatches(name: string, requested: string): boolean {
  const identity = canonicalIngredient(name), subject = canonicalIngredient(requested);
  return identity === subject || Boolean(INGREDIENT_VARIETIES[subject]?.test(identity));
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourceMaySpecifyAmount(recipe: Recipe, requested: string): boolean {
  const mention = new RegExp(`\\b${escapePattern(requested)}\\b`, "i");
  const possibleAmount = /[\d¼½¾⅐-⅞]|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|half|quarter|pinch|dash|handful|spoonful|to taste|as needed)\b/i;
  return [...recipe.instructions, ...(recipe.sourceNotes ?? [])].some(text => mention.test(text) && possibleAmount.test(text));
}

function ingredientListContains(list: string, requested: string): boolean {
  return list.split(/,|\band\b/i).some(part => ingredientNameMatches(part.trim()
    .replace(/^(?:the\s+)?(?:remaining\s+)?/i, ""), requested));
}

/** Only direct ingredient additions qualify; heating milk or adding to milk does not. */
function addsIngredient(text: string, requested: string): boolean {
  return text.split(/[.!?;]\s*/).some(sentence => {
    const addition = sentence.trim().match(/^(?:add|combine|mix in|stir in|pour|fold in)\s+(.+?)(?=\s+(?:into|in|to|with|until|over|a little at a time)\b|$)/i)
      ?? sentence.trim().match(/^season by adding\s+(.+?)(?=\s+a little at a time\b|$)/i);
    return Boolean(addition && ingredientListContains(addition[1], requested));
  });
}

function explicitIngredientRole(text: string, requested: string): boolean {
  const sentences = text.split(/(?<=[.!?])\s+|\s*;\s*/).map(value => value.trim().replace(/[.!?]+$/, ""));
  const role = "(?:(?:to|in order to) (?:coat|grease|thicken|sweeten|balance|prevent)|for (?:flavou?r|texture))";
  return sentences.some((sentence, index) => {
    const direct = sentence.match(new RegExp(`^(?:add|use|stir in|mix in)\\s+(.+?)\\s+${role}\\b`, "i"))
      ?? sentence.match(new RegExp(`^(.+?)\\s+(?:is|are)\\s+(?:used|added)\\s+${role}\\b`, "i"));
    if (direct && ingredientNameMatches(direct[1].replace(/^the\s+/i, "").replace(/,\s*$/, ""), requested)) return true;
    // Preserve this explicit taste contrast with its immediately following sugar
    // addition, including its negation. Other adjacent rationales need verification.
    return canonicalIngredient(requested) === "sugar"
      && /^you do not want the sauce to be sweet, just not sour$/i.test(sentence)
      && Boolean(sentences[index + 1] && addsIngredient(sentences[index + 1], requested));
  });
}

/** Quote original amounts and explicit ingredient roles without model arithmetic or inference. */
export function originalIngredientAnswer(recipe: Recipe, query: string, step?: { evidenceId: string; number: number; text: string } | null) {
  // This shortcut answers one request in full. Keep compound questions on the
  // evidence-verified path rather than dropping an earlier action or question.
  const request = query.trim().replace(/[?.!\s]+$/, "");
  if (/[,;?!]|\b(?:and|or|also|then|plus|but)\b/i.test(request)) return undefined;
  const quantity = query.trim().match(/^(?:please\s+)?how (?:much|many)\s+(.+?)\s+does\s+(?:(?:the|this)\s+)?(?:(?:original|source)\s+)?recipe\s+(?:use|need|require|call for)[?.!\s]*$/i)
    ?? query.trim().match(/^(?:please\s+)?how (?:much|many)\s+(.+?)(?:\s+(?:do|should)\s+(?:i|we)\s+(?:use|need|add))?[?.!\s]*$/i);
  const purpose = query.trim().match(/^(?:please\s+)?what (?:is|are)\s+(?:the\s+)?(.+?)\s+used for(?:\s+in\s+(?:this|the)\s+(?:recipe|step))?[?.!\s]*$/i)
    ?? query.trim().match(/^why\s+(?:(?:(?:do|should)\s+(?:i|we)|does\s+(?:the\s+)?(?:source|recipe)\s+(?:tell|instruct)\s+(?:me|us)\s+to)\s+)?(?:add|use)\s+(?:the\s+)?(.+?)[?.!\s]*$/i)
    ?? query.trim().match(/^why\s+(?:is|are)\s+(?:the\s+)?(.+?)\s+(?:added|used)[?.!\s]*$/i);
  const requested = (quantity?.[1] ?? purpose?.[1])?.toLowerCase().trim();
  if (!requested || !/^[a-z][a-z -]*$/.test(requested)) return undefined;
  const matches = recipe.ingredients.map((ingredient, index) => ({ ingredient, index }))
    .filter(({ ingredient }) => ingredientNameMatches(ingredient.name, requested));
  if (quantity && !matches.length && DIFFERENT_FOODS[requested] && !sourceMaySpecifyAmount(recipe, requested)) {
    const mention = new RegExp(`\\b${escapePattern(requested)}\\b`, "i");
    const mentioned = recipe.ingredients.map((ingredient, index) => ({ ingredient, index }))
      .filter(({ ingredient }) => mention.test(ingredient.name));
    if (mentioned.length === 1 && DIFFERENT_FOODS[requested].test(canonicalIngredient(mentioned[0].ingredient.name))) {
      const { ingredient, index } = mentioned[0];
      return {
        answer: `The source ingredient list specifies ${[ingredient.measure, ingredient.name].filter(Boolean).join(" ")}. It does not give a separate amount of ${requested}.`,
        answerStatus: "unsupported" as const, evidenceId: `I${index + 1}`,
      };
    }
  }
  if (matches.length !== 1) return undefined;
  const { ingredient, index } = matches[0];
  if (quantity && !ingredient.measure.trim()) {
    // A blank ingredient-list measure does not establish absence everywhere in
    // the source. Let directions or notes with a possible amount be verified.
    if (sourceMaySpecifyAmount(recipe, requested)) return undefined;
    return { answer: `The source ingredient list does not specify an amount for ${ingredient.name}.`, answerStatus: "unsupported" as const, evidenceId: `I${index + 1}` };
  }
  if (quantity) return {
    answer: `Original recipe ingredient: ${[ingredient.measure, ingredient.name].filter(Boolean).join(" ")}.`,
    answerStatus: "answered" as const, evidenceId: `I${index + 1}`,
  };
  const candidates = step ? [step] : recipe.instructions.map((text, index) => ({ evidenceId: `S${index + 1}`, number: index + 1, text }));
  const explicit = candidates.filter(item => explicitIngredientRole(item.text, requested));
  if (explicit.length === 1) {
    const source = explicit[0];
    return { answer: `Source step ${source.number}: ${source.text}`, answerStatus: "answered" as const, evidenceId: source.evidenceId };
  }
  return undefined;
}

/** Answer only a saved amount plus one unambiguous source addition, with both bases exposed. */
export function planningIngredientStepAnswer(meal: PlannedMeal, recipe: Recipe, query: string) {
  if (meal.recipeId !== recipe.id || /\b(?:original|source)\b/i.test(query)) return undefined;
  const compound = query.trim().match(/^(how (?:much|many)\s+.+?)(?:,\s*(?:and\s+)?|\s+and\s+|\?\s*)when\s+(?:do|should)\s+(?:i|we)\s+add\s+(.+?)[?.!\s]*$/i);
  if (!compound || !isPlanningQuantityQuestion(compound[1])) return undefined;
  const quantity = planningQuantityAnswer(meal, compound[1]);
  if (quantity.answerStatus !== "answered" || quantity.planningFacts.length !== 1) return undefined;
  const fact = quantity.planningFacts[0], requested = compound[2].replace(/^the\s+/i, "").trim();
  if (requested.toLowerCase() !== "it" && canonicalIngredient(requested) !== canonicalIngredient(fact.name)) return undefined;
  const ingredient = recipe.ingredients[fact.ingredientIndex];
  // A different/reordered planning ingredient cannot borrow a source ingredient
  // ID or instructions just because a saved amount occupies the same index.
  if (!ingredient || canonicalIngredient(ingredient.name) !== canonicalIngredient(fact.name)
    || recipe.ingredients.filter(row => canonicalIngredient(row.name) === canonicalIngredient(fact.name)).length !== 1) return undefined;
  const steps = recipe.instructions.map((text, index) => ({ evidenceId: `S${index + 1}`, number: index + 1, text }))
    .filter(item => addsIngredient(item.text, canonicalIngredient(fact.name)));
  if (steps.length !== 1) return undefined;
  return { ...quantity, answerStatus: "answered" as const, answer: `${quantity.answer} Source step ${steps[0].number}: ${steps[0].text}`, sourceStep: steps[0] };
}
