import { cookingStepText, methodDirections, type SourceDirection } from "./recipe-instructions";
import type { Recipe } from "./recipe-types";
import type { PreparationAnswer } from "./chef-preparation";

const tips = {
  dice: "Make even slices first, then cut the slices into strips of the same width. Turn the strips and cut across them at the same spacing to make cubes.",
  chop: "Start with pieces that sit steadily on the board. Cut them into strips, then cut across the strips. Gather any larger pieces and chop them again until the pieces are fairly even.",
  slice: "Steady the ingredient on the board. Make a slice, then use its thickness as a guide as you work along the ingredient, moving your holding hand back between cuts.",
  rounds: "Lay the ingredient lengthwise on the board and steady it so it cannot roll. Cut straight across it to make rounds, keeping the spacing even as you go.",
  strips: "Cut broad, flat slices first. Lay each slice flat and cut along its length in parallel lines to make strips.",
  wedges: "Cut through the center, then rest a half on its cut face. Make angled cuts back toward the center so each wedge has a narrow inner edge and a wider outside edge.",
  halve: "Steady the ingredient on the board and cut through the middle so the two halves are about the same size.",
  quarter: "Cut the ingredient in half, rest each half on its flat face, then divide each half evenly to make four pieces.",
  mince: "Start by chopping the ingredient into small pieces. Gather them together and chop across the pile, turning it and repeating until the pieces are fine.",
  cut: "Steady the ingredient on its flattest side. Use the first piece as a guide for the next cuts so the pieces come out a similar size.",
};
type Technique = keyof typeof tips;

const cutWord = /\b(?:cut|chop(?:ped)?|dic(?:e|ed)|slic(?:e|ed)|minc(?:e|ed)|cub(?:e|ed)|halv(?:e|ed)|quarter(?:ed)?|grat(?:e|ed))\b/i;
function technique(text: string): Technique {
  if (/\bwedges?\b/i.test(text)) return "wedges";
  if (/\b(?:strips?|matchsticks?)\b/i.test(text)) return "strips";
  if (/\brounds?\b/i.test(text)) return "rounds";
  if (/\b(?:dic(?:e|ed)|cub(?:e|es|ed))\b/i.test(text)) return "dice";
  if (/\bslic(?:e|es|ed)\b/i.test(text)) return "slice";
  if (/\bminc(?:e|ed)\b/i.test(text)) return "mince";
  if (/\bchop(?:ped)?\b/i.test(text)) return "chop";
  if (/^quarter\b|\b(?:quartered|(?:in|into) quarters)\b/i.test(text)) return "quarter";
  if (/^halve\b|\b(?:halved|in half|(?:in|into) halves)\b/i.test(text)) return "halve";
  return "cut";
}

function foodKey(text: string): string {
  return text.toLowerCase().trim().replace(/^(?:the |each |a |an )/, "").replace(/\b(potato|tomato)es\b/g, "$1")
    .replace(/\b([a-z]{3,}?)s\b/g, (word, stem: string) => /(?:ss|us)$/.test(word) ? word : stem);
}

type Food = { id: string; name: string; key: string; line: string; preparation: string };
function foodLine(row: Recipe["ingredients"][number], index: number): Food {
  const parts = row.name.trim().split(/\s*[,()]\s*(?=(?:(?:finely|thinly|roughly|coarsely|thickly)\s+)?(?:chopped|sliced|diced|minced|cut|cubed|peeled|halved|quartered|grated|trimmed|whole)\b)/i);
  const prefix = parts[0].match(/^((?:(?:finely|thinly|roughly|coarsely|thickly) )?(?:chopped|sliced|diced|minced|cubed|halved|quartered|grated|whole)) (.+)$/i);
  const suffix = parts[0].match(/^(.+?) (cut (?:in half|into (?:halves|quarters))|halved|quartered)$/i);
  const name = prefix?.[2] ?? suffix?.[1] ?? parts[0];
  return { id: `I${index + 1}`, name, key: foodKey(name), line: [row.measure, row.name].filter(Boolean).join(" "),
    preparation: [prefix?.[1], suffix?.[2], ...parts.slice(1)].filter(Boolean).join(" ").trim() };
}

function mentions(text: string, food: Food): boolean {
  const normalized = foodKey(text).replace(/[^a-z0-9-]+/g, " ");
  return Boolean(food.key) && ` ${normalized.trim()} `.includes(` ${food.key} `);
}

type Cut = { food: Food; step: SourceDirection; sentence: string; detail: string; guarded: boolean };
function directionCuts(step: SourceDirection, foods: Food[]): Cut[] {
  const cuts: Cut[] = [];
  let previous = "";
  for (const sentence of cookingStepText(step.text).split(/(?<=[.!?;])\s+/)) {
    const actions = [...sentence.matchAll(/\b(cut|chop|dice|slice|mince|cube|halve|quarter|grate|keep|leave|use|serve|add|cook|roast|bake)\s+/gi)];
    for (const [i, action] of actions.entries()) {
      const verb = action[1].toLowerCase();
      const body = sentence.slice(action.index! + action[0].length, actions[i + 1]?.index)
        .split(/(?:,?\s+then|,?\s+and\s+(?:add|serve|stir|cook|place|toss|put|set|season|roast|bake))\b/i)[0];
      const describesForm = !cutWord.test(verb);
      if (describesForm && !/\b(?:whole|intact|uncut|grated)\b/i.test(body)) continue;
      const object = body.replace(/^(the )?(?:whole|uncut|grated) /i, "$1").split(/\b(?:into|in|with|using|on|before|after|until|lengthwise|crosswise|finely|thinly|roughly|coarsely|thickly|whole|intact|uncut)\b/i)[0];
      const pieces = object.replace(/[.!?;]+$/, "").split(/,|\b(?:and|or|then)\b/i).map(foodKey).filter(Boolean);
      let targets = pieces.flatMap(piece => {
        const exact = foods.filter(food => food.key === piece);
        if (exact.length) return exact;
        const simple = piece.replace(/^(?:(?:boneless|skinless|peeled|seeded|trimmed) )+/, "");
        const matches = foods.filter(food => food.key === simple || food.key.endsWith(` ${simple}`));
        return matches.length === 1 ? matches : [];
      });
      if (/^(?:it|them|the flesh)\b/i.test(object)) {
        const before = sentence.slice(0, action.index).trim() || previous;
        const named = foods.filter(food => mentions(before, food));
        targets = named.length === 1 && /\b(?:peel|scrub|wash|trim|rinse|halve|remove|use|core|seed)\b/i.test(before) ? named : [];
      }
      const modifier = sentence.slice(0, action.index).match(/\b(finely|thinly|roughly|coarsely|thickly)\s*$/i)?.[1] ?? "";
      const guarded = describesForm || verb === "grate" || /\b(?:if|unless|never|not|avoid|instead|without|or)\b|n['’]t\b/i.test(sentence);
      for (const food of targets) cuts.push({ food, step, sentence, detail: `${modifier} ${verb} ${body}`.trim(), guarded });
    }
    previous = sentence;
  }
  return cuts;
}

const size = /[\d¼½¾⅐-⅞]|\b(?:mm|cm|millimet(?:er|re)s?|centimet(?:er|re)s?|inch(?:es)?|halves|quarters?|size of|width of|thickness of|as (?:thick|thin|wide) as)\b/i;
function differs(details: string[]): boolean {
  const styles = new Set(details.map(technique).map(style => style === "rounds" ? "slice" : style).filter(style => style !== "cut"));
  const text = details.join(" ");
  const lengths = details.flatMap(detail => {
    const dimensions = [...detail.matchAll(/\b(\d+(?:\.\d+)?)[ -]*(mm|cm|inch(?:es)?)\b/gi)];
    if (dimensions.length !== 1 || /\d\s*(?:\/|-|–|to)\s*\d|\b(?:than|between)\b/i.test(detail)) return [];
    const [, value, unit] = dimensions[0];
    return [Number(value) * (unit.toLowerCase() === "cm" ? 10 : /^inch/i.test(unit) ? 25.4 : 1)];
  });
  return styles.size > 1 || new Set(lengths).size > 1
    || /\bthin(?:ly)?\b/i.test(text) && /\bthick(?:ly)?\b/i.test(text)
    || /\bfin(?:e|ely)\b/i.test(text) && /\b(?:rough|coarse)(?:ly)?\b/i.test(text);
}

/** Keep original cutting instructions and general knife technique separately attributed. */
export function cuttingHelp({ recipe, query, step, ingredient }: { recipe: Recipe; query: string; step?: SourceDirection | null; ingredient?: string }): PreparationAnswer | undefined {
  const match = query.trim().replace(/[?.!]+$/, "").trim().match(/^(?:please )?(?:how(?: (?:big|small|thin|thick|finely))?|what size) (?:(?:should|do|can) (?:i|we)|to) (cut|dice|slice|chop|mince|halve|quarter)(?: up)?(?: (.+))?$/i);
  if (!match || match[2] && /[?!.;,]|\b(?:and|or|before|after|instead|without|why|should|would|could|when|into|using)\b/i.test(match[2])) return;
  const subject = (ingredient ?? match[2] ?? "").trim().replace(/^(?:the|my|this|these)(?:\s+|$)/i, "").replace(/\s+(?:here|in this step|for this (?:recipe|dinner|step))$/i, "");
  if (/^(?:heat|time|cost|cooking time)\b/i.test(subject)) return;
  const named = Boolean(subject && !/^(?:it|them|that|those)$/i.test(subject));
  const foods = recipe.ingredients.map(foodLine);
  const directions = methodDirections(recipe, step);
  if (!directions.length && (step || recipe.instructions.length)) {
    return { answerStatus: "needs_clarification", answer: "Which cooking method are you following? Open its step so I can use the cutting instructions for that method.", evidenceIds: [] };
  }
  const cuts = directions.flatMap(direction => directionCuts(direction, foods));
  const here = step ? cuts.filter(cut => cut.step.evidenceId === step.evidenceId) : cuts;
  const affirmative = here.filter(cut => !cut.guarded);
  let options = named ? foods.filter(food => food.key === foodKey(subject)) : [...new Set((affirmative.length ? affirmative : here).map(cut => cut.food))];
  if (!options.length && named) options = foods.filter(food => food.key.endsWith(` ${foodKey(subject)}`));
  if (!options.length && !named) options = step ? foods.filter(food => mentions(step.text, food)) : foods.filter(food => cutWord.test(food.preparation));
  if (!options.length && !named) options = foods;
  if (options.length !== 1) {
    const choices = (options.length ? options : foods).slice(0, 5);
    return { answerStatus: "needs_clarification", answer: `Which ingredient do you want to cut?${choices.length ? ` The recipe lists ${new Intl.ListFormat("en", { type: "conjunction" }).format(choices.map(food => food.name))}.` : ""}`,
      evidenceIds: choices.map(food => food.id) };
  }

  const food = options[0];
  const local = here.filter(cut => cut.food === food);
  const relevant = local.length ? local : cuts.filter(cut => cut.food === food);
  const ingredientPrep = cutWord.test(food.preparation);
  const details = [...(ingredientPrep ? [food.preparation] : []), ...relevant.map(cut => cut.detail)];
  const evidenceIds = [...new Set([food.id, ...relevant.map(cut => cut.step.evidenceId)])];
  const quotes = [...new Set(relevant.map(cut => `Step ${cut.step.number} says “${cut.sentence}”`))];
  if (ingredientPrep || !quotes.length) quotes.unshift(`The ingredient list calls for “${food.line}”.`);
  const answer = quotes.join(" ");
  if (relevant.some(cut => cut.guarded) || /\b(?:grated|not|or|without|instead|if|optional)\b/i.test(food.preparation)) {
    return { answer, answerStatus: "answered", evidenceIds };
  }
  const noteExceptions = (recipe.sourceNotes ?? []).flatMap((text, index) => {
    const evidenceId = `N${index + 1}`;
    const cutsInNote = directionCuts({ text, evidenceId, number: 0 }, foods);
    return cutsInNote.some(cut => cut.food === food && cut.guarded) ? [{ text, evidenceId }] : [];
  });
  if (details.length && noteExceptions.length) {
    const notes = noteExceptions.map(note => `Recipe note: “${note.text}”`).join(" ");
    return { answer: `${answer} ${notes} Which preparation applies to your ${food.name}?`,
      answerStatus: "needs_clarification", evidenceIds: [...evidenceIds, ...noteExceptions.map(note => note.evidenceId)] };
  }
  if (details.length > 1 && differs(details)) {
    return { answer: `${answer} These give different cutting directions for ${food.name}. Which preparation are you following?`, answerStatus: "needs_clarification", evidenceIds };
  }
  if (!details.length) {
    const requested = technique(match[1]);
    const produce = /^(?:(?:red|yellow|green|white|sweet|russet|baby|fresh) )*(?:onion|carrot|potato|bell pepper|zucchini|courgette|garlic|garlic clove|cucumber|mushroom|tomato|eggplant|aubergine|apple|celery|cabbage|leek|parsley)$/i.test(food.key);
    const caution = /\b(?:whole|intact|uncut|grat(?:e|ed)|without|avoid|never|not)\b|n['’]t\b/i;
    const restricted = [food.line, ...directions.map(direction => direction.text), ...(recipe.sourceNotes ?? [])].some(text => mentions(text, food) && caution.test(text));
    return { answer: `${answer} I couldn't identify a required cut or piece size for ${food.name} in this method.`, answerStatus: "unsupported", evidenceIds,
      ...(produce && !restricted && requested !== "cut" ? { cookingTip: tips[requested] } : {}) };
  }
  const style = details.map(technique).findLast(value => value !== "cut") ?? "cut";
  const specified = style === "halve" || style === "quarter" || size.test(details.join(" "));
  const sizing = style === "slice" || style === "rounds" ? "an exact thickness" : "an exact piece size";
  return { answer: specified ? answer : `${answer} ${relevant.length ? "The direction" : "The ingredient list"} doesn't give ${sizing}.`, answerStatus: "answered",
    evidenceIds, cookingTip: tips[style] };
}
