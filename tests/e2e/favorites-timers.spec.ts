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
async function recipes(request: APIRequestContext): Promise<Recipe[]> { return (await (await request.get("/api/recipes/catalog")).json()).recipes; }
async function navigate(page: Page, name: string) {
  if (name === "Settings") { await page.getByRole("button", { name, exact: true }).click(); return; }
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click();
}
function meal(recipe: Recipe, date: string, cooked = false): PlannedMeal {
  return { id: `dinner:${date}`, date, recipeId: recipe.id, recipe, title: recipe.title, baseServings: recipe.servings ?? null, servings: recipe.servings ?? null, batches: 1, ingredientOverrides: {}, locked: false, status: cooked ? "cooked" : "planned",
    ...(cooked ? { completion: { id: `completed:${date}`, at: `${date}T18:00:00.000Z`, deductions: [] } } : {}) };
}
test.beforeEach(async ({ page, request }) => {
  await page.clock.install({ time: new Date(`${TODAY}T12:00:00+03:00`) });
  if (test.info().project.name === "mobile") await page.setViewportSize({ width: 320, height: 740 });
  await save(request, empty());
});

test("main timer setup follows other tabs without replacing an unfinished duration draft", async ({ page, context, request }) => {
  const recipe = (await recipes(request)).find(item => item.id === "fixture-tomato-rice")!;
  await save(request, { ...empty(), meals: { [TODAY]: meal(recipe, TODAY) } });
  await page.goto("/");
  await page.getByRole("button", { name: "Cook dinner", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  const remaining = cooking.getByRole("timer", { name: "Time remaining", exact: true });
  await expect(remaining).toHaveText("05:00");
  await page.clock.pauseAt(new Date(`${TODAY}T12:10:00+03:00`));
  const other = await context.newPage();
  await other.goto("/");
  const changeFromOtherTab = async (seconds: number) => {
    await other.evaluate(seconds => {
      const session = JSON.parse(localStorage.getItem("rag-chef-cooking-v1")!);
      session.timer = { durationMs: seconds * 1000, remainingMs: seconds * 1000, endAt: null, status: "idle" };
      localStorage.setItem("rag-chef-cooking-v1", JSON.stringify(session));
    }, seconds);
  };
  await changeFromOtherTab(600);
  await expect(remaining).toHaveText("10:00");
  await cooking.getByRole("button", { name: "Set timer", exact: true }).click();
  const minutes = cooking.getByRole("spinbutton", { name: "Minutes", exact: true });
  const seconds = cooking.getByRole("spinbutton", { name: "Seconds", exact: true });
  await expect(minutes).toHaveValue("10");
  await changeFromOtherTab(1230);
  await expect(minutes).toHaveValue("20");
  await expect(seconds).toHaveValue("30");
  await minutes.fill("7"); await seconds.fill("15");
  await changeFromOtherTab(720);
  await expect(remaining).toHaveText("12:00");
  await expect(minutes).toHaveValue("7");
  await expect(seconds).toHaveValue("15");
  await cooking.getByRole("button", { name: "Start custom timer", exact: true }).click();
  await expect(remaining).toHaveText("07:15");
  await expect.poll(() => other.evaluate(() => JSON.parse(localStorage.getItem("rag-chef-cooking-v1")!).timer.durationMs)).toBe(435000);
  await changeFromOtherTab(585);
  await expect(remaining).toHaveText("09:45");
  await cooking.getByRole("button", { name: "Set timer", exact: true }).click();
  await expect(minutes).toHaveValue("9");
  await expect(seconds).toHaveValue("45");
  await other.close();
});

test("favorites persist across reloads, export with backups and remain subject to saved exclusions", async ({ page, request }) => {
  const catalogBefore = await recipes(request);
  await page.goto("/"); await navigate(page, "Recipes");
  await page.getByRole("searchbox", { name: "Search recipes", exact: true }).fill("Tomato Rice");
  await page.getByRole("button", { name: "Favorite: Tomato Rice", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.favoriteRecipeIds).toEqual(["fixture-tomato-rice"]);
  await page.reload(); await navigate(page, "Recipes");
  await page.getByRole("button", { name: "Favorites", exact: true }).click();
  await expect(page.locator(".recipe-card")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Remove favorite: Tomato Rice", exact: true })).toHaveAttribute("aria-pressed", "true");
  await navigate(page, "Settings");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export backup", exact: true }).click();
  const download = await downloading;
  const stream = await download.createReadStream(); let text = "";
  for await (const chunk of stream!) text += chunk;
  expect(JSON.parse(text).state.favoriteRecipeIds).toEqual(["fixture-tomato-rice"]);
  await page.getByLabel("Allergies", { exact: true }).fill("rice");
  await page.getByLabel("Allergies", { exact: true }).press("Enter");
  await navigate(page, "Recipes");
  await expect(page.locator(".recipe-card")).toHaveCount(0);
  expect((await read(request)).state.favoriteRecipeIds).toEqual(["fixture-tomato-rice"]);
  await navigate(page, "Settings");
  await page.getByRole("button", { name: "Remove allergies rice", exact: true }).click();
  await navigate(page, "Recipes");
  await expect(page.locator(".recipe-card")).toHaveCount(1);
  await page.getByRole("button", { name: "View Tomato Rice", exact: true }).click();
  await page.getByRole("button", { name: "Remove favorite", exact: true }).click();
  await page.getByRole("button", { name: "Close recipe", exact: true }).click();
  await expect(page.locator(".recipe-card")).toHaveCount(0);
  expect(await recipes(request)).toEqual(catalogBefore);
});

test("Cook again deduplicates recent dinners and creates a new meal without changing history or stock", async ({ page, request }) => {
  const catalog = await recipes(request);
  const rice = catalog.find(recipe => recipe.id === "fixture-tomato-rice")!;
  const pasta = catalog.find(recipe => recipe.id === "fixture-cheese-pasta")!;
  const beans = catalog.find(recipe => recipe.id === "fixture-vegan-beans")!;
  const meals = Object.fromEntries([meal(rice, "2026-10-19", true), meal(pasta, "2026-10-20", true), meal(rice, "2026-10-21", true), meal(beans, "2026-10-23")].map(meal => [meal.date, meal]));
  await save(request, { ...empty(), meals, pantry: [{ id: "rice", name: "rice", measure: "500 g" }] });
  await page.goto("/"); await navigate(page, "Recipes");
  await page.getByRole("button", { name: "Cook again", exact: true }).click();
  await expect(page.locator(".recipe-card")).toHaveCount(2);
  await expect(page.locator(".recipe-card").first()).toContainText("Tomato Rice");
  await expect(page.locator(".recipe-card").last()).toContainText("Cheese Pasta");
  const before = await read(request);
  await page.screenshot({ path: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/cook-again-${test.info().project.name}.png`, scale: "css" });
  await page.getByRole("button", { name: "Cook again for tonight: Tomato Rice", exact: true }).click();
  await expect(page.getByRole("region", { name: "Chosen dinner", exact: true })).toContainText("Tomato Rice");
  await expect.poll(async () => (await read(request)).state.meals[TODAY]?.status).toBe("planned");
  const after = await read(request);
  for (const date of Object.keys(meals)) expect(after.state.meals[date]).toEqual(before.state.meals[date]);
  expect(after.state.pantry).toEqual(before.state.pantry);
  expect(after.state.meals[TODAY].completion).toBeUndefined();
});

test("main and additional timers share clear validation and accept long durations", async ({ page, request }) => {
  const rice = (await recipes(request)).find(recipe => recipe.id === "fixture-tomato-rice")!;
  await save(request, { ...empty(), meals: { [TODAY]: meal(rice, TODAY) } });
  const kitchenBefore = await read(request);
  await page.goto("/"); await page.getByRole("button", { name: "Cook dinner", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.getByRole("button", { name: "Set timer", exact: true }).click();
  const minutes = cooking.getByRole("spinbutton", { name: "Minutes", exact: true });
  const seconds = cooking.getByRole("spinbutton", { name: "Seconds", exact: true });
  await minutes.fill("1.5");
  await cooking.getByRole("button", { name: "Start custom timer", exact: true }).click();
  await expect(cooking.getByRole("alert")).toHaveText("Enter whole minutes from 0 to 1440.");
  await minutes.fill("90"); await seconds.fill("60");
  await cooking.getByRole("button", { name: "Start custom timer", exact: true }).click();
  await expect(cooking.getByRole("alert")).toHaveText("Enter whole seconds from 0 to 59.");
  await minutes.fill("1440"); await seconds.fill("1");
  await cooking.getByRole("button", { name: "Start custom timer", exact: true }).click();
  await expect(cooking.getByRole("alert")).toHaveText("Choose a timer between 1 second and 24 hours.");
  await expect(cooking.getByRole("button", { name: "Pause timer", exact: true })).toHaveCount(0);
  await minutes.fill("90"); await seconds.fill("15");
  await cooking.getByRole("button", { name: "Start custom timer", exact: true }).click();
  await expect(cooking.getByRole("timer", { name: "Time remaining", exact: true })).toHaveText("1:30:15");
  await cooking.getByRole("button", { name: "Pause timer", exact: true }).click();
  await cooking.getByRole("button", { name: "Add another timer", exact: true }).click();
  const form = cooking.getByRole("form", { name: "New cooking timer", exact: true });
  await form.getByRole("textbox", { name: "New timer name", exact: true }).fill("Stock");
  const extraMinutes = form.getByRole("spinbutton", { name: "Additional timer minutes", exact: true });
  const extraSeconds = form.getByRole("spinbutton", { name: "Additional timer seconds", exact: true });
  await extraMinutes.fill("1.5");
  await form.getByRole("button", { name: "Start additional timer", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText("Enter whole minutes from 0 to 1440.");
  await extraMinutes.fill("90"); await extraSeconds.fill("60");
  await form.getByRole("button", { name: "Start additional timer", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText("Enter whole seconds from 0 to 59.");
  await extraMinutes.fill("1440"); await extraSeconds.fill("1");
  await form.getByRole("button", { name: "Start additional timer", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText("Choose a timer between 1 second and 24 hours.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/timer-validation-${test.info().project.name}.png`, scale: "css" });
  await extraSeconds.fill("0");
  await form.getByRole("button", { name: "Start additional timer", exact: true }).click();
  await expect(cooking.getByRole("timer", { name: "Stock time remaining", exact: true })).toHaveText("24:00:00");
  await expect(form).toHaveCount(0);
  expect(await read(request)).toEqual(kitchenBefore);
});

test("labeled timers run independently, survive reloads, and require a choice before removing an active timer", async ({ page, request }) => {
  const rice = (await recipes(request)).find(recipe => recipe.id === "fixture-tomato-rice")!;
  await save(request, { ...empty(), meals: { [TODAY]: meal(rice, TODAY) } });
  const kitchenBefore = await read(request);
  await page.goto("/"); await page.getByRole("button", { name: "Cook dinner", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.getByRole("button", { name: "Set timer", exact: true }).click();
  await cooking.getByRole("textbox", { name: "Main timer name", exact: true }).fill("Sauce");
  await cooking.getByRole("spinbutton", { name: "Minutes", exact: true }).fill("0");
  await cooking.getByRole("spinbutton", { name: "Seconds", exact: true }).fill("20");
  await cooking.getByRole("button", { name: "Start custom timer", exact: true }).click();
  for (const [label, duration] of [["Rice", "2"], ["Oven", "20"]]) {
    await cooking.getByRole("button", { name: "Add another timer", exact: true }).click();
    const form = cooking.getByRole("form", { name: "New cooking timer", exact: true });
    await form.getByRole("textbox", { name: "New timer name", exact: true }).fill(label);
    await form.getByRole("spinbutton", { name: "Additional timer minutes", exact: true }).fill("0");
    await form.getByRole("spinbutton", { name: "Additional timer seconds", exact: true }).fill(duration);
    await form.getByRole("button", { name: "Start additional timer", exact: true }).click();
  }
  await page.clock.fastForward(3000);
  await expect(cooking.getByRole("status")).toContainText("Rice timer finished");
  const oven = cooking.getByRole("group", { name: "Oven timer", exact: true });
  await oven.getByRole("button", { name: "Pause Oven timer", exact: true }).click();
  const remaining = await oven.getByRole("timer").textContent();
  await page.clock.fastForward(2000);
  await expect(oven.getByRole("timer")).toHaveText(remaining!);
  await page.reload();
  await page.getByRole("button", { name: "Resume cooking", exact: true }).click();
  await expect(cooking.getByRole("timer", { name: "Oven time remaining", exact: true })).toHaveText(remaining!);
  await expect(cooking.getByRole("timer", { name: "Rice time remaining", exact: true })).toHaveText("00:00");
  await expect(cooking.getByRole("region", { name: "Cooking timer", exact: true })).toContainText("Sauce");
  await oven.getByRole("button", { name: "Remove Oven timer", exact: true }).click();
  await oven.getByRole("button", { name: "Keep timer", exact: true }).click();
  await expect(oven).toBeVisible();
  await oven.getByRole("button", { name: "Remove Oven timer", exact: true }).click();
  await oven.getByRole("button", { name: "Remove timer", exact: true }).click();
  await expect(oven).toHaveCount(0);
  await cooking.getByRole("button", { name: "Next step →", exact: true }).click();
  await expect(cooking.getByRole("timer", { name: "Rice time remaining", exact: true })).toHaveText("00:00");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/multiple-timers-${test.info().project.name}.png`, scale: "css" });
  expect(await read(request)).toEqual(kitchenBefore);
});
