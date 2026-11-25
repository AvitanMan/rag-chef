import { expect, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { RecipeMetadata } from "../../app/lib/recipe-types";

export async function eggplantReviewFixture(request: APIRequestContext) {
  const endpoint = "/api/admin/recipes/metadata";
  const snapshot = await (await request.get(endpoint)).json();
  const entry = snapshot.entries.find((row: { recipeId: string }) => row.recipeId === "fixture-eggplant");
  const previousRevision = entry.metadata?.revision ?? 0;
  const testState = process.env.RAG_CHEF_TEST_STATE_DIR;
  if (!testState || realpathSync(testState) !== realpathSync(resolve(process.cwd(), "..", "d1-state"))) throw new Error("Metadata regressions require the isolated test harness.");
  const isolatedState = realpathSync(testState);
  if (!Number.isInteger(previousRevision) || previousRevision < 0) throw new Error("Unexpected fixture metadata revision.");
  const fields = ["coreDinner", "dinnerRole", "diets.vegan", "diets.vegetarian", "diets.gluten_free", "diets.low_carb", "totalMinutes", "equipment", "servings", "ingredients"];
  const metadata: RecipeMetadata = {
    revision: 1,
    sourceContentHash: entry.contentHash,
    coreDinner: false,
    dinnerRole: "side",
    diets: { vegan: "fits", vegetarian: "fits", gluten_free: "fits", low_carb: "unknown" },
    totalMinutes: 20,
    equipment: ["stovetop"],
    provenance: Object.fromEntries(fields.map((field) => [field, { basis: field === "totalMinutes" ? "curator_estimate" : "curator_assessment", evidence: "Synthetic fixture review of the listed eggplant and tomato ingredients and stovetop method." }])),
    reviewedBy: "Automated synthetic fixture review",
    reviewedAt: "2026-10-22T09:00:00.000Z",
  };
  async function restore() {
    // Restore only revisions written by this test, including an originally absent review.
    // Keep the fixture's earlier reviews and source recipe intact for following suites.
    execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--local", "--config", "wrangler.jsonc", "--persist-to", isolatedState,
      "--command", `DELETE FROM recipe_metadata WHERE recipe_id = 'fixture-eggplant' AND revision > ${previousRevision};`], { timeout: 20000, stdio: "pipe" });
    const restored = await request.get(endpoint);
    if (!restored.ok()) throw new Error("Could not read restored metadata.");
    expect(await restored.json()).toEqual(snapshot);
  }
  return { snapshot, entry, metadata, restore };
}
