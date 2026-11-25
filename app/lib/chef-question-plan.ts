import { cookingStepText } from "./recipe-instructions";
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

type SourceStep = { evidenceId: string; number: number; text: string };
type StepFact = { answer: string; answerStatus: "answered" | "unsupported"; missingCue?: boolean };

/** Only extract details attached to one affirmative instruction. More complex
 * grammar stays on the verified evidence path rather than guessing a duration. */
export function focusedCookingFact(step: SourceStep, query: string): StepFact | undefined {
  const text = cookingStepText(step.text);
  const q = query.toLowerCase().trim().replaceAll("’", "'").replace(/^please\s+/, "").replace(/[?.!\s]+$/, "")
    .replace(/\b(?:step|direction|instruction)\s*#?\s*\d+\b/g, "this step");
  if (/^(?:what (?:do|should) (?:i|we) do(?: (?:now|here|in this step))?|what (?:is this step|does this step say(?: to do)?))$/.test(q)) {
    return { answer: text, answerStatus: "answered" };
  }
  const confirmation = q.match(/^(?:do|should|must|can) (?:i|we) ([a-z]+) (.+)$/);
  if (confirmation && text.toLowerCase().split(/[.!?;]/).some(sentence =>
    ["do not", "don't", "don’t", "never"].some(prefix => sentence.trim() === `${prefix} ${confirmation[1]} ${confirmation[2]}`))) {
    return { answer: text, answerStatus: "answered" };
  }
  const stepTime = /^(?:how long(?: (?:does|should|will) (?:this step|this|it) take)?|(?:how much time|what duration) (?:for|does) this step(?: take)?)$/.test(q);
  const timeAction = stepTime ? null : q.match(/^how long (?:do|should|must) (?:i|we) ([a-z]+)(?: (.+?))?$/)
    ?? q.match(/^how long (?:does|should|will) (?:it|this|(?:this|the) (?:dish|recipe)) ([a-z]+)$/);
  const time = Boolean(timeAction) || stepTime;
  const namedCue = q.match(/^how (?:do|can|should) (?:i|we) (?:know|tell) (?:when|if|whether|that) (the [a-z -]+?) (?:is|are) (?:ready|done|cooked|finished)$/);
  const cue = Boolean(namedCue) || /^(?:how (?:do|can|should) (?:i|we) (?:know|tell)(?: (?:when|if|whether|that))? (?:it(?:'s| is)?|they(?:'re| are)?|this(?: step)?(?: is)?) (?:ready|done|cooked|finished)|what (?:should (?:it|this) look like|(?:is|are) the (?:doneness |visual )?cues?))$/.test(q);
  const heat = /^(?:what (?:heat|temperature|oven setting)(?: (?:do|should) (?:i|we) use)?(?: (?:for|in) this step)?|how hot should the oven be)$/.test(q);
  if (!time && !cue && !heat) return undefined;

  // An action beginning after "if", "while", "never", etc. cannot supply
  // the requested fact. Never split conditionals or alternatives into advice.
  if (/\b(?:if|unless|otherwise|while|before|after|or|but|instead|except|however|whereas|meanwhile|not|never|without|avoid|cannot|rather than)\b|n['’]t\b/i.test(text)) return undefined;
  const clauses = text.trim().replace(/[.!?]+$/, "").split(/[.;!?]\s*|,?\s+(?:and\s+)?then\s+/i);
  const matches = clauses.filter(clause => {
    if (!timeAction) return true;
    const [verb] = clause.toLowerCase().split(/\W+/);
    if (verb !== timeAction[1]) return false;
    const object = timeAction[2];
    return !object || /^(?:it|this|them|the dish|the recipe)$/.test(object)
      || /^the [\w -]+$/.test(object) && clause.toLowerCase().startsWith(`${verb} ${object} `);
  });
  if (matches.length !== 1) return undefined;
  const clause = matches[0].trim();
  // This small grammar is sufficient for unambiguous actions. A coordinated
  // instruction might time only its final action, even inside a single clause.
  if (!/^(?:bake|simmer|boil|roast|cook|sauté|saute|fry|stir|steam|rest|let|leave|chill|cool|grill|broil|heat|warm|preheat|toast|whisk|mix|knead)\b/i.test(clause)
    || /\band\b|,(?!\s*until\b)|[()]/i.test(clause)) return undefined;
  const instruction = `${clause}.`;
  const [action, endpoint, additionalEndpoint] = clause.split(/\buntil\b/i);
  if (additionalEndpoint !== undefined || /\bto\s+[a-z]|\b(?:followed by|subsequently|next|continue|[a-z]+ing)\b/i.test(action)) return undefined;
  if (namedCue) {
    const subject = namedCue[1];
    const object = action.toLowerCase().replace(/^\S+\s*/, "").replace(/\s+for\s+.*$/, "").replace(/[,\s]+$/, "");
    if (object !== subject) return undefined;
    if (endpoint && /^\s*(?:the|a|an)\s/i.test(endpoint) && !endpoint.trimStart().toLowerCase().startsWith(`${subject} `)) return undefined;
  }
  if (time) {
    const duration = action.match(/\bfor\s+((?:(?:about|around|approximately|at least|up to)\s+)?\d+(?:\s*(?:[-–]|to)\s*\d+)?\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?))\s*,?\s*$/i)?.[1];
    if (duration) {
      // A stated heat setting, lid position, or named attachment qualifies the
      // timing. Preserve the complete clause instead of dropping that condition.
      if (/\b(?:at|on|over|under|with|covered|uncovered|only|gently|slowly|vigorously)\b/i.test(action)) return { answer: instruction, answerStatus: "answered" };
      const verb = action.split(/\s+/)[0];
      const lead = /^(?:let|leave)$/i.test(verb) ? "For" : `${verb} for`;
      return { answer: `${lead} ${duration}${endpoint ? `, until ${endpoint.trim()}` : ""}.`, answerStatus: "answered" };
    }
    if (/\b(?:for|seconds?|secs?|minutes?|mins?|hours?|hrs?|overnight|briefly|moments?|days?|hourly)\b|\d/i.test(clause)) return undefined;
    return { answer: `This step does not specify a duration for this action. ${instruction}`, answerStatus: "unsupported" };
  }
  if (heat) {
    if (q.includes("oven") && !/\b(?:oven|bake|roast|broil|preheat)\b/i.test(clause)) return undefined;
    return /\b(?:low|medium(?:-high|-low)?|high) heat\b|\d\s*°\s*[CF]\b/i.test(clause) ? { answer: instruction, answerStatus: "answered" } : undefined;
  }
  if (endpoint && !/^(?:(?:it|they|the [\w -]+?)\s+(?:is|are)\s+)?(?:(?:just|fully|completely)\s+)?(?:done|ready|cooked(?: through)?)$/i.test(endpoint.trim())) {
    if (/\b(?:seconds?|minutes?|hours?)\b/i.test(endpoint)) return undefined;
    const answer = /\b(?:at least|at most|up to|no more than|no less than)\b/i.test(action) ? instruction : `Continue until ${endpoint.trim()}.`;
    return { answer, answerStatus: "answered" };
  }
  if (!/\buntil\b/i.test(clause) && /\b(?:brown|golden|crisp|tender|set|soft|dry|firm|absorb\w*)\b/i.test(clause)) return undefined;
  return { answer: `${instruction} This step does not specify a more detailed doneness cue.`, answerStatus: "unsupported", missingCue: true };
}

/** Resolve independent requests separately, preserving known facts alongside gaps. */
export function partialRecipeAnswer(recipe: Recipe, query: string, metadata?: RecipeMetadata, meal?: PlannedMeal, step?: { evidenceId: string; number: number; text: string } | null) {
  const requests = recipeQuestionParts(query);
  if (requests.length < 2) return undefined;
  const parts: Part[] = requests.map(part => {
    if (lacksRequestedNutrition(part, recipe)) return { query: part, answer: NUTRITION_GAP, evidenceIds: [], gap: true };
    if (lacksRequestedTotalTime(part, recipe, metadata)) return { query: part, answer: TIME_GAP, evidenceIds: [], gap: true };
    const stepFact = step && focusedCookingFact(step, part);
    if (stepFact && step) return { query: part, answer: stepFact.answer, evidenceIds: [step.evidenceId], gap: stepFact.answerStatus !== "answered" };
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
    if (!step && durationRequest) {
      const action = durationRequest[1] ?? durationRequest[2];
      // A duration must directly modify this positive action, not a later
      // rest, prerequisite, condition or prohibition in the same source step.
      const timedAction = new RegExp(`^${action}\\b(?:(?!\\b(?:and|then|while|before|after|until|not|never)\\b)[^.;!?])*?\\bfor\\s+(?:(?:about|around|approximately|roughly)\\s+)?[\\d¼½¾][^.;!?]{0,30}\\b(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)\\b`, "i");
      const matches = recipe.instructions.map((text, index) => ({ text, index })).filter(item => item.text.split(/[.;!?]/).some(clause => timedAction.test(clause.trim())));
      if (matches.length === 1) return { query: part, answer: `Source step ${matches[0].index + 1}: ${matches[0].text}`, evidenceIds: [`S${matches[0].index + 1}`], gap: false };
    }
    return { query: part, evidenceIds: [], gap: false };
  });
  const hasFocusedFact = step && parts.some(part => part.evidenceIds.includes(step.evidenceId));
  if (!parts.some(part => part.gap) && !hasFocusedFact && !(step && parts.every(part => part.answer !== undefined))) return undefined;
  return {
    parts,
    remainingQuery: parts.filter(part => part.answer === undefined).map(part => part.query).join("; "),
    answer: [...new Set(parts.map(part => part.answer).filter(Boolean))].join("\n\n"),
    evidenceIds: [...new Set(parts.flatMap(part => part.evidenceIds))],
    planningFacts: parts.flatMap(part => part.planningFacts ?? []),
    answerStatus: parts.some(part => part.answer && !part.gap) ? "answered" as const : "unsupported" as const,
  };
}
