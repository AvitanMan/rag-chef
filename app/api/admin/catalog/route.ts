import { withGatewayTrace } from "@/app/lib/service-observability";
import { DEFAULT_RECIPE_EMBED_MODEL } from "@/app/lib/recipe-embeddings";
import { catalogService } from "@/app/lib/catalog-service";
import { authorizeCatalogRequest } from "@/app/lib/catalog-auth";
import { householdSetting, hostedMode } from "@/app/lib/household";
import { CatalogBodyTooLargeError, catalogJobError, catalogJobJson as json, catalogRequestText, submitCatalogJob } from "@/app/lib/catalog-job-api";

async function handleGET(request: Request): Promise<Response> {
  const denied = await authorizeCatalogRequest(request);
  if (denied) return denied;
  try {
    await catalogService.ensureReady();
    return json({ ok: true, catalog: await catalogService.status(householdSetting("OLLAMA_EMBED_MODEL") || DEFAULT_RECIPE_EMBED_MODEL) });
  } catch (error) { return catalogJobError(error); }
}

async function handlePOST(request: Request): Promise<Response> {
  const denied = await authorizeCatalogRequest(request);
  if (denied) return denied;
  if (hostedMode()) return json({ ok: false, error: { code: "HOSTED_CATALOG_SYNC_DISABLED", message: "Hosted catalogs do not use local prototype source sync or server embeddings. Load original starter recipes or import sources explicitly enabled after hosted rights review." } }, 403);
  let embeddingsOnly = false;
  try {
    const text = await catalogRequestText(request, 1024);
    if (text.trim()) {
      const input = JSON.parse(text);
      if (input?.embeddingsOnly !== true || Object.keys(input).some(key => key !== "embeddingsOnly")) return json({ error: "Expected embeddingsOnly: true, or an empty body for source sync." }, 400);
      embeddingsOnly = true;
    }
  } catch (error) { return json({ error: "Invalid request body." }, error instanceof CatalogBodyTooLargeError ? 413 : 400); }
  return submitCatalogJob(request, { kind: embeddingsOnly ? "embeddings" : "sync" });
}

export const GET = withGatewayTrace("catalog.admin", handleGET);

export const POST = withGatewayTrace("catalog.admin", handlePOST);
