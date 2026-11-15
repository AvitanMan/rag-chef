import { test, expect, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import type { KitchenDocument, KitchenState, PlannedMeal } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";
import { isKitchenWrite } from "./kitchen-requests";
import { choosePantryLocation, expectPantryLocation, openPantryAdd, openSpiceChecklist } from "./pantry-helpers";

const TODAY = "2026-10-22";
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });

async function document(request: APIRequestContext): Promise<KitchenDocument> {
  const response = await request.get("/api/kitchen");
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function state(request: APIRequestContext): Promise<KitchenState> {
  return (await document(request)).state!;
}
async function save(request: APIRequestContext, value: KitchenState) {
  const current = await document(request);
  const response = await request.put("/api/kitchen", { data: { revision: current.revision, state: value } });
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
function ingredient(page: Page, name: string) {
  return page.getByRole("button", { name: `Use ${name} tonight`, exact: true });
}
function results(page: Page) {
  return page.getByRole("region", { name: "Dinner ideas for tonight", exact: true });
}
function watchWrites(page: Page) {
  const writes: string[] = [];
  page.on("request", request => { if (isKitchenWrite(request)) writes.push(request.url()); });
  return writes;
}
async function unchanged(page: Page, request: APIRequestContext, before: KitchenDocument, writes: string[]) {
  await page.clock.runFor(700);
  expect(writes).toEqual([]);
  expect(await document(request)).toEqual(before);
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
  expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function refreshKitchen(page: Page) {
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/kitchen" && response.request().method() === "GET");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect((await refreshed).ok()).toBeTruthy();
}
async function addPlain(page: Page, text: string) {
  await openPantryAdd(page);
  await page.getByRole("textbox", { name: "New pantry ingredient", exact: true }).fill(text);
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
}

test.beforeEach(async ({ page, request, baseURL }) => {
  expect(baseURL, "Run with the disposable isolated preview").toBeTruthy();
  expect(["127.0.0.1", "localhost"]).toContain(new URL(baseURL!).hostname);
  expect(new URL(baseURL!).port).not.toBe("3000");
  await page.clock.install({ time: new Date(`${TODAY}T12:00:00+03:00`) });
  await page.route("**/api/chef", route => route.abort());
  await save(request, empty());
});

test("mixed paste suggests editable locations before saving and leaves unfamiliar food Unsorted", async ({ page, request }, info) => {
  await openPantry(page);
  const before = await document(request), writes = watchWrites(page);
  await page.getByRole("textbox", { name: "New pantry ingredient", exact: true }).fill("milk, rice\nsalt; frozen peas; dragon fruit");
  for (const [index, value] of ["fridge", "cupboard", "spice-rack", "freezer", ""].entries()) {
    await expect(page.getByRole("combobox", { name: `Location for ingredient ${index + 1}`, exact: true })).toHaveValue(value);
  }
  await page.getByRole("combobox", { name: "Location for ingredient 2", exact: true }).selectOption("fridge");
  await unchanged(page, request, before, writes);
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await state(request)).pantry.map(stock => ({ name: stock.name, location: stock.location ?? null }))).toEqual([
    { name: "milk", location: "fridge" }, { name: "rice", location: "fridge" }, { name: "salt", location: "spice-rack" },
    { name: "frozen peas", location: "freezer" }, { name: "dragon fruit", location: null },
  ]);
  await expectPantryLocation(page, "All", 5);
  await expect(ingredient(page, "rice").locator(".pantry-location-badges")).toHaveText("Fridge");
  await screenshot(page, info, "pantry-locations-populated");
  await choosePantryLocation(page, "Unsorted");
  await expect(ingredient(page, "dragon fruit")).toBeVisible();
  await expect(ingredient(page, "rice")).toHaveCount(0);
});

test("tab additions stay in that location, deduplicate there, and preserve existing Unsorted entries", async ({ page, request }) => {
  const original = { id: "legacy-rice", name: "rice", measure: "100 g" };
  await save(request, { ...empty(), pantry: [original, { id: "pasta", name: "pasta", measure: "", location: "cupboard" }] });
  await openPantry(page);
  await choosePantryLocation(page, "Unsorted");
  await expect(ingredient(page, "rice")).toBeVisible();
  await expect(ingredient(page, "pasta")).toHaveCount(0);
  await choosePantryLocation(page, "Cupboard");
  await openPantryAdd(page);
  await page.getByRole("textbox", { name: "New pantry ingredient", exact: true }).fill("rice");
  await expect(page.getByRole("combobox", { name: "Location for ingredient 1", exact: true })).toHaveValue("cupboard");
  await expect(page.locator(".pantry-placement-drafts")).toContainText("Also saved in Unsorted");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  await expect.poll(async () => (await state(request)).pantry.length).toBe(3);
  const before = await document(request), writes = watchWrites(page);
  await addPlain(page, "rice, rice");
  await expect(page.getByRole("status").filter({ hasText: "Already in your pantry in this location" })).toHaveCount(1);
  await unchanged(page, request, before, writes);
  await choosePantryLocation(page, "Fridge");
  await addPlain(page, "rice");
  await expect.poll(async () => (await state(request)).pantry.filter(stock => stock.name === "rice").map(stock => stock.location ?? null)).toEqual([null, "cupboard", "fridge"]);
  expect((await state(request)).pantry.find(stock => stock.id === original.id)).toEqual(original);
  await choosePantryLocation(page, "All");
  await expect(ingredient(page, "rice")).toHaveCount(1);
  await expect(ingredient(page, "rice").locator(".pantry-location-badges")).toHaveText("Unsorted · Cupboard · Fridge");
});

test("location counts match available ingredient identities and search reports the scoped total", async ({ page, request, isMobile }) => {
  await save(request, { ...empty(), pantry: [
    { id: "milk", name: "milk", measure: "", location: "fridge" },
    { id: "milk-second", name: "milk", measure: "100 ml", location: "fridge" },
    { id: "spinach", name: "spinach", measure: "1 bag", location: "fridge" },
    { id: "finished", name: "eggs", measure: "0", location: "fridge" },
    { id: "past", name: "yogurt", measure: "1 tub", useBy: "2026-10-21", location: "fridge" },
    { id: "rice", name: "rice", measure: "", location: "cupboard" },
    { id: "unsorted-past", name: "beans", measure: "100 g", useBy: "2026-10-21" },
  ] });
  await openPantry(page);
  const before = await document(request), writes = watchWrites(page);
  await expectPantryLocation(page, "All", 3);
  await choosePantryLocation(page, "Fridge");
  await expectPantryLocation(page, "Fridge", 2);
  const scope = page.locator(".pantry-tonight-heading").getByRole("status");
  await expect(scope).toHaveText("2 available ingredients in Fridge");
  await expect(page.locator(".pantry-tonight-item")).toHaveCount(2);
  await expect(page.locator(".pantry-managed-note")).toContainText("2 finished or past-date batches are kept in Fridge");
  await page.getByRole("searchbox", { name: "Search pantry", exact: true }).fill("milk");
  await expect(scope).toHaveText("Showing 1 of 2 available ingredients in Fridge");
  await expectPantryLocation(page, "Fridge", 2);
  await choosePantryLocation(page, "Unsorted");
  await expectPantryLocation(page, "Unsorted", 0);
  await expect(scope).toHaveText("0 available ingredients in Unsorted");
  await expect(page.locator(".pantry-tonight-item")).toHaveCount(0);
  await expect(page.locator(".pantry-managed-note")).toContainText("1 finished or past-date batch is kept in Unsorted");
  if (isMobile) {
    await expect(page.getByRole("combobox", { name: "Location", exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "Pantry locations", exact: true })).toHaveCount(0);
  } else {
    await expect(page.getByRole("group", { name: "Pantry locations", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Location", exact: true })).toHaveCount(0);
  }
  await unchanged(page, request, before, writes);
});

test("global ingredient selections cross tabs and explicitly include freezer food through Back and Forward", async ({ page, request }, info) => {
  await save(request, { ...empty(), pantry: [
    { id: "rice", name: "rice", measure: "500 g", location: "cupboard" },
    { id: "tomato", name: "tomato", measure: "2", location: "freezer" },
    { id: "salmon", name: "salmon", measure: "200 g", location: "freezer" },
    { id: "egg", name: "egg", measure: "", location: "fridge" },
  ] });
  await openPantry(page);
  const before = await document(request), writes = watchWrites(page), chefCalls: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/chef") chefCalls.push(request.url()); });
  await choosePantryLocation(page, "Cupboard");
  await ingredient(page, "rice").click();
  await page.getByRole("button", { name: "Find dinners", exact: true }).click();
  await expect(results(page).getByRole("button", { name: "Remove rice from picks", exact: true })).toBeVisible();
  const tomatoCard = results(page).locator(".recipe-card").filter({ hasText: "Tomato Rice" });
  await expect(tomatoCard.locator(".recipe-pantry-fit")).toContainText("In freezer: tomato");
  await expect(tomatoCard.locator(".recipe-pantry-fit")).not.toContainText("Missing: tomato");
  await results(page).getByRole("button", { name: "Change ingredients", exact: true }).click();
  await choosePantryLocation(page, "Freezer");
  await expect(page.locator(".pantry-selection-chips").getByRole("button", { name: "Remove rice from picks", exact: true })).toBeVisible();
  await ingredient(page, "tomato").click();
  await choosePantryLocation(page, "Fridge");
  await expect(page.locator(".pantry-selection-chips").getByRole("button", { name: "Remove tomato from picks", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Find dinners", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Find dinners", exact: true }).click();
  await expect(results(page).locator(".recipe-card")).toHaveCount(3);
  await expect(tomatoCard.locator(".recipe-pantry-fit")).toContainText("Uses your picks: rice, tomato");
  await expect(tomatoCard.locator(".recipe-pantry-fit")).toContainText("Also saved in freezer: tomato");
  await expect(results(page).locator(".recipe-card").filter({ hasText: "Salmon Bowl" }).locator(".recipe-pantry-fit")).not.toContainText("Also saved in freezer: tomato");
  await screenshot(page, info, "selected-freezer-dinner");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeVisible();
  await page.goBack();
  await expect(results(page).getByRole("button", { name: "Remove tomato from picks", exact: true })).toHaveCount(0);
  await expect(results(page).locator(".recipe-card")).toHaveCount(2);
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeVisible();
  await page.goForward();
  await expect(results(page).getByRole("button", { name: "Remove tomato from picks", exact: true })).toBeVisible();
  await expect(results(page).locator(".recipe-card")).toHaveCount(3);
  await unchanged(page, request, before, writes);
  expect(chefCalls).toEqual([]);
});

test("ingredient details move one chosen batch and exact undo restores its location", async ({ page, request }, info) => {
  const first = { id: "rice-first", name: "rice", measure: "100 g", useBy: "2026-10-25", location: "cupboard" as const };
  const second = { id: "rice-second", name: "rice", measure: "200 g", useBy: "2026-10-26", location: "fridge" as const };
  const original = { ...empty(), pantry: [first, second] };
  await save(request, original);
  await openPantry(page);
  const before = await document(request), writes = watchWrites(page);
  await expect(page.locator(".pantry-tonight-item").getByRole("button", { name: "Move rice", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Details for rice", exact: true }).click();
  await page.locator(`#pantry-row-${second.id}`).getByRole("button", { name: "Move batch rice", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Move rice", exact: true });
  await expect(dialog.getByRole("button", { name: "Move entry", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("combobox", { name: "Batch to move", exact: true })).toHaveCount(0);
  await expect(dialog).toContainText("rice · Fridge · 200 g");
  await dialog.getByRole("combobox", { name: "Move to", exact: true }).selectOption("freezer");
  await screenshot(page, info, "move-specific-entry");
  await unchanged(page, request, before, writes);
  await dialog.getByRole("button", { name: "Move entry", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Moved rice to Freezer");
  await expect.poll(async () => (await state(request)).pantry).toEqual([first, { ...second, location: "freezer" }]);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Undo last batch edit", exact: true }).click();
  await expect.poll(async () => (await state(request)).pantry).toEqual(original.pantry);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
});

test("an externally changed move is blocked until current stock is loaded and cannot overwrite it", async ({ page, request }) => {
  const rice = { id: "rice", name: "rice", measure: "100 g", location: "cupboard" as const };
  await save(request, { ...empty(), pantry: [rice] });
  await openPantry(page);
  await page.getByRole("button", { name: "Details for rice", exact: true }).click();
  await page.locator("#pantry-row-rice").getByRole("button", { name: "Move batch rice", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Move rice", exact: true });
  await dialog.getByRole("combobox", { name: "Move to", exact: true }).selectOption("freezer");
  const external = { ...empty(), pantry: [{ ...rice, measure: "80 g", location: "fridge" as const }] };
  await save(request, external);
  await refreshKitchen(page);
  const before = await document(request), writes = watchWrites(page);
  await expect(dialog.getByRole("alert")).toContainText("This entry changed while the move was open");
  await expect(dialog.getByRole("button", { name: "Move entry", exact: true })).toBeDisabled();
  await dialog.locator("form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await unchanged(page, request, before, writes);
  await dialog.getByRole("button", { name: "Load current entry", exact: true }).click();
  await expect(dialog).toContainText("rice · Fridge · 80 g");
  await dialog.getByRole("combobox", { name: "Move to", exact: true }).selectOption("freezer");
  await dialog.getByRole("button", { name: "Move entry", exact: true }).click();
  await expect.poll(async () => (await state(request)).pantry).toEqual([{ ...external.pantry[0], location: "freezer" }]);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeFocused();
  await save(request, external);
  await refreshKitchen(page);
  const changedAgain = await document(request), undoWrites = watchWrites(page);
  await expect(page.getByRole("button", { name: "Undo last batch edit", exact: true })).toBeDisabled();
  await unchanged(page, request, changedAgain, undoWrites);
});

test("an applied move can recover when another tab restores its exact original batch", async ({ page, request }) => {
  const rice = { id: "rice", name: "rice", measure: "100 g", location: "cupboard" as const };
  const original = { ...empty(), pantry: [rice] };
  await save(request, original);
  await openPantry(page);
  await page.getByRole("button", { name: "Details for rice", exact: true }).click();
  await page.locator("#pantry-row-rice").getByRole("button", { name: "Move batch rice", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Move rice", exact: true });
  await dialog.getByRole("combobox", { name: "Move to", exact: true }).selectOption("freezer");
  await dialog.getByRole("button", { name: "Move entry", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Moved rice to Freezer");
  await expect.poll(async () => (await state(request)).pantry).toEqual([{ ...rice, location: "freezer" }]);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");

  await save(request, original);
  const restored = await document(request), writes = watchWrites(page);
  await refreshKitchen(page);
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Load current entry", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Move entry", exact: true })).toBeDisabled();
  await dialog.locator("form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await unchanged(page, request, restored, writes);

  await dialog.getByRole("button", { name: "Load current entry", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "Move to", exact: true })).toHaveValue("cupboard");
  await dialog.getByRole("combobox", { name: "Move to", exact: true }).selectOption("fridge");
  await dialog.getByRole("button", { name: "Move entry", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Moved rice to Fridge");
  await expect.poll(async () => (await state(request)).pantry).toEqual([{ ...rice, location: "fridge" }]);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("spice ownership is a no-write checklist until Add and existing food elsewhere is moved without duplication", async ({ page, request }, info) => {
  await save(request, { ...empty(), pantry: [
    { id: "salt", name: "salt", measure: "", location: "cupboard" },
    { id: "pepper", name: "black pepper", measure: "", location: "spice-rack" },
    { id: "past-thyme", name: "dried thyme", measure: "20 g", useBy: "2026-10-21", location: "cupboard" },
  ] });
  await openPantry(page);
  const before = await document(request), writes = watchWrites(page);
  await choosePantryLocation(page, "Spice rack");
  await openSpiceChecklist(page);
  await openPantryAdd(page);
  await expect(page.getByRole("checkbox", { name: "salt", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "salt", exact: true })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "black pepper", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "dried thyme", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "dried thyme", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move saved dried thyme", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "New pantry ingredient", exact: true }).fill("rosemary");
  await page.getByRole("checkbox", { name: "paprika", exact: true }).check();
  await page.getByRole("checkbox", { name: "ground cumin", exact: true }).check();
  await screenshot(page, info, "spice-ownership-drafts");
  await unchanged(page, request, before, writes);
  await page.getByRole("button", { name: "Add selected spices", exact: true }).click();
  await expect.poll(async () => (await state(request)).pantry.map(stock => ({ name: stock.name, location: stock.location }))).toEqual([
    { name: "salt", location: "cupboard" }, { name: "black pepper", location: "spice-rack" },
    { name: "dried thyme", location: "cupboard" },
    { name: "paprika", location: "spice-rack" }, { name: "ground cumin", location: "spice-rack" },
  ]);
  await expect(page.getByRole("button", { name: "Add selected spices", exact: true })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "New pantry ingredient", exact: true })).toHaveValue("rosemary");
  await page.getByRole("button", { name: "Move saved salt", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Move salt", exact: true });
  await dialog.getByRole("combobox", { name: "Move to", exact: true }).selectOption("spice-rack");
  await dialog.getByRole("button", { name: "Move entry", exact: true }).click();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect.poll(async () => (await state(request)).pantry.filter(stock => stock.name === "salt")).toEqual([
    { id: "salt", name: "salt", measure: "", location: "spice-rack" },
  ]);
  await addPlain(page, "rosemary");
  await expect.poll(async () => (await state(request)).pantry.find(stock => stock.name === "rosemary")?.location).toBe("spice-rack");
});

test("purchase previews review locations before adding and preserve the confirmed location in the receipt", async ({ page, request }) => {
  const response = await request.get("/api/recipes/catalog");
  const recipe = (await response.json()).recipes.find((item: Recipe) => item.id === "fixture-tomato-rice") as Recipe;
  const dinner: PlannedMeal = { id: "location-purchase", date: TODAY, recipeId: recipe.id, recipe, title: recipe.title,
    baseServings: recipe.servings ?? null, servings: recipe.servings ?? null, batches: 1,
    ingredientOverrides: {}, planningIngredients: recipe.ingredients, status: "planned", locked: false };
  await save(request, { ...empty(), meals: { [TODAY]: dinner } });
  await page.goto("/");
  await navigate(page, "Shopping");
  await page.getByRole("checkbox", { name: "Bought rice 200 g", exact: true }).click();
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  const before = await document(request), writes = watchWrites(page);
  await page.getByRole("button", { name: "Add bought items to pantry", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Add bought items to pantry", exact: true });
  await expect(preview.getByRole("combobox", { name: "Location for rice", exact: true })).toHaveValue("cupboard");
  await preview.getByRole("combobox", { name: "Location for rice", exact: true }).selectOption("freezer");
  await unchanged(page, request, before, writes);
  await preview.getByRole("button", { name: "Confirm pantry additions", exact: true }).click();
  await expect.poll(async () => (await state(request)).pantry.map(stock => ({ name: stock.name, measure: stock.measure, location: stock.location }))).toEqual([
    { name: "rice", measure: "200 g", location: "freezer" },
  ]);
  expect((await state(request)).shoppingPurchases?.[0].items[0].pantry).toEqual((await state(request)).pantry[0]);
});
