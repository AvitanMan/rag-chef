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
  await page.goto("/"); await navigate(page, "Plan");
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
  await page.reload(); await navigate(page, "Plan");
  await navigate(page, "Pantry");
  await expect(date).toHaveValue(tomorrow);
  await date.fill("");
  await expect.poll(async () => (await readKitchen(request)).state.pantry.find((stock: { id: string }) => stock.id === "rice").useBy).toBeUndefined();
  await navigate(page, "Shopping");
  await expect(page.getByRole("checkbox", { name: "Bought rice 200 g", exact: true })).toBeVisible();
});

for (const date of ["2026-10-21", "2026-10-23"]) {
  test(`cooking dinner planned for ${date} checks stock against today`, async ({ page, request }) => {
    const recipe = await recipeFixture(request);
    const early = date > TODAY;
    const useBy = early ? TODAY : date;
    await saveFixture(request, { ...emptyState(), pantry: [{ id: "rice", name: "rice", measure: "200 g", useBy }, { id: "tomato", name: "tomato", measure: "4" }], meals: { [date]: mealFixture(recipe, date) } });
    await page.goto("/"); await navigate(page, "Plan");
    if (!early) {
      await navigate(page, "Shopping");
      await expect(page.getByRole("checkbox", { name: "Bought rice 200 g", exact: true })).toBeVisible();
      await navigate(page, "Plan");
    }
    await page.getByRole("button", { name: /^Cook Tomato Rice / }).click();
    const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
    await cooking.getByRole("button", { name: /Next step/ }).click();
    await cooking.getByRole("button", { name: "Finish cooking", exact: true }).click();
    const complete = page.getByRole("region", { name: "Complete dinner", exact: true });
    if (early) await expect(complete).toContainText("rice: 200 g → 0 g");
    else await expect(complete).toContainText("past its entered use-by date");
    await complete.getByRole("checkbox").check();
    await complete.getByRole("button", { name: "Mark dinner cooked", exact: true }).click();
    await expect.poll(async () => (await readKitchen(request)).state.pantry.find((stock: { id: string }) => stock.id === "rice").measure).toBe(early ? "0 g" : "200 g");
  });
}

test("cooking shows final amounts once and cooked undo restores dated stock", async ({ page, request }) => {
  const recipe = await recipeFixture(request);
  const planned = mealFixture(recipe, TODAY, { servings: 4, ingredientOverrides: { "0": "350 g" } });
  await saveFixture(request, { ...emptyState(), pantry: [{ id: "rice", name: "rice", measure: "500 g", useBy: "2026-10-24" }, { id: "tomato", name: "tomato", measure: "8" }], meals: { [TODAY]: planned } });
  await page.goto("/"); await navigate(page, "Plan");
  await page.getByRole("button", { name: /^Cook Tomato Rice / }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.locator(".cook-ingredients > summary").click();
  const amounts = cooking.getByRole("region", { name: "Ingredients for this dinner", exact: true });
  await expect(amounts).toContainText("350 g");
  await expect(amounts).not.toContainText("700 g");
  await expect(cooking).toContainText("Rinse the rice.");
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await expect(cooking).toContainText("Simmer the rice and tomatoes for 10 minutes.");
  await cooking.getByRole("button", { name: "Finish cooking", exact: true }).click();
  const complete = page.getByRole("region", { name: "Complete dinner", exact: true });
  await complete.getByRole("checkbox").check();
  await complete.getByRole("button", { name: "Mark dinner cooked", exact: true }).click();
  await expect.poll(async () => (await readKitchen(request)).state.pantry.find((stock: { id: string }) => stock.id === "rice").measure).toBe("150 g");
  await page.getByRole("button", { name: /Undo cooked/ }).click();
  await expect.poll(async () => (await readKitchen(request)).state.pantry.find((stock: { id: string }) => stock.id === "rice")).toMatchObject({ measure: "500 g", useBy: "2026-10-24" });
});

test("source-duration timers pause, reset and keep their remaining time across step changes", async ({ page, request }) => {
  const recipe = await recipeFixture(request);
  await saveFixture(request, { ...emptyState(), meals: { [TODAY]: mealFixture(recipe) } });
  await page.goto("/"); await navigate(page, "Plan");
  await page.getByRole("button", { name: /^Cook Tomato Rice / }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await cooking.getByRole("button", { name: "Start 10 min from this step", exact: true }).click();
  await page.clock.fastForward("00:01:00");
  await expect(cooking.getByRole("timer")).toContainText("09:00");
  await cooking.getByRole("button", { name: "Pause timer", exact: true }).click();
  await cooking.getByRole("button", { name: "Dark mode", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
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
  await page.goto("/"); await navigate(page, "Plan");
  await page.getByRole("button", { name: /^Cook Tomato Rice / }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.getByRole("button", { name: "Set timer", exact: true }).click();
  await cooking.getByRole("spinbutton", { name: "Minutes", exact: true }).fill("0");
  await cooking.getByRole("spinbutton", { name: "Seconds", exact: true }).fill("2");
  await cooking.getByRole("button", { name: "Start custom timer", exact: true }).click();
  await page.clock.fastForward(3000);
  await expect(cooking.getByRole("status")).toContainText("Timer finished");
  expect((await readKitchen(request)).state.meals[TODAY].status).toBe("planned");
  await page.reload(); await navigate(page, "Plan");
  await expect(page.getByRole("button", { name: /^Cook Tomato Rice / })).toBeVisible();
  await page.getByRole("button", { name: "Resume cooking", exact: true }).click();
  await expect(cooking.getByRole("timer")).toContainText("00:00");
  await expect(cooking.getByRole("status")).toContainText("Timer finished");
  const replacement = { ...planned, id: "replacement-dinner" };
  await saveFixture(request, { ...emptyState(), meals: { [TODAY]: replacement } });
  await page.reload(); await navigate(page, "Plan");
  await expect(page.getByRole("button", { name: /^Cook Tomato Rice / })).toBeVisible();
  await page.getByRole("button", { name: "Resume cooking", exact: true }).click();
  await cooking.getByRole("button", { name: /Next step/ }).click();
  const finish = cooking.getByRole("button", { name: "Finish cooking", exact: true });
  await finish.scrollIntoViewIfNeeded();
  await expect(finish).toBeInViewport();
  await finish.click();
  await expect(page.getByRole("region", { name: "Complete dinner", exact: true }).getByRole("button", { name: "Mark dinner cooked", exact: true })).toBeDisabled();
  await expect(page.getByText("This dinner changed. Return to the current dinner before completing it.")).toBeVisible();
  expect((await readKitchen(request)).state.meals[TODAY]).toMatchObject({ id: replacement.id, status: "planned" });
});

test("waste-aware filling preserves saved dinners and leaves past empty days untouched", async ({ page, request }) => {
  const recipe = await recipeFixture(request);
  const savedDate = "2026-10-23";
  const saved = mealFixture(recipe, savedDate, { locked: true });
  await saveFixture(request, { ...emptyState(), pantry: [{ id: "reserved-rice", name: "rice", measure: "200 g", useBy: savedDate }, { id: "beans-soon", name: "beans", measure: "400 g", useBy: TODAY }, { id: "garlic", name: "garlic", measure: "2 cloves" }], meals: { [savedDate]: saved } });
  await page.goto("/"); await navigate(page, "Plan");
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
  await page.goto("/"); await navigate(page, "Plan");
  await page.getByRole("button", { name: /^Cook Tomato Rice / }).click();
  const riceSession = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await riceSession.getByRole("button", { name: /Next step/ }).click();
  await riceSession.getByRole("button", { name: "Start 10 min from this step", exact: true }).click();
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
  await page.goto("/"); await navigate(page, "Plan");
  await page.getByRole("button", { name: /^Cook Tomato Rice / }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.getByRole("button", { name: /Exit cooking/ }).click();
  const edited = { ...planned, servings: 4, ingredientOverrides: { "0": "350 g" } };
  await saveFixture(request, { ...emptyState(), pantry, meals: { [TODAY]: edited } });
  await page.reload(); await navigate(page, "Plan");
  await expect(page.getByRole("spinbutton", { name: "Servings Thu, Oct 22", exact: true })).toHaveValue("4");
  await page.getByRole("button", { name: "Resume cooking", exact: true }).click();
  await cooking.locator(".cook-ingredients > summary").click();
  await expect(cooking.getByRole("region", { name: "Ingredients for this dinner", exact: true })).toContainText("200 g");
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await cooking.getByRole("button", { name: "Finish cooking", exact: true }).click();
  await expect(page.getByRole("region", { name: "Complete dinner", exact: true }).getByRole("button", { name: "Mark dinner cooked", exact: true })).toBeDisabled();
  await expect(page.getByText("This dinner changed. Return to the current dinner before completing it.")).toBeVisible();
  const current = (await readKitchen(request)).state;
  expect(current.meals[TODAY]).toEqual(edited);
  expect(current.pantry).toEqual(pantry);
});


test("a long cooking recipe uses one scrolling area and keeps step navigation visible", async ({ page, request }) => {
  const recipe = await recipeFixture(request);
  const longRecipe = { ...recipe, ingredients: Array.from({ length: 40 }, (_, index) => ({ name: `ingredient ${index + 1}`, measure: "100 g" })) };
  await saveFixture(request, { ...emptyState(), meals: { [TODAY]: mealFixture(longRecipe) } });
  await page.goto("/"); await navigate(page, "Plan");
  await page.getByRole("button", { name: /^Cook Tomato Rice / }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await expect(cooking.locator(".cook-ingredients")).not.toHaveAttribute("open");
  await cooking.locator(".cook-ingredients > summary").click();
  const scrollers = await cooking.evaluate((dialog) => [dialog, ...dialog.querySelectorAll("*")].filter((element) =>
    /^(auto|scroll)$/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1
  ).map((element) => element.tagName));
  expect(scrollers).toEqual(["MAIN"]);
  await expect(page.locator("html")).toHaveCSS("overflow", "hidden");
  await cooking.getByRole("listitem").last().scrollIntoViewIfNeeded();
  const next = cooking.getByRole("button", { name: /Next step/ });
  const box = await next.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await next.click();
  await expect.poll(() => cooking.getByRole("main").evaluate((main) => main.scrollTop)).toBe(0);
  await expect(cooking).toContainText("Simmer the rice and tomatoes for 10 minutes.");
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).not.toHaveCSS("overflow", "hidden");
});

test("refilling cleared days draws a new plan while preserving locked dinners", async ({ page, request }) => {
  await page.addInitScript(() => {
    const original = crypto.getRandomValues.bind(crypto);
    let seed = 1;
    Object.defineProperty(crypto, "getRandomValues", { configurable: true, value: (array: Uint32Array) => {
      if (array instanceof Uint32Array && array.length === 1) { array[0] = seed++; return array; }
      return original(array);
    } });
  });
  const recipe = await recipeFixture(request);
  const saved = mealFixture(recipe, "2026-10-26", { locked: true });
  await saveFixture(request, { ...emptyState(), meals: { [saved.date]: saved } });
  await page.goto("/"); await navigate(page, "Plan");
  await page.getByRole("button", { name: "Next week", exact: true }).click();
  await page.getByRole("button", { name: "Fill empty days", exact: true }).click();
  await expect(page.locator(".day-card.filled")).toHaveCount(7);
  await expect.poll(async () => Object.keys((await readKitchen(request)).state.meals).length).toBe(7);
  const first = (await readKitchen(request)).state.meals;
  await page.getByRole("region", { name: "Plan actions", exact: true }).getByText("More", { exact: true }).click();
  await page.getByRole("button", { name: "Clear unlocked", exact: true }).click();
  await page.getByRole("button", { name: "Remove unlocked meals", exact: true }).click();
  await expect(page.locator(".day-card.filled")).toHaveCount(1);
  await expect.poll(async () => Object.keys((await readKitchen(request)).state.meals).length).toBe(1);
  await page.getByRole("button", { name: "Fill empty days", exact: true }).click();
  await expect.poll(async () => Object.keys((await readKitchen(request)).state.meals).length).toBe(7);
  const second = (await readKitchen(request)).state.meals;
  const ids = (meals: Record<string, PlannedMeal>) => Object.keys(meals).sort().map((date) => meals[date].recipeId);
  expect(ids(second)).not.toEqual(ids(first));
  expect(new Set(ids(second)).size).toBe(7);
  expect(second[saved.date]).toEqual(saved);
});
