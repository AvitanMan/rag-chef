import { canonicalIngredient, normalizePlanningIngredient, pantryStockEligibility, parseMeasure } from "./quantities";
import type { PantryLocation, PantryStock } from "./kitchen-types";
import { EMPTY_KITCHEN } from "./kitchen-types";
import { validateKitchenWrite } from "./kitchen-validation";

export type PantryInputRow = Pick<PantryStock, "name" | "measure" | "useBy" | "location"> & {
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

/** Keys identify rows within one parsed draft; reconcile placements when the text changes. */
export function pantryDraftRows(text: string): Array<{ key: string; row: PantryInputRow }> {
  const occurrences = new Map<string, number>();
  return parsePantryInput(text).map(row => {
    const occurrence = occurrences.get(row.name) ?? 0;
    occurrences.set(row.name, occurrence + 1);
    return { key: JSON.stringify([row.name, occurrence]), row };
  });
}

type PantryDraftRow = ReturnType<typeof pantryDraftRows>[number];

function groupDraftRows(rows: PantryDraftRow[], identify: (row: PantryInputRow) => string): Map<string, PantryDraftRow[]> {
  const groups = new Map<string, PantryDraftRow[]>();
  for (const entry of rows) {
    const identity = identify(entry.row);
    const group = groups.get(identity) ?? [];
    group.push(entry);
    groups.set(identity, group);
  }
  return groups;
}

/** Keep placements with retained batches, and forget choices whose row is ambiguous or removed. */
export function reconcilePantryDraftLocations(
  previousText: string, nextText: string, locations: Record<string, PantryLocation | "">,
): Record<string, PantryLocation | ""> {
  const previous = groupDraftRows(pantryDraftRows(previousText), row => row.name);
  const next = groupDraftRows(pantryDraftRows(nextText), row => row.name);
  const result: Record<string, PantryLocation | ""> = {};
  const batchIdentity = (row: PantryInputRow) => JSON.stringify([row.name, row.measure, row.useBy]);
  const copyLocation = (from: PantryDraftRow, to: PantryDraftRow) => {
    if (Object.hasOwn(locations, from.key)) result[to.key] = locations[from.key];
  };
  for (const [name, nextRows] of next) {
    const previousRows = previous.get(name) ?? [];
    const previousBatches = groupDraftRows(previousRows, batchIdentity);
    const nextBatches = groupDraftRows(nextRows, batchIdentity);
    const matchedPrevious = new Set<string>(), matchedNext = new Set<string>();
    for (const [identity, nextBatch] of nextBatches) {
      const previousBatch = previousBatches.get(identity) ?? [];
      // A changed number of identical batches cannot identify which copy was edited or deleted.
      if (previousBatch.length !== nextBatch.length) continue;
      nextBatch.forEach((entry, index) => {
        copyLocation(previousBatch[index], entry);
        matchedPrevious.add(previousBatch[index].key);
        matchedNext.add(entry.key);
      });
    }
    const removed = previousRows.filter(entry => !matchedPrevious.has(entry.key));
    const added = nextRows.filter(entry => !matchedNext.has(entry.key));
    // One remaining pair with an unchanged row count is an unambiguous amount edit.
    if (previousRows.length === nextRows.length && removed.length === 1 && added.length === 1) {
      copyLocation(removed[0], added[0]);
    }
  }
  return result;
}

/** Only a bare, new ingredient can skip the preview; existing batches are never merged. */
export function pantryInputNeedsReview(rows: PantryInputRow[], pantry: PantryStock[]): boolean {
  const existing = new Set(pantry.map(pantryEntryKey));
  return rows.length > 1 || rows.some((row) => Boolean(row.measure.trim() || row.useBy?.trim() || row.reviewReasons?.length)
    || NUMBER.test(row.name) || UNCERTAIN_WORDING.test(row.name) || row.name.includes(",") || existing.has(pantryEntryKey(row)));
}

function pantryEntryKey(row: Pick<PantryStock, "name" | "location">): string {
  return JSON.stringify([canonicalIngredient(row.name), row.location ?? null]);
}

/** A simple saved list records presence once; measured or ambiguous additions still need review. */
export function quickPantryAdditions(rows: PantryInputRow[], pantry: PantryStock[], today: string): PantryInputRow[] | null {
  if (!rows.length || rows.some(row => pantryInputNeedsReview([row], []))) return null;
  const existing = new Set(pantry.map(pantryEntryKey));
  const available = new Set(pantry.filter(stock => pantryStockEligibility(stock, today).eligible).map(pantryEntryKey));
  const additions: PantryInputRow[] = [];
  for (const row of rows) {
    const key = pantryEntryKey(row);
    // An old or finished batch needs an explicit decision, rather than silently reviving it.
    if (existing.has(key) && !available.has(key)) return null;
    if (!available.has(key)) { additions.push(row); available.add(key); }
  }
  return additions;
}

/** Project a validated draft onto persistent fields, without leaking preview metadata. */
export function pantryInputStock(row: PantryInputRow, id: string): PantryStock {
  const useBy = row.useBy?.trim();
  return { id, name: row.name.trim().toLowerCase(), measure: row.measure.trim(), ...(useBy ? { useBy } : {}),
    ...(row.location !== undefined ? { location: row.location } : {}) };
}

export function pantryInputProblem(rows: PantryInputRow[], pantry: PantryStock[]): string {
  if (!rows.length) return "Enter at least one ingredient.";
  if (rows.length + pantry.length > 500) return "Your pantry can hold up to 500 rows. Add fewer ingredients.";
  try {
    validateKitchenWrite({ revision: 0, state: { ...EMPTY_KITCHEN, pantry: rows.map((row, index) => pantryInputStock(row, `preview-${index}`)) } });
  } catch (error) {
    return error instanceof Error
      ? error.message.replace(/state\.pantry\[(\d+)\]\.(name|measure|useBy|location)/g, (_, index, field) => `Ingredient ${Number(index) + 1} ${field === "measure" ? "amount" : field === "useBy" ? "use-by date" : field === "location" ? "storage location" : "name"}`)
      : "Check ingredient names, amounts and use-by dates.";
  }
  return "";
}
