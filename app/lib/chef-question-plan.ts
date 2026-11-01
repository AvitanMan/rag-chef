import type { Recipe, RecipeMetadata } from "./recipe-types";
import { lacksRequestedNutrition, lacksRequestedTotalTime } from "./chef-grounding";
import type { PlannedMeal } from "./kitchen-types";
import type { ChefPlanningFact } from "./chef-schema";
import { originalIngredientAnswer, isPlanningQuantityQuestion, planningQuantityAnswer } from "./chef-planning-answer";

export function recipeQuestionParts(query: string): string[] {
  const question = "(?:how|what|why|when|where|which|does|do|should|can|could|would|is|are|explain|list|show)";
  const separator = new RegExp(`(?:[;?]\\s*(?:and\\s+)?|,\\s*(?:and\\s+)?|\\band\\s+|\\balso\\s+)(?=${question}\\b)`, "i");
  const parts = query.split(separator).map(part => part.trim()).filter(Boolean);
  // A title/context prefix before the first question is not another request.
  if (parts.length > 1 && !new RegExp(`\\b${question}\\b`, "i").test(parts[0])) {
    parts.splice(0, 2, `${parts[0]}, ${parts[1]}`);
  }
  return parts.length <= 4 ? parts : [query];
}

const NUTRITION_GAP = "The approved recipe does not state the requested nutrition information; ingredient amounts do not establish nutrients per serving.";
const TIME_GAP = "The approved recipe does not establish a total start-to-finish time; durations in individual steps are not a complete recipe time.";

type Part = { query: string; answer?: string; evidenceIds: string[]; gap: boolean; planningFacts?: ChefPlanningFact[] };

/** Resolve independent requests separately, preserving known facts alongside gaps. */
export function partialRecipeAnswer(recipe: Recipe, query: string, metadata?: RecipeMetadata, meal?: PlannedMeal, step?: { evidenceId: string; number: number; text: string } | null) {
  const requests = recipeQuestionParts(query);
  if (requests.length < 2) return undefined;
  const parts: Part[] = requests.map(part => {
    if (lacksRequestedNutrition(part, recipe)) return { query: part, answer: NUTRITION_GAP, evidenceIds: [], gap: true };
    if (lacksRequestedTotalTime(part, recipe, metadata)) return { query: part, answer: TIME_GAP, evidenceIds: [], gap: true };
    if (meal && !/\b(?:original|source)\b/i.test(part) && isPlanningQuantityQuestion(part)) {
      const planned = planningQuantityAnswer(meal, part);
      if (planned.answerStatus === "answered") return { query: part, answer: planned.answer, evidenceIds: planned.planningFacts.map(fact => fact.sourceEvidenceId), gap: false, planningFacts: planned.planningFacts };
    }
    const original = !meal || /\b(?:original|source)\b/i.test(part) ? originalIngredientAnswer(recipe, part, step) : undefined;
    if (original) return { query: part, answer: original.answer, evidenceIds: [original.evidenceId], gap: original.answerStatus !== "answered" };
    // A uniquely identified source action can establish its own duration,
    // never an overall recipe time or a newly requested method.
    // Only a generic action request can use this shortcut. Named objects,
    // conditions and new methods must be checked, not matched by a shared verb.
    const durationRequest = part.match(/^(?:please\s+)?how long (?:(?:does|should|will) (?:it|this dish|this recipe|the dish|the recipe) (bake|simmer|boil|roast)|(?:do|should|must) (?:i|we) (bake|simmer|boil|roast) (?:it|this|the dish|the recipe))[?.!\s]*$/i);
    if (durationRequest) {
      const action = durationRequest[1] ?? durationRequest[2];
      // A duration must directly modify this positive action, not a later
      // rest, prerequisite, condition or prohibition in the same source step.
      const timedAction = new RegExp(`^${action}\\b(?:(?!\\b(?:and|then|while|before|after|until|not|never)\\b)[^.;!?])*?\\bfor\\s+(?:(?:about|around|approximately|roughly)\\s+)?[\\d¼½¾][^.;!?]{0,30}\\b(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)\\b`, "i");
      const matches = recipe.instructions.map((text, index) => ({ text, index })).filter(item => (!step || `S${item.index + 1}` === step.evidenceId) && item.text.split(/[.;!?]/).some(clause => timedAction.test(clause.trim())));
      if (matches.length === 1) return { query: part, answer: `Source step ${matches[0].index + 1}: ${matches[0].text}`, evidenceIds: [`S${matches[0].index + 1}`], gap: false };
    }
    return { query: part, evidenceIds: [], gap: false };
  });
  if (!parts.some(part => part.gap)) return undefined;
  return {
    parts,
    remainingQuery: parts.filter(part => part.answer === undefined).map(part => part.query).join("; "),
    answer: parts.map(part => part.answer).filter(Boolean).join("\n\n"),
    evidenceIds: [...new Set(parts.flatMap(part => part.evidenceIds))],
    planningFacts: parts.flatMap(part => part.planningFacts ?? []),
    answerStatus: parts.some(part => part.answer && !part.gap) ? "answered" as const : "unsupported" as const,
  };
}
