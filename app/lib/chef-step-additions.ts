import type { ChefPlanningFact, ChefRequest } from "./chef-schema";
import type { PlannedMeal } from "./kitchen-types";
import { mealAmountBasis, normalizePlanningIngredient, parseMeasure, resolvedMealIngredients } from "./quantities";
import { cookingStepText, methodDirections, type SourceDirection } from "./recipe-instructions";
import type { Recipe } from "./recipe-types";

type AdditionAnswer = {
  answerStatus: "answered" | "unsupported" | "needs_clarification";
  answer: string;
  evidenceIds: string[];
  planningFacts: ChefPlanningFact[];
};

const now = /^how (?:much|many)(?: (.+?))? (?:goes? in|(?:do|should) (?:i|we) (?:add|use|pour in)) (?:now|here|(?:in|for) this step)$/i;
const rest = /^what about (?:the )?(?:rest|remainder)(?: of (?:the )?(.+))?$/i;
const total = /^how (?:much|many) (.+?) (?:do (?:i|we) (?:need|use)|does (?:the|this) (?:original |saved )?(?:recipe|dinner) (?:need|use))(?: for (?:this |the )?(?:saved )?(?:dinner|recipe))?$/i;
const clean = (text: string) => text.trim().replace(/[?.!]+$/, "").trim();

// A previous question can name the food. Its amount and the assistant's answer
// have no authority over the selected source or the current dinner.
function previousSubject(history: ChefRequest["history"]) {
  let quantityTurn = false;
  for (const turn of [...(history ?? [])].reverse()) {
    if (turn.role !== "user") continue;
    const query = clean(turn.content);
    const match = query.match(now) ?? query.match(total) ?? query.match(rest);
    if (!match) break;
    quantityTurn = true;
    if (match[1]) return { quantityTurn, name: match[1] };
  }
  return { quantityTurn };
}

// Read the direct object of an affirmative addition. A time in the next
// clause, an alternative, or a measurement on a different food cannot supply it.
function additionAmount(step: SourceDirection, name: string, ingredientNames: string[]): "measured" | "unstated" | undefined {
  const text = cookingStepText(step.text);
  if (/\b(?:if|unless|instead|except|without|or|not|never)\b/i.test(text)) return;
  const action = text.match(/^(?:add|whisk(?: in)?|stir in|pour(?: in)?|fold in|mix in|combine)\s+(.+)$/i);
  if (!action) return;
  const objects = action[1].split(/\s+(?:with|into|until|over|to|and (?:simmer|cook|stir|whisk|heat|bake|mix))\s+|[.!?](?:\s|$)/i)[0];
  const items = objects.toLowerCase().split(/\s+and\s+|,\s*/);
  for (const item of items) {
    if (item !== name && !item.endsWith(` ${name}`)) continue;
    const prefix = item.slice(0, item.length - name.length).trim();
    if (/^(?:(?:the )?remaining|some(?: of the)?|the rest of the|the)?$/i.test(prefix)) {
      // Only say the direction gives no measure when the rest of the
      // sentence is accounted for. A second clause may supply one in words.
      const tail = action[1].slice(objects.length).trim().replace(/[.!?]$/, "").toLowerCase();
      const companion = tail.match(/^with (?:the )?(.+)$/)?.[1];
      const simpleList = items.every(other => other === item || ingredientNames.includes(other.replace(/^the /, "")));
      if (simpleList && (!tail || companion && ingredientNames.includes(companion)
        || /^and (?:simmer|cook|stir|whisk|mix) until (?:thick|thickened|smooth|combined|golden)$/.test(tail))) return "unstated";
    }
    if (parseMeasure(prefix.replace(/\s+of(?: the)?$/, ""))) return "measured";
  }
}

function clarify(answer: string, evidenceIds: string[]): AdditionAnswer {
  return { answerStatus: "needs_clarification", answer, evidenceIds, planningFacts: [] };
}

function mentions(text: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Boolean(name) && new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

/** Answer a source allocation in the active method. A meal override only supplies a total. */
export function focusedStepAdditionAnswer({ recipe, meal, step, query, history }: {
  recipe: Recipe; meal?: PlannedMeal | null; step: SourceDirection; query: string; history?: ChefRequest["history"];
}): AdditionAnswer | undefined {
  const request = clean(query);
  const current = request.match(now), later = request.match(rest);
  if (!current && !later) return;
  const prior = previousSubject(history);
  if (later && !later[1] && !prior.quantityTurn) return;
  const method = methodDirections(recipe, step);
  if (!method.length) return clarify("Which direction in this cooking method do you mean?", []);

  const requested = (current?.[1] ?? later?.[1] ?? prior.name)?.trim().toLowerCase().replace(/^(?:of (?:the )?|the )/, "");
  const names = recipe.ingredients.map(ingredient => normalizePlanningIngredient(ingredient).name.trim().toLowerCase());
  if (later && !later[1] && requested && !names.includes(requested)) return;
  const candidates = names.map((name, index) => ({ name, index })).filter(row =>
    mentions(step.text, row.name) && (!requested || row.name === requested));
  if (candidates.length !== 1) {
    return clarify(`Which ingredient in step ${step.number} do you mean? The direction says: ${cookingStepText(step.text)}`, [step.evidenceId]);
  }

  const { name, index } = candidates[0];
  const ingredientId = `I${index + 1}`;
  const evidenceIds = [ingredientId, step.evidenceId];
  let target = step, targetAmount = additionAmount(step, name, names);
  if (later) {
    // An unrecognized later mention could also use this ingredient. Do not
    // silently skip it and present another step as the unique remainder.
    const uses = method.filter(row => row.number > step.number && (mentions(row.text, name)
      || /\b(?:add|stir in|mix in|pour in|fold in) (?:it|the rest|the remainder)\b/i.test(row.text)));
    const nextAmount = uses.length === 1 ? additionAmount(uses[0], name, names) : undefined;
    if (!targetAmount || !nextAmount) return clarify(`Which later direction for ${name} do you mean? I couldn't identify one clear later addition in this method.`, evidenceIds);
    target = uses[0];
    targetAmount = nextAmount;
    evidenceIds.push(target.evidenceId);
  }

  let answer = `Original recipe, step ${target.number}: ${cookingStepText(target.text)}`;
  if (targetAmount === "unstated") answer += ` This direction gives no measured amount of ${name} for this step.`;
  if (!targetAmount) answer += ` I couldn't identify a separate amount to add for ${name} from this direction.`;
  const planningFacts: ChefPlanningFact[] = [];
  const saved = meal && meal.recipeId === recipe.id ? resolvedMealIngredients(meal)[index] : undefined;
  if (meal && saved?.name.trim().toLowerCase() === name) {
    const fact = { ...saved, recipeId: meal.recipeId, ingredientIndex: index, sourceEvidenceId: ingredientId, basis: mealAmountBasis(meal, index) };
    planningFacts.push(fact);
    answer += saved.needsReview ? `\n\nThe saved dinner total for ${name} needs review.`
      : `\n\nSaved dinner total: ${saved.measure} ${saved.name} for the whole dinner. The saved dinner does not assign a separate amount to this step.`;
  }
  return { answer, answerStatus: targetAmount === "measured" ? "answered" : "unsupported", evidenceIds, planningFacts };
}
