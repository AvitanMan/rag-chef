import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const loader = await createSourceLoader({ name: "everyday-collection" });
after(() => loader.dispose());
const { DEMO_RECIPES, DEMO_SOURCE } = await loader.import("app/lib/demo-recipes.ts");
const { isEverydayRecipe, missingEverydayRecipeCount, recipeIntroduction } = await loader.import("app/lib/everyday-collection.ts");
const stored = DEMO_RECIPES.map(recipe => ({ ...recipe, id: `${DEMO_SOURCE.id}:${recipe.id}` }));

test("the everyday collection contains eight originals without relabeling imported recipes or older starters", () => {
  const everyday = stored.filter(isEverydayRecipe);
  assert.equal(everyday.length, 8);
  assert.equal(missingEverydayRecipeCount([]), 8);
  assert.equal(missingEverydayRecipeCount(stored), 0);
  assert.equal(missingEverydayRecipeCount([everyday[0], everyday[0]]), 7);
  assert.equal(isEverydayRecipe({ ...everyday[0], id: "other:tagged", tags: ["everyday"] }), false);
  assert.equal(isEverydayRecipe({ ...everyday[0], sourceUrl: "https://example.test/changed" }), false);
  assert.equal(stored.slice(0, 3).some(isEverydayRecipe), false);
});

test("introductions use authored source notes and never replace absent descriptions with invented copy", () => {
  assert.equal(recipeIntroduction({ ...stored[0], sourceNotes: undefined }), undefined);
  assert.equal(recipeIntroduction({ ...stored[0], sourceNotes: ["Original starter recipe."] }), undefined);
  for (const recipe of stored.filter(isEverydayRecipe)) {
    const intro = recipeIntroduction(recipe);
    assert.ok(intro?.length > 20);
    assert.ok(recipe.sourceNotes.includes(`About this dish: ${intro}`));
  }
});
