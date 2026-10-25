import { normalizeRecipeSearch } from "./recipe-browser";
import { normalizeConstraints, normalizeEquipmentName } from "./recipe-constraints";
import type { RecipeConstraints } from "./recipe-types";

export const STOP_WORDS = new Set("a an and are as at be by can cook cooking could dish dishes do find for from give have help how i in ingredients is it like make meal meals me most my of on only or pantry please perishable quick recipe recipes recommend some something suggest suggestions that the to tonight use want what when which with would dinner ideas using".split(" "));
const REQUEST_EQUIPMENT = new Set(["oven", "stovetop", "microwave", "blender", "slow cooker", "pressure cooker", "air fryer", "grill"]);

export interface RecipeQueryIntent {
  topic: string;
  broad: boolean;
  mode: "recommendation" | "adaptation";
  excludedIngredients: string[];
  excludedEquipment?: string[];
  diets: string[];
  adaptationDiets: string[];
  maxTotalMinutes?: number;
}

export function queryRequestsAdaptation(query: string, hasRecipeFocus = false): boolean {
  const request = query.replace(/\bwithout\s+(?:changing|rewriting|altering|modifying)\b[^.;!?]*/gi, "");
  return /\b(substitut\w*|replac\w*|instead|swap\w*|adapt\w*|chang\w*|can i use|could i use|scal(?:e|ing)|halv(?:e|ing)|doubl(?:e|ing))\b/i.test(request)
    || hasRecipeFocus && /\bmake\b.+\b(?:vegan|vegetarian|meatless|meat[ -]free|gluten[ -]free|dairy[ -]free)\b/i.test(request)
    || /\b(?:halve|reduce|cut)\b.+\b(?:salt|sugar|butter|oil|amount)\b/i.test(request);
}

/** Deterministic intent only: do not let generated text relax stored exclusions. */
export function recipeQueryIntent(query: string, hasRecipeFocus = false): RecipeQueryIntent {
  const text = query.normalize("NFKD").replace(/\p{M}/gu, "").replaceAll("’", "'").toLowerCase();
  const excluded: string[] = [];
  const excludedEquipment: string[] = [];
  const equipmentAware = text.replace(/\b(?:do not have|don't have|no access to|without access to)\s+(?:(?:an?|the|my)\s+)?(oven|stove(?:top| top)?|hob|microwave|blender|slow cooker|pressure cooker|air fryer|grill)\b/g, (_clause, name: string) => {
    excludedEquipment.push(normalizeEquipmentName(name)); return " ";
  });
  const positive = equipmentAware.replace(/\b(?:do\s+not\s+use|don't\s+use|leave\s+out|without|excluding|exclude|avoid|no|not)\s+(.+?)(?=[.;!?]|\b(?:but|with|using|under|within|for|instead|please)\b|$)/g, (clause, ingredients: string) => {
    if (/^(?:only|just|necessarily|bake|cook|need|longer|more|less|changing|rewriting|altering|modifying)\b/.test(ingredients.trim())) return clause;
    const terms = ingredients.split(/,|\band\b|\bor\b/g).map((item) => normalizeRecipeSearch(item)
      .replace(/^(?:(?:do not use|don t use|leave out|without|excluding|exclude|avoid|no|not)\s+)+/, "")
      .replace(/^using\s+/, "").replace(/^(?:any|all|the|a|an|my)\s+/, "").replace(/\s+(?:dinners?|dishes|recipes|meals)$/, "")).filter(Boolean);
    for (const term of terms) {
      const equipment = normalizeEquipmentName(term);
      if (REQUEST_EQUIPMENT.has(equipment)) excludedEquipment.push(equipment);
      else excluded.push(term);
    }
    return " ";
  });
  const mode = queryRequestsAdaptation(query, hasRecipeFocus) || hasRecipeFocus && excluded.length > 0 ? "adaptation" : "recommendation";
  const namedAdaptation = mode === "adaptation" && hasRecipeFocus;
  const normalized = normalizeRecipeSearch(positive);
  const time = normalized.match(/\b(?:under|within|less than|up to|in)\s+(\d{1,3})\s*(?:minutes?|mins?)\b/);
  const diets = [
    ...( /\bvegan\b/.test(normalized) ? ["vegan"] : []),
    ...( /\b(?:vegetarian|meatless|meat free)\b/.test(normalized) ? ["vegetarian"] : []),
    ...( /\bgluten free\b/.test(normalized) ? ["gluten_free"] : []),
    ...( /\blow carb\b/.test(normalized) ? ["low_carb"] : []),
  ];
  const dairyFree = /\bdairy free\b/.test(normalized);
  const topic = normalized.replace(/\b(?:under|within|less than|up to|in)\s+\d{1,3}\s*(?:minutes?|mins?)\b/g, " ")
    .replace(/\b(?:vegan|vegetarian|meatless|meat free|dairy free|gluten free|low carb)\b/g, " ")
    .split(" ").filter((word) => word && word !== "but" && !STOP_WORDS.has(word)).join(" ");
  return { topic, broad: !topic, mode, excludedIngredients: namedAdaptation ? [] : [...new Set([...excluded, ...(dairyFree ? ["dairy"] : [])])], ...(excludedEquipment.length ? { excludedEquipment: [...new Set(excludedEquipment)] } : {}), diets: namedAdaptation ? [] : diets, adaptationDiets: namedAdaptation ? [...diets, ...(dairyFree ? ["dairy_free"] : [])] : [], ...(time && Number(time[1]) > 0 ? { maxTotalMinutes: Number(time[1]) } : {}) };
}

export function constraintsForRecipeQuery(query: string, constraints: RecipeConstraints, hasRecipeFocus = false): RecipeConstraints {
  const intent = recipeQueryIntent(query, hasRecipeFocus);
  const parsed = normalizeConstraints({ ...constraints, diets: [...constraints.diets, ...intent.diets], excludedIngredients: [...(constraints.excludedIngredients ?? []), ...intent.excludedIngredients], excludedEquipment: [...(constraints.excludedEquipment ?? []), ...(intent.excludedEquipment ?? [])] });
  const maximum = [constraints.maxTotalMinutes, intent.maxTotalMinutes].filter((x): x is number => x !== undefined);
  return { ...parsed, ...(maximum.length ? { maxTotalMinutes: Math.min(...maximum) } : {}) };
}

export function recipeRetrievalQuery(query: string, hasRecipeFocus = false): string {
  const intent = recipeQueryIntent(query, hasRecipeFocus);
  return intent.excludedIngredients.length || intent.excludedEquipment?.length ? intent.topic : query.trim();
}
