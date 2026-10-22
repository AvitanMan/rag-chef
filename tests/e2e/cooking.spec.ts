import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { KitchenState, PlannedMeal } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";

const TODAY = "2026-10-22";
const emptyState = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: false });
async function readKitchen(request: APIRequestContext) { return (await request.get("/api/kitchen")).json(); }
async function saveFixture(request: APIRequestContext, state: KitchenState) {
  const current = await readKitchen(request);
  const response = await request.put("/api/kitchen", { data: { revision: current.revision, state } });
  expect(response.ok()).toBeTruthy();
}
async function recipeFixture(request: APIRequestContext, id = "fixture-tomato-rice"): Promise<Recipe> {
  const catalog = await (await request.get("/api/recipes/catalog")).json();
  const recipe = catalog.recipes.find((value: Recipe) => value.id === id);
  expect(recipe).toBeTruthy();
  return recipe;
}
function mealFixture(recipe: Recipe, date = TODAY, overrides: Partial<PlannedMeal> = {}): PlannedMeal {
  return { id: `meal-${date}`, date, recipeId: recipe.id, recipe, title: recipe.title, baseServings: recipe.servings ?? null, servings: recipe.servings ?? null, batches: 1, locked: false, status: "planned", ingredientOverrides: {}, ...overrides };
}
async function navigate(page: Page, name: string) { await page.getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click(); }

test.beforeEach(async ({ page, request }) => {
  await page.clock.install({ time: new Date("2026-10-22T12:00:00+03:00") });
  await saveFixture(request, emptyState());
});

test("use-by edits persist and shared stock covers only dinners on eligible dates", async ({ page, request }) => {
  const recipe = await recipeFixture(request);
  const tomorrow = "2026-10-23";
  await saveFixture(request, { ...emptyState(), pantry: [{ id: "rice", name: "rice", measure: "200 g", useBy: TODAY }, { id: "tomato", name: "tomato", measure: "4" }], meals: { [TODAY]: mealFixture(recipe), [tomorrow]: mealFixture(recipe, tomorrow) } });
  await page.goto("/");
  await navigate(page, "Shopping");
  await expect(page.getByRole("checkbox", { name: "Bought rice 200 g", exact: true })).toBeVisible();
  await navigate(page, "Pantry");
  const date = page.getByLabel("Use by rice", { exact: true });
  await date.fill("2026-10-21");
  await navigate(page, "Shopping");
  await expect(page.getByRole("checkbox", { name: "Bought rice 400 g", exact: true })).toBeVisible();
  await navigate(page, "Pantry");
  await date.fill(tomorrow);
  await expect.poll(async () => (await readKitchen(request)).state.pantry.find((stock: { id: string }) => stock.id === "rice").useBy).toBe(tomorrow);
  await page.reload();
  await navigate(page, "Pantry");
  await expect(date).toHaveValue(tomorrow);
  await date.fill("");
  await expect.poll(async () => (await readKitchen(request)).state.pantry.find((stock: { id: string }) => stock.id === "rice").useBy).toBeUndefined();
  await navigate(page, "Shopping");
  await expect(page.getByRole("checkbox", { name: "Bought rice 200 g", exact: true })).toBeVisible();
});

test("cooking shows final amounts once and cooked undo restores dated stock", async ({ page, request }) => {
  const recipe = await recipeFixture(request);
  const planned = mealFixture(recipe, TODAY, { servings: 4, ingredientOverrides: { "0": "350 g" } });
  await saveFixture(request, { ...emptyState(), pantry: [{ id: "rice", name: "rice", measure: "500 g", useBy: "2026-10-24" }, { id: "tomato", name: "tomato", measure: "8" }], meals: { [TODAY]: planned } });
  await page.goto("/");
  await page.getByRole("button", { name: /^Cook Tomato Rice / }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  const amounts = cooking.getByRole("region", { name: "Ingredients for this dinner", exact: true });
  await expect(amounts).toContainText("350 g");
  await expect(amounts).not.toContainText("700 g");
  await expect(cooking).toContainText("Rinse the rice.");
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await expect(cooking).toContainText("Simmer the rice and tomatoes for 10 minutes.");
  await cooking.getByRole("button", { name: "Finish cooking", exact: true }).click();
  const complete = page.getByRole("dialog", { name: "Complete dinner", exact: true });
  await complete.getByRole("checkbox").check();
  await complete.getByRole("button", { name: "Confirm cooked", exact: true }).click();
  await expect.poll(async () => (await readKitchen(request)).state.pantry.find((stock: { id: string }) => stock.id === "rice").measure).toBe("150 g");
  await page.getByRole("button", { name: /Undo cooked/ }).click();
  await expect.poll(async () => (await readKitchen(request)).state.pantry.find((stock: { id: string }) => stock.id === "rice")).toMatchObject({ measure: "500 g", useBy: "2026-10-24" });
});

test("source-duration timers pause, reset and keep their remaining time across step changes", async ({ page, request }) => {
  const recipe = await recipeFixture(request);
  await saveFixture(request, { ...emptyState(), meals: { [TODAY]: mealFixture(recipe) } });
  await page.goto("/");
  await page.getByRole("button", { name: /^Cook Tomato Rice / }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await cooking.getByRole("button", { name: /Start.*10.*min/i }).click();
  await page.clock.fastForward("00:01:00");
  await expect(cooking.getByRole("timer")).toContainText("09:00");
  await cooking.getByRole("button", { name: "Pause timer", exact: true }).click();
  await page.clock.fastForward("00:01:00");
  await expect(cooking.getByRole("timer")).toContainText("09:00");
  await cooking.getByRole("button", { name: "Previous", exact: true }).click();
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await expect(cooking.getByRole("timer")).toContainText("09:00");
  await cooking.getByRole("button", { name: "Reset timer", exact: true }).click();
  await expect(cooking.getByRole("timer")).toContainText("10:00");
});

test("custom timer completion survives reload and an old cooking session cannot complete a replacement dinner", async ({ page, request }) => {
  const recipe = await recipeFixture(request);
  const planned = mealFixture(recipe);
  await saveFixture(request, { ...emptyState(), meals: { [TODAY]: planned } });
  await page.goto("/");
  await page.getByRole("button", { name: /^Cook Tomato Rice / }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.getByRole("spinbutton", { name: "Timer duration (seconds)", exact: true }).fill("2");
  await cooking.getByRole("button", { name: "Start custom timer", exact: true }).click();
  await page.clock.fastForward(3000);
  await expect(cooking.getByRole("status")).toContainText("Timer finished");
  expect((await readKitchen(request)).state.meals[TODAY].status).toBe("planned");
  await page.reload();
  await expect(page.getByRole("button", { name: /^Cook Tomato Rice / })).toBeVisible();
  await page.getByRole("button", { name: "Resume cooking", exact: true }).click();
  await expect(cooking.getByRole("timer")).toContainText("00:00");
  await expect(cooking.getByRole("status")).toContainText("Timer finished");
  const replacement = { ...planned, id: "replacement-dinner" };
  await saveFixture(request, { ...emptyState(), meals: { [TODAY]: replacement } });
  await page.reload();
  await expect(page.getByRole("button", { name: /^Cook Tomato Rice / })).toBeVisible();
  await page.getByRole("button", { name: "Resume cooking", exact: true }).click();
  await cooking.getByRole("button", { name: /Next step/ }).click();
  const finish = cooking.getByRole("button", { name: "Finish cooking", exact: true });
  await finish.scrollIntoViewIfNeeded();
  await expect(finish).toBeInViewport();
  await finish.click();
  await expect(page.getByRole("dialog", { name: "Complete dinner", exact: true })).toHaveCount(0);
  await expect(page.getByText("The saved dinner changed while cooking. Open the current dinner to complete it.")).toBeVisible();
  expect((await readKitchen(request)).state.meals[TODAY]).toMatchObject({ id: replacement.id, status: "planned" });
});

test("waste-aware filling preserves saved dinners and leaves past empty days untouched", async ({ page, request }) => {
  const recipe = await recipeFixture(request);
  const savedDate = "2026-10-23";
  const saved = mealFixture(recipe, savedDate, { locked: true });
  await saveFixture(request, { ...emptyState(), pantry: [{ id: "reserved-rice", name: "rice", measure: "200 g", useBy: savedDate }, { id: "beans-soon", name: "beans", measure: "400 g", useBy: TODAY }, { id: "garlic", name: "garlic", measure: "2 cloves" }], meals: { [savedDate]: saved } });
  await page.goto("/");
  await page.getByRole("button", { name: "Fill empty days", exact: true }).click();
  await expect.poll(async () => Object.keys((await readKitchen(request)).state.meals).length).toBeGreaterThan(1);
  const meals = (await readKitchen(request)).state.meals;
  expect(meals[savedDate]).toEqual(saved);
  expect(Object.keys(meals).every((date) => date >= TODAY)).toBeTruthy();
  expect(meals[TODAY].recipeId).toBe("fixture-vegan-beans");
  expect(Object.values(meals).filter((meal) => (meal as PlannedMeal).recipeId === recipe.id)).toHaveLength(1);
});

test("starting another dinner asks before replacing saved cooking progress and its timer", async ({ page, request }) => {
  const rice = await recipeFixture(request);
  const beans = await recipeFixture(request, "fixture-vegan-beans");
  const tomorrow = "2026-10-23";
  await saveFixture(request, { ...emptyState(), meals: { [TODAY]: mealFixture(rice), [tomorrow]: mealFixture(beans, tomorrow) } });
  await page.goto("/");
  await page.getByRole("button", { name: /^Cook Tomato Rice / }).click();
  const riceSession = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await riceSession.getByRole("button", { name: /Next step/ }).click();
  await riceSession.getByRole("button", { name: /Start.*10.*min/i }).click();
  await riceSession.getByRole("button", { name: /Exit cooking/ }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("rag-chef-cooking-v1")!));
  await page.getByRole("button", { name: /^Cook Garlic Beans / }).click();
  const confirmation = page.getByRole("dialog", { name: "Replace cooking session", exact: true });
  await expect(confirmation).toContainText("Tomato Rice");
  await expect(confirmation).toContainText("Garlic Beans");
  await confirmation.getByRole("button", { name: "Keep current session", exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("rag-chef-cooking-v1")!))).toEqual(saved);
  await page.getByRole("button", { name: "Resume cooking", exact: true }).click();
  await expect(riceSession).toContainText("Step 2");
  await expect(riceSession.getByRole("button", { name: "Pause timer", exact: true })).toBeEnabled();
  await riceSession.getByRole("button", { name: /Exit cooking/ }).click();
  await page.getByRole("button", { name: /^Cook Garlic Beans / }).click();
  await confirmation.getByRole("button", { name: "Replace cooking session", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Cooking Garlic Beans", exact: true })).toBeVisible();
  const replacement = await page.evaluate(() => JSON.parse(localStorage.getItem("rag-chef-cooking-v1")!));
  expect(replacement.id).not.toBe(saved.id);
  expect(replacement.recipe.id).toBe("fixture-vegan-beans");
  expect(replacement.timer.status).toBe("idle");
  expect((await readKitchen(request)).state.meals[TODAY].status).toBe("planned");
  expect((await readKitchen(request)).state.meals[tomorrow].status).toBe("planned");
});

test("same-ID amount edits invalidate cooking completion without deducting stock", async ({ page, request }) => {
  const recipe = await recipeFixture(request);
  const planned = mealFixture(recipe);
  const pantry = [{ id: "rice", name: "rice", measure: "500 g" }];
  await saveFixture(request, { ...emptyState(), pantry, meals: { [TODAY]: planned } });
  await page.goto("/");
  await page.getByRole("button", { name: /^Cook Tomato Rice / }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.getByRole("button", { name: /Exit cooking/ }).click();
  const edited = { ...planned, servings: 4, ingredientOverrides: { "0": "350 g" } };
  await saveFixture(request, { ...emptyState(), pantry, meals: { [TODAY]: edited } });
  await page.reload();
  await expect(page.getByRole("spinbutton", { name: "Servings Thu, Oct 22", exact: true })).toHaveValue("4");
  await page.getByRole("button", { name: "Resume cooking", exact: true }).click();
  await expect(cooking.getByRole("region", { name: "Ingredients for this dinner", exact: true })).toContainText("200 g");
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await cooking.getByRole("button", { name: "Finish cooking", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Complete dinner", exact: true })).toHaveCount(0);
  await expect(page.getByText("The saved dinner changed while cooking. Open the current dinner to complete it.")).toBeVisible();
  const current = (await readKitchen(request)).state;
  expect(current.meals[TODAY]).toEqual(edited);
  expect(current.pantry).toEqual(pantry);
});
