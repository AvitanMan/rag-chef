import { withGatewayTrace } from "@/app/lib/service-observability";
import { catalogReadService } from "@/app/lib/catalog-read-service";
import { requireHousehold, householdError } from "@/app/lib/household";

async function handleGET(request: Request): Promise<Response> {
  try { await requireHousehold(request); } catch (error) { return householdError(error); }
  try {
    const stored = await catalogReadService.list(1000);
    return Response.json({ recipes: stored.map((item) => item.recipe), contentHashesByRecipeId: Object.fromEntries(stored.map(item => [item.recipe.id, item.contentHash])), metadataByRecipeId: Object.fromEntries(stored.flatMap((item) => item.metadata ? [[item.recipe.id, item.metadata]] : [])) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "The recipe catalog is unavailable. Retry to load dinners." }, { status: 503 });
  }
}

export const GET = withGatewayTrace("recipes.list", handleGET);
