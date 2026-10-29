import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { KitchenState, PlannedMeal } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";

const TODAY = "2026-10-22";
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });
async function read(request: APIRequestContext) { return (await request.get("/api/kitchen")).json(); }
async function save(request: APIRequestContext, state: KitchenState) {
  const current = await read(request);
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state } })).ok()).toBeTruthy();
}
async function source(request: APIRequestContext, id = "fixture-tomato-rice"): Promise<Recipe> {
  return (await (await request.get("/api/recipes/catalog")).json()).recipes.find((recipe: Recipe) => recipe.id === id);
}
function meal(recipe: Recipe, date = TODAY): PlannedMeal {
  return { id: `dinner:${date}`, date, recipeId: recipe.id, recipe, title: recipe.title, baseServings: recipe.servings ?? null, servings: recipe.servings ?? null, batches: 1, ingredientOverrides: {}, locked: false, status: "planned" };
}
async function navigate(page: Page, name: string) {
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click();
}
async function chooseRice(page: Page) {
  await navigate(page, "Recipes");
  await page.getByRole("searchbox", { name: "Search recipes", exact: true }).fill("Tomato Rice");
  await page.getByRole("button", { name: "Choose for tonight: Tomato Rice", exact: true }).click();
  await expect(page.getByRole("region", { name: "Chosen dinner", exact: true })).toBeVisible();
}
async function finalReview(page: Page) {
  await page.getByRole("button", { name: "Cook dinner", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await cooking.getByRole("button", { name: "Finish cooking", exact: true }).click();
  return cooking.getByRole("region", { name: "Complete dinner", exact: true });
}

test.beforeEach(async ({ page, request }) => {
  await page.clock.install({ time: new Date("2026-10-22T12:00:00+03:00") });
  await save(request, empty());
});

test("choose, see missing ingredients and cook without Plan, a picker or an AI request", async ({ page, request }) => {
  let chefCalls = 0;
  page.on("request", request => { if (request.url().endsWith("/api/chef")) chefCalls++; });
  await page.goto("/"); await chooseRice(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const dinner = page.getByRole("region", { name: "Chosen dinner", exact: true });
  await expect(dinner).toContainText("Tonight’s dinner");
  await expect(dinner).toContainText("2 missing");
  await expect(dinner.getByRole("heading", { name: "Tomato Rice", exact: true })).toBeFocused();
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await page.screenshot({ path: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/chosen-dinner-${test.info().project.name}.png`, fullPage: true });
  await dinner.getByRole("button", { name: "Cook dinner", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true })).toBeVisible();
  expect(chefCalls).toBe(0);
  await expect.poll(async () => (await read(request)).state.meals[TODAY]?.recipeId).toBe("fixture-tomato-rice");
});

test("change and cancel keep the saved dinner; browser Back restores recipe filters", async ({ page, request }) => {
  await page.goto("/"); await chooseRice(page);
  await expect.poll(async () => (await read(request)).state.meals[TODAY]?.recipeId).toBe("fixture-tomato-rice");
  const before = await read(request);
  await page.goBack();
  await expect(page.getByRole("searchbox", { name: "Search recipes", exact: true })).toHaveValue("Tomato Rice");
  await page.goForward();
  await expect(page.getByRole("region", { name: "Chosen dinner", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Change dinner", exact: true }).click();
  await page.getByRole("button", { name: "Cancel change", exact: true }).click();
  await expect(page.getByRole("region", { name: "Chosen dinner", exact: true })).toContainText("Tomato Rice");
  expect(await read(request)).toEqual(before);
});

test("inline needs reserve other dinners and weekly shopping returns to this dinner", async ({ page, request }) => {
  const recipe = await source(request);
  await save(request, { ...empty(), pantry: [{ id: "rice", name: "rice", measure: "300 g" }, { id: "tomatoes", name: "tomatoes", measure: "4" }], meals: { [TODAY]: meal(recipe), "2026-10-23": meal(recipe, "2026-10-23") } });
  await page.goto("/");
  const needs = page.getByRole("region", { name: "Dinner shopping needs", exact: true });
  await expect(needs).toContainText("rice: 100 g");
  await page.getByRole("button", { name: "Weekly shopping", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Bought rice 100 g", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to dinner", exact: true }).click();
  await expect(needs).toContainText("rice: 100 g");
});

test("finish review keeps one dialog, cancellation and reload preserve timer and source step", async ({ page, request }) => {
  const recipe = await source(request);
  await save(request, { ...empty(), pantry: [{ id: "rice", name: "rice", measure: "500 g" }], meals: { [TODAY]: meal(recipe) } });
  await page.goto("/");
  const review = await finalReview(page);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(review.getByRole("checkbox")).not.toBeChecked();
  await review.getByRole("button", { name: "Back to directions", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.getByRole("button", { name: "Start 10 min from this step", exact: true }).click();
  await page.clock.fastForward(30_000);
  await cooking.getByRole("button", { name: "Finish cooking", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Resume cooking", exact: true }).click();
  await expect(cooking).toContainText("Step 2");
  await expect(cooking.getByRole("timer")).toHaveText("09:30");
  await cooking.getByRole("button", { name: "Finish cooking", exact: true }).click();
  await review.getByRole("button", { name: "Mark dinner cooked", exact: true }).click();
  await expect(page.getByRole("region", { name: "Chosen dinner", exact: true })).toContainText("Cooked");
  await expect.poll(async () => (await read(request)).state.meals[TODAY].status).toBe("cooked");
  expect((await read(request)).state.pantry[0].measure).toBe("500 g");
  await page.getByRole("button", { name: "Undo cooked", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.meals[TODAY].status).toBe("planned");
});

test("completion survives dual storage failure and retry deducts only once", async ({ page, request }) => {
  const recipe = await source(request);
  await save(request, { ...empty(), pantry: [{ id: "rice", name: "rice", measure: "500 g" }], meals: { [TODAY]: meal(recipe) } });
  await page.goto("/");
  const review = await finalReview(page);
  await review.getByRole("checkbox").check();
  await page.evaluate(() => {
    (window as unknown as { restoreStorage: typeof Storage.prototype.setItem }).restoreStorage = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new DOMException("Storage full", "QuotaExceededError"); };
  });
  await page.route("**/api/kitchen", route => route.request().method() === "PUT" ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Unavailable" } }) }) : route.continue());
  await review.getByRole("button", { name: "Mark dinner cooked", exact: true }).click();
  await expect(review.getByRole("button", { name: "Retry save", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true })).toBeVisible();
  expect((await read(request)).state.meals[TODAY].status).toBe("planned");
  await page.evaluate(() => { Storage.prototype.setItem = (window as unknown as { restoreStorage: typeof Storage.prototype.setItem }).restoreStorage; });
  await page.unroute("**/api/kitchen");
  await review.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(page.getByRole("region", { name: "Chosen dinner", exact: true })).toContainText("Cooked");
  await expect.poll(async () => (await read(request)).state.pantry[0].measure).toBe("300 g");
});

test("unknown yields use editable batches and multiple methods are selected inline", async ({ page, request }) => {
  const soup = await source(request, "fixture-unknown-soup");
  await save(request, { ...empty(), meals: { [TODAY]: meal(soup) } });
  await page.goto("/");
  const dinner = page.getByRole("region", { name: "Chosen dinner", exact: true });
  await expect(dinner).toContainText("1 recipe batches");
  await dinner.getByText("Adjust amounts", { exact: true }).click();
  await dinner.getByLabel("Dinner portions", { exact: true }).fill("2");
  await expect.poll(async () => (await read(request)).state.meals[TODAY].batches).toBe(2);
  expect((await read(request)).state.meals[TODAY].recipe).toEqual(soup);
  const recipe = { ...await source(request), instructions: ["Stovetop", "Simmer for 10 minutes.", "Oven", "Bake for 20 minutes."] };
  await save(request, { ...empty(), meals: { [TODAY]: meal(recipe) } });
  await page.reload();
  await page.getByRole("button", { name: "Cook dinner", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Cook · Oven", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await expect(cooking).toContainText("Bake for 20 minutes.");
  await expect(cooking).not.toContainText("Simmer for 10 minutes.");
});

test("finishing unplanned cooking leaves plan and pantry untouched", async ({ page, request }) => {
  await page.goto("/"); await navigate(page, "Recipes");
  await page.getByRole("button", { name: "View Cheese Pasta", exact: true }).click();
  await page.getByRole("button", { name: "Start cooking", exact: true }).click();
  const before = await read(request);
  const cooking = page.getByRole("dialog", { name: "Cooking Cheese Pasta", exact: true });
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await cooking.getByRole("button", { name: "Finish cooking", exact: true }).click();
  await cooking.getByRole("button", { name: "Finish session", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await read(request)).toEqual(before);
});
