import { test, expect } from "@playwright/test";
import type { RecipeMetadata } from "../../app/lib/recipe-types";

test("reviewed metadata previews, applies idempotently and drives public constraints without rewriting recipes", async ({ page, request }) => {
  const endpoint = "/api/admin/recipes/metadata";
  const snapshot = await (await request.get(endpoint)).json();
  const entry = snapshot.entries.find((row: { recipeId: string }) => row.recipeId === "fixture-eggplant");
  const kitchenBefore = await (await request.get("/api/kitchen")).json();
  const sourceBefore = entry.recipe;
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
  const payload = { entries: [{ recipeId: entry.recipeId, reviewed: true, metadata }] };
  const preview = await request.post(endpoint, { data: { ...payload, preview: true } });
  expect(preview.ok()).toBeTruthy();
  expect(await (await request.get(endpoint)).json()).toEqual(snapshot);
  const applied = await request.post(endpoint, { data: payload });
  expect(applied.ok()).toBeTruthy();
  const result = await applied.json();
  const repeated = await (await request.post(endpoint, { data: payload })).json();
  expect(repeated.results[0]).toMatchObject({ changed: false, revision: result.results[0].revision });
  const after = await (await request.get(endpoint)).json();
  const updated = after.entries.find((row: { recipeId: string }) => row.recipeId === entry.recipeId);
  expect(updated.recipe).toEqual(sourceBefore);
  expect(updated.metadata.totalMinutes).toBe(20);
  expect(await (await request.get("/api/kitchen")).json()).toEqual(kitchenBefore);
  const estimated = await (await request.get("/api/recipes?q=Eggplant%20Stew&maxMinutes=25")).json();
  expect(estimated.recipes).toEqual([]);
  const sourceTimed = { ...metadata, provenance: { ...metadata.provenance, totalMinutes: { basis: "source", evidence: "Total time: 20 minutes." } } };
  expect((await request.post(endpoint, { data: { entries: [{ recipeId: entry.recipeId, reviewed: true, metadata: sourceTimed }] } })).ok()).toBeTruthy();
  const allowed = await (await request.get("/api/recipes?q=Eggplant%20Stew&diet=vegan&maxMinutes=25&equipment=stovetop")).json();
  expect(allowed.recipes.map((recipe: { id: string }) => recipe.id)).toContain(entry.recipeId);
  const tooShort = await (await request.get("/api/recipes?q=Eggplant%20Stew&maxMinutes=10")).json();
  expect(tooShort.recipes).toEqual([]);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Diet", { exact: false }).selectOption("Vegan");
  await page.getByRole("button", { name: /Recipes/ }).filter({ visible: true }).first().click();
  await page.getByRole("searchbox", { name: "Search recipes" }).fill("Eggplant Stew");
  await expect(page.locator(".recipe-card")).toBeVisible();
  await expect(page.locator(".recipe-card")).not.toContainText("Diet not verified");
  await page.getByRole("checkbox", { name: "Core dinners", exact: true }).check();
  await expect(page.locator(".recipe-card")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Core dinners", exact: true }).uncheck();
  await expect(page.locator(".recipe-card")).toHaveCount(1);
  await page.getByRole("spinbutton", { name: "Maximum total minutes", exact: true }).fill("15");
  await expect(page.locator(".recipe-card")).toHaveCount(0);
  await page.getByRole("spinbutton", { name: "Maximum total minutes", exact: true }).fill("25");
  await expect(page.locator(".recipe-card")).toHaveCount(1);
});
