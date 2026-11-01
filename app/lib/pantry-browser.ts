import type { PantryStock } from "./kitchen-types";
import { normalizeRecipeSearch } from "./recipe-browser";

export type PantrySort = "current" | "name" | "useBy";

/** Display-only filtering and sorting; stock batches retain their identities. */
export function browsePantry(items: PantryStock[], query: string, sort: PantrySort): PantryStock[] {
  const words = normalizeRecipeSearch(query).split(" ").filter(Boolean);
  const matches = items.filter(item => words.every(word => normalizeRecipeSearch(item.name).includes(word)));
  if (sort === "current") return matches;
  return matches.sort((a, b) => (sort === "useBy" ? (a.useBy || "9999-99-99").localeCompare(b.useBy || "9999-99-99") : 0)
    || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}
