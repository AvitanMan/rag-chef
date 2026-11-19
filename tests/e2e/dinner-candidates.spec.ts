import { writeFile } from "node:fs/promises";
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { EVERYDAY_RECIPES } from "../../app/lib/everyday-collection";
import { DEMO_SOURCE } from "../../app/lib/demo-recipes";
import type { KitchenDocument, KitchenState, PlannedMeal } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";
import { MAX_PENDING_KITCHEN_WRITES } from "../../app/lib/kitchen-write-queue";
import { draft, navigate, openPendingKitchenOutbox, saved } from "./pending-kitchen-outbox";
import { isKitchenWrite } from "./kitchen-requests";

const TODAY = "2026-10-22";
const NEXT_WEEK = "2026-10-27";
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });
const bundled = EVERYDAY_RECIPES.map(recipe => ({ ...recipe, id: `${DEMO_SOURCE.id}:${recipe.id}` }));

async function save(request: APIRequestContext, state: KitchenState) {
  const current = await saved(request);
  const response = await request.put("/api/kitchen", { data: { revision: current.revision, state } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function source(request: APIRequestContext, id = "fixture-tomato-rice"): Promise<Recipe> {
  const response = await request.get("/api/recipes/catalog");
  expect(response.ok()).toBeTruthy();
  const recipe = (await response.json()).recipes.find((item: Recipe) => item.id === id);
  expect(recipe).toBeTruthy();
  return recipe;
}

function meal(recipe: Recipe, date: string): PlannedMeal {
  return { id: `reserved-${date}`, date, recipeId: recipe.id, recipe, title: recipe.title,
    baseServings: recipe.servings ?? null, servings: recipe.servings ?? null, batches: 1,
    ingredientOverrides: {}, locked: false, status: "planned" };
}

async function open(page: Page, view = "Pantry") {
  await page.goto("/");
  await navigate(page, view);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
}

async function pick(page: Page, names = ["rice"]) {
  for (const name of names) await page.getByRole("button", { name: `Use ${name} tonight`, exact: true }).click();
  await page.getByRole("button", { name: "Find dinners", exact: true }).click();
  await expect(page.locator(".pantry-dinner-results")).toBeVisible();
}

function card(page: Page, title = "Tomato Rice") {
  return page.locator(".recipe-card").filter({ has: page.getByRole("button", { name: title, exact: true }) });
}

async function context(page: Page) {
  const controls = page.locator("details.dinner-context");
  await expect(controls).toHaveCount(1);
  if (await controls.getAttribute("open") === null) await controls.locator("summary").click();
  return controls;
}

async function shopping(scope: Locator) {
  const details = scope.locator(".recipe-readiness details");
  await expect(details).toHaveCount(1);
  if (await details.getAttribute("open") === null) await details.locator("summary").click();
  return details;
}

function watch(page: Page) {
  const writes: string[] = [], chef: string[] = [];
  page.on("request", request => {
    if (isKitchenWrite(request)) writes.push(request.url());
    if (new URL(request.url()).pathname === "/api/chef") chef.push(request.url());
  });
  return { writes, chef };
}

async function unchanged(page: Page, request: APIRequestContext, before: KitchenDocument, activity: ReturnType<typeof watch>) {
  await page.clock.runFor(700);
  expect(activity.writes).toEqual([]);
  expect(activity.chef).toEqual([]);
  expect(await saved(request)).toEqual(before);
}

async function refreshKitchen(page: Page) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/kitchen" && response.request().method() === "GET");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect((await response).ok()).toBeTruthy();
}

test.beforeEach(async ({ page, request, baseURL }) => {
  expect(baseURL, "Use the disposable isolated preview").toBeTruthy();
  expect(["127.0.0.1", "localhost"]).toContain(new URL(baseURL!).hostname);
  expect(new URL(baseURL!).port).not.toBe("3000");
  await page.clock.install({ time: new Date(`${TODAY}T12:00:00+03:00`) });
  await page.route("**/api/chef", route => route.abort());
  await save(request, empty());
});

test("the first pantry choice fits above navigation and confirmed shortages precede selection", async ({ page, request, isMobile }, info) => {
  await page.setViewportSize(isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await save(request, { ...empty(), pantry: [
    { id: "beans", name: "beans", measure: "400 g", location: "cupboard" },
    { id: "cheese", name: "cheese", measure: "", location: "fridge" },
    { id: "eggplant", name: "eggplant", measure: "240 g", location: "fridge" },
    { id: "garlic", name: "garlic", measure: "1 clove", location: "cupboard" },
    { id: "oil", name: "olive oil", measure: "", location: "cupboard" },
    { id: "onion", name: "onion", measure: "2", location: "cupboard" },
    { id: "pasta", name: "pasta", measure: "300 g", location: "cupboard" },
    { id: "rice", name: "rice", measure: "250 g", location: "cupboard" },
    { id: "salmon", name: "salmon", measure: "150 g", location: "freezer" },
    { id: "salt", name: "salt", measure: "", location: "spice-rack" },
    { id: "tomato", name: "tomato", measure: "3", useBy: "2026-10-23", location: "fridge" },
    { id: "paste", name: "tomato paste", measure: "30 ml", location: "fridge" },
  ] });
  await open(page, "Chef");
  await page.clock.runFor(100);
  await page.evaluate(() => window.scrollTo({ top: 700, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(300);
  await page.clock.runFor(100);
  await navigate(page, "Pantry");
  const before = await saved(request), activity = watch(page);
  await pick(page, ["rice", "tomato"]);
  const first = page.locator(".pantry-dinner-results .recipe-card").first();
  await expect(first.getByRole("button", { name: "Tomato Rice", exact: true })).toBeVisible();
  await page.clock.runFor(250);
  const heading = page.getByRole("heading", { name: "Dinner ideas for tonight", exact: true });
  await expect(heading).toBeFocused();
  expect(await heading.evaluate(el => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
  const geometry = await first.evaluate(card => {
    const rect = (element: Element) => {
      const r = element.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
    };
    const nav = document.querySelector(".mobile-nav")!;
    return {
      title: rect(card.querySelector(".recipe-title-button")!), outcome: rect(card.querySelector(".estimate-outcome")!),
      choose: rect(card.querySelector(".recipe-add-action")!), limit: nav.getClientRects().length ? rect(nav).top : innerHeight,
    };
  });
  await writeFile(info.outputPath("pantry-results-layout.json"), JSON.stringify(geometry, null, 2));
  for (const box of [geometry.title, geometry.outcome, geometry.choose]) {
    expect(box.top, JSON.stringify(geometry)).toBeGreaterThanOrEqual(0);
    expect(box.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.limit);
  }
  await page.screenshot({ path: info.outputPath("pantry-results.png"), animations: "disabled" });
  const stew = card(page, "Eggplant Stew");
  await expect(stew.locator(".estimate-outcome")).toHaveText("Needs 60 g more eggplant");
  await expect(stew.locator(".recipe-readiness details")).not.toHaveAttribute("open", "");
  if (isMobile) {
    await page.setViewportSize({ width: 320, height: 568 });
    const comparison = await stew.locator(".estimate-outcome").evaluate(outcome => {
      const navTop = document.querySelector(".mobile-nav")!.getBoundingClientRect().top;
      const distance = Math.ceil(outcome.getBoundingClientRect().bottom - navTop) + 2;
      window.scrollBy({ top: distance, behavior: "instant" });
      return { distance, navTop };
    });
    expect(comparison.distance).toBeLessThanOrEqual(comparison.navTop);
    for (const result of [first, stew]) {
      const lines = result.locator(".recipe-title-button, .recipe-picks, .estimate-outcome");
      await expect(lines).toHaveCount(3);
      for (const line of await lines.all()) {
        const box = await line.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height).toBeLessThanOrEqual(comparison.navTop);
      }
    }
    await page.screenshot({ path: info.outputPath("pantry-two-dinners-320.png"), animations: "disabled" });
  }
  await expect(await shopping(stew)).toContainText("eggplant: 60 g");
  const title = stew.getByRole("button", { name: "Eggplant Stew", exact: true });
  await title.press("Enter");
  const drawer = page.getByRole("dialog", { name: "Eggplant Stew", exact: true });
  await expect(drawer.locator(".estimate-outcome")).toHaveText("Needs 60 g more eggplant");
  await drawer.press("Escape");
  await expect(title).toBeFocused();
  await unchanged(page, request, before, activity);
});

test("Pantry estimates reserve saved dinners and preserve picks and portions when changing dinner day", async ({ page, request }, info) => {
  const recipe = await source(request);
  const reserved = meal(recipe, "2026-10-21");
  await save(request, { ...empty(), pantry: [
    { id: "rice", name: "rice", measure: "300 g" },
    { id: "tomato", name: "tomato", measure: "4" },
  ], meals: { [reserved.date]: reserved } });
  await open(page);
  const before = await saved(request), activity = watch(page);
  await pick(page, ["rice", "tomato"]);
  await expect(card(page).locator(".recipe-readiness")).toContainText("1 covered · 1 partial · 0 missing · 0 need review");
  await expect(card(page).locator(".estimate-outcome")).toHaveText("Needs 100 g more rice");
  await expect(await shopping(card(page))).toContainText("rice: 100 g");
  const controls = await context(page);
  await controls.getByRole("spinbutton", { name: "Chef portions", exact: true }).fill("4");
  await expect(card(page).locator(".recipe-readiness")).toContainText("0 covered · 2 partial · 0 missing · 0 need review");
  await expect(card(page).locator(".estimate-outcome")).toContainText("Needs 300 g more rice");
  await expect(await shopping(card(page))).toContainText("rice: 300 g");
  await expect(await shopping(card(page))).toContainText("tomato: 2");
  await controls.getByLabel("Dinner day", { exact: true }).fill(NEXT_WEEK);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dinner ideas for Tuesday");
  await expect(controls.getByRole("spinbutton", { name: "Chef portions", exact: true })).toHaveValue("4");
  for (const name of ["rice", "tomato"]) await expect(page.getByRole("button", { name: `Remove ${name} from picks`, exact: true })).toBeVisible();
  await expect(card(page).locator(".recipe-readiness")).toContainText("1 covered · 1 partial · 0 missing · 0 need review");
  await expect(card(page).locator(".estimate-outcome")).toHaveText("Needs 100 g more rice");
  await expect(await shopping(card(page))).toContainText("rice: 100 g");
  await unchanged(page, request, before, activity);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("reservation-aware-dinner.png"), fullPage: true, animations: "disabled" });
  await card(page).getByRole("button", { name: /^Choose for .*: Tomato Rice$/ }).click();
  await expect.poll(async () => (await saved(request)).state?.meals[NEXT_WEEK]?.servings).toBe(4);
  const after = await saved(request);
  expect(after.state!.meals[reserved.date]).toEqual(before.state!.meals[reserved.date]);
  expect(after.state!.pantry).toEqual(before.state!.pantry);
  expect(activity.chef).toEqual([]);
});

test("unknown pantry amounts remain review items and measured freezer stock carries a preparation note", async ({ page, request }) => {
  await save(request, { ...empty(), pantry: [
    { id: "rice", name: "rice", measure: "", useBy: "2026-10-23" },
    { id: "tomato", name: "tomato", measure: "2", location: "freezer" },
  ] });
  await open(page);
  const before = await saved(request), activity = watch(page);
  await pick(page);
  const dinner = card(page);
  await expect(dinner.locator(".recipe-readiness")).toContainText("1 covered · 0 partial · 0 missing · 1 need review");
  await expect(dinner.getByText("Review amount: rice.", { exact: true })).toBeVisible();
  await expect(dinner.getByText("Includes frozen stock:", { exact: true })).toBeVisible();
  await expect(await shopping(dinner)).toContainText(/rice:.*review/i);
  await expect(dinner).toContainText("Includes frozen stock:");
  await expect(dinner).toContainText("Check preparation before cooking.");
  await expect(dinner.locator(".dinner-ranking-reason")).not.toContainText(/due soon/i);
  await dinner.getByRole("button", { name: "Tomato Rice", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Tomato Rice", exact: true });
  await expect(drawer.getByText("Review amount: rice.", { exact: true })).toBeVisible();
  await expect(drawer.getByText(/tomato: 2\. Check preparation before cooking\./)).toBeVisible();
  await unchanged(page, request, before, activity);
});

test("a confirmed use-soon reason disappears when another saved dinner reserves that stock", async ({ page, request }) => {
  const recipe = await source(request);
  const state: KitchenState = { ...empty(), pantry: [
    { id: "rice", name: "rice", measure: "200 g", useBy: "2026-10-23" },
    { id: "tomato", name: "tomato", measure: "4" },
  ] };
  await save(request, state);
  await open(page);
  const activity = watch(page);
  await pick(page);
  await expect(card(page).locator(".dinner-ranking-reason")).toHaveText("Uses rice due soon.");
  const reserved = meal(recipe, "2026-10-23");
  await save(request, { ...state, meals: { [reserved.date]: reserved } });
  const before = await saved(request);
  await refreshKitchen(page);
  await expect(card(page).locator(".dinner-ranking-reason")).not.toContainText(/due soon/i);
  await expect(card(page).locator(".recipe-readiness")).toContainText("1 covered · 0 partial · 1 missing · 0 need review");
  await unchanged(page, request, before, activity);
});

test("Everyday dinners rank by measured fit while an exact title remains findable with shared preview controls", async ({ page, request }) => {
  const pasta = bundled.find(recipe => recipe.title === "Garlic Tomato Pasta")!;
  await save(request, { ...empty(), pantry: pasta.ingredients.map((ingredient, index) => ({
    id: `everyday-${index}`, name: ingredient.name, measure: ingredient.measure,
  })) });
  await page.route("**/api/recipes/catalog", route => route.fulfill({ json: { recipes: bundled, metadataByRecipeId: {}, contentHashesByRecipeId: {} } }));
  await open(page, "Recipes");
  const before = await saved(request), activity = watch(page);
  await page.getByRole("button", { name: "Everyday dinners", exact: true }).click();
  await expect(page.locator(".recipe-card .recipe-title-button").first()).toHaveText("Garlic Tomato Pasta");
  await expect(card(page, "Garlic Tomato Pasta").locator(".recipe-readiness")).toContainText("8 covered · 0 partial · 0 missing · 0 need review");
  await expect(card(page, "Garlic Tomato Pasta").locator(".estimate-outcome")).toHaveText("Known quantities are covered.");
  const title = card(page, "Garlic Tomato Pasta").getByRole("button", { name: "Garlic Tomato Pasta", exact: true });
  await title.press("Enter");
  const drawer = page.getByRole("dialog", { name: "Garlic Tomato Pasta", exact: true });
  await expect(drawer.locator(".estimate-outcome")).toHaveText("Known quantities are covered.");
  await drawer.getByRole("button", { name: "Close recipe" }).click();
  await expect(title).toBeFocused();
  const query = page.getByRole("searchbox", { name: "Search recipes", exact: true });
  await query.fill("Creamy Garlic Mushroom Pasta");
  await expect(page.locator(".recipe-card .recipe-title-button").first()).toHaveText("Creamy Garlic Mushroom Pasta");
  await expect(card(page, "Creamy Garlic Mushroom Pasta").locator(".recipe-readiness")).toBeVisible();
  const controls = await context(page);
  await controls.getByRole("spinbutton", { name: "Chef portions", exact: true }).fill("4");
  await controls.getByLabel("Dinner day", { exact: true }).fill(NEXT_WEEK);
  await expect(query).toHaveValue("Creamy Garlic Mushroom Pasta");
  await expect(controls.getByRole("spinbutton", { name: "Chef portions", exact: true })).toHaveValue("4");
  await expect(await shopping(card(page, "Creamy Garlic Mushroom Pasta"))).toContainText("pasta: 200 g");
  await unchanged(page, request, before, activity);
});

test("Everyday replacement after a Pantry search uses the collection scope rather than old ingredient picks", async ({ page, request }) => {
  const original = meal(await source(request, "fixture-cheese-pasta"), TODAY);
  const pasta = bundled.find(recipe => recipe.title === "Garlic Tomato Pasta")!;
  await save(request, { ...empty(), pantry: [{ id: "rice", name: "rice", measure: "300 g" }], meals: { [TODAY]: original } });
  await page.route("**/api/recipes/catalog", route => route.fulfill({ json: { recipes: bundled, metadataByRecipeId: {}, contentHashesByRecipeId: {} } }));
  await open(page);
  const before = await saved(request), activity = watch(page);
  await pick(page);
  await expect(page.getByRole("button", { name: "Remove rice from picks", exact: true })).toBeVisible();
  await navigate(page, "Recipes");
  await page.getByRole("button", { name: "Everyday dinners", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search recipes", exact: true }).fill(pasta.title);
  await card(page, pasta.title).getByRole("button", { name: `Choose for tonight: ${pasta.title}`, exact: true }).click();
  const replace = page.getByRole("dialog", { name: "Replace dinner", exact: true });
  await expect(replace.locator(".recipe-readiness")).toContainText("0 covered · 0 partial · 8 missing · 0 need review");
  await expect(replace).not.toContainText("This choice is no longer available");
  await expect(replace.getByRole("button", { name: "Replace dinner", exact: true })).toBeEnabled();
  await unchanged(page, request, before, activity);
  await replace.getByRole("button", { name: "Replace dinner", exact: true }).click();
  await expect(replace).toHaveCount(0);
  await expect.poll(async () => (await saved(request)).state?.meals[TODAY]?.recipeId).toBe(pasta.id);
  const after = await saved(request);
  expect(after.state!.meals[TODAY].servings).toBe(2);
  expect(after.state!.pantry).toEqual(before.state!.pantry);
  expect(activity.chef).toEqual([]);
});

test("replacement review refreshes changed stock and saves the reviewed portions only after confirmation", async ({ page, request }) => {
  const original = meal(await source(request, "fixture-cheese-pasta"), TODAY);
  const state: KitchenState = { ...empty(), pantry: [
    { id: "rice", name: "rice", measure: "300 g" }, { id: "tomato", name: "tomato", measure: "4" },
  ], meals: { [TODAY]: original } };
  await save(request, state);
  await open(page);
  const activity = watch(page);
  await pick(page);
  await (await context(page)).getByRole("spinbutton", { name: "Chef portions", exact: true }).fill("4");
  await card(page).getByRole("button", { name: "Choose for tonight: Tomato Rice", exact: true }).click();
  const replace = page.getByRole("dialog", { name: "Replace dinner", exact: true });
  await expect(replace).toContainText("Cheese Pasta");
  await expect(await shopping(replace)).toContainText("rice: 100 g");
  await save(request, { ...state, pantry: state.pantry.map(stock => stock.id === "rice" ? { ...stock, measure: "100 g" } : stock) });
  const before = await saved(request);
  await refreshKitchen(page);
  await expect(replace.getByRole("status")).toContainText("The dinner estimate below has been refreshed");
  await expect(await shopping(replace)).toContainText("rice: 300 g");
  await unchanged(page, request, before, activity);
  await replace.getByRole("button", { name: "Replace dinner", exact: true }).click();
  await expect(replace).toHaveCount(0);
  await expect.poll(async () => (await saved(request)).state?.meals[TODAY]?.recipeId).toBe("fixture-tomato-rice");
  const after = await saved(request);
  expect(after.state!.meals[TODAY].servings).toBe(4);
  expect(after.state!.pantry).toEqual(before.state!.pantry);
  expect(activity.chef).toEqual([]);
});

test("a rejected replacement retains picks, preview portions and the original dinner for retry", async ({ page, request }) => {
  const original = meal(await source(request, "fixture-cheese-pasta"), TODAY);
  await save(request, { ...empty(), pantry: [
    { id: "rice", name: "rice", measure: "300 g" }, { id: "tomato", name: "tomato", measure: "4" },
  ], meals: { [TODAY]: original } });
  const { before } = await openPendingKitchenOutbox(page, request);
  await pick(page, ["rice", "tomato"]);
  await (await context(page)).getByRole("spinbutton", { name: "Chef portions", exact: true }).fill("4");
  await card(page).getByRole("button", { name: "Choose for tonight: Tomato Rice", exact: true }).click();
  const replace = page.getByRole("dialog", { name: "Replace dinner", exact: true });
  await expect(await shopping(replace)).toContainText("rice: 100 g");
  await replace.getByRole("button", { name: "Replace dinner", exact: true }).click();
  await expect(replace.getByRole("alert")).toContainText(/not saved.*try again/i);
  await expect(replace.getByRole("button", { name: "Replace dinner", exact: true })).toBeEnabled();
  await expect(await shopping(replace)).toContainText("rice: 100 g");
  await replace.getByRole("button", { name: "Replace dinner", exact: true }).click();
  await expect(replace.getByRole("alert")).toContainText(/not saved.*try again/i);
  await replace.getByRole("button", { name: "Keep current dinner", exact: true }).click();
  for (const name of ["rice", "tomato"]) await expect(page.getByRole("button", { name: `Remove ${name} from picks`, exact: true })).toBeVisible();
  await expect((await context(page)).getByRole("spinbutton", { name: "Chef portions", exact: true })).toHaveValue("4");
  const cached = await draft(page);
  expect(cached.writeQueue.writes).toHaveLength(MAX_PENDING_KITCHEN_WRITES);
  expect(cached.state.meals).toEqual(before.state!.meals);
  expect(await saved(request)).toEqual(before);
});

test("a replacement opened before a week rollover keeps its reviewed date and reservations", async ({ page, request }) => {
  const sunday = "2026-10-25";
  await page.clock.setSystemTime(new Date(`${sunday}T23:59:00+03:00`));
  const original = meal(await source(request, "fixture-cheese-pasta"), sunday);
  const future = meal(await source(request), NEXT_WEEK);
  await save(request, { ...empty(), pantry: [
    { id: "rice", name: "rice", measure: "300 g" }, { id: "tomato", name: "tomato", measure: "4" },
  ], meals: { [sunday]: original, [NEXT_WEEK]: future } });
  await open(page);
  const before = await saved(request), activity = watch(page);
  await pick(page);
  await (await context(page)).getByRole("spinbutton", { name: "Chef portions", exact: true }).fill("4");
  await card(page).getByRole("button", { name: "Choose for tonight: Tomato Rice", exact: true }).click();
  const replace = page.getByRole("dialog", { name: "Replace dinner", exact: true });
  await expect(await shopping(replace)).toContainText("rice: 100 g");
  await page.clock.setSystemTime(new Date("2026-10-26T00:01:00+02:00"));
  await refreshKitchen(page);
  await expect(await shopping(replace)).toContainText("rice: 100 g");
  await expect(await shopping(replace)).not.toContainText("rice: 300 g");
  await unchanged(page, request, before, activity);
  await replace.getByRole("button", { name: "Replace dinner", exact: true }).click();
  await expect.poll(async () => (await saved(request)).state?.meals[sunday]?.recipeId).toBe("fixture-tomato-rice");
  const after = await saved(request);
  expect(after.state!.meals[sunday].servings).toBe(4);
  expect(after.state!.meals[NEXT_WEEK]).toEqual(before.state!.meals[NEXT_WEEK]);
  expect(after.state!.meals["2026-10-26"]).toBeUndefined();
  expect(after.state!.pantry).toEqual(before.state!.pantry);
});
