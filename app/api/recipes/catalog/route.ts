import { listCatalogRecipes } from "@/app/lib/recipe-store";

export async function GET(): Promise<Response> {
  try {
    const stored = await listCatalogRecipes(1000);
    return Response.json({ recipes: stored.map((item) => item.recipe), metadataByRecipeId: Object.fromEntries(stored.flatMap((item) => item.metadata ? [[item.recipe.id, item.metadata]] : [])) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "The recipe catalog is unavailable. Retry to load dinners." }, { status: 503 });
  }
}
