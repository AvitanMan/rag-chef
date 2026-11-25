import type { Recipe } from "./recipe-types";
import type { PreparationAnswer } from "./chef-preparation";
import { cookingStepText, methodDirections, type SourceDirection } from "./recipe-instructions";

type Action = { step: SourceDirection; text: string };
type Order = { food: string; waterFirst: boolean; actions: Action[] };

const water = /^(?:bring (?:the |some |a (?:large )?(?:pan|pot|saucepan) of )?(?:salted )?water to (?:a |the )(?:rolling )?boil|boil (?:the |some )?(?:salted )?water)(?: in (?:a|the) (?:large |small )?(?:pot|saucepan|pan))?(?: on the stovetop| over (?:high|medium-high) heat)?$/i;
const heatTogether = /^bring (?:it |them |the (?:pot|water|mixture) |everything )?to (?:a |the )(?:rolling )?boil(?: over (?:high|medium-high) heat)?$/i;
const prohibition = /^(?:do not|don't|don’t|never) (?:boil (?:the )?water|bring (?:the )?water to a boil)$/i;
const orderQuestion = /^(?:please[, ]+)?(?:should (?:i|we)|do (?:i|we)(?: need to)?|must (?:i|we)) (?:boil (?:the )?water|bring (?:the )?water to a boil)(?: first)?(?: before(?: (?:i |we )?(?:add(?:ing)?|put(?:ting)?|cook(?:ing)?) (?:the )?([a-z][a-z -]*?)(?: in(?:to the (?:pan|pot|water))?)?)?)?$/i;

function actionList(steps: SourceDirection[]): Action[] {
  return steps.flatMap(step => cookingStepText(step.text).split(/(?<=[.!?])\s+/).flatMap(sentence => {
    const text = sentence.trim().replace(/[.!?]+$/, "");
    // Retain an unrecognised instruction as a barrier. Never join actions
    // across a conditional, a change of pot, or an intervening preparation.
    if (/\b(?:if|unless|or|instead|after|while|only|never|not|avoid|without)\b|n['’]t\b/i.test(text)) return [{ step, text }];
    return text.replace(/ before adding /i, ", then add ").split(/,?\s+(?:and then|then|and (?=bring\b|add\b))\s*|;\s*/i)
      .map(part => ({ step, text: part.trim() }));
  }));
}

// Bind a direction's direct object to a recipe ingredient. This deliberately
// keeps "add the pasta to the sauce" out of a water instruction.
function foodAction(text: string, foods: string[]) {
  if (/\b(?:if|unless|instead|or|not|never|without)\b|n['’]t\b/i.test(text)) return;
  const addition = text.replace(/ (?:and cook(?: for [\d –-]+ (?:minutes?|seconds?)| according to (?:its|the) package directions)?(?: until [a-z -]+)?|according to (?:its|the) package directions(?: until [a-z -]+)?|until (?:just )?(?:tender|done|cooked through|al dente)|for [\d –-]+ (?:minutes?|seconds?))$/i, "");
  const match = /^(?:put|place) (?:the )?(.+?) and (?:the )?((?:cold )?water) in (?:a|the) (?:pan|pot|saucepan)$/i.exec(text)
    ?? /^cover (?:the )?(.+?) with ((?:cold )?water)$/i.exec(text)
    ?? /^combine (?:the )?(.+?) (?:and|with) (?:the )?((?:cold )?water)(?: in (?:a|the) (?:pan|pot|saucepan))?$/i.exec(text)
    ?? /^(?:add|put|place|cook|stir in) (?:the )?(.+?)(?: (?:to|in|into) (?:the )?((?:(?:boiling|cold|salted) )*water))?$/i.exec(addition);
  if (!match) return;
  const food = foods.find(name => name === match[1].toLowerCase());
  if (food) return { food, liquid: match[2]?.toLowerCase() };
}

function directionsText(actions: Action[]) {
  return actions.map(action => action.text.charAt(0).toUpperCase() + action.text.slice(1) + ".").join(" ");
}

function answer(status: PreparationAnswer["answerStatus"], text: string, steps: SourceDirection[]): PreparationAnswer {
  return { answer: text, answerStatus: status, evidenceIds: [...new Set(steps.map(step => step.evidenceId))] };
}

// A note may qualify the method for a particular form of the ingredient.
// An unnamed start can qualify for clarification, but cannot establish which food it refers to.
function conflictingWaterNote(notes: string[], order: Order, foods: string[]): PreparationAnswer | undefined {
  const hasFood = (text: string, name: string) => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `.includes(` ${name} `);
  for (const [index, note] of notes.entries()) {
    for (const clause of note.split(/[.,;!?]/)) {
      const starts = /\b(?:start|put|place|add|cook|cover)(?:\s+(.+?))?\s+(?:in|into|to|with) (?:the )?(cold|boiling) water\b/gi;
      for (const match of clause.matchAll(starts)) {
        const object = match[1]?.trim();
        if (object && !/^(?:it|them)$/i.test(object)) {
          if (!hasFood(object, order.food)) continue;
        } else {
          const named = foods.filter(food => hasFood(note, food));
          if (named.length && !named.includes(order.food)) continue;
        }
        const prohibited = /\b(?:do not|never|avoid|don't|don’t)\s*$/i.test(clause.slice(0, match.index));
        const usesBoilingWater = match[2].toLowerCase() === "boiling";
        const conflicts = prohibited ? usesBoilingWater === order.waterFirst : usesBoilingWater !== order.waterFirst;
        if (!conflicts) continue;
        return {
          answerStatus: "needs_clarification",
          answer: `The directions say: ${directionsText(order.actions)} The recipe also notes: “${note}” Does that note apply to the ${order.food} you’re preparing?`,
          evidenceIds: [...new Set(order.actions.map(action => action.step.evidenceId)), `N${index + 1}`],
        };
      }
    }
  }
}

export function boilingOrderHelp({ recipe, query, step }: { recipe: Recipe; query: string; step?: SourceDirection | null }): PreparationAnswer | undefined {
  const request = query.trim().replace(/[?!.]+$/, "").trim();
  const question = orderQuestion.exec(request);
  if (!question || /\b(?:and|or|why|how|what|should|instead)\b/i.test(question[1] ?? "")) return;
  const subject = question[1]?.toLowerCase().replace(/^in (?:the )?/, "").replace(/ (?:in|into|to) (?:it|the (?:water|pot|pan))$/, "");
  const requested = /^(?:it|them|this|the)$/.test(subject ?? "") ? undefined : subject;
  const steps = methodDirections(recipe, step);
  if (!steps.length) return answer("needs_clarification", "Which cooking method are you following? I need its water and ingredient directions to tell you which goes in first.", []);

  const foods = recipe.ingredients.map(row => row.name.split(",")[0].trim().toLowerCase()).filter(name => name && name !== "water");
  const actions = actionList(steps);
  const orders: Order[] = [];
  for (const [index, action] of actions.entries()) {
    const food = foodAction(action.text, foods);
    if (!food || requested && requested !== food.food) continue;
    const previous = actions[index - 1], next = actions[index + 1];
    if (food.liquid?.includes("boiling") || (!food.liquid || food.liquid === "water") && previous && water.test(previous.text)) {
      orders.push({ food: food.food, waterFirst: true, actions: previous && water.test(previous.text) ? [previous, action] : [action] });
    } else if (food.liquid && (food.liquid.includes("cold") || next && heatTogether.test(next.text))) {
      orders.push({ food: food.food, waterFirst: false, actions: next && heatTogether.test(next.text) ? [action, next] : [action] });
    }
  }

  // Some foods meet water twice (for example, soaking and cooking). An
  // explicit cooking question refers to the stated cooking stage.
  const asksAboutCooking = /\bbefore (?:(?:i|we) )?cook(?:ing)?\b/i.test(request);
  const cookingOrders = orders.filter(order => order.actions.some(action => /^cook /i.test(action.text)));
  const candidates = asksAboutCooking && cookingOrders.length ? cookingOrders
    : asksAboutCooking ? orders.filter(order => order.waterFirst || order.actions.some(action => heatTogether.test(action.text))) : orders;
  const local = step ? candidates.filter(order => order.actions.some(action => action.step.evidenceId === step.evidenceId)) : [];
  const matches = local.length ? local : candidates;
  const ban = actions.find(action => prohibition.test(action.text));
  const alternative = actions.some(action => /\b(?:if|unless|instead|alternatively|otherwise|or)\b/i.test(action.text)
    && (/\b(?:bring .+ to (?:a |the )?boil|boil (?:the )?water)\b/i.test(action.text)
      || /\b(?:put|place|cover|add|cook|combine) .+ (?:in|into|to|with) (?:the )?(?:cold|boiling) water\b/i.test(action.text)));
  if (matches.length === 1 && !ban && !alternative) {
    const order = matches[0];
    const exception = conflictingWaterNote(recipe.sourceNotes ?? [], order, foods);
    if (exception) return exception;
    const decision = order.waterFirst ? "yes" : "no";
    const lead = requested ? `${decision[0].toUpperCase()}${decision.slice(1)}.` : `If you mean before adding the ${order.food}, ${decision}.`;
    const result = answer("answered", `${lead} ${directionsText(order.actions)}`, order.actions.map(action => action.step));
    if (order.waterFirst) result.technique = "Boiling";
    return result;
  }
  if (ban && (!requested || actions.some(action => foodAction(action.text, [requested]))) && !alternative && !actions.some(action => water.test(action.text) || heatTogether.test(action.text) || /\bboiling water\b/i.test(action.text)) && !orders.length) {
    return answer("answered", `Keep the water below a boil here. Step ${ban.step.number} gives an explicit instruction: ${cookingStepText(ban.step.text)}`, [ban.step]);
  }
  if (matches.length > 1 || !requested) {
    const names = [...new Set(matches.map(order => order.food))];
    if (matches.length > 1 && requested && new Set(matches.map(order => order.waterFirst)).size > 1) {
      const first = matches.find(order => !order.waterFirst)!, second = matches.find(order => order.waterFirst)!;
      const stages = [first, second].sort((a, b) => a.actions[0].step.number - b.actions[0].step.number);
      return answer("needs_clarification", `Which addition do you mean? ${stages.map(order => directionsText(order.actions)).join(" ")}`, stages.flatMap(order => order.actions.map(action => action.step)));
    }
    const detail = names.length > 1 ? `Are you asking about adding ${names.slice(0, 3).join(" or ")}?` : requested ? `Which step with the ${requested} are you following?` : "Which ingredient are you about to add to the water?";
    return answer("needs_clarification", detail, matches.flatMap(order => order.actions.map(action => action.step)));
  }
  const relevant = steps.find(row => row.text.toLowerCase().includes(requested)) ?? step;
  const direction = relevant ? ` Step ${relevant.number} says: ${cookingStepText(relevant.text)}` : "";
  return answer("unsupported", `I can't establish whether the water should already be boiling when you add the ${requested}.${direction}`, relevant ? [relevant] : []);
}
