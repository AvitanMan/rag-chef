import { canonicalIngredient, normalizePlanningIngredient, parseMeasure } from "./quantities";
import type { PantryStock } from "./kitchen-types";
import { EMPTY_KITCHEN } from "./kitchen-types";
import { validateKitchenWrite } from "./kitchen-validation";

export type PantryInputRow = Pick<PantryStock, "name" | "measure" | "useBy"> & {
  originalText?: string;
  reviewReasons?: string[];
};

const NUMBER = /[\d¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/;
const UNCERTAIN_WORDING = /[()[\]–—+~≈<>]|(?:^|\s)[−-]\s*\d|\d\s*-\s*\d|\b(?:to|or|and|plus|about|approximately|approx|roughly|around|nearly|almost|some|several|handfuls?)\b|\b(?:as needed|as required|at least|at most|up to)\b|^(?:a|an|one|two|three|four|five|six|half|quarter|couple|few|dozen)\b/i;
const COMMA_DESCRIPTION = /^(?:(?:(?:finely|coarsely|roughly|thinly|thickly|freshly|lightly|well)\s+)?(?:chopped|diced|minced|sliced|grated|shredded|crushed|peeled|pitted|seeded|deseeded|drained|rinsed|washed|trimmed|halved|quartered|divided|sifted|softened|melted|beaten|thawed|frozen|canned|roasted|toasted|boiled|steamed|prepared|cut|torn)\b|(?:cooked|uncooked|raw|dry|dried)(?=\s*(?:[:\t,]|[\d¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]|$)|\s+(?:and|or|about|approximately|until|overnight)\b)|(?:to taste|as needed|as required|for serving|for garnish|seeds removed|stems removed)\b)/i;
const UNCERTAIN_REASON = "Ingredient or amount is unclear. Text was kept unchanged; check the name and enter an amount only if known.";
const DESCRIPTION_REASON = "Comma description kept with the ingredient. Check that this is one batch, not separate ingredients.";

function splitPantryLine(line: string): string[] {
  const entries: string[] = [];
  let start = 0, depth = 0;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === "(" || character === "[") depth++;
    else if (character === ")" || character === "]") depth = Math.max(0, depth - 1);
    if (character !== "," || depth) continue;
    // A decimal/thousands separator or a preparation clause is not a new stock.
    if (/\d/.test(line[index - 1] ?? "") && /\d/.test(line[index + 1] ?? "")) continue;
    if (COMMA_DESCRIPTION.test(line.slice(index + 1).trimStart())) continue;
    entries.push(line.slice(start, index).trim());
    start = index + 1;
  }
  entries.push(line.slice(start).trim());
  return entries.filter(Boolean);
}

function withReview(row: PantryInputRow, originalText: string, reviewReasons: string[]): PantryInputRow {
  return reviewReasons.length ? { ...row, originalText, reviewReasons } : row;
}

/** Explicit name:amount entries retain notes; uncertain plain entries never guess amounts. */
export function parsePantryInput(text: string): PantryInputRow[] {
  return text.split(/[;\n]+/).flatMap(splitPantryLine).map((line) => {
    const reasons = line.includes(",") ? [DESCRIPTION_REASON] : [];
    const separator = line.search(/[:\t]/);
    if (separator >= 0) {
      const row = { name: line.slice(0, separator).trim(), measure: line.slice(separator + 1).trim() };
      if (!row.measure || UNCERTAIN_WORDING.test(row.name) || NUMBER.test(row.name)) reasons.push(UNCERTAIN_REASON);
      return withReview(row, line, reasons);
    }
    const original = { name: line, measure: "" };
    const onlyMeasure = parseMeasure(line);
    if (UNCERTAIN_WORDING.test(line) || (onlyMeasure && onlyMeasure.dimension !== "count:egg")) {
      return withReview(original, line, [...reasons, UNCERTAIN_REASON]);
    }
    // A leading amount plus comma prose can be a measure-only note ("2 tbsp, divided").
    const normalized = line.includes(",") ? original : normalizePlanningIngredient(original);
    if (normalized.measure && !NUMBER.test(normalized.name)) return withReview(normalized, line, reasons);
    const words = line.split(/\s+/);
    for (let index = 1; index < words.length; index++) {
      const name = words.slice(0, index).join(" "), measure = words.slice(index).join(" ");
      if (!NUMBER.test(name) && parseMeasure(measure)) return withReview({ name, measure }, line, reasons);
    }
    if (NUMBER.test(line)) reasons.push(UNCERTAIN_REASON);
    return withReview(original, line, reasons);
  });
}

/** Only a bare, new ingredient can skip the preview; existing batches are never merged. */
export function pantryInputNeedsReview(rows: PantryInputRow[], pantry: PantryStock[]): boolean {
  const existing = new Set(pantry.map((stock) => canonicalIngredient(stock.name)));
  return rows.length > 1 || rows.some((row) => Boolean(row.measure.trim() || row.useBy?.trim() || row.reviewReasons?.length)
    || NUMBER.test(row.name) || UNCERTAIN_WORDING.test(row.name) || row.name.includes(",") || existing.has(canonicalIngredient(row.name)));
}

/** Project a validated draft onto persistent fields, without leaking preview metadata. */
export function pantryInputStock(row: PantryInputRow, id: string): PantryStock {
  const useBy = row.useBy?.trim();
  return { id, name: row.name.trim().toLowerCase(), measure: row.measure.trim(), ...(useBy ? { useBy } : {}) };
}

export function pantryInputProblem(rows: PantryInputRow[], pantry: PantryStock[]): string {
  if (!rows.length) return "Enter at least one ingredient.";
  if (rows.length + pantry.length > 500) return "Your pantry can hold up to 500 rows. Add fewer ingredients.";
  try {
    validateKitchenWrite({ revision: 0, state: { ...EMPTY_KITCHEN, pantry: rows.map((row, index) => pantryInputStock(row, `preview-${index}`)) } });
  } catch (error) {
    return error instanceof Error
      ? error.message.replace(/state\.pantry\[(\d+)\]\.(name|measure|useBy)/g, (_, index, field) => `Ingredient ${Number(index) + 1} ${field === "measure" ? "amount" : field === "useBy" ? "use-by date" : "name"}`)
      : "Check ingredient names, amounts and use-by dates.";
  }
  return "";
}
