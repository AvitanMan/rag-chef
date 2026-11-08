import { authorizeCatalogRequest } from "@/app/lib/catalog-auth";
import { DEMO_RECIPES, DEMO_SOURCE } from "@/app/lib/demo-recipes";
import { buildRecipeSearchText, sha256Hex } from "@/app/lib/recipe-embeddings";
import { upsertApprovedRecipeSource, upsertCatalogRecipe } from "@/app/lib/recipe-store";

/** Idempotent local setup: adds original recipes, without models or kitchen writes. */
export async function POST(request: Request): Promise<Response> {
  const denied = await authorizeCatalogRequest(request);
  if (denied) return denied;
  if ((await request.text()).trim()) return Response.json({ error: { message: "This action takes no recipe data." } }, { status: 400 });
  try {
    await upsertApprovedRecipeSource(DEMO_SOURCE);
    for (const recipe of DEMO_RECIPES) {
      const searchText = buildRecipeSearchText(recipe);
      await upsertCatalogRecipe({ sourceId: DEMO_SOURCE.id, recipe, searchText, contentHash: await sha256Hex(searchText) });
    }
    return Response.json({ ok: true, count: DEMO_RECIPES.length }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false, error: { message: "Starter recipes could not be saved. Check that the local database is set up, then retry. Any recipes already saved are kept." } }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
