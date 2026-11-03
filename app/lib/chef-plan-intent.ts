import type { ChefPlanDraft, ChefPlanIntent, ChefPlanPriority } from "./chef-plan-types";
import type { Diet } from "./recipe-types";
import { addDateDays, weekStart } from "./kitchen-state";
import { recipeQueryIntent } from "./recipe-query";
import { normalizeEquipmentName } from "./recipe-constraints";
import { validatePlanIntent } from "./chef-plan";
import { DEFAULT_OLLAMA_CHAT_MODEL } from "./chef-schema";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const NUMBER = "(?:one|two|three|four|five|six|seven|eight|nine|ten|a couple of|a couple|a pair of|a pair|[0-9]+(?:\\.[0-9]+)?)";
const DIET_LABEL = "(?:vegan|vegetarian|meatless|meat[ -]free|gluten[ -]free|low[ -]carb)";
const number = (text: string) => ({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, "a couple": 2, "a couple of": 2, "a pair": 2, "a pair of": 2 } as Record<string, number>)[text] ?? Number(text);
const unique = <T,>(values: T[]) => [...new Set(values)];
const dietFor = (text: string): Diet | undefined => /\bvegan\b/.test(text) ? "vegan" : /\b(?:vegetarian|meatless|meat.free)\b/.test(text) ? "vegetarian" : /\bgluten.free\b/.test(text) ? "gluten_free" : /\blow.carb\b/.test(text) ? "low_carb" : undefined;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
// Keep independent requirements separate, including conjunctions after a scoped
// edit. A decimal batch amount is not a sentence boundary.
const planClauses = (text: string) => text.split(/[,!?;]|(?<!\d)\.|\.(?!\d)|\b(?:and|but)\s+(?=(?:do not|don't|never|make|set|keep|retain|preserve|replace|swap|change|avoid|exclude|omit|without|no|prioriti[sz]e|minimi[sz]e|reduce|prefer|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow)\b)/);
const portionMatch = (text: string) => text.match(new RegExp(`\\b(?:for|serve|serves|serving|feed|feeding)\\s+(${NUMBER})\\b(?![\\d.])(?!\\s+(?:(?:different|varied|vegetarian|vegan|meatless|gluten[ -]free|dairy[ -]free|low[ -]carb)\\s+)*(?:dinners?|meals?|nights?|minutes?|mins?|hours?|batches?)\\b)\\s*(?:people|persons?|servings?|portions?|adults?)?`))
  ?? text.match(new RegExp(`\\b(${NUMBER})\\s+(?:servings?|portions?|people)\\b`));

export class ChefPlanIntentError extends Error {
  constructor(message: string, public code = "invalid_plan_request", public status = 400) { super(message); }
}

export function defaultPlanIntent(week: string, today: string): ChefPlanIntent {
  return { week, today, count: 3, dates: [], servings: null, batches: null, excludedIngredients: [], diets: [], excludedEquipment: [], priority: "use_soon", allowRepeats: false, replaceDates: [], keepDates: [], perDate: {} };
}

export const CHEF_PLAN_INTENT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["count", "servings", "batches", "dates", "excludedIngredients", "diets", "excludedEquipment", "maxTotalMinutes", "priority", "allowRepeats", "evidence"],
  properties: {
    count: { type: ["integer", "null"], minimum: 1, maximum: 7 },
    servings: { type: ["integer", "null"], minimum: 1, maximum: 100 },
    batches: { type: ["number", "null"], minimum: 0.25, maximum: 20 },
    dates: { type: "array", maxItems: 7, items: { type: "string" } },
    excludedIngredients: { type: "array", maxItems: 30, items: { type: "string" } },
    diets: { type: "array", maxItems: 4, items: { type: "string", enum: ["vegan", "vegetarian", "gluten_free", "low_carb"] } },
    excludedEquipment: { type: "array", maxItems: 20, items: { type: "string" } },
    maxTotalMinutes: { type: ["integer", "null"], minimum: 1, maximum: 1440 },
    priority: { type: ["string", "null"], enum: ["use_soon", "fewer_groceries", "variety", null] },
    allowRepeats: { type: ["boolean", "null"] },
    evidence: { type: "object", additionalProperties: false, required: ["count", "servings", "batches", "excludedIngredients", "diets", "excludedEquipment", "maxTotalMinutes", "priority", "allowRepeats"], properties: Object.fromEntries(["count", "servings", "batches", "excludedIngredients", "diets", "excludedEquipment", "maxTotalMinutes", "priority", "allowRepeats"].map(field => [field, { type: "string", maxLength: 300 }])) },
  },
} as const;

/** The model boundary requires the complete schema; the deterministic resolver
 * deliberately also accepts partial inputs for preflight and manual parsing. */
function validateGeneratedPlanIntent(value: unknown): asserts value is Record<string, unknown> {
  const fail = () => { throw new ChefPlanIntentError("The local model returned an invalid interpretation. Use the planning controls or retry.", "invalid_interpretation", 502); };
  if (!record(value) || CHEF_PLAN_INTENT_SCHEMA.required.some(field => !Object.hasOwn(value, field)) || Object.keys(value).some(field => !Object.hasOwn(CHEF_PLAN_INTENT_SCHEMA.properties, field))) fail();
  const result = value as Record<string, unknown>;
  for (const [field, minimum, maximum, integer] of [["count", 1, 7, true], ["servings", 1, 100, true], ["batches", 0.25, 20, false], ["maxTotalMinutes", 1, 1440, true]] as const) {
    const amount = result[field];
    if (amount !== null && (typeof amount !== "number" || !Number.isFinite(amount) || amount < minimum || amount > maximum || integer && !Number.isInteger(amount))) fail();
  }
  for (const [field, maximum] of [["dates", 7], ["excludedIngredients", 30], ["diets", 4], ["excludedEquipment", 20]] as const) {
    const values = result[field];
    if (!Array.isArray(values) || values.length > maximum || !values.every(item => typeof item === "string" && item.length <= 120 && (field !== "diets" || ["vegan", "vegetarian", "gluten_free", "low_carb"].includes(item)))) fail();
  }
  if (result.priority !== null && (typeof result.priority !== "string" || !["use_soon", "fewer_groceries", "variety"].includes(result.priority))) fail();
  if (result.allowRepeats !== null && typeof result.allowRepeats !== "boolean") fail();
  const evidence = result.evidence;
  const evidenceFields: readonly string[] = CHEF_PLAN_INTENT_SCHEMA.properties.evidence.required;
  if (!record(evidence) || evidenceFields.some(field => typeof evidence[field] !== "string" || (evidence[field] as string).length > 300) || Object.keys(evidence).some(field => !evidenceFields.includes(field))) fail();
}

/** Explicit English values and saved draft requirements are authoritative over model slots. */
export function resolveChefPlanIntent(query: string, base: ChefPlanIntent, generated: unknown = {}): { intent?: ChefPlanIntent; clarification?: string } {
  if (!record(generated) || Object.keys(generated).some(key => !(key in CHEF_PLAN_INTENT_SCHEMA.properties))) throw new ChefPlanIntentError("The local model returned an invalid interpretation. Use the planning controls or retry.", "invalid_interpretation", 502);
  for (const field of ["count", "servings", "batches", "maxTotalMinutes"] as const) if (generated[field] !== undefined && generated[field] !== null && (typeof generated[field] !== "number" || !Number.isFinite(generated[field]))) throw new ChefPlanIntentError("Invalid numeric interpretation. Use the planning controls or retry.", "invalid_interpretation", 502);
  for (const field of ["dates", "excludedIngredients", "diets", "excludedEquipment"] as const) if (generated[field] !== undefined && (!Array.isArray(generated[field]) || (generated[field] as unknown[]).length > 30 || !(generated[field] as unknown[]).every(item => typeof item === "string" && item.length <= 120))) throw new ChefPlanIntentError("Invalid planning interpretation. Use the planning controls or retry.", "invalid_interpretation", 502);
  // Negative planning commands must not become positive actions or model
  // evidence. Ingredient prohibitions ("do not use peanuts") remain intact.
  let text = planClauses(query.toLowerCase().replaceAll("’", "'").trim()).map(clause => clause.replace(/\b(?:do not|don't|never|not)\s+(?:plan|make|set|keep|retain|preserve|leave|replace|swap|change|switch|serve|feed|prioriti[sz]e|prefer|focus)\b.*$/, " ")).join(";");
  const replacedDiets: Diet[] = [];
  // Explicit global preference revisions replace draft requirements only. Saved
  // household requirements are independently enforced by the planning service.
  if (!new RegExp(`\\b(?:${DAYS.join("|")}|today|tonight|tomorrow|\\d{4}-\\d{2}-\\d{2})\\b`).test(text)) {
    text = text.replace(new RegExp(`\\b(?:switch|change)\\s+from\\s+(${DIET_LABEL})\\s+to\\s+(${DIET_LABEL})\\b`, "g"), (_match, from: string, to: string) => {
      replacedDiets.push(dietFor(from)!); return to;
    }).replace(new RegExp(`\\b(${DIET_LABEL})(\\s+(?:dinners?|meals?))?\\s+(?:instead of|rather than)\\s+(${DIET_LABEL})\\b`, "g"), (_match, to: string, noun: string | undefined, from: string) => {
      replacedDiets.push(dietFor(from)!); return `${to}${noun ?? ""}`;
    });
  }
  if (generated.evidence !== undefined && (!record(generated.evidence) || Object.entries(generated.evidence).some(([field, value]) => !["count", "servings", "batches", "excludedIngredients", "diets", "excludedEquipment", "maxTotalMinutes", "priority", "allowRepeats"].includes(field) || typeof value !== "string" || value.length > 300))) throw new ChefPlanIntentError("Invalid interpretation evidence. Use the planning controls or retry.", "invalid_interpretation", 502);
  const sourceSpan = (field: string, source = text) => {
    const value = record(generated.evidence) ? generated.evidence[field] : undefined;
    const span = typeof value === "string" ? value.toLowerCase().replaceAll("’", "'").trim() : "";
    return span && source.includes(span) ? span : "";
  };
  const negatedDirective = (span: string) => /\b(?:do not|don't|never|not)\s+(?:prioriti[sz]e|prefer|want|favor|focus|use|choose|plan|make|include|exclude|avoid|allow)\b/.test(span);
  const citedNumber = (field: string, value: unknown) => {
    const span = sourceSpan(field);
    if (!span || typeof value !== "number" || negatedDirective(span)) return false;
    const values = [...span.matchAll(new RegExp(`\\b(${NUMBER}|half|quarter)\\b`, "g"))].map(match => match[1] === "half" ? 0.5 : match[1] === "quarter" ? 0.25 : number(match[1]));
    return values.includes(value) || field === "maxTotalMinutes" && /\bhours?\b/.test(span) && values.some(candidate => candidate * 60 === value);
  };
  const intent = structuredClone(base);
  intent.diets = intent.diets.filter(diet => !replacedDiets.includes(diet));
  intent.replaceDates = []; // A replacement command applies to this turn, never later unrelated turns.
  const dates = DAYS.map((_, index) => addDateDays(base.week, index));
  const named = DAYS.flatMap((day, index) => new RegExp(`\\b${day}\\b`).test(text) ? [dates[index]] : []);
  const iso = [...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(match => match[0]);
  const relative = [...(/\b(?:tonight|today)\b/.test(text) ? [base.today] : []), ...(/\btomorrow\b/.test(text) ? [addDateDays(base.today, 1)] : [])];
  const mentioned = unique([...named, ...iso, ...relative]);
  if (/\bnext week\b/.test(text) && base.week !== addDateDays(weekStart(base.today), 7)) return { clarification: "Select next week in the planning controls, then ask again." };
  if (/\b(?:two|2|three|3|several|multiple)\s+weeks\b/.test(text) || mentioned.some(date => !dates.includes(date) || date < base.today)) return { clarification: "Choose future dinner dates within the selected week." };
  if (/\b(?:it|that|this one|the other one)\b/.test(text) && /\b(?:replace|swap|change|keep)\b/.test(text) && !mentioned.length) return { clarification: "Which dinner date do you want to change or keep?" };
  const count = text.match(new RegExp(`\\b(${NUMBER})\\s+(?:(?:different|varied|vegetarian|vegan|meatless|gluten[ -]free|dairy[ -]free|low[ -]carb)\\s+)*(?:dinners?|meals?|nights?)\\b`));
  const serves = portionMatch(text);
  const batches = text.match(new RegExp(`\\b(${NUMBER})\\s+(?:recipe\\s+)?batches?\\b`));
  if (count) intent.count = number(count[1]);
  else if (citedNumber("count", generated.count) && /\b(?:dinners?|meals?|nights?|evenings?)\b/.test(sourceSpan("count"))) intent.count = generated.count as number;

  if (intent.count < 1 || intent.count > 7) return { clarification: "Choose between one and seven dinners in a single week." };
  // A per-day portion request must not alter all dinners.
  const scopedPortions = mentioned.length > 0 && (base.dates.length > 0 || mentioned.length > 1);
  if (serves && !scopedPortions) { intent.servings = number(serves[1]); intent.batches = null; }

  if (!serves && !batches && !scopedPortions && citedNumber("servings", generated.servings) && /\b(?:people|persons?|adults?|children|family|household|us|servings?|portions?)\b/.test(sourceSpan("servings"))) { intent.servings = generated.servings as number; intent.batches = null; }
  if (batches && !scopedPortions) { intent.batches = number(batches[1]); intent.servings = null; }
  else if (!serves && !scopedPortions && citedNumber("batches", generated.batches) && /\b(?:batches?|recipe)\b/.test(sourceSpan("batches"))) { intent.batches = generated.batches as number; intent.servings = null; }
  if (/\b(?:source|original)\s+(?:quantities|portions|amounts)\b/.test(text)) { intent.servings = null; intent.batches = null; }

  let globalText = text;
  const scopedDays = [...DAYS.map((day, index) => [day, dates[index]]), ...iso.map(date => [date, date]), ["today", base.today], ["tonight", base.today], ["tomorrow", addDateDays(base.today, 1)]];
  for (const [day, date] of scopedDays) {
    const clauses = planClauses(text).filter(part => new RegExp(`\\b${day}\\b`).test(part));
    if (clauses.some(clause => new RegExp(`\\b(?:(?:not|isn't|doesn't|don't|no longer)\\s+(?:(?:need|have)\\s+to\\s+be\\s+|be\\s+)?|non[ -])${DIET_LABEL}\\b`).test(clause))) return { clarification: "Negated dietary requirements for a date are not supported. Choose a positive dietary requirement or edit that dinner in the planning controls." };
    const dailyDiets = unique(clauses.flatMap(clause => [...clause.matchAll(new RegExp(`\\b${DIET_LABEL}\\b`, "g"))].map(match => dietFor(match[0])!)));
    if (dailyDiets.length > 1) return { clarification: "Choose one dietary requirement for each date, or apply combined dietary requirements to the whole plan in the planning controls." };
    for (const clause of clauses) {
      if (/\b(?:keep|retain|leave|preserve)\b/.test(clause) && !/\b(?:do not|don't)\s+keep\b/.test(clause)) intent.keepDates = unique([...intent.keepDates, date]);
      if (/\b(?:replace|swap|change)\b/.test(clause) && !/\b(?:do not|don't|never)\s+(?:replace|swap|change)\b/.test(clause)) {
        intent.replaceDates.push(date); intent.keepDates = intent.keepDates.filter(value => value !== date);
        if (intent.perDate[date]) delete intent.perDate[date].recipeId;
      }
      const diet = dietFor(clause);
      const dayServings = portionMatch(clause);
      const dayBatches = clause.match(new RegExp(`\\b(${NUMBER})\\s+(?:recipe\\s+)?batches?\\b`));
      if (diet || dayServings || dayBatches) {
        intent.perDate[date] = { ...intent.perDate[date], ...(diet ? { diet } : {}), ...(dayServings ? { servings: number(dayServings[1]) } : {}), ...(dayBatches ? { batches: number(dayBatches[1]) } : {}) };
        if (dayServings) delete intent.perDate[date].batches;
        if (dayBatches) delete intent.perDate[date].servings;
        // Remove only the scoped portions/diet; retain independent ingredient,
        // equipment, and time requirements from the same sentence.
        let remaining = clause.replace(/\b(?:vegan|vegetarian|meatless|meat[ -]free|gluten[ -]free|low[ -]carb)\b/g, " ");
        if (dayServings) remaining = remaining.replace(dayServings[0], " ");
        if (dayBatches) remaining = remaining.replace(dayBatches[0], " ");
        globalText = globalText.replace(clause, remaining);
      }
    }
  }
  if (mentioned.length) intent.dates = unique([...base.dates, ...mentioned]).sort();
  else if (!base.dates.length && /\b(?:weekend|saturday and sunday)\b/.test(text)) intent.dates = dates.slice(5).filter(date => date >= base.today);
  if (count && !mentioned.length && base.dates.length) {
    const requested = intent.count;
    intent.dates = base.dates.slice(0, requested);
    intent.keepDates = intent.keepDates.filter(date => intent.dates.includes(date));
    intent.perDate = Object.fromEntries(Object.entries(intent.perDate).filter(([date]) => intent.dates.includes(date)));
    // Clear explicit targets when expanding, allowing the engine to add empty dates.
    if (requested > base.dates.length) intent.dates = [];
  } else if (intent.dates.length) intent.count = intent.dates.length;
  // Negated exclusion directives are not food exclusions. Explicitly undo only draft exclusions.
  globalText = globalText.replace(/\b(?:do not|don't|never)\s+(?:exclude|avoid|omit|remove|leave out)\s+([^.;!?]+?)(?=[.;!?]|,?\s+(?:and\s+)?(?:avoid|exclude|omit|without|no)\b|$)/g, (_match, names: string) => {
    const removed = names.split(/,|\band\b|\bor\b/).map(name => name.trim());
    intent.excludedIngredients = intent.excludedIngredients.filter(name => !removed.some(value => value.replace(/s$/, "") === name.replace(/s$/, "")));
    return " ";
  });
  // Planning controls and priority wording must not be interpreted as ingredient names.
  const constraintText = globalText.replace(/\b(?:no|without|avoid|don't want)\s+(?:repeats?|repeating|shopping|extra shopping|waste|wasting food)\b/g, " ");
  const constraints = recipeQueryIntent(constraintText);
  const exclusionSpan = sourceSpan("excludedIngredients", globalText);
  const exclusionCue = /\b(?:no|without|avoid|exclude|omit|out of|cannot eat|can't eat|allergic|do not use|don't use)\b/;
  const groundedExclusions = exclusionSpan && exclusionCue.test(exclusionSpan) && !negatedDirective(exclusionSpan) && Array.isArray(generated.excludedIngredients)
    ? generated.excludedIngredients.filter((value): value is string => typeof value === "string" && new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(exclusionSpan)) : [];
  intent.excludedIngredients = unique([...intent.excludedIngredients, ...constraints.excludedIngredients, ...groundedExclusions]);
  intent.excludedEquipment = unique([...intent.excludedEquipment, ...(constraints.excludedEquipment ?? [])]);
  const equipmentSpan = sourceSpan("excludedEquipment", globalText);
  if (equipmentSpan && !negatedDirective(equipmentSpan) && /\b(?:no|without|unavailable|broken|out of order|cannot use|can't use)\b/.test(equipmentSpan) && Array.isArray(generated.excludedEquipment)) {
    intent.excludedEquipment = unique([...intent.excludedEquipment, ...generated.excludedEquipment.filter((value): value is string => typeof value === "string" && equipmentSpan.includes(value.toLowerCase())).map(normalizeEquipmentName)]);
  }
  const dietSpan = sourceSpan("diets", globalText);
  const groundedDiets = dietSpan && !negatedDirective(dietSpan) && !/\b(?:not|isn't|is not|no need)\b/.test(dietSpan) && Array.isArray(generated.diets)
    ? generated.diets.filter((value): value is Diet => ({ vegan: /\b(?:vegan|plant[ -]based|(?:no|without) animal|animal[ -]free)\b/, vegetarian: /\b(?:vegetarian|meatless|meat[ -]free|(?:no|without) meat)\b/, gluten_free: /\bgluten\b/, low_carb: /\bcarb(?:s|ohydrates?)?\b/ } as Record<string, RegExp>)[String(value)]?.test(dietSpan) ?? false) : [];
  intent.diets = unique([...intent.diets, ...constraints.diets as Diet[], ...groundedDiets]);
  if (constraints.maxTotalMinutes) intent.maxTotalMinutes = constraints.maxTotalMinutes;
  const limit = text.match(/\b(?:under|within|up to|less than|at most)\s+(\d+)\s*(?:minutes?|mins?)\b/);
  if (limit) intent.maxTotalMinutes = Number(limit[1]);
  else if (citedNumber("maxTotalMinutes", generated.maxTotalMinutes) && /\b(?:minutes?|hours?|time|ready|under|within|maximum|limit)\b/.test(sourceSpan("maxTotalMinutes"))) intent.maxTotalMinutes = generated.maxTotalMinutes as number;
  let priority: ChefPlanPriority | undefined;
  if (/\b(?:expires?|expiring|use.by|use.soon|due.soon|waste|perishable)\b/.test(text)) priority = "use_soon";
  else if (/\b(?:fewer|less|minimi[sz]e|reduce|minimal)\b[^.!?;]*\b(?:groceries|shopping|ingredients to buy)\b/.test(text)) priority = "fewer_groceries";
  else if (/\b(?:variety|varied|different each|mix it up)\b/.test(text)) priority = "variety";

  const prioritySpan = sourceSpan("priority");
  const priorityAnchors: Record<string, RegExp> = { use_soon: /\b(?:perishables?|expir\w*|waste|go(?:es|ing)? off|use[ -]by|due soon|use up)\b/, fewer_groceries: /\b(?:buy|shop\w*|grocer\w*|purchas\w*|pantry|cupboard)\b/, variety: /\b(?:variety|varied|different|mix|repeat\w*|novel\w*)\b/ };
  if (!priority && prioritySpan && !negatedDirective(prioritySpan) && priorityAnchors[String(generated.priority)]?.test(prioritySpan)) priority = generated.priority as ChefPlanPriority;
  if (priority) intent.priority = priority;
  if (/\b(?:allow|okay with|ok with|fine with|don't mind)\s+(?:recipe\s+)?repeat/.test(text)) intent.allowRepeats = true;
  if (sourceSpan("allowRepeats") && !negatedDirective(sourceSpan("allowRepeats")) && typeof generated.allowRepeats === "boolean" && /\b(?:same|again|repeat|unique|different)\b/.test(sourceSpan("allowRepeats"))) intent.allowRepeats = generated.allowRepeats;
  if (/\b(?:no|without|avoid|don't want|do not allow|don't allow)\s+repeat/.test(text)) intent.allowRepeats = false;
  return { intent: validatePlanIntent(intent) };
}

export async function requestChefPlanIntent(options: { query: string; week: string; today: string; previousDraft?: ChefPlanDraft; model?: string; signal?: AbortSignal }): Promise<{ intent?: ChefPlanIntent; clarification?: string }> {
  const base = options.previousDraft ? validatePlanIntent({ ...options.previousDraft.intent, dates: unique([...options.previousDraft.intent.dates, ...options.previousDraft.changes.map(change => change.date)]), authorizedReplacementDates: unique([...(options.previousDraft.intent.authorizedReplacementDates ?? []), ...options.previousDraft.changes.filter(change => change.expectedMealId !== null).map(change => change.date)]) }) : defaultPlanIntent(options.week, options.today);
  if (base.week !== options.week || base.today !== options.today) throw new ChefPlanIntentError("The draft belongs to a different week or date. Start a new plan.", "plan_changed", 409);
  const query = options.query.trim();
  if (!query || query.length > 2000) throw new ChefPlanIntentError("Enter a planning request of 1–2000 characters.");
  if (/\b(?:italian|mexican|indian|thai|chinese|japanese|mediterranean|greek|french|korean|lentil|lentils|pasta|pizza|soup|salad|chicken|beef|fish|rice)\b/i.test(recipeQueryIntent(query).topic)) return { clarification: "For a particular dish or cuisine, choose recipes in the dinner controls or use recipe search. This planner currently understands dates, portions, dietary requirements, exclusions, and shopping priorities." };
  // Resolve obvious ambiguity before spending model work.
  const checked = resolveChefPlanIntent(query, base);
  if (checked.clarification) return checked;
  const baseUrl = (typeof process !== "undefined" ? process.env.OLLAMA_BASE_URL?.trim() : "") || "http://127.0.0.1:11434";
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) throw new ChefPlanIntentError("Planning requires local Ollama. Use the manual planning controls.", "planner_unavailable", 503);
  const model = options.model?.trim() || (typeof process !== "undefined" ? process.env.OLLAMA_CHAT_MODEL?.trim() : "") || DEFAULT_OLLAMA_CHAT_MODEL;
  if (model.length > 120 || !/^[\w./:-]+$/.test(model)) throw new ChefPlanIntentError("Choose a valid local model name.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/chat`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
      body: JSON.stringify({ model, stream: false, think: false, format: CHEF_PLAN_INTENT_SCHEMA, options: { temperature: 0, num_predict: 500 }, messages: [
        { role: "system", content: "Extract a dinner-planning request as the supplied JSON schema. This only interprets a request; it never authorizes changes. Use null or [] for unspecified fields. For every non-null proposed value, evidence must quote an exact short substring of the user query supporting that field; use an empty string for unspecified fields. Evidence must come from the query, never previousIntent. Examples: a household of five supports servings=5; a pair of meals supports count=2; do not buy much supports priority=fewer_groceries; plant based supports diets=[vegan]. Dates must be explicit requested dates within the selected week, not guessed from a meal count. Do not include an ingredient when the user says not to exclude it. Preserve negations. For constraints scoped to a weekday, leave global diets and servings unspecified; the application resolves those day-specific clauses. Priority values mean use expiring food, fewer additional groceries, or variety. Do not invent nutrition, prices, ingredients, recipes, dates or quantities. Never ask clarification: the application validates and supplies defaults. The previous draft is context, not a new instruction." },
        { role: "user", content: JSON.stringify({ query, week: options.week, today: options.today, previousIntent: options.previousDraft?.intent }) },
      ] }) });
    if (!response.ok) throw new Error("Ollama did not return an interpretation.");
    const text = await response.text(); if (text.length > 30_000) throw new Error("Oversized interpretation.");
    const result = JSON.parse(text);
    if (result.done_reason === "length" || typeof result.message?.content !== "string") throw new Error("Incomplete interpretation.");
    const generated: unknown = JSON.parse(result.message.content);
    validateGeneratedPlanIntent(generated);
    return resolveChefPlanIntent(query, base, generated);
  } catch (error) {
    if (error instanceof ChefPlanIntentError) throw error;
    throw new ChefPlanIntentError(options.signal?.aborted ? "Planning request cancelled." : "Local planning is unavailable or its answer was invalid. Use the manual planning controls or retry.", options.signal?.aborted ? "cancelled" : "planner_unavailable", options.signal?.aborted ? 499 : 503);
  } finally { clearTimeout(timeout); }
}
