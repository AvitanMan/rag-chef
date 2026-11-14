import { withGatewayTrace } from "@/app/lib/service-observability";
import { authorizeCatalogRequest } from "@/app/lib/catalog-auth";
import { WIKIBOOKS_SOURCE } from "@/app/lib/recipe-import";
import { catalogService } from "@/app/lib/catalog-service";
import { hostedMode } from "@/app/lib/household";
import { CatalogBodyTooLargeError, catalogRequestText, submitCatalogJob } from "@/app/lib/catalog-job-api";

export const dynamic = "force-dynamic";
const MAX_BYTES = 1_000_000;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

async function handlePOST(request: Request): Promise<Response> {
  const denied = await authorizeCatalogRequest(request);
  if (denied) return denied;
  const hosted = hostedMode();
  if (!await catalogService.sourceEnabled(WIKIBOOKS_SOURCE.id)) return json({ error: "Wikibooks is not enabled for hosted distribution. An operator must review source rights and add its exact source ID to HOSTED_RECIPE_SOURCE_IDS." }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") return json({ error: "Send application/json." }, 415);
  let input;
  try {
    input = JSON.parse(await catalogRequestText(request, MAX_BYTES));
    if (!input || typeof input !== "object" || Object.keys(input).some((key) => !["recipes", "retryEmbeddingsOnly"].includes(key)) ||
        !Array.isArray(input.recipes) || input.recipes.length < 1 || input.recipes.length > 20 ||
        (input.retryEmbeddingsOnly !== undefined && typeof input.retryEmbeddingsOnly !== "boolean")) throw new Error();
  } catch (error) { return error instanceof CatalogBodyTooLargeError ? json({ error: "Import is too large." }, 413) : json({ error: "Send 1–20 reviewed recipes as valid JSON." }, 400); }
  if (hosted && input.retryEmbeddingsOnly) return json({ error: "Hosted catalogs use text retrieval and do not request server embeddings." }, 403);

  try {
    const policy = await catalogService.sourcePolicy("wikibooks");
    if (policy && (policy.approval_status !== "approved" || !policy.allow_display || !policy.allow_cache || !policy.allow_index_text || !policy.allow_embed)) {
      return json({ error: "This source has been disabled or its permissions restricted." }, 403);
    }
    return submitCatalogJob(request, { kind: "import", recipes: input.recipes, ...(input.retryEmbeddingsOnly === undefined ? {} : { retryEmbeddingsOnly: input.retryEmbeddingsOnly }) });
  } catch {
    return json({ error: "Recipe storage is unavailable. Run local migrations and retry the saved report." }, 503);
  }
}

export const POST = withGatewayTrace("catalog.import", handlePOST);
