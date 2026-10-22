import { authorizeCatalogRequest } from "@/app/lib/catalog-auth";
import { validateRecipeSnapshot } from "@/app/lib/kitchen-store";
import { WIKIBOOKS_SOURCE, draftRecipe, validateImportDraft } from "@/app/lib/recipe-import";
import { buildRecipeSearchText, DEFAULT_RECIPE_EMBED_MODEL, precomputeRecipeEmbeddings, sha256Hex } from "@/app/lib/recipe-embeddings";
import { catalogRecipeId, getRecipeSourcePolicy, listCatalogRecipes, listStoredRecipeEmbeddings, saveRecipeEmbeddings, upsertApprovedRecipeSource, upsertCatalogRecipe } from "@/app/lib/recipe-store";

export const dynamic = "force-dynamic";
const MAX_BYTES = 1_000_000;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request): Promise<Response> {
  const denied = authorizeCatalogRequest(request);
  if (denied) return denied;
  if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") return json({ error: "Send application/json." }, 415);
  let input;
  try {
    if (Number(request.headers.get("content-length")) > MAX_BYTES) return json({ error: "Import is too large." }, 413);
    const reader = request.body?.getReader();
    if (!reader) throw new Error();
    const chunks = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); return json({ error: "Import is too large." }, 413); }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!input || typeof input !== "object" || Object.keys(input).some((key) => !["recipes", "retryEmbeddingsOnly"].includes(key)) ||
        !Array.isArray(input.recipes) || input.recipes.length < 1 || input.recipes.length > 20 ||
        (input.retryEmbeddingsOnly !== undefined && typeof input.retryEmbeddingsOnly !== "boolean")) throw new Error();
  } catch { return json({ error: "Send 1–20 reviewed recipes as valid JSON." }, 400); }

  try {
    const policy = await getRecipeSourcePolicy("wikibooks");
    if (policy && (policy.approval_status !== "approved" || !policy.allow_display || !policy.allow_cache || !policy.allow_index_text || !policy.allow_embed)) {
      return json({ error: "This source has been disabled or its permissions restricted." }, 403);
    }
    // Approval is a fixed server policy, never accepted from submitted drafts.
    await upsertApprovedRecipeSource(WIKIBOOKS_SOURCE);
    const results: { sourceUrl: string; status: string; catalogId?: string; version?: number; contentChanged?: boolean; embedding?: string; error?: string }[] = [];
    const seen = new Set<string>();
    const model = process.env.OLLAMA_EMBED_MODEL?.trim() || DEFAULT_RECIPE_EMBED_MODEL;
    const existingEmbeddings = await listStoredRecipeEmbeddings(model);
    const savedRecipes = input.retryEmbeddingsOnly ? await listCatalogRecipes(1000) : [];
    for (const raw of input.recipes) {
      let sourceUrl = typeof raw?.sourceUrl === "string" ? raw.sourceUrl : "";
      try {
        const draft = await validateImportDraft(raw);
        sourceUrl = draft.sourceUrl;
        if (seen.has(sourceUrl)) throw new Error("Duplicate source URL in this batch.");
        seen.add(sourceUrl);
        const recipe = await draftRecipe(draft);
        validateRecipeSnapshot(recipe);
        const searchText = buildRecipeSearchText(recipe);
        const contentHash = await sha256Hex(searchText);
        const id = catalogRecipeId("wikibooks", recipe.id);
        let stored;
        if (input.retryEmbeddingsOnly) {
          const current = savedRecipes.find((record) => record.catalogId === id);
          if (!current || current.contentHash !== contentHash) throw new Error("Saved recipe differs from this draft. Collect and review the current version again.");
          stored = { catalogId: id, version: current.version, contentChanged: false };
        } else {
          stored = await upsertCatalogRecipe({ sourceId: "wikibooks", recipe, searchText, contentHash });
        }
        // Recipe saving is independent of model availability. No placeholder vectors.
        let embedding = "pending";
        try {
          const embedded = await precomputeRecipeEmbeddings([{ ...recipe, id }], existingEmbeddings, { model, timeoutMs: 5000 });
          await saveRecipeEmbeddings(embedded.embeddings);
          embedding = embedded.failures.length ? "pending" : "ready";
        } catch { /* Retry from the run report without collecting again. */ }
        results.push({ sourceUrl, status: "saved", ...stored, embedding });
      } catch (error) {
        results.push({ sourceUrl, status: "failed", error: error instanceof Error ? error.message : "Recipe import failed." });
      }
    }
    return json({ ok: results.every((item) => item.status === "saved"), results });
  } catch {
    return json({ error: "Recipe storage is unavailable. Run local migrations and retry the saved report." }, 503);
  }
}
