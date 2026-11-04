import { openChef } from "./open-chef";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { KitchenState, PlannedMeal } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";
const TODAY = "2026-10-22";
const importedIds: string[] = [];
let catalogCountBefore = 0;
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });
async function read(request: APIRequestContext) { return (await request.get("/api/kitchen")).json(); }
async function save(request: APIRequestContext, state: KitchenState) {
  const current = await read(request);
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state } })).ok()).toBeTruthy();
}
function meal(recipe: Recipe, cooked = false): PlannedMeal {
  return { id: "review-dinner", date: TODAY, recipeId: recipe.id, recipe, title: recipe.title, baseServings: recipe.servings ?? null, servings: recipe.servings ?? null, batches: 1, locked: false, status: cooked ? "cooked" : "planned", ingredientOverrides: {}, ...(cooked ? { completion: { id: "already-completed", at: "2026-10-22T08:00:00.000Z", deductions: [] } } : {}) };
}
async function importRecipe(request: APIRequestContext, title: string, instructions: string[]): Promise<Recipe> {
  const source = { sourceUrl: "https://en.wikibooks.org/wiki/Cookbook:" + title.replaceAll(" ", "_"), title, ingredients: [{ name: "rice", measure: "200 g" }], instructions, servings: 2 };
  const reviewHash = createHash("sha256").update(JSON.stringify(source)).digest("hex");
  const response = await request.post("/api/admin/recipes/import", { data: { recipes: [{ ...source, reviewed: true, reviewHash }] } });
  expect(response.ok()).toBeTruthy();
  const result = (await response.json()).results[0];
  if (result.catalogId) importedIds.push(result.catalogId);
  expect(result.status).not.toBe("failed");
  const catalog = await (await request.get("/api/recipes/catalog")).json();
  return catalog.recipes.find((item: Recipe) => item.id === result.catalogId);
}
test.beforeEach(async ({ page, request }) => {
  importedIds.length = 0;
  catalogCountBefore = (await (await request.get("/api/recipes/catalog")).json()).recipes.length;
  await page.clock.install({ time: new Date(TODAY + "T12:00:00+03:00") });
  await save(request, empty());
});
test.afterEach(async ({ request }) => {
  if (!importedIds.length) return;
  // Remove only this test's imports from the harness's disposable database.
  const state = process.env.RAG_CHEF_TEST_STATE_DIR;
  if (!state || realpathSync(state) !== realpathSync(resolve(process.cwd(), "..", "d1-state"))) throw new Error("Cooking regressions require the isolated test harness.");
  if (!importedIds.every(id => /^wikibooks:[a-f0-9]{64}$/.test(id))) throw new Error("Unexpected synthetic recipe identity.");
  const sql = `DELETE FROM recipes WHERE id IN (${importedIds.map(id => `'${id}'`).join(",")});`;
  execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--local", "--config", "wrangler.jsonc", "--persist-to", state, "--command", sql], { timeout: 20000, stdio: "pipe" });
  expect((await (await request.get("/api/recipes/catalog")).json()).recipes.length).toBe(catalogCountBefore);
});
test("cooking again from a cooked dinner uses an unattached session and preserves kitchen history", async ({ page, request }) => {
  const catalog = await (await request.get("/api/recipes/catalog")).json();
  const source = catalog.recipes.find((item: Recipe) => item.id === "fixture-tomato-rice")!;
  const cooked = { ...meal(source, true), servings: 4, ingredientOverrides: { "0": "350 g" } };
  const pantry = [{ id: "rice-stock", name: "rice", measure: "500 g" }];
  await save(request, { ...empty(), pantry, meals: { [TODAY]: cooked } });
  await openChef(page); await page.getByRole("button", { name: "Recipe details", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: source.title, exact: true });
  await expect(drawer).toContainText("Starting again uses original recipe quantities");
  await drawer.getByRole("button", { name: "Start cooking again", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking " + source.title, exact: true });
  await cooking.getByText("Ingredients for this dinner", { exact: true }).click();
  const ingredients = cooking.getByRole("region", { name: "Ingredients for this dinner", exact: true });
  await expect(ingredients).toContainText("200 g"); await expect(ingredients).not.toContainText("350 g");
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await cooking.getByRole("button", { name: "Finish cooking", exact: true }).click();
  const completion = cooking.getByRole("region", { name: "Complete cooking", exact: true });
  await expect(completion).toContainText("not attached to a saved dinner");
  await cooking.screenshot({ path: process.env.RAG_CHEF_TEST_ARTIFACTS + "/cooked-again-completion-" + test.info().project.name + ".png", scale: "css" });
  await completion.getByRole("button", { name: "Finish session", exact: true }).click();
  await expect(cooking).toHaveCount(0);
  expect((await read(request)).state.meals[TODAY]).toEqual(cooked);
  expect((await read(request)).state.pantry).toEqual(pantry);
  expect(await page.evaluate(() => localStorage.getItem("rag-chef-cooking-v1"))).toBeNull();
});
test("procedural source directions stay in the full method until cooking is finished", async ({ page, request }) => {
  const source = await importRecipe(request, "Cooking Review Directions", ["Boil water.", "Cook rice according to package instructions", "Drain and serve."]);
  expect(source.instructions[1]).toBe("Cook rice according to package instructions");
  await save(request, { ...empty(), meals: { [TODAY]: meal(source) } });
  await openChef(page); await page.getByRole("button", { name: "Cook dinner", exact: true }).click();
  await expect(page.getByRole("region", { name: "Choose cooking method", exact: true })).toHaveCount(0);
  const cooking = page.getByRole("dialog", { name: "Cooking " + source.title, exact: true });
  await expect(cooking).toContainText("Boil water.");
  await expect(cooking.getByRole("button", { name: "Finish cooking", exact: true })).toHaveCount(0);
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await expect(cooking).toContainText("Cook rice according to package instructions");
  await cooking.screenshot({ path: process.env.RAG_CHEF_TEST_ARTIFACTS + "/complete-directions-" + test.info().project.name + ".png", scale: "css" });
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await expect(cooking).toContainText("Drain and serve.");
  await expect(cooking.getByRole("button", { name: "Finish cooking", exact: true })).toBeVisible();
});

test("previously saved sessions attached to cooked dinners can finish without replaying completion", async ({ page, request }) => {
  const catalog = await (await request.get("/api/recipes/catalog")).json();
  const source = catalog.recipes.find((item: Recipe) => item.id === "fixture-tomato-rice")!;
  const cooked = { ...meal(source, true), ingredientOverrides: { "0": "350 g" } };
  const pantry = [{ id: "rice-stock", name: "rice", measure: "500 g" }];
  await save(request, { ...empty(), pantry, meals: { [TODAY]: cooked } });
  await page.addInitScript(({ recipe, dinner }) => {
    localStorage.setItem("rag-chef-cooking-v1", JSON.stringify({ version: 1, id: "legacy-cooked-session", recipe, plannedMeal: dinner,
      instructions: recipe.instructions, method: "Main method", step: recipe.instructions.length - 1,
      timer: { durationMs: 300000, remainingMs: 120000, endAt: null, status: "paused" }, soundEnabled: false }));
  }, { recipe: source, dinner: cooked });
  await openChef(page);
  await page.getByRole("button", { name: "Resume cooking", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking " + source.title, exact: true });
  await expect(cooking.getByRole("timer", { name: "Time remaining", exact: true })).toHaveText("02:00");
  await cooking.getByRole("button", { name: "Finish cooking", exact: true }).click();
  const completion = cooking.getByRole("region", { name: "Complete cooking", exact: true });
  await expect(completion).toContainText("already marked cooked");
  await completion.getByRole("button", { name: "Finish session", exact: true }).click();
  await expect(cooking).toHaveCount(0);
  expect((await read(request)).state.meals[TODAY]).toEqual(cooked);
  expect((await read(request)).state.pantry).toEqual(pantry);
  expect(await page.evaluate(() => localStorage.getItem("rag-chef-cooking-v1"))).toBeNull();
});
test("numbered source directions keep their canonical step evidence IDs in cooking help", async ({ page, request }) => {
  const source = await importRecipe(request, "Cooking Review Numbered Rice", ["1. Rinse the rice.", "2. Simmer the rice for 10 minutes."]);
  expect(source.instructions[0]).toBe("1. Rinse the rice.");
  await save(request, { ...empty(), meals: { [TODAY]: meal(source) } });
  await openChef(page); await page.getByRole("button", { name: "Cook dinner", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking " + source.title, exact: true });
  await expect(cooking).toContainText("Rinse the rice.");
  await cooking.getByText("Ask about this step", { exact: true }).click();
  await expect(cooking).not.toContainText("this saved step cannot be matched");
  await cooking.getByRole("textbox", { name: "Question about this step", exact: true }).fill("What does this instruction mean?");
  const responding = page.waitForResponse(response => response.url().endsWith("/api/chef") && response.request().method() === "POST");
  await cooking.getByRole("button", { name: "Ask Chef about step", exact: true }).click();
  const response = await responding; expect(response.ok()).toBeTruthy();
  expect(response.request().postDataJSON().context.stepEvidenceId).toBe("S1");
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await expect(cooking).toContainText("Simmer the rice for 10 minutes.");
  await cooking.getByRole("textbox", { name: "Question about this step", exact: true }).fill("How long does this step take?");
  const secondResponse = page.waitForResponse(response => response.url().endsWith("/api/chef") && response.request().method() === "POST");
  await cooking.getByRole("button", { name: "Ask Chef about step", exact: true }).click();
  const second = await secondResponse; expect(second.ok()).toBeTruthy();
  expect(second.request().postDataJSON().context.stepEvidenceId).toBe("S2");
  await expect.poll(async () => (await (await request.get("/api/recipes/catalog")).json()).recipes.find((item: Recipe) => item.id === source.id).instructions).toEqual(source.instructions);
  await cooking.screenshot({ path: process.env.RAG_CHEF_TEST_ARTIFACTS + "/numbered-step-help-" + test.info().project.name + ".png", scale: "css" });
});
