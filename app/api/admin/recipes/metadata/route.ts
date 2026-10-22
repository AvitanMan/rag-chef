import { authorizeCatalogRequest } from "@/app/lib/catalog-auth";
import { listCatalogRecipes, reviewRecipeMetadata } from "@/app/lib/recipe-store";
import { normalizePlanningIngredient, parseMeasure } from "@/app/lib/quantities";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
export async function GET(request: Request): Promise<Response> {
  const denied = authorizeCatalogRequest(request); if (denied) return denied;
  try {
    const entries = (await listCatalogRecipes(1000)).map((item) => {
      const amountGaps = item.recipe.ingredients.flatMap((original, index) => {
        const normalized = normalizePlanningIngredient(original);
        if (parseMeasure(normalized.measure)) return [];
        const text = `${original.measure} ${original.name}`;
        const classification = /\boptional\b/i.test(text) ? "optional_unquantified" : /\b(?:or|to)\b|\d\s*[-–]\s*\d/i.test(text) ? "range_or_alternative" : normalized.measure ? "free_text_measure" : "unspecified_measure";
        return [{ index, name: original.name, measure: original.measure, classification }];
      });
      return { recipeId: item.recipe.id, title: item.recipe.title, sourceUrl: item.recipe.sourceUrl, contentHash: item.contentHash, version: item.version, recipe: item.recipe, metadata: item.metadata ?? null,
        quality: { sourceServings: item.recipe.servings ?? null, amountGaps, totalTimeKnown: item.metadata?.totalMinutes != null && item.metadata.provenance.totalMinutes?.basis === "source", metadataReviewed: Boolean(item.metadata) } };
    });
    return json({ schemaVersion: 1, summary: { recipes: entries.length, coreDinners: entries.filter((item) => item.metadata?.coreDinner).length, knownServings: entries.filter((item) => item.quality.sourceServings !== null).length, amountReviewRecipes: entries.filter((item) => item.quality.amountGaps.length).length, knownTotalTimes: entries.filter((item) => item.quality.totalTimeKnown).length }, entries });
  } catch { return json({ error: "Catalog metadata is unavailable." }, 503); }
}

export async function POST(request: Request): Promise<Response> {
  const denied = authorizeCatalogRequest(request); if (denied) return denied;
  if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") return json({ error: "Send application/json." }, 415);
  let input: { entries: unknown[]; preview?: boolean };
  try {
    const reader = request.body?.getReader(); if (!reader) throw new Error();
    const chunks = []; let total = 0;
    while (true) { const chunk = await reader.read(); if (chunk.done) break; total += chunk.value.byteLength; if (total > 1_000_000) { await reader.cancel(); return json({ error: "Metadata review is too large." }, 413); } chunks.push(chunk.value); }
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!input || typeof input !== "object" || Object.keys(input).some((key) => !["entries", "preview"].includes(key)) || !Array.isArray(input.entries) || (input.preview !== undefined && typeof input.preview !== "boolean")) throw new Error();
  } catch { return json({ error: "Send reviewed metadata entries as valid JSON." }, 400); }
  try { return json({ ok: true, preview: input.preview === true, results: await reviewRecipeMetadata(input.entries, input.preview === true) }); }
  catch (error) { return json({ error: error instanceof Error ? error.message : "Metadata review could not be saved." }, 400); }
}
