import { test, expect, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import type { KitchenDocument, KitchenState, PantryStock } from "../../app/lib/kitchen-types";
import { EVERYDAY_RECIPES } from "../../app/lib/everyday-collection";
import { DEMO_SOURCE } from "../../app/lib/demo-recipes";
import { isKitchenWrite } from "./kitchen-requests";
import { openPantryAdd } from "./pantry-helpers";

const TODAY = "2026-10-22";
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });
const bundled = EVERYDAY_RECIPES.map(recipe => ({ ...recipe, id: `${DEMO_SOURCE.id}:${recipe.id}` }));
const stock = (names: string[]): PantryStock[] => names.map((name, index) => ({ id: `pick-${index}`, name, measure: "" }));

async function saved(request: APIRequestContext): Promise<KitchenDocument> {
  const response = await request.get("/api/kitchen");
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function save(request: APIRequestContext, pantry: PantryStock[]) {
  const current = await saved(request);
  const response = await request.put("/api/kitchen", { data: { revision: current.revision, state: { ...empty(), pantry } } });
  expect(response.ok(), await response.text()).toBeTruthy();
}
async function navigate(page: Page, name: string) {
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click();
}
async function openPantry(page: Page) {
  await page.goto("/");
  await navigate(page, "Pantry");
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeVisible();
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
}
const ingredient = (page: Page, name: string) => page.getByRole("button", { name: `Use ${name} tonight`, exact: true });
const removePick = (page: Page, name: string) => page.getByRole("button", { name: `Remove ${name} from picks`, exact: true });
const results = (page: Page) => page.getByRole("region", { name: "Dinner ideas for tonight", exact: true });
const card = (page: Page, title: string) => results(page).locator(".recipe-card").filter({ has: page.getByRole("button", { name: title, exact: true }) });
async function pick(page: Page, names: string[]) {
  for (const name of names) await ingredient(page, name).click();
  await page.getByRole("button", { name: "Find dinners", exact: true }).click();
  await expect(results(page)).toBeVisible();
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
async function capture(page: Page, info: TestInfo, name: string, fullPage = false) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

test.beforeEach(async ({ page, baseURL }) => {
  expect(baseURL, "Use the disposable isolated preview").toBeTruthy();
  const url = new URL(baseURL!);
  expect(["127.0.0.1", "localhost"]).toContain(url.hostname);
  expect(url.port).not.toBe("3000");
  await page.clock.install({ time: new Date(`${TODAY}T12:00:00+03:00`) });
  await page.route("**/api/chef", route => route.abort());
  // Use the actual authored collection without changing the disposable or personal catalog.
  await page.route("**/api/recipes/catalog", route => route.fulfill({ json: {
    recipes: bundled, metadataByRecipeId: {}, contentHashesByRecipeId: {},
  } }));
});

test("real bundled foods offer chicken tray bake and mushroom pasta from different subsets of the picks", async ({ page, request, isMobile }, info) => {
  await save(request, stock(["chicken breast", "potatoes", "pasta", "mushrooms",
    "onion", "paprika", "garlic", "butter", "heavy cream", "Parmesan cheese"]));
  await openPantry(page);
  const before = await saved(request), activity = watch(page);
  await expect(page.locator("details.pantry-add-disclosure")).not.toHaveAttribute("open");
  for (const name of ["chicken breast", "potatoes", "pasta", "mushrooms"]) await ingredient(page, name).click();
  await page.getByRole("heading", { name: "Your pantry", exact: true }).scrollIntoViewIfNeeded();
  if (isMobile) {
    const actions = page.locator(".pantry-find-actions"), nav = page.locator(".mobile-nav");
    await expect(page.locator(".pantry-picks-section").getByRole("button", { name: "Clear selection", exact: true })).toBeVisible();
    await expect(actions.getByRole("button", { name: "Clear selection", exact: true })).toHaveCount(0);
    await expect.poll(async () => {
      const actionBox = await actions.boundingBox(), navBox = await nav.boundingBox();
      return Boolean(actionBox && navBox && actionBox.y >= 0 && actionBox.y + actionBox.height <= navBox.y);
    }).toBe(true);
    const actionsBox = await actions.boundingBox();
    expect(actionsBox!.height).toBeLessThanOrEqual((await page.evaluate(() => visualViewport?.height ?? innerHeight)) / 4);
  }
  await capture(page, info, "compact-pantry-picks");
  await page.getByRole("button", { name: "Find dinners", exact: true }).click();
  await expect(results(page).locator(".recipe-card")).toHaveCount(3);
  await expect(card(page, "Paprika Chicken & Potato Tray Bake")).toBeVisible();
  await expect(card(page, "Creamy Garlic Mushroom Pasta")).toBeVisible();
  await expect(card(page, "Paprika Chicken & Potato Tray Bake")).toContainText(/Uses your picks:.*chicken breast.*potatoes/i);
  await expect(card(page, "Creamy Garlic Mushroom Pasta")).toContainText(/Uses your picks:.*pasta.*mushrooms/i);
  await capture(page, info, "bundled-dinner-options", true);
  await expect(results(page).getByRole("button", { name: "Show more dinners", exact: true })).toBeVisible();
  await results(page).getByRole("button", { name: "Show more dinners", exact: true }).click();
  expect(await results(page).locator(".recipe-card").count()).toBeGreaterThan(3);
  await expect(results(page).getByRole("button", { name: "Tomato Skillet Eggs with Toast", exact: true })).toHaveCount(0);
  await unchanged(page, request, before, activity);
});

test("larger pantry text keeps the dinner action and focused ingredient reachable", async ({ page, request, isMobile }, info) => {
  await save(request, [...stock(["rice", "eggs"]), ...Array.from({ length: 35 }, (_, index) => ({
    id: `large-text-${index}`, name: `saved ingredient ${index}`, measure: "",
  }))]);
  await openPantry(page);
  const before = await saved(request), activity = watch(page);
  await ingredient(page, "rice").click();
  await page.addStyleTag({ content: ".pantry-page, .pantry-page button, .pantry-page input, .pantry-page select { font-size: 24px !important; }" });
  for (const width of isMobile ? [320, 390] : [1280]) {
    await page.setViewportSize({ width, height: 844 });
    const target = page.getByRole("button", { name: "Details for saved ingredient 20", exact: true });
    await target.focus();
    await expect(target).toBeFocused();
    await expect(target).toBeInViewport();
    if (isMobile) {
      const actions = page.locator(".pantry-find-actions");
      await expect(actions.getByRole("button", { name: "Find dinners", exact: true })).toBeInViewport();
      await expect.poll(async () => target.evaluate(element => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return hit === element || element.contains(hit);
      })).toBe(true);
      const bar = await actions.boundingBox(), nav = await page.locator(".mobile-nav").boundingBox();
      expect(bar!.y + bar!.height).toBeLessThanOrEqual(nav!.y);
      expect(bar!.height).toBeLessThanOrEqual(844 / 4);
      await capture(page, info, `pantry-${width}-large-text`);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await unchanged(page, request, before, activity);
});

test("seasoning-only picks cannot start dinner search and matching salt never introduces an unrelated meal", async ({ page, request }) => {
  await save(request, stock(["rice", "eggs", "salt", "mushrooms", "pasta", "garlic", "butter", "heavy cream", "Parmesan cheese"]));
  await openPantry(page);
  const before = await saved(request), activity = watch(page);
  await ingredient(page, "salt").click();
  await expect(page.getByRole("button", { name: "Find dinners", exact: true })).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: "Pick an available food ingredient" })).toBeVisible();
  await pick(page, ["rice", "eggs"]);
  await expect(card(page, "Egg & Pea Fried Rice")).toBeVisible();
  const more = results(page).getByRole("button", { name: "Show more dinners", exact: true });
  if (await more.isVisible()) await more.click();
  await expect(card(page, "Creamy Garlic Mushroom Pasta")).toHaveCount(0);
  await expect(card(page, "Garlic Tomato Pasta")).toHaveCount(0);
  await expect(card(page, "Golden Potato & Onion Frittata")).toBeVisible();
  await expect(card(page, "Chicken & Pepper Rice Bowls")).toBeVisible();
  await unchanged(page, request, before, activity);
});

test("keyboard result chips update options in place and removing the final pick returns to Pantry", async ({ page, request }) => {
  await save(request, stock(["chicken breast", "potatoes", "pasta", "mushrooms", "onion", "paprika"]));
  await openPantry(page);
  const before = await saved(request), activity = watch(page);
  await pick(page, ["chicken breast", "potatoes", "pasta", "mushrooms"]);
  await removePick(page, "pasta").focus();
  await removePick(page, "pasta").press("Enter");
  await expect(results(page)).toBeVisible();
  await expect(removePick(page, "pasta")).toHaveCount(0);
  await expect(removePick(page, "mushrooms")).toBeFocused();
  await expect(results(page).locator(".recipe-card")).toHaveCount(3);
  await page.goBack();
  await expect(removePick(page, "pasta")).toBeVisible();
  await page.goForward();
  await expect(removePick(page, "pasta")).toHaveCount(0);
  await removePick(page, "mushrooms").focus();
  await removePick(page, "mushrooms").press("Enter");
  await expect(removePick(page, "potatoes")).toBeFocused();
  await removePick(page, "potatoes").press("Enter");
  await expect(removePick(page, "chicken breast")).toBeFocused();
  await removePick(page, "chicken breast").press("Enter");
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your picks", exact: true })).toBeFocused();
  await expect(results(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Find dinners", exact: true })).toBeDisabled();
  await unchanged(page, request, before, activity);
});

test("a long pantry keeps picks accessible, keeps addition drafts through disclosure and search, and exposes the mobile action", async ({ page, request, isMobile }, info) => {
  await save(request, [...stock(["rice", "eggs"]), ...Array.from({ length: 65 }, (_, index) => ({
    id: `long-${index}`, name: `pantry food ${index}`, measure: "", location: "cupboard" as const,
  }))]);
  await openPantry(page);
  const before = await saved(request), activity = watch(page);
  await openPantryAdd(page);
  const draft = page.getByRole("textbox", { name: "New pantry ingredient", exact: true });
  await draft.fill("milk, dragon fruit");
  await page.getByRole("combobox", { name: "Location for ingredient 1", exact: true }).selectOption("freezer");
  await page.locator(".pantry-add-disclosure > summary").click();
  await expect(draft).toBeHidden();
  await ingredient(page, "rice").click();
  const search = page.getByRole("searchbox", { name: "Search pantry", exact: true });
  await search.fill("eggs");
  await ingredient(page, "eggs").click();
  await expect(removePick(page, "rice")).toBeVisible();
  await expect(removePick(page, "eggs")).toBeVisible();
  await search.fill("");
  await openPantryAdd(page);
  await expect(draft).toHaveValue("milk, dragon fruit");
  await expect(page.getByRole("combobox", { name: "Location for ingredient 1", exact: true })).toHaveValue("freezer");
  await page.locator(".pantry-add-disclosure > summary").click();
  await page.locator(".pantry-tonight-item").nth(35).scrollIntoViewIfNeeded();
  if (isMobile) {
    const action = page.getByRole("button", { name: "Find dinners", exact: true });
    await expect(action).toBeInViewport();
    const actionBox = await action.boundingBox(), navBox = await page.locator(".mobile-nav").boundingBox();
    expect(actionBox).not.toBeNull();
    expect(navBox).not.toBeNull();
    expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(navBox!.y);
    expect(await page.locator(".pantry-find-actions").evaluate(element => getComputedStyle(element).position)).toBe("sticky");
  }
  await capture(page, info, "long-pantry-action");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Find dinners", exact: true }).click();
  await expect(card(page, "Egg & Pea Fried Rice")).toBeVisible();
  await unchanged(page, request, before, activity);
});
