import type { Recipe } from "./recipe-types";

/** Cosmetic display normalization only; canonical source evidence stays intact. */
export function cookingStepText(value: string): string {
  return value.trim().replace(/^(?:step\s+)?\d+[.)]\s+/i, "").trim();
}

export function requestedCookingStep(query: string): number | undefined {
  const match = /\b(?:step|direction|instruction)\s*#?\s*(\d{1,3})\b/i.exec(query);
  return match ? Number(match[1]) : undefined;
}

/** An imperative ending in "instructions" or "method" is still a source step. */
export function isCookingMethodHeading(value: string): boolean {
  const heading = cookingStepText(value).replace(/:$/, "").trim();
  return /^(?:instant pot|pressure cooker|stove ?top|oven|slow cooker|air fryer|grill|hob)(?:\s+(?:instructions?|directions?|method))?$/i.test(heading)
    || /^(?:(?:main|alternate|alternative|original) )?method$/i.test(heading);
}
export type SourceDirection = { evidenceId: string; number: number; text: string };

/** Keep source IDs alongside visible step numbers. Discussion without a
 * selected method can use its directions only when there is a single method. */
export function methodDirections(recipe: Pick<Recipe, "instructions">, focus?: SourceDirection | null): SourceDirection[] {
  const methods: SourceDirection[][] = [];
  let method: SourceDirection[] = [];
  for (const [index, raw] of recipe.instructions.entries()) {
    const text = cookingStepText(raw);
    if (isCookingMethodHeading(text)) {
      method = [];
    } else if (text && !/^(?:step\s*#?\s*\d+|instructions?|directions?)\s*[:.)-]?$/i.test(text)) {
      if (!method.length) methods.push(method);
      method.push({ evidenceId: `S${index + 1}`, number: method.length + 1, text: raw });
    }
  }
  if (!focus) return methods.length === 1 ? methods[0] : [];
  return methods.find(steps => {
    const candidate = steps[focus.number - 1];
    return candidate?.evidenceId === focus.evidenceId && candidate.text === focus.text;
  }) ?? [];
}
