import { canonicalIngredient, normalizePlanningIngredient, parseMeasure } from "./quantities";
import type { PantryStock } from "./kitchen-types";
import { EMPTY_KITCHEN } from "./kitchen-types";
import { validateKitchenWrite } from "./kitchen-validation";

export type PantryInputRow = Pick<PantryStock, "name" | "measure">;

/** Explicit name:amount entries retain notes; plain entries split only known measures. */
export function parsePantryInput(text: string): PantryInputRow[] {
  const lines = text.split(/[;\n]+/).flatMap((line) => line.split(/,(?!\s*(?:cooked|uncooked|raw|dry|dried)(?:\s*[:\t]|\s+\d|\s*(?:,|$)))/i))
    .map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => {
    const separator = line.search(/[:\t]/);
    if (separator >= 0) return { name: line.slice(0, separator).trim(), measure: line.slice(separator + 1).trim() };
    const normalized = normalizePlanningIngredient({ name: line, measure: "" });
    if (normalized.measure) return normalized;
    const words = line.split(/\s+/);
    for (let index = 1; index < words.length; index++) {
      const measure = words.slice(index).join(" ");
      if (parseMeasure(measure)) return { name: words.slice(0, index).join(" "), measure };
    }
    return { name: line, measure: "" };
  });
}

export function pantryInputProblem(rows: PantryInputRow[], pantry: PantryStock[]): string {
  if (!rows.length) return "Enter at least one ingredient.";
  if (rows.length + pantry.length > 500) return "Your pantry can hold up to 500 rows. Add fewer ingredients.";
  try {
    validateKitchenWrite({ revision: 0, state: { ...EMPTY_KITCHEN, pantry: rows.map((row, index) => ({ id: `preview-${index}`, name: row.name.trim(), measure: row.measure.trim() })) } });
  } catch (error) {
    return error instanceof Error
      ? error.message.replace(/state\.pantry\[(\d+)\]\.(name|measure)/g, (_, index, field) => `Ingredient ${Number(index) + 1} ${field === "measure" ? "amount" : "name"}`)
      : "Check ingredient names and amounts.";
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const key = canonicalIngredient(row.name);
    if (seen.has(key)) return `“${row.name}” appears more than once. Edit or remove the repeated row.`;
    seen.add(key);
  }
  return "";
}
