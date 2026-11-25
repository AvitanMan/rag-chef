import { boilingOrderHelp } from "./chef-boiling-order";
import { cuttingHelp } from "./chef-cutting-help";
import type { ChefRequest } from "./chef-schema";
import { canonicalIngredient } from "./quantities";
import type { Recipe } from "./recipe-types";
import type { SourceDirection } from "./recipe-instructions";

export type PreparationAnswer = {
  answer: string;
  answerStatus: "answered" | "unsupported" | "needs_clarification";
  evidenceIds: string[];
  cookingTip?: string;
  technique?: "Boiling";
};

/** A terse reply can complete Chef's last clarification. Re-establish both
 * the question and its answer from the currently selected recipe and method. */
export function preparationHelp(recipe: Recipe, step: SourceDirection | null, query: string, history?: ChefRequest["history"]): PreparationAnswer | undefined {
  const args = { recipe, step, query };
  const direct = cuttingHelp(args) ?? boilingOrderHelp(args);
  if (direct) return direct;

  const previous = history?.at(-2), clarification = history?.at(-1);
  if (previous?.role !== "user" || clarification?.role !== "assistant") return;
  const ingredient = query.trim().replace(/[.!?]+$/, "").replace(/^(?:before (?:I add|adding) |adding )/i, "");
  if (!/^(?:[\p{L}'’-]+\s+){0,5}[\p{L}'’-]+$/u.test(ingredient)) return;
  const prior = { ...args, query: previous.content };
  const cut = cuttingHelp(prior);
  if (cut?.answerStatus === "needs_clarification" && cut.answer === clarification.content) {
    const resolved = cuttingHelp({ ...prior, ingredient });
    if (resolved && resolved.answerStatus !== "needs_clarification") return resolved;
  }
  const boil = boilingOrderHelp(prior);
  if (boil?.answerStatus === "needs_clarification" && boil.answer === clarification.content) {
    const food = canonicalIngredient(ingredient.replace(/^the\s+/i, ""));
    const row = recipe.ingredients.find(item => canonicalIngredient(item.name.split(",")[0]) === food);
    if (row) return boilingOrderHelp({ ...args, query: `Should I boil the water before adding ${row.name.split(",")[0].trim()}?` });
  }
}
