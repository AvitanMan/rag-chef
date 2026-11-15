import { test, expect, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import type { CookingProfile, KitchenDocument, KitchenState } from "../../app/lib/kitchen-types";
import { isKitchenWrite } from "./kitchen-requests";
import { openPantryIngredientManagement, openPantryAdd } from "./pantry-helpers";

const TODAY = "2026-10-22";
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });
const profile = (changes: Partial<CookingProfile> = {}): CookingProfile => ({
  version: 1, allergies: [], diet: "No restriction", dislikes: [], skillLevel: "Confident beginner",
  budget: "Medium", equipment: ["Oven", "Stovetop"], ...changes,
});

async function saved(request: APIRequestContext): Promise<KitchenDocument> {
  const response = await request.get("/api/kitchen");
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function save(request: APIRequestContext, state: KitchenState) {
  const current = await saved(request);
  const response = await request.put("/api/kitchen", { data: { revision: current.revision, state } });
  expect(response.ok(), await response.text()).toBeTruthy();
}
async function openPantry(page: Page) {
  await page.goto("/");
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: /Pantry/ }).filter({ visible: true }).first().click();
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeVisible();
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
}
function ingredient(page: Page, name: string) {
  return page.getByRole("button", { name: `Use ${name} tonight`, exact: true });
}
function results(page: Page) {
  return page.getByRole("region", { name: "Dinner ideas for tonight", exact: true });
}
async function findDinner(page: Page, names: string[]) {
  for (const name of names) {
    await ingredient(page, name).click();
    await expect(ingredient(page, name)).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("button", { name: "Find dinners", exact: true }).click();
  await expect(results(page)).toBeVisible();
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}
async function refreshKitchen(page: Page) {
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/kitchen" && response.request().method() === "GET");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect((await refreshed).ok()).toBeTruthy();
}

test.beforeEach(async ({ page, request, baseURL }) => {
  expect(baseURL, "This suite needs the disposable preview").toBeTruthy();
  expect(["127.0.0.1", "localhost"]).toContain(new URL(baseURL!).hostname);
  expect(new URL(baseURL!).port).not.toBe("3000");
  await page.clock.install({ time: new Date(`${TODAY}T12:00:00+03:00`) });
  await page.route("**/api/chef", route => route.abort());
  await save(request, empty());
});

test("plain ingredients save immediately, survive reload and do not create duplicate pantry entries", async ({ page, request }) => {
  await openPantry(page);
  const advanced = page.locator("details").filter({ has: page.locator("summary", { hasText: "Manage amounts, dates and batches" }) });
  await expect(advanced).not.toHaveAttribute("open");
  await page.getByRole("textbox", { name: "New pantry ingredient", exact: true }).fill("rice, tomato\ngarlic");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await saved(request)).state?.pantry.map(item => ({ name: item.name, measure: item.measure }))).toEqual([
    { name: "rice", measure: "" }, { name: "tomato", measure: "" }, { name: "garlic", measure: "" },
  ]);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  const before = await saved(request);
  await page.reload();
  // Navigation state need not be persisted for the pantry itself to be saved.
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: /Pantry/ }).filter({ visible: true }).first().click();
  for (const name of ["rice", "tomato", "garlic"]) {
    await expect(ingredient(page, name)).toBeVisible();
    await expect(ingredient(page, name)).toHaveAttribute("aria-pressed", "false");
  }
  await openPantryAdd(page);
  await page.getByRole("textbox", { name: "New pantry ingredient", exact: true }).fill("rice, beans, beans");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await saved(request)).state?.pantry.map(item => item.name)).toEqual(["rice", "tomato", "garlic", "beans"]);
  const after = await saved(request);
  expect(after.state!.pantry.slice(0, 3)).toEqual(before.state!.pantry);
  expect(after.state!.pantry.every(item => item.measure === "" && item.useBy === undefined)).toBe(true);
});

test("picked foods offer dinner options without editing stock and lead into the existing dinner flow", async ({ page, request }, info) => {
  await save(request, { ...empty(), pantry: [
    { id: "rice", name: "rice", measure: "500 g", useBy: "2026-10-25" },
    { id: "tomato", name: "tomato", measure: "2" },
    { id: "garlic", name: "garlic", measure: "" },
  ] });
  await openPantry(page);
  const before = await saved(request), writes: string[] = [], chefCalls: string[] = [];
  page.on("request", request => {
    if (isKitchenWrite(request)) writes.push(request.url());
    if (new URL(request.url()).pathname === "/api/chef") chefCalls.push(request.url());
  });
  for (const name of ["rice", "tomato"]) {
    await ingredient(page, name).click();
    await expect(ingredient(page, name)).toHaveAttribute("aria-pressed", "true");
  }
  await screenshot(page, info, "pantry-selected-ingredients");
  await page.getByRole("button", { name: "Find dinners", exact: true }).click();
  await expect(results(page).locator(".recipe-card")).toHaveCount(3);
  await expect(results(page).locator(".recipe-card").first()).toContainText("Tomato Rice");
  await screenshot(page, info, "pantry-matching-dinner");
  await page.clock.runFor(700);
  expect(writes).toEqual([]);
  expect(await saved(request)).toEqual(before);
  expect(chefCalls).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await results(page).getByRole("button", { name: "Choose for tonight: Tomato Rice", exact: true }).click();
  await expect(page.getByRole("region", { name: "Chosen dinner", exact: true })).toContainText("Tomato Rice");
  await expect.poll(async () => (await saved(request)).state?.meals[TODAY]?.recipeId).toBe("fixture-tomato-rice");
  expect((await saved(request)).state!.pantry).toEqual(before.state!.pantry);
  expect(chefCalls).toEqual([]);
});

test("Back and Forward restore the ingredient combination belonging to each dinner search", async ({ page, request }) => {
  await save(request, { ...empty(), pantry: [
    { id: "rice", name: "rice", measure: "" }, { id: "tomato", name: "tomato", measure: "" },
    { id: "beans", name: "beans", measure: "" }, { id: "garlic", name: "garlic", measure: "" },
  ] });
  await openPantry(page);
  const before = await saved(request);
  await findDinner(page, ["rice", "tomato"]);
  await expect(results(page).locator(".recipe-card")).toHaveCount(3);
  const firstSearchOrder = await results(page).locator(".recipe-title-button").allTextContents();
  expect(firstSearchOrder).toContain("Tomato Rice");
  await results(page).getByRole("button", { name: "Change ingredients", exact: true }).click();
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await findDinner(page, ["beans", "garlic"]);
  await expect(results(page).locator(".recipe-card")).toHaveCount(1);
  await expect(results(page).locator(".recipe-card")).toContainText("Garlic Beans");

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeVisible();
  await page.goBack();
  await expect(results(page).getByRole("button", { name: "Remove rice from picks", exact: true })).toBeVisible();
  await expect(results(page).getByRole("button", { name: "Remove tomato from picks", exact: true })).toBeVisible();
  await expect(results(page).locator(".recipe-card")).toHaveCount(3);
  await expect(results(page).locator(".recipe-title-button")).toHaveText(firstSearchOrder);
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeVisible();
  await page.goForward();
  await expect(results(page).getByRole("button", { name: "Remove beans from picks", exact: true })).toBeVisible();
  await expect(results(page).getByRole("button", { name: "Remove garlic from picks", exact: true })).toBeVisible();
  await expect(results(page).locator(".recipe-card")).toHaveCount(1);
  await expect(results(page).locator(".recipe-card")).toContainText("Garlic Beans");
  await page.clock.runFor(700);
  expect(await saved(request)).toEqual(before);
});

test("leaving pantry results allows choosing an unrelated recipe from the recipe browser", async ({ page, request }) => {
  await save(request, { ...empty(), pantry: [
    { id: "rice", name: "rice", measure: "" }, { id: "tomato", name: "tomato", measure: "" },
  ] });
  await openPantry(page);
  const before = await saved(request);
  await findDinner(page, ["rice", "tomato"]);
  await expect(results(page).locator(".recipe-card")).toHaveCount(3);
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: /Recipes/ }).filter({ visible: true }).first().click();
  await page.getByRole("searchbox", { name: "Search recipes", exact: true }).fill("Cheese Pasta");
  await page.getByRole("button", { name: "Choose for tonight: Cheese Pasta", exact: true }).click();
  await expect(page.getByRole("region", { name: "Chosen dinner", exact: true })).toContainText("Cheese Pasta");
  await expect.poll(async () => (await saved(request)).state?.meals[TODAY]?.recipeId).toBe("fixture-cheese-pasta");
  expect((await saved(request)).state!.pantry).toEqual(before.state!.pantry);
});

test("editing Pantry picks updates that history entry without changing the previous dinner search", async ({ page, request }) => {
  await save(request, { ...empty(), pantry: [
    { id: "rice", name: "rice", measure: "" }, { id: "tomato", name: "tomato", measure: "" },
  ] });
  await openPantry(page);
  const before = await saved(request), writes: string[] = [], chefCalls: string[] = [];
  page.on("request", request => {
    if (isKitchenWrite(request)) writes.push(request.url());
    if (new URL(request.url()).pathname === "/api/chef") chefCalls.push(request.url());
  });
  await findDinner(page, ["rice", "tomato"]);
  await results(page).getByRole("button", { name: "Change ingredients", exact: true }).click();
  await page.getByRole("button", { name: "Remove rice from picks", exact: true }).click();
  await expect(ingredient(page, "rice")).toHaveAttribute("aria-pressed", "false");
  await expect(ingredient(page, "tomato")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Find dinners", exact: true }).click();
  await expect(results(page).getByRole("button", { name: "Remove rice from picks", exact: true })).toHaveCount(0);
  await expect(results(page).getByRole("button", { name: "Remove tomato from picks", exact: true })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeVisible();
  await expect(ingredient(page, "rice")).toHaveAttribute("aria-pressed", "false");
  await expect(ingredient(page, "tomato")).toHaveAttribute("aria-pressed", "true");
  await page.goBack();
  await expect(results(page).getByRole("button", { name: "Remove rice from picks", exact: true })).toBeVisible();
  await expect(results(page).getByRole("button", { name: "Remove tomato from picks", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeVisible();
  await expect(ingredient(page, "rice")).toHaveAttribute("aria-pressed", "false");
  await expect(ingredient(page, "tomato")).toHaveAttribute("aria-pressed", "true");
  await page.goForward();
  await expect(results(page).getByRole("button", { name: "Remove rice from picks", exact: true })).toHaveCount(0);
  await expect(results(page).getByRole("button", { name: "Remove tomato from picks", exact: true })).toBeVisible();
  await page.clock.runFor(700);
  expect(writes).toEqual([]);
  expect(chefCalls).toEqual([]);
  expect(await saved(request)).toEqual(before);
});

for (const change of ["remote removal", "entered date passing"] as const) {
  test(`an unavailable pick through ${change} is shown while valid foods still offer dinner options`, async ({ page, request }) => {
    const state = { ...empty(), pantry: [
      { id: "rice", name: "rice", measure: "" }, { id: "tomato", name: "tomato", measure: "2", useBy: TODAY },
    ] };
    await save(request, state);
    await openPantry(page);
    await findDinner(page, ["rice", "tomato"]);
    await expect(results(page).locator(".recipe-card")).toHaveCount(3);
    const writes: string[] = [];
    page.on("request", request => { if (isKitchenWrite(request)) writes.push(request.url()); });
    if (change === "remote removal") {
      await save(request, { ...state, pantry: state.pantry.filter(item => item.id !== "tomato") });
    } else {
      await page.clock.setSystemTime(new Date("2026-10-23T00:00:01+03:00"));
    }
    const afterExternalChange = await saved(request);
    await refreshKitchen(page);
    await expect(results(page).locator(".pantry-selection-chips")).toContainText("Unavailable");
    await expect(results(page).locator(".recipe-card")).toHaveCount(2);
    await expect(results(page).getByRole("button", { name: "Remove tomato from picks", exact: true })).toBeVisible();
    await results(page).getByRole("button", { name: "Change ingredients", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeVisible();
    await expect(page.locator(".pantry-selection-chips")).toContainText("Unavailable");
    await expect(page.getByRole("button", { name: "Find dinners", exact: true })).toBeEnabled();
    await expect(ingredient(page, "tomato")).toHaveCount(0);
    await page.getByRole("button", { name: "Clear selection", exact: true }).click();
    await findDinner(page, ["rice"]);
    await expect(results(page).locator(".recipe-card")).toHaveCount(2);
    await page.clock.runFor(700);
    expect(writes).toEqual([]);
    expect(await saved(request)).toEqual(afterExternalChange);
  });
}

test("ingredient Details opens its saved batch and Add another batch still requires an explicit preview", async ({ page, request }) => {
  await save(request, { ...empty(), pantry: [{ id: "rice", name: "rice", measure: "500 g", useBy: "2026-10-25" }] });
  await openPantry(page);
  const before = await saved(request);
  const management = page.locator("details.pantry-management");
  await expect(management).not.toHaveAttribute("open");
  await openPantryIngredientManagement(page, "rice");
  await expect(management).toHaveAttribute("open", "");
  const amount = page.locator("#pantry-row-rice").getByRole("textbox", { name: "Available rice", exact: true });
  await expect(amount).toBeFocused();
  await expect(amount).toHaveValue("500 g");
  await page.getByRole("button", { name: "Add another batch of rice", exact: true }).click();
  const input = page.getByRole("textbox", { name: "New pantry ingredient", exact: true });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("rice: ");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Review pantry ingredients", exact: true });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole("textbox", { name: "Amount 1", exact: true })).toHaveValue("");
  await page.clock.runFor(700);
  expect(await saved(request)).toEqual(before);
  await preview.getByRole("button", { name: "Confirm new batch", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect.poll(async () => (await saved(request)).state?.pantry.length).toBe(2);
  const after = await saved(request);
  expect(after.state!.pantry[0]).toEqual(before.state!.pantry[0]);
  expect(after.state!.pantry[1]).toMatchObject({ name: "rice", measure: "" });
  expect(after.state!.pantry[1].id).not.toBe("rice");
});

test("an empty recipe collection offers setup while keeping the selected pantry ingredients", async ({ page, request }) => {
  await save(request, { ...empty(), pantry: [{ id: "rice", name: "rice", measure: "" }] });
  await page.route("**/api/recipes/catalog", route => route.fulfill({ json: { recipes: [], metadataByRecipeId: {}, contentHashesByRecipeId: {} } }));
  await openPantry(page);
  const before = await saved(request);
  await findDinner(page, ["rice"]);
  await expect(results(page).getByRole("button", { name: "Load starter recipes", exact: true })).toBeVisible();
  await expect(results(page).getByText("No dinners use these picks with your saved requirements.", { exact: true })).toHaveCount(0);
  await results(page).getByRole("button", { name: "Choose other ingredients", exact: true }).click();
  await expect(ingredient(page, "rice")).toHaveAttribute("aria-pressed", "true");
  expect(await saved(request)).toEqual(before);
});

test("unmatched picks show no unrelated recipes and choosing other ingredients recovers", async ({ page, request }) => {
  await save(request, { ...empty(), pantry: [
    { id: "rice", name: "rice", measure: "" }, { id: "dragon", name: "dragon fruit", measure: "" },
  ] });
  await openPantry(page);
  const before = await saved(request);
  await findDinner(page, ["dragon fruit"]);
  await expect(results(page).locator(".recipe-card")).toHaveCount(0);
  await expect(results(page)).toContainText("No dinners use these picks with your saved requirements.");
  await results(page).getByRole("button", { name: "Browse dinners", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search recipes", exact: true })).toBeVisible();
  await page.goBack();
  await expect(results(page)).toBeVisible();
  await results(page).getByRole("button", { name: "Choose other ingredients", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeVisible();
  await expect(ingredient(page, "dragon fruit")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Remove dragon fruit from picks", exact: true }).click();
  await ingredient(page, "rice").click();
  await page.getByRole("button", { name: "Find dinners", exact: true }).click();
  await expect(results(page).locator(".recipe-card")).toHaveCount(2);
  await expect(results(page).getByRole("button", { name: "Choose for tonight: Tomato Rice", exact: true })).toBeVisible();
  await expect(results(page).getByRole("button", { name: "Choose for tonight: Salmon Bowl", exact: true })).toBeVisible();
  await page.clock.runFor(700);
  expect(await saved(request)).toEqual(before);
});

for (const { label, preferences, expectedTitle, excludedTitle } of [
  { label: "allergies", preferences: profile({ allergies: ["tomato"] }), expectedTitle: "Salmon Bowl", excludedTitle: "Tomato Rice" },
  { label: "diet", preferences: profile({ diet: "Vegan" }), expectedTitle: "Tomato Rice", excludedTitle: "Salmon Bowl" },
]) {
  test(`pantry dinner ideas respect saved ${label}`, async ({ page, request }) => {
    await save(request, { ...empty(), cookingProfile: preferences, pantry: [{ id: "rice", name: "rice", measure: "" }] });
    await openPantry(page);
    const before = await saved(request);
    await findDinner(page, ["rice"]);
    await expect(results(page).locator(".recipe-card")).toHaveCount(1);
    await expect(results(page).locator(".recipe-card")).toContainText(expectedTitle);
    await expect(results(page).getByRole("button", { name: `Choose for tonight: ${excludedTitle}`, exact: true })).toHaveCount(0);
    await page.clock.runFor(700);
    expect(await saved(request)).toEqual(before);
  });
}
