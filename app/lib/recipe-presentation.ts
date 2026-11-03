import { formatMeasure, parseMeasure } from "./quantities";

/** Convert a complete, unambiguous measure using the shared culinary units. */
export function metricMeasure(measure: string, metric: boolean): string {
  if (!metric) return measure;
  const parsed = parseMeasure(measure);
  // Preserve ranges, package sizes, qualifiers and count wording as supplied.
  if (!parsed || (parsed.dimension !== "mass" && parsed.dimension !== "volume")) return measure;
  const sourceUnit = measure.trim().match(/[a-z][a-z ]*\.?$/i)?.[0].replace(/\.$/, "").trim();
  // Already metric amounts retain their original precision and wording.
  if (sourceUnit && /^(?:g|gr|grams?|grammes?|kg|kilograms?|kilogrammes?|mg|milligrams?|ml|milliliters?|millilitres?|l|liters?|litres?)$/i.test(sourceUnit)) return measure;
  const rounded = Number(parsed.quantity.toFixed(2));
  return rounded === 0 && parsed.quantity > 0 ? measure : formatMeasure(rounded, parsed.unit);
}
