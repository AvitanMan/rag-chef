/** Cosmetic display normalization only; canonical source evidence stays intact. */
export function cookingStepText(value: string): string {
  return value.trim().replace(/^(?:step\s+)?\d+[.)]\s+/i, "").trim();
}

/** An imperative ending in "instructions" or "method" is still a source step. */
export function isCookingMethodHeading(value: string): boolean {
  const heading = cookingStepText(value).replace(/:$/, "").trim();
  return /^(?:instant pot|pressure cooker|stove ?top|oven|slow cooker|air fryer|grill|hob)(?:\s+(?:instructions?|directions?|method))?$/i.test(heading)
    || /^(?:(?:main|alternate|alternative|original) )?method$/i.test(heading);
}
