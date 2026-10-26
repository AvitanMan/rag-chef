import type { ChefStructuredAnswer } from "./chef-schema";
import type { Recipe, RecipeMetadata, RecipeMetadataMap } from "./recipe-types";

type Detail = { kind: string; minimum: number; maximum: number };
type SourceContext = { recipeId: string; evidence: Array<{ evidenceId: string; text: string }> };
export type ChefGroundingIssue = "unsupported_detail" | "unsupported_total_time" | "unlabeled_time_estimate";

const NUMBER = "[-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const RANGE = `(${NUMBER})(?:\\s*(?:–|—|-|to)\\s*(${NUMBER}))?`;
const TIME_UNIT = "(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)";
const WORD_NUMBERS: Record<string, number> = Object.fromEntries("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ").map((word, value) => [word, value]));
Object.assign(WORD_NUMBERS, { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 });
const ONES = "one|two|three|four|five|six|seven|eight|nine";
const UNDER_HUNDRED = `(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[ -](?:${ONES}))?|${Object.keys(WORD_NUMBERS).join("|")})`;
const NUTRIENT = "(?:protein|carbohydrates?|carbs?|fat|fibre|fiber|sodium|sugar)";

function normalized(text: string): string {
  return text.replace(/[½¼¾]/g, (fraction) => ` ${{ "½": "1/2", "¼": "1/4", "¾": "3/4" }[fraction]}`).normalize("NFKC").replaceAll("⁄", "/").toLowerCase()
    .replace(/\b(?:(\d+)\s+)?(\d+)\s*\/\s*([1-9]\d*)\b/g, (_, whole, numerator, denominator) => String(Number(whole ?? 0) + Number(numerator) / Number(denominator)))
    .replace(/\bhalf (?:an? )?hour\b/g, "0.5 hours").replace(/\b(?:a )?quarter (?:of an? )?hour\b/g, "0.25 hours")
    .replace(/\ban hour\b/g, "1 hour").replace(new RegExp(`\\b(?:(?:${ONES}) hundred(?:[ -](?:and[ -])?${UNDER_HUNDRED})?|${UNDER_HUNDRED})\\b`, "g"), (phrase) =>
    String(phrase.split(/[ -]+/).reduce((value, word) => word === "hundred" ? value * 100 : value + (WORD_NUMBERS[word] ?? 0), 0)));
}

/** These narrow checks compare explicit details, not general semantic entailment. */
function details(text: string): Detail[] {
  const input = normalized(text);
  const result: Detail[] = [];
  const add = (kind: string, low: string, high: string | undefined, convert = (value: number) => value) => {
    const minimum = convert(Number(low)), maximum = convert(Number(high ?? low));
    result.push({ kind, minimum: Math.min(minimum, maximum), maximum: Math.max(minimum, maximum) });
  };
  for (const match of input.matchAll(new RegExp(`(?<![\\w.])${RANGE}[\\s-]*(${TIME_UNIT})\\b`, "g"))) {
    const factor = /^h/.test(match[3]) ? 3600 : /^m/.test(match[3]) ? 60 : 1;
    add("duration", match[1], match[2], (value) => value * factor);
  }
  for (const match of input.matchAll(new RegExp(`(?<![\\w.])${RANGE}\\s*(?:°\\s*|degrees?\\s*)?(celsius|fahrenheit|c|f)\\b`, "g"))) {
    add("temperature", match[1], match[2], /^f/.test(match[3]) ? (value) => (value - 32) * 5 / 9 : undefined);
  }
  for (const match of input.matchAll(new RegExp(`\\bgas\\s+mark\\s+${RANGE}\\b`, "g"))) add("gas_mark", match[1], match[2]);
  for (const match of input.matchAll(new RegExp(`(?<![\\w.])${RANGE}\\s*(?:kcal|calories?)\\b`, "g"))) add("nutrition:energy", match[1], match[2]);
  for (const match of input.matchAll(new RegExp(`\\bcalories?\\s*[:=]?\\s*${RANGE}\\b`, "g"))) add("nutrition:energy", match[1], match[2]);
  for (const match of input.matchAll(new RegExp(`(?<![\\w.])${RANGE}\\s*(mg|g|grams?|milligrams?)\\s+(?:of\\s+)?(${NUTRIENT})(?!\\s+powder)\\b`, "g"))) {
    add(`nutrition:${nutrientName(match[4])}`, match[1], match[2], /^m/.test(match[3]) ? (value) => value / 1000 : undefined);
  }
  for (const match of input.matchAll(new RegExp(`\\b(${NUTRIENT})\\b\\s*[:=]?\\s*${RANGE}\\s*(mg|g|grams?|milligrams?)\\b`, "g"))) {
    add(`nutrition:${nutrientName(match[1])}`, match[2], match[3], /^m/.test(match[4]) ? (value) => value / 1000 : undefined);
  }
  return result;
}

function nutrientName(name: string): string {
  return /^carb/.test(name) ? "carbohydrate" : name === "fiber" ? "fibre" : name;
}

function supported(detail: Detail, sources: Detail[]): boolean {
  return sources.some((source) => {
    const tolerance = 1e-6 * Math.max(1, Math.abs(source.minimum), Math.abs(source.maximum));
    return source.kind === detail.kind && detail.minimum >= source.minimum - tolerance && detail.maximum <= source.maximum + tolerance;
  });
}

function claimsTotalTime(text: string, cookingStep: boolean): boolean {
  const value = normalized(text);
  return /\b(?:total|overall|altogether|start[ -]to[ -]finish|ready in)\b/.test(value)
    || !cookingStep && /\b(?:(?:this |the )?(?:recipe|dish|dinner)|it)\s+takes?\b/.test(value);
}

function sourceClaimsTotalTime(text: string): boolean {
  const value = normalized(text);
  // Source steps often use "it" or "ready" for a component. Only an explicit
  // recipe-level statement or total-time label establishes a recipe duration.
  return /^(?:(?:the|this)\s+)?(?:(?:recipe|dish|dinner)\s+)?(?:total|overall)\s+(?:(?:recipe|cooking|cook|preparation|prep)\s+)?(?:time|duration)\b/.test(value.trim())
    || /\b(?:recipe|dish|dinner)\s+(?:takes?|(?:is|will be) ready in)\b/.test(value)
    || /\b(?:recipe|dish|dinner)\b.*\b(?:start[ -]to[ -]finish|altogether)\b/.test(value);
}

function totalTimeDetails(text: string, cookingStep: boolean, source = false): Detail[] {
  return text.split(/[.!?;](?:\s+|$)/).flatMap((sentence) => {
    // A statement of uncertainty must not be read as a claimed total duration.
    if (/\b(?:unknown|unspecified|not (?:given|provided|stated|established|specified|specify|provide|state|give|include|a total)|no total|doesn't (?:state|provide|specify|give|include))\b/i.test(sentence)) return [];
    return (source ? sourceClaimsTotalTime(sentence) : claimsTotalTime(sentence, cookingStep)) ? details(sentence).filter((detail) => detail.kind === "duration") : [];
  });
}

/** Missing whole-recipe duration is a source gap, never a sum of step times. */
export function lacksRequestedTotalTime(query: string, recipe: Recipe, metadata?: RecipeMetadata): boolean {
  const asksTotal = /\b(?:total|overall)\s+(?:(?:recipe|cooking|cook|preparation|prep)\s+)?(?:time|duration)\b|\bstart[ -]to[ -]finish\b/i.test(query)
    || /\bhow long\b.*\boverall\b/i.test(query);
  return asksTotal && metadata?.totalMinutes == null && !recipe.instructions.some((text) => totalTimeDetails(text, false, true).length > 0);
}

/** Validate only source claims. Explicit advisory changes stay separate. */
export function chefGroundingIssue(answer: ChefStructuredAnswer, sources: SourceContext[], metadata: RecipeMetadataMap, options: { cookingStep: boolean }): ChefGroundingIssue | null {
  const contexts = new Map(sources.map((source) => [source.recipeId, source]));
  const cited = answer.sourceFacts.map((fact) => fact.fact);
  const metadataTexts = (recipeIds: string[]) => recipeIds.flatMap((id) => metadata[id]?.totalMinutes != null ? [`Total time: ${metadata[id].totalMinutes} minutes.`] : []);
  const check = (text: string, support: string[], recipeIds: string[]): ChefGroundingIssue | null => {
    const metadataEvidence = metadataTexts(recipeIds);
    const totals = totalTimeDetails(text, options.cookingStep);
    // A reviewed total cannot be reused as an invented duration for one step.
    const available = [...support.flatMap(details), ...metadataEvidence.flatMap(details).filter((detail) => totals.some((total) => supported(total, [detail])))];
    if (details(text).some((detail) => !supported(detail, available))) return "unsupported_detail";
    const totalEvidence = [...support.flatMap((source) => totalTimeDetails(source, false, true)), ...metadataEvidence.flatMap(details)];
    if (totals.some((detail) => !supported(detail, totalEvidence))) return "unsupported_total_time";
    const usesEstimate = totals.some((detail) => recipeIds.some((id) => {
      const entry = metadata[id];
      return entry?.totalMinutes != null && entry.provenance.totalMinutes?.basis === "curator_estimate"
        && supported(detail, details(`Total time: ${entry.totalMinutes} minutes.`))
        && !support.some((source) => supported(detail, totalTimeDetails(source, false, true)));
    }));
    if (usesEstimate && !/\b(?:estimated?|approximately|about|around)\b/i.test(text)) return "unlabeled_time_estimate";
    return null;
  };
  // Advice can contain newly proposed times/temperatures in chefChanges. The
  // factual answer itself must still be supported, including during adaptations.
  const answerIssue = check(answer.answer, cited, [...new Set(answer.sourceFacts.map((fact) => fact.recipeId))]);
  if (answerIssue) return answerIssue;
  for (const recommendation of answer.recommendations) {
    const evidence = contexts.get(recommendation.recipeId)?.evidence.map((item) => item.text) ?? [];
    const issue = check(recommendation.reason, evidence, [recommendation.recipeId]);
    if (issue) return issue;
  }
  return null;
}
