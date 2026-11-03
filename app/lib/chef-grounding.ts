import type { ChefStructuredAnswer } from "./chef-schema";
import type { Recipe, RecipeMetadata, RecipeMetadataMap } from "./recipe-types";

type Detail = { kind: string; minimum: number; maximum: number };
type SourceEvidence = { recipeId?: string; evidenceId?: string; text: string };
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
function details(text: string, options: { ingredientAmounts?: boolean; ingredientLabels?: Detail[] } = {}): Detail[] {
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
  let nutritionSection = false;
  for (const statement of input.split(/(?<=[.!?;])\s+|\n/)) {
    // A heading applies to subsequent rows; a colon alone does not establish
    // whether sugar/fat is an ingredient quantity or a nutrient value.
    const heading = statement.replace(/^[\s#*_•-]+/, "");
    if (/^(?:nutrition(?:al)?|nutrients?|macros?|(?:per|each)[\s\u2010-\u2015-]+(?:serving|portion|100\s*g))\b/.test(heading)) nutritionSection = true;
    if (/^(?:(?:original|source|recipe)\s+)?ingredients?\b/.test(heading)) nutritionSection = false;
    // Ingredient directions and bare sugar/fat weights are not nutrient facts.
    const ingredientAction = /\b(?:add|adding|use|using|mix|mixing|stir|stirring|melt|melting|fry|frying|ingredient(?:s)?)\b/.test(statement);
    const nutritionContext = nutritionSection || options.ingredientAmounts || /\b(?:nutrition(?:al)?|nutrients?|provides?|per[\s\u2010-\u2015-]+(?:serving|portion|100\s*g)|each[\s\u2010-\u2015-]+(?:serving|portion))\b/.test(statement);
    const nutrientClaim = (name: string, label = false) => !ingredientAction && (label || !/^(?:sugar|fat)$/.test(name) || nutritionContext);
    for (const match of statement.matchAll(new RegExp(`(?<![\\w.])${RANGE}\\s*(mg|g|grams?|milligrams?)\\s+(?:of\\s+)?(${NUTRIENT})(?!\\s+powder)\\b`, "g"))) {
      if (nutrientClaim(match[4])) add(`nutrition:${nutrientName(match[4])}`, match[1], match[2], /^m/.test(match[3]) ? (value) => value / 1000 : undefined);
    }
    for (const match of statement.matchAll(new RegExp(`\\b(${NUTRIENT})\\b\\s*[:=]?\\s*${RANGE}\\s*(mg|g|grams?|milligrams?)\\b`, "g"))) {
      if (!nutritionContext && /^(?:sugar|fat)$/.test(match[1])
        && new RegExp(`^\\s*(?:[-*•]\\s*)?${match[1]}\\s*[:=]\\s*${RANGE}\\s*(?:mg|g|grams?|milligrams?)\\s*[.]?\\s*$`).test(statement)) {
        const factor = /^m/.test(match[4]) ? 0.001 : 1;
        const low = Number(match[2]) * factor, high = Number(match[3] ?? match[2]) * factor;
        // Only a matching, cited ingredient amount permits this ambiguous
        // label. Those amounts remain unavailable as nutrition evidence.
        if (supported({ kind: `nutrition:${nutrientName(match[1])}`, minimum: Math.min(low, high), maximum: Math.max(low, high) }, options.ingredientLabels ?? [])) continue;
      }
      if (nutrientClaim(match[1], /[:=]/.test(match[0]))) add(`nutrition:${nutrientName(match[1])}`, match[2], match[3], /^m/.test(match[4]) ? (value) => value / 1000 : undefined);
    }
  }
  return result;
}

function ingredientLabelDetails(source: SourceEvidence): Detail[] {
  if (!source.evidenceId?.startsWith("I")) return [];
  // Match a whole ingredient name, including ordinary sugar varieties. The
  // weight of sugar snap peas or fat-free yogurt is not sugar/fat weight.
  const text = normalized(source.text).trim().replace(/\b(?:granulated|white|brown|caster|powdered|icing|confectioners'?|light brown|dark brown) sugar\b/g, "sugar");
  const unit = "(?:mg|g|grams?|milligrams?)";
  const amount = new RegExp(`^(?:${RANGE}\\s*${unit}\\s+(?:sugar|fat)|(?:sugar|fat)\\s*[:=]\\s*${RANGE}\\s*${unit})[.]?$`);
  return amount.test(text) ? details(text, { ingredientAmounts: true }) : [];
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

function sourceClaimsTotalTime(text: string, sourceNote = false): boolean {
  const value = normalized(text);
  // Source steps often use "it" or "ready" for a component. Only an explicit
  // recipe-level statement establishes their total. An original recipe note
  // can also carry the source's plain Time label outside the directions.
  return sourceNote && /^time\s*[:=]/.test(value.trim())
    || /^(?:(?:the|this)\s+)?(?:(?:recipe|dish|dinner)\s+)?(?:total|overall)\s+(?:(?:recipe|cooking|cook|preparation|prep)\s+)?(?:time|duration)\b/.test(value.trim())
    || /\b(?:recipe|dish|dinner)\s+(?:takes?|(?:is|will be) ready in)\b/.test(value)
    || /\b(?:recipe|dish|dinner)\b.*\b(?:start[ -]to[ -]finish|altogether)\b/.test(value);
}

function totalTimeDetails(text: string, cookingStep: boolean, source = false, sourceNote = false): Detail[] {
  return text.split(/[.!?;](?:\s+|$)/).flatMap((sentence) => {
    // A statement of uncertainty must not be read as a claimed total duration.
    if (/\b(?:unknown|unspecified|not (?:given|provided|stated|established|specified|specify|provide|state|give|include|a total)|no total|doesn't (?:state|provide|specify|give|include))\b/i.test(sentence)) return [];
    return (source ? sourceClaimsTotalTime(sentence, sourceNote) : claimsTotalTime(sentence, cookingStep)) ? details(sentence).filter((detail) => detail.kind === "duration") : [];
  });
}

/** Missing whole-recipe duration is a source gap, never a sum of step times. */
export function lacksRequestedTotalTime(query: string, recipe: Recipe, metadata?: RecipeMetadata): boolean {
  const asksTotal = /\b(?:total|overall)\s+(?:(?:recipe|cooking|cook|preparation|prep)\s+)?(?:time|duration)\b|\bstart[ -]to[ -]finish\b/i.test(query)
    || /\bhow long\b.*\boverall\b/i.test(query)
    || /\bhow long (?:does|will|would) (?:(?:this|the) (?:recipe|dish|dinner|meal)|(?:the )?(?:first|second|third) (?:one|recipe|dish|suggestion|option)) take(?: to (?:make|cook|prepare))?[?!.\s]*$/i.test(query);
  if (!asksTotal) return false;
  // A complete review can reject an original Time label because it omits
  // prerequisites. Retaining that note must not undo the reviewed unknown.
  if (metadata) return metadata.totalMinutes === null;
  return !recipe.instructions.some(text => totalTimeDetails(text, false, true).length > 0)
    && !(recipe.sourceNotes ?? []).some(text => totalTimeDetails(text, false, true, true).length > 0);
}

/** Ingredient weights cannot establish an unstated calorie or nutrient value. */
export function lacksRequestedNutrition(query: string, recipe: Recipe): boolean {
  const requested: string[] = [];
  if (/\b(?:calories?|kcal)\b/i.test(query)) requested.push("nutrition:energy");
  const explicitNutrition = /\b(?:nutrition(?:al)?|nutrients?|macros?|content)\b/i.test(query);
  const nutritionScope = explicitNutrition || /\b(?:per (?:serving|portion|100\s*g)|(?:each|every) (?:serving|portion)|in (?:a|one) (?:serving|portion))\b/i.test(query);
  const ingredientIntent = /\b(?:used? for|purpose|role|why|add|use|need|mix|stir|melt|fry|put|ingredient|substitute|replace|omit)\b/i.test(query);
  if (nutritionScope || /\b(?:how (?:many|much)|what (?:is|are))\b/i.test(query)) {
    for (const match of query.toLowerCase().matchAll(new RegExp(`\\b(${NUTRIENT})\\b`, "g"))) {
      const ingredient = /^(?:sugar|fat)$/.test(match[1]) && recipe.ingredients.some(item => new RegExp(`\\b${match[1]}\\b`, "i").test(item.name));
      const proteinProduct = match[1] === "protein" && /^\s+powder\b/i.test(query.slice(match.index + match[0].length));
      if ((ingredientIntent || proteinProduct) && !explicitNutrition || !nutritionScope && ingredient) continue;
      requested.push(`nutrition:${nutrientName(match[1])}`);
    }
  }
  const established = [...(recipe.sourceNotes ?? []), ...recipe.instructions].flatMap(text => details(text)).filter(detail => detail.kind.startsWith("nutrition:"));
  if (!requested.length) return explicitNutrition && established.length === 0;
  return requested.some(kind => !established.some(detail => detail.kind === kind));
}

/** Validate only source claims. Explicit advisory changes stay separate. */
export function chefGroundingIssue(answer: ChefStructuredAnswer, sources: SourceContext[], metadata: RecipeMetadataMap, options: { cookingStep: boolean }): ChefGroundingIssue | null {
  const contexts = new Map(sources.map((source) => [source.recipeId, source]));
  const cited = answer.sourceFacts.map((fact) => ({ recipeId: fact.recipeId, evidenceId: fact.evidenceId, text: fact.fact }));
  const metadataTexts = (recipeIds: string[]) => recipeIds.flatMap((id) => {
    const entry = metadata[id];
    if (entry?.totalMinutes == null) return [];
    const summary = `Total time: ${entry.totalMinutes} minutes.`;
    const provenance = entry.provenance.totalMinutes;
    const sameText = (text: string) => normalized(text).replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
    const note = provenance?.basis === "source" && provenance.evidence
      ? contexts.get(id)?.evidence.find(item => /^N[1-9]\d{0,2}$/.test(item.evidenceId) && sameText(item.text) === sameText(provenance.evidence)) : undefined;
    // Preserve a reviewed source range instead of shrinking it to the stored
    // scalar. Only a matching original note can expand that scalar's support.
    return note && details(summary).every(detail => supported(detail, totalTimeDetails(note.text, false, true, true))) ? [summary, note.text] : [summary];
  });
  const check = (text: string, support: SourceEvidence[], recipeIds: string[]): ChefGroundingIssue | null => {
    const metadataEvidence = metadataTexts(recipeIds);
    const totals = totalTimeDetails(text, options.cookingStep);
    // A reviewed total cannot be reused as an invented duration for one step.
    const available = [...support.flatMap(source => details(source.text).filter(detail => !source.evidenceId?.startsWith("I") || !detail.kind.startsWith("nutrition:"))), ...metadataEvidence.flatMap(text => details(text)).filter((detail) => totals.some((total) => supported(total, [detail])))];
    const ingredientLabels = support.flatMap(ingredientLabelDetails);
    if (details(text, { ingredientLabels }).some((detail) => !supported(detail, available))) return "unsupported_detail";
    const totalEvidence = [...support.filter(source => !source.recipeId || metadata[source.recipeId]?.totalMinutes !== null)
      .flatMap((source) => totalTimeDetails(source.text, false, true, /^N[1-9]\d{0,2}$/.test(source.evidenceId ?? ""))), ...metadataEvidence.flatMap(text => details(text))];
    if (totals.some((detail) => !supported(detail, totalEvidence))) return "unsupported_total_time";
    const usesEstimate = totals.some((detail) => recipeIds.some((id) => {
      const entry = metadata[id];
      return entry?.totalMinutes != null && entry.provenance.totalMinutes?.basis === "curator_estimate"
        && supported(detail, details(`Total time: ${entry.totalMinutes} minutes.`))
        && !support.some((source) => supported(detail, totalTimeDetails(source.text, false, true, /^N[1-9]\d{0,2}$/.test(source.evidenceId ?? ""))));
    }));
    if (usesEstimate && !/\b(?:estimated?|approximately|about|around)\b/i.test(text)) return "unlabeled_time_estimate";
    return null;
  };
  // Advice can contain newly proposed times/temperatures in chefChanges. The
  // factual answer itself must still be supported, including during adaptations.
  const answerIssue = check(answer.answer, cited, [...new Set(answer.sourceFacts.map((fact) => fact.recipeId))]);
  if (answerIssue) return answerIssue;
  for (const warning of answer.warnings) {
    const issue = check(warning, cited, [...new Set(answer.sourceFacts.map((fact) => fact.recipeId))]);
    if (issue) return issue;
  }
  for (const recommendation of answer.recommendations) {
    const evidence = (contexts.get(recommendation.recipeId)?.evidence ?? []).map(item => ({ ...item, recipeId: recommendation.recipeId }));
    const issue = check(recommendation.reason, evidence, [recommendation.recipeId]);
    if (issue) return issue;
  }
  return null;
}
