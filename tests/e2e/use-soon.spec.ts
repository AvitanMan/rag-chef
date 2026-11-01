import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { KitchenState, PlannedMeal } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";

const TODAY = "2026-10-22";
const initial = (): KitchenState => ({ schemaVersion: 2, pantry: [{ id: "rice", name: "rice", measure: "500 g", useBy: TODAY }], meals: {}, shoppingChecked: {}, migratedLegacy: true });
async function read(request: APIRequestContext) { return (await request.get("/api/kitchen")).json(); }
async function save(request: APIRequestContext, state: KitchenState) {
  const document = await read(request);
  expect((await request.put("/api/kitchen", { data: { revision: document.revision, state } })).ok()).toBeTruthy();
}
async function source(request: APIRequestContext, id = "fixture-tomato-rice"): Promise<Recipe> {
  return (await (await request.get("/api/recipes/catalog")).json()).recipes.find((recipe: Recipe) => recipe.id === id);
}
function meal(recipe: Recipe, date = TODAY): PlannedMeal {
  return { id: `meal:${date}`, date, recipeId: recipe.id, recipe, title: recipe.title, baseServings: recipe.servings ?? null, servings: recipe.servings ?? null, batches: 1, ingredientOverrides: {}, locked: false, status: "planned" };
}
async function navigate(page: Page, name: string) {
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click();
}
async function selectRice(page: Page) {
  await page.getByRole("region", { name: "Use soon", exact: true }).getByRole("button", { name: "Find dinners using rice", exact: true }).click();
  const results = page.getByRole("region", { name: "Dinners using rice", exact: true });
  await expect(results.getByRole("button", { name: "Choose for tonight: Tomato Rice", exact: true })).toBeVisible();
  return results;
}

test.beforeEach(async ({ page, request }) => {
  await page.clock.install({ time: new Date("2026-10-22T12:00:00+03:00") });
  await save(request, initial());
});

test("ingredient to dinner, cooking, deductions and Undo without AI", async ({ page, request }) => {
  let calls = 0;
  page.on("request", request => { if (request.url().endsWith("/api/chef")) calls++; });
  await page.route("**/api/chef", route => route.abort());
  await page.goto("/");
  const results = await selectRice(page);
  await expect(results).toContainText("Estimated use from this pantry item: 200 g.");
  await expect(results).not.toContainText("Cheese Pasta");
  await page.screenshot({ path: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/use-soon-${test.info().project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await results.getByRole("button", { name: "Choose for tonight: Tomato Rice", exact: true }).click();
  await page.getByRole("button", { name: "Cook dinner", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await cooking.getByRole("button", { name: "Finish cooking", exact: true }).click();
  const review = cooking.getByRole("region", { name: "Complete dinner", exact: true });
  await expect(review.getByRole("checkbox")).not.toBeChecked();
  await review.getByRole("checkbox").check();
  await review.getByRole("button", { name: "Mark dinner cooked", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.pantry[0].measure).toBe("300 g");
  await expect(page.getByRole("region", { name: "Use soon", exact: true })).toContainText("300 g");
  await page.getByRole("button", { name: "Undo cooked", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.pantry[0].measure).toBe("500 g");
  expect(calls).toBe(0);
});

test("review filters, selected row focus, amount edits and removal recovery", async ({ page, request }) => {
  await save(request, { ...initial(), pantry: [...initial().pantry, { id: "past", name: "carrot", measure: "2", useBy: "2026-10-21" }, { id: "undated", name: "beans", measure: "" }] });
  await page.goto("/");
  const results = await selectRice(page);
  await results.getByRole("button", { name: "Review this item", exact: true }).click();
  await expect(page.getByRole("button", { name: "Use soon (1)", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "Available rice", exact: true })).toBeFocused();
  await page.screenshot({ path: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/use-soon-pantry-${test.info().project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.getByRole("textbox", { name: "Available rice", exact: true }).fill("300 g");
  await page.getByRole("textbox", { name: "Available rice", exact: true }).press("Tab");
  await expect.poll(async () => (await read(request)).state.pantry[0].measure).toBe("300 g");
  await page.goBack();
  await expect(results).toContainText("300 g remaining");
  await page.goForward();
  await page.getByRole("button", { name: "Remove rice", exact: true }).click();
  await expect(page.getByRole("button", { name: "Use soon (0)", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Available rice", exact: true })).toHaveValue("300 g");
  await page.getByRole("button", { name: "Past entered date (1)", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Available carrot", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Available rice", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "All items (3)", exact: true }).click();
  await page.getByLabel("Use by rice", { exact: true }).fill("2026-10-28");
  await expect(page.getByRole("button", { name: "Use soon (0)", exact: true })).toBeVisible();
  await expect.poll(async () => (await read(request)).state.pantry.find((item: { id: string }) => item.id === "rice").useBy).toBe("2026-10-28");
  await page.reload();
  await expect(page.getByRole("region", { name: "Use soon", exact: true })).not.toContainText("rice");
});

test("unknown amounts remain uncertain and midnight removes old selections", async ({ page, request }) => {
  await save(request, { ...initial(), pantry: [{ ...initial().pantry[0], measure: "" }] });
  await page.goto("/");
  const results = await selectRice(page);
  await expect(results).toContainText("Amount unknown");
  await expect(results).toContainText("Check amount");
  await expect(results).not.toContainText("Estimated use from this pantry item");
  await page.clock.setSystemTime(new Date("2026-10-23T00:00:01+03:00"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(results).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Use soon", exact: true })).toContainText("Past entered date: 1");
});

test("date and portions change estimates while reservations and replacement remain protected", async ({ page, request }) => {
  const recipe = await source(request);
  await save(request, { ...initial(), pantry: [{ ...initial().pantry[0], useBy: "2026-10-23" }], meals: { "2026-10-23": meal(recipe, "2026-10-23") } });
  await page.goto("/");
  const results = await selectRice(page);
  await expect(results).toContainText("300 g remaining");
  await page.getByText("Dinner day and portions", { exact: false }).first().click();
  await page.getByRole("spinbutton", { name: "Chef portions", exact: true }).fill("4");
  await expect(results).toContainText("Estimated use from this pantry item: 300 g.");
  await page.getByLabel("Dinner day", { exact: true }).fill("2026-10-24");
  await expect(results).toContainText("before the selected dinner day");
  await expect(results.locator(".recipe-card")).toHaveCount(0);
  await page.getByLabel("Dinner day", { exact: true }).fill(TODAY);
  await results.getByRole("button", { name: "Choose for tonight: Tomato Rice", exact: true }).click();
  await page.getByRole("region", { name: "Use soon", exact: true }).getByRole("button", { name: "Find dinners using rice", exact: true }).click();
  await page.getByRole("button", { name: "Cancel change", exact: true }).click();
  await expect(page.getByRole("region", { name: "Chosen dinner", exact: true })).toContainText("Tomato Rice");
  await expect.poll(async () => (await read(request)).state.meals[TODAY]?.recipeId).toBe(recipe.id);
});

test("fully reserved pantry item cannot promise another dinner", async ({ page, request }) => {
  const recipe = await source(request);
  await save(request, { ...initial(), pantry: [{ ...initial().pantry[0], measure: "200 g", useBy: "2026-10-23" }], meals: { "2026-10-23": meal(recipe, "2026-10-23") } });
  await page.goto("/");
  await page.getByRole("button", { name: "Find dinners using rice", exact: true }).click();
  const results = page.getByRole("region", { name: "Dinners using rice", exact: true });
  await expect(results).toContainText("fully reserved");
  await expect(results.locator(".recipe-card")).toHaveCount(0);
});

test("no match and empty pantry are explained with a path back to browsing", async ({ page, request }) => {
  await save(request, { ...initial(), pantry: [{ id: "unmatched", name: "dragonfruit", measure: "2", useBy: TODAY }] });
  await page.goto("/");
  await page.getByRole("button", { name: "Find dinners using dragonfruit", exact: true }).click();
  await expect(page.getByRole("region", { name: "Dinners using dragonfruit", exact: true })).toContainText("No matching recipes meet your saved requirements");
  await page.getByRole("button", { name: "Browse all recipes", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search recipes", exact: true })).toBeVisible();
  await navigate(page, "Pantry");
  await page.getByRole("button", { name: "Remove dragonfruit", exact: true }).click();
  await navigate(page, "Chef");
  await expect(page.getByRole("region", { name: "Use soon", exact: true })).toContainText("No food with an entered date");
});

test("three choices expand to the rest of the matching collection", async ({ page, request }) => {
  const rice = await source(request);
  const recipes = Array.from({ length: 5 }, (_, index) => ({ ...rice, id: `rice-${index}`, title: `Rice dinner ${index}` }));
  await page.route("**/api/recipes/catalog", route => route.fulfill({ json: { recipes, metadataByRecipeId: {} } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Find dinners using rice", exact: true }).click();
  const results = page.getByRole("region", { name: "Dinners using rice", exact: true });
  await expect(results.locator(".recipe-card")).toHaveCount(3);
  await results.getByRole("button", { name: "Show more dinners", exact: true }).click();
  await expect(results.locator(".recipe-card")).toHaveCount(5);
  await expect(results.getByRole("button", { name: "Show more dinners", exact: true })).toHaveCount(0);
});

test("changing saved exclusions removes affected ingredient-led choices", async ({ page }) => {
  await page.goto("/");
  const results = await selectRice(page);
  await expect(results).toContainText("Salmon Bowl");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Diet", { exact: false }).selectOption("Vegan");
  await navigate(page, "Chef");
  await expect(results).not.toContainText("Salmon Bowl");
  await expect(results).toContainText("Tomato Rice");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("textbox", { name: "Allergies", exact: true }).fill("tomato");
  await page.getByRole("textbox", { name: "Allergies", exact: true }).press("Enter");
  await navigate(page, "Chef");
  await expect(results).toContainText("No matching recipes meet your saved requirements");
  await expect(results.locator(".recipe-card")).toHaveCount(0);
});

test("Back clears a removed ingredient without adding a history loop", async ({ page }) => {
  await page.goto("/");
  const results = await selectRice(page);
  await results.getByRole("button", { name: "Review this item", exact: true }).click();
  const historyLength = await page.evaluate(() => window.history.length);
  await page.getByRole("button", { name: "Remove rice", exact: true }).click();
  await expect(page.getByRole("button", { name: "Use soon (0)", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
  await page.goBack();
  await expect(results).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Use soon", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
  await page.goBack();
  await expect(results).toHaveCount(0);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
});
