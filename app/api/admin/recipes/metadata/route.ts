import { withGatewayTrace } from "@/app/lib/service-observability";
import { authorizeCatalogRequest } from "@/app/lib/catalog-auth";
import { catalogService } from "@/app/lib/catalog-service";
import { CatalogBodyTooLargeError, catalogRequestText } from "@/app/lib/catalog-job-api";
import { normalizePlanningIngredient, parseMeasure } from "@/app/lib/quantities";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
async function handleGET(request: Request): Promise<Response> {
  const denied = await authorizeCatalogRequest(request); if (denied) return denied;
  try {
    const entries = (await catalogService.list(1000)).map((item) => {
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

async function handlePOST(request: Request): Promise<Response> {
  const denied = await authorizeCatalogRequest(request); if (denied) return denied;
  if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") return json({ error: "Send application/json." }, 415);
  let input: { entries: unknown[]; preview?: boolean };
  try {
    input = JSON.parse(await catalogRequestText(request, 1_000_000));
    if (!input || typeof input !== "object" || Object.keys(input).some((key) => !["entries", "preview"].includes(key)) || !Array.isArray(input.entries) || (input.preview !== undefined && typeof input.preview !== "boolean")) throw new Error();
  } catch (error) { return error instanceof CatalogBodyTooLargeError ? json({ error: "Metadata review is too large." }, 413) : json({ error: "Send reviewed metadata entries as valid JSON." }, 400); }
  try { return json({ ok: true, preview: input.preview === true, results: await catalogService.reviewMetadata(input.entries, input.preview === true) }); }
  catch (error) { return json({ error: error instanceof Error ? error.message : "Metadata review could not be saved." }, 400); }
}

export const GET = withGatewayTrace("catalog.metadata", handleGET);

export const POST = withGatewayTrace("catalog.metadata", handlePOST);
