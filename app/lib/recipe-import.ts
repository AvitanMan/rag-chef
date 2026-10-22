import type { Recipe } from "./recipe-types";
import type { ApprovedRecipeSourceInput } from "./recipe-store";
import { sha256Hex } from "./recipe-embeddings";

export const WIKIBOOKS_SOURCE: ApprovedRecipeSourceInput = {
  id: "wikibooks", name: "Wikibooks Cookbook", url: "https://en.wikibooks.org/wiki/Cookbook:Recipes",
  licenseId: "CC-BY-SA-4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  termsUrl: "https://en.wikibooks.org/wiki/Wikibooks:Copyrights",
  permissionBasis: "Wikibooks text reuse under CC BY-SA 4.0; retain attribution, license and change notices.",
  attributionText: "Wikibooks contributors (see source page and its history). Ingredients and directions extracted; formatting normalized. Source wording retained. Normalized recipe text is available under CC BY-SA 4.0.",
  approvalStatus: "approved", approvedBy: "local prototype owner",
  allowDisplay: true, allowCache: true, allowIndexText: true, allowEmbed: true,
  allowDerive: true, allowCommercial: false, allowImages: false,
};

export interface ImportDraft {
  sourceUrl: string;
  title: string;
  ingredients: { name: string; measure: string }[];
  instructions: string[];
  servings?: number;
  reviewed: true;
  reviewHash: string;
}

export function canonicalRecipeUrl(value: string): string {
  const url = new URL(value);
  const path = decodeURIComponent(url.pathname).normalize("NFC").replaceAll(" ", "_");
  if (url.protocol !== "https:" || url.hostname !== "en.wikibooks.org" || url.port || url.username || url.password || url.search ||
      !path.startsWith("/wiki/Cookbook:") || path.length <= 15 || /[\\\x00-\x1f\x7f]/.test(path) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) {
    throw new Error("Only HTTPS English Wikibooks Cookbook recipe URLs are supported.");
  }
  return `https://en.wikibooks.org${path.split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`).replaceAll("%3A", ":")).join("/")}`;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error("Invalid recipe text.");
  return value;
}

export async function validateImportDraft(value: unknown): Promise<ImportDraft> {
  const row = object(value);
  const allowed = new Set(["sourceUrl", "title", "ingredients", "instructions", "servings", "reviewed", "reviewHash"]);
  if (Object.keys(row).some((key) => !allowed.has(key)) || row.reviewed !== true) throw new Error("Each recipe must have explicit review approval and no unsupported fields.");
  const sourceUrl = canonicalRecipeUrl(text(row.sourceUrl, 1500));
  const title = text(row.title, 300);
  if (!Array.isArray(row.ingredients) || !row.ingredients.length || row.ingredients.length > 200 || !Array.isArray(row.instructions) || !row.instructions.length || row.instructions.length > 300) throw new Error("Recipes need 1–200 ingredients and 1–300 directions.");
  const ingredients = row.ingredients.map((value) => {
    const ingredient = object(value);
    if (Object.keys(ingredient).some((key) => key !== "name" && key !== "measure")) throw new Error("Invalid ingredient fields.");
    return { name: text(ingredient.name, 200), measure: text(ingredient.measure, 160, true) };
  });
  const instructions = row.instructions.map((step) => text(step, 4000));
  const servings = row.servings;
  if (servings !== undefined && (typeof servings !== "number" || !Number.isFinite(servings) || servings <= 0 || servings > 10_000)) throw new Error("Servings must be an explicit positive number.");
  // This exact representation is shared with the Python review prompt.
  const reviewHash = await sha256Hex(JSON.stringify({ sourceUrl, title, ingredients, instructions, servings: servings ?? null }));
  if (row.reviewHash !== reviewHash) throw new Error("Recipe changed since review. Review and approve it again.");
  return { sourceUrl, title, ingredients, instructions, ...(servings === undefined ? {} : { servings: servings as number }), reviewed: true, reviewHash };
}

export async function draftRecipe(draft: ImportDraft): Promise<Recipe> {
  return {
    id: await sha256Hex(draft.sourceUrl), title: draft.title, sourceUrl: draft.sourceUrl,
    image: null, category: "Cookbook", cuisine: "International", tags: [],
    ingredients: draft.ingredients, instructions: draft.instructions,
    ...(draft.servings === undefined ? {} : { servings: draft.servings }),
    source: { name: WIKIBOOKS_SOURCE.name, url: WIKIBOOKS_SOURCE.url, licenseId: WIKIBOOKS_SOURCE.licenseId, licenseUrl: WIKIBOOKS_SOURCE.licenseUrl!, attributionText: WIKIBOOKS_SOURCE.attributionText! },
  };
}
