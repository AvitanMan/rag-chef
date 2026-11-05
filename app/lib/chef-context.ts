import type { Recipe } from "./recipe-types";
import type { PlannedMeal } from "./kitchen-types";
import type { ChefDinnerContext } from "./chef-schema";
import { cookingStepText } from "./recipe-instructions";

export type CookingTechniqueGuide = { term: string; explanation: string; sourceName: string; sourceUrl: string; licenseUrl: string };

/** Reviewed technique definitions, separate from any recipe's facts or timings. */
const COOKING_TECHNIQUES = [
  { pattern: /\bboil(?:ing|ed)?\b/i, term: "Boiling", explanation: "Boiling means cooking food in boiling water, with large bubbles rising and breaking continuously at the surface.", sourceUrl: "https://en.wikibooks.org/wiki/Cookbook:Boiling" },
  { pattern: /\bsimmer(?:ing|ed)?\b/i, term: "Simmering", explanation: "Simmering cooks food in liquid below a boil. The liquid moves gently rather than rapidly.", sourceUrl: "https://en.wikibooks.org/wiki/Cookbook:Simmering" },
];

export function focusedCookingStep(recipe: Recipe, query: string, currentStepId?: string) {
  const requested = query.match(/\b(?:step|direction|instruction)\s*#?\s*(\d{1,3})\b/i);
  const evidenceId = requested ? `S${Number(requested[1])}` : currentStepId;
  const index = evidenceId && /^S[1-9]\d{0,2}$/.test(evidenceId) ? Number(evidenceId.slice(1)) - 1 : -1;
  const text = recipe.instructions[index];
  return text ? { evidenceId: evidenceId!, number: index + 1, text } : null;
}

export function cookingTechniqueGuides(stepText: string, query: string): CookingTechniqueGuide[] {
  if (!/\b(?:explain|mean|meaning|how do|how should|how to|what is|what does|what should|help)\b/i.test(query)) return [];
  const namedTerm = query.match(/\b(?:what (?:does|is)|explain)\s+(boil(?:ing)?|simmer(?:ing)?)\b/i)?.[1];
  return COOKING_TECHNIQUES.filter(guide => guide.pattern.test(stepText) && (!namedTerm || guide.pattern.test(namedTerm))).map(({ term, explanation, sourceUrl }) => ({ term, explanation, sourceUrl,
    sourceName: "Wikibooks Cookbook", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/" }));
}

/** Only standalone meaning requests; compound or recipe-specific questions still use Chef. */
export function isCookingMeaningQuestion(query: string): boolean {
  return /^(?:please\s+)?(?:what does (?:this|the|this source|the current) (?:step|instruction|direction) mean|what does (?:boil(?:ing)?|simmer(?:ing)?) mean|explain (?:this|the|the current) (?:source )?(?:step|instruction|direction)|what does this mean)(?:\s+(?:in plain english|in simple terms|simply))?[?.!\s]*$/i.test(query.trim());
}

/** Preserve every source action and restriction before adding term definitions. */
export function focusedCookingMeaningAnswer(step: ReturnType<typeof focusedCookingStep>, query: string, guides: CookingTechniqueGuide[]): string | undefined {
  if (!step || !guides.length || !isCookingMeaningQuestion(query)) return undefined;
  const source = `Source step ${step.number}: ${step.text}`;
  const asksTerm = /^(?:please\s+)?what does (?:boil(?:ing)?|simmer(?:ing)?) mean[?.!\s]*$/i.test(query.trim());
  // A general explanation must never turn a prohibited action into advice.
  // Quoting the complete step also preserves alternatives and conditional bans.
  if (!asksTerm && /\b(?:not|never|without|avoid|don['’]t|doesn['’]t|mustn['’]t|shouldn['’]t)\b/i.test(step.text)) {
    const avoidsBoiling = /\b(?:do not|must not|should not|don['’]t|never|without|avoid)\s+boil(?:ing)?\b(?!\s+(?:over|dry))|\bnot to boiling\b|\bnot\s+(?:to\s+)?(?:let|allow)\b[^.;!?]{0,70}\bboil\b(?!\s+(?:over|dry))/i.test(step.text);
    const boiling = guides.find(guide => guide.term === "Boiling");
    if (avoidsBoiling && boiling) return `${source}\n\nThis step says to avoid boiling. The term reference describes that state: ${boiling.explanation}`;
    return source;
  }
  return `${source}\n\nTerm reference only; follow the source instruction above:\n${guides.map(guide => guide.explanation).join("\n\n")}`;
}

/** Preview explicit planning changes without changing stored amounts or cooking. */
export function chefMealPreview(meal: PlannedMeal, context: ChefDinnerContext): PlannedMeal {
  if (context.purpose === "cooking") return meal;
  return { ...meal, date: context.targetDate ?? meal.date,
    ...(meal.baseServings && context.servings !== undefined ? { servings: context.servings } : {}),
    ...(!meal.baseServings && context.batches !== undefined ? { batches: context.batches } : {}),
  };
}

/** Private HTTP LAN origins lack SubtleCrypto; preserve the exact SHA-256 fingerprint. */
async function contextHash(text: string): Promise<string> {
  const input = new TextEncoder().encode(text);
  const bytes = globalThis.crypto?.subtle
    ? new Uint8Array(await crypto.subtle.digest("SHA-256", input))
    : (await import("@noble/hashes/sha2.js")).sha256(input);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function chefRecipeHash(recipe: Recipe): Promise<string> {
  const text = JSON.stringify([recipe.id, recipe.title, recipe.ingredients, recipe.instructions, recipe.servings ?? null, recipe.sourceUrl, ...(recipe.sourceNotes?.length ? [recipe.sourceNotes] : [])]);
  return contextHash(text);
}

export function recipeEvidence(recipe: Recipe) {
  return [...recipe.ingredients.map((item, i) => ({ evidenceId: `I${i + 1}`, text: [item.measure, item.name].filter(Boolean).join(" ") })),
    ...recipe.instructions.map((text, i) => ({ evidenceId: `S${i + 1}`, text })),
    ...(recipe.sourceNotes ?? []).map((text, i) => ({ evidenceId: `N${i + 1}`, text }))];
}

/** Keep original IDs and whole source steps. Missing context is explicit. */
export function selectQuestionEvidence(recipe: Recipe, query: string, stepId?: string) {
  const all = recipeEvidence(recipe);
  if (!stepId && (all.length <= 12 || /\b(?:full|complete|all)\s+(?:directions|instructions|method)|\bhow\b.*\b(?:make|cook|prepare)\b/i.test(query))) return all;
  const forms: Record<string, string> = { baking: "bake", baked: "bake", boiling: "boil", boiled: "boil", frying: "fry", fried: "fry", simmering: "simmer", simmered: "simmer", melting: "melt", melted: "melt", mixing: "mix", mixed: "mix", draining: "drain", drained: "drain", cooling: "cool", cooled: "cool", stirring: "stir", stirred: "stir" };
  const words = (text: string) => (text.toLowerCase().match(/[a-z]{3,}/g) ?? []).map((word) => forms[word] ?? word);
  const stopWords = new Set("what which does this that with recipe source step steps direction directions instruction instructions method please explain mentions how long much time should would could can the and for are was were have has from into say says tell me about".split(" "));
  const terms = new Set(words(query).filter((term) => !stopWords.has(term)));
  const selected = new Set(recipe.ingredients.map((_, index) => `I${index + 1}`));
  const current = stepId ? Number(stepId.slice(1)) - 1 : -1;
  const addStep = (index: number) => {
    for (const nearby of [index - 1, index, index + 1]) if (recipe.instructions[nearby]) selected.add(`S${nearby + 1}`);
  };
  if (current >= 0) addStep(current);
  const requestedStep = query.match(/\b(?:step|direction|instruction)\s*#?\s*(\d{1,3})\b/i);
  if (requestedStep && recipe.instructions[Number(requestedStep[1]) - 1]) addStep(Number(requestedStep[1]) - 1);
  const timing = /\b(?:how long|how much time|duration|timing|minutes?|hours?|seconds?)\b/i.test(query);
  const temperature = /\b(?:temperature|degrees?|what heat|how hot|oven setting|preheat)\b/i.test(query);
  const doneness = /\b(?:done|doneness|ready|finished|tender|cooked through)\b/i.test(query);
  const scored = recipe.instructions.map((text, index) => ({ index, score: [...terms].filter((term) => words(text).includes(term)).length
    + (timing && /\b(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|overnight)\b/i.test(text) ? 3 : 0)
    + (temperature && /\b(?:preheat|temperature|degrees?)\b|°\s*[cf]\b|\b\d+\s*[cf]\b|\bgas mark\b/i.test(text) ? 3 : 0)
    + (doneness && /\b(?:until|golden|tender|crisp|browned|set|cooked through)\b/i.test(text) ? 2 : 0) }));
  for (const item of scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 6)) {
    addStep(item.index);
  }
  // A weak match is not evidence that the source lacks an answer. Fall back to
  // the complete method when it fits; keep large methods explicitly partial.
  if (selected.size === recipe.ingredients.length) {
    if (all.reduce((size, item) => size + item.text.length, 0) <= 16_000) return all;
    for (const index of [0, 1, 2, recipe.instructions.length - 2, recipe.instructions.length - 1]) addStep(index);
  }
  return all.filter((item) => selected.has(item.evidenceId) || item.evidenceId.startsWith("N"));
}

function matchingCookingSteps(source: string[], instructions: string[], step: number): number[] {
  const n = instructions.length, m = source.length;
  const prefix = Array.from({ length: n + 1 }, () => Array<boolean>(m + 1).fill(false));
  const suffix = Array.from({ length: n + 1 }, () => Array<boolean>(m + 1).fill(false));
  prefix[0].fill(true); suffix[n].fill(true);
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) prefix[i][j] = prefix[i][j - 1] || instructions[i - 1] === source[j - 1] && prefix[i - 1][j - 1];
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) suffix[i][j] = suffix[i][j + 1] || instructions[i] === source[j] && suffix[i + 1][j + 1];
  return source.flatMap((text, index) => text === instructions[step] && prefix[step][index] && suffix[step + 1][index + 1] ? [index] : []);
}

/** Prefer exact evidence; older/display-only numbering may match only uniquely. */
export function cookingSourceStep(recipe: Recipe, instructions: string[], step: number): string | undefined {
  if (step < 0 || step >= instructions.length) return undefined;
  const exact = matchingCookingSteps(recipe.instructions, instructions, step);
  const matches = exact.length ? exact : matchingCookingSteps(recipe.instructions.map(cookingStepText), instructions.map(cookingStepText), step);
  return matches.length === 1 ? `S${matches[0] + 1}` : undefined;
}

export async function chefMealHash(meal: import("./kitchen-types").PlannedMeal): Promise<string> {
  const text = JSON.stringify([meal.id, meal.recipeId, meal.recipe, meal.planningIngredients ?? null, meal.personalAmountIndices ?? null, meal.baseServings, meal.servings, meal.batches, meal.ingredientOverrides]);
  return contextHash(text);
}
