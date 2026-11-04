import { openChef } from "./open-chef";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { KitchenState, PlannedMeal } from "../../app/lib/kitchen-types";
import type { Recipe, RecipeMetadata, RecipeMetadataMap } from "../../app/lib/recipe-types";

const TODAY = "2026-10-22";
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });
async function read(request: APIRequestContext) { return (await request.get("/api/kitchen")).json(); }
async function save(request: APIRequestContext, state: KitchenState) {
  const current = await read(request);
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state } })).ok()).toBeTruthy();
}
async function navigate(page: Page, name: string) {
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click();
}
function metadata(minutes: number | null, basis: "source" | "curator_estimate" = "source"): RecipeMetadata {
  return { revision: 1, sourceContentHash: "a".repeat(64), coreDinner: true, dinnerRole: "main", diets: { vegan: "unknown", vegetarian: "unknown", gluten_free: "unknown", low_carb: "unknown" },
    equipment: null, totalMinutes: minutes, provenance: { totalMinutes: { basis, evidence: "Synthetic test time." } }, reviewedBy: "Test", reviewedAt: "2026-10-22T09:00:00Z" };
}
async function catalog(request: APIRequestContext): Promise<Recipe[]> { return (await (await request.get("/api/recipes/catalog")).json()).recipes; }
async function mockCatalog(page: Page, recipes: Recipe[], metadataByRecipeId: RecipeMetadataMap) {
  await page.route("**/api/recipes/catalog", route => route.fulfill({ json: { recipes, metadataByRecipeId } }));
}
async function narrowScreenshot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/${name}-${test.info().project.name}.png`, scale: "css" });
}

test.beforeEach(async ({ page, request }) => {
  if (test.info().project.name === "mobile") await page.setViewportSize({ width: 320, height: 740 });
  await page.clock.install({ time: new Date(`${TODAY}T12:00:00+03:00`) });
  await save(request, empty());
});

test("unknown and estimated recipe times explain empty results and clearing time preserves other filters", async ({ page, request }) => {
  const recipes = await catalog(request);
  await mockCatalog(page, recipes, { "fixture-tomato-rice": metadata(10, "curator_estimate") });
  await openChef(page); await navigate(page, "Recipes");
  await page.getByRole("searchbox", { name: "Search recipes", exact: true }).fill("rice");
  await page.getByRole("checkbox", { name: "Reviewed dinners", exact: true }).check();
  await page.getByRole("spinbutton", { name: "Maximum total minutes", exact: true }).fill("30");
  await expect(page.getByText("0 of 1 matching recipes have verified total cooking times.", { exact: true })).toBeVisible();
  await expect(page.getByText("Total cooking times are unknown.", { exact: true })).toBeVisible();
  await expect(page.locator(".recipe-card")).toHaveCount(0);
  await narrowScreenshot(page, "unknown-times");
  await page.getByRole("button", { name: "Clear time limit", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("searchbox", { name: "Search recipes", exact: true })).toHaveValue("rice");
  await expect(page.getByRole("checkbox", { name: "Reviewed dinners", exact: true })).toBeChecked();
  await expect(page.locator(".recipe-card")).toHaveCount(1);
  await expect(page.locator(".recipe-card")).toContainText("Tomato Rice");
});

test("mixed times count only source totals and distinguish a low limit from an unrelated search", async ({ page, request }) => {
  const recipes = (await catalog(request)).filter(recipe => ["fixture-tomato-rice", "fixture-vegan-beans", "fixture-cheese-pasta", "fixture-eggplant"].includes(recipe.id));
  await mockCatalog(page, recipes, { "fixture-tomato-rice": metadata(40), "fixture-vegan-beans": metadata(20), "fixture-cheese-pasta": metadata(10, "curator_estimate") });
  await openChef(page); await navigate(page, "Recipes");
  await expect(page.getByText("2 of 4 matching recipes have verified total cooking times.", { exact: true })).toBeVisible();
  const limit = page.getByRole("spinbutton", { name: "Maximum total minutes", exact: true });
  await limit.fill("30");
  await expect(page.locator(".recipe-card")).toHaveCount(1);
  await expect(page.locator(".recipe-card")).toContainText("Garlic Beans");
  await limit.fill("10");
  await expect(page.getByText("Verified total times exceed your limit.", { exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search recipes", exact: true }).fill("no such recipe");
  await expect(page.getByText("No recipes match.", { exact: true })).toBeVisible();
  await expect(page.getByText("Verified total times exceed your limit.", { exact: true })).toHaveCount(0);
});

test("reviewed dinner counts compose with collections, search, time and saved exclusions", async ({ page, request }) => {
  const recipes = (await catalog(request)).filter(recipe => ["fixture-tomato-rice", "fixture-vegan-beans", "fixture-cheese-pasta", "fixture-eggplant"].includes(recipe.id));
  const rice = recipes.find(recipe => recipe.id === "fixture-tomato-rice")!;
  const meal: PlannedMeal = { id: "cooked-rice", date: TODAY, recipeId: rice.id, recipe: rice, title: rice.title, baseServings: 2, servings: 2, batches: 1, ingredientOverrides: {}, locked: false, status: "cooked", completion: { id: "completed-rice", at: `${TODAY}T09:00:00.000Z`, deductions: [] } };
  await save(request, { ...empty(), meals: { [TODAY]: meal }, favoriteRecipeIds: [rice.id, "fixture-cheese-pasta"] });
  await mockCatalog(page, recipes, { [rice.id]: metadata(40), "fixture-vegan-beans": metadata(20), "fixture-cheese-pasta": metadata(null) });
  await openChef(page); await navigate(page, "Recipes");
  const reviewed = page.getByRole("checkbox", { name: "Reviewed dinners", exact: true });
  const explanation = page.locator("#reviewed-dinners-help");
  await expect(reviewed).not.toBeChecked();
  await expect(explanation).toContainText("3 reviewed dinners match these filters.");
  await expect(page.locator(".recipe-card")).toHaveCount(4);
  await reviewed.check();
  await expect(page.locator(".recipe-card")).toHaveCount(3);
  await page.getByRole("button", { name: "Favorites", exact: true }).click();
  await expect(explanation).toContainText("2 reviewed dinners match these filters.");
  await page.getByRole("spinbutton", { name: "Maximum total minutes", exact: true }).fill("30");
  await expect(explanation).toContainText("0 reviewed dinners match these filters.");
  await expect(page.getByText("Verified total times exceed your limit.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear time limit", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search recipes", exact: true }).fill("rice");
  await expect(explanation).toContainText("1 reviewed dinner matches these filters.");
  await navigate(page, "Pantry"); await navigate(page, "Recipes");
  await expect(reviewed).toBeChecked();
  await expect(page.locator(".recipe-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await page.getByRole("button", { name: "Cook again", exact: true }).click();
  await expect(explanation).toContainText("1 reviewed dinner matches these filters.");
  await expect(page.locator(".recipe-card")).toContainText("Tomato Rice");
  await page.getByRole("button", { name: "All recipes", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("textbox", { name: "Allergies", exact: true }).fill("cheese");
  await page.getByRole("textbox", { name: "Allergies", exact: true }).press("Enter");
  await navigate(page, "Recipes");
  await expect(explanation).toContainText("2 reviewed dinners match these filters.");
  await expect(page.locator(".recipe-card")).toHaveCount(2);
  await narrowScreenshot(page, "reviewed-dinners");
});

test("reviewed dinner count includes all matches before pagination and excludes unknown reviews", async ({ page, request }) => {
  const template = (await catalog(request)).find(recipe => recipe.id === "fixture-tomato-rice")!;
  const recipes = Array.from({ length: 35 }, (_, index) => ({ ...template, id: `dinner-${index}`, title: `Dinner ${String(index).padStart(2, "0")}` }));
  const reviews = Object.fromEntries(recipes.slice(0, 30).map(recipe => [recipe.id, metadata(40)]));
  await mockCatalog(page, recipes, reviews);
  await openChef(page); await navigate(page, "Recipes");
  await expect(page.locator("#reviewed-dinners-help")).toContainText("30 reviewed dinners match these filters.");
  await expect(page.locator(".recipe-card")).toHaveCount(24);
  await page.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(page.locator(".recipe-card")).toHaveCount(35);
  await page.getByRole("checkbox", { name: "Reviewed dinners", exact: true }).check();
  await expect(page.locator(".recipe-card")).toHaveCount(24);
  await page.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(page.locator(".recipe-card")).toHaveCount(30);
  await expect(page.locator("#reviewed-dinners-help")).toContainText("30 reviewed dinners match these filters.");
  await expect(page.getByRole("button", { name: "Show more", exact: true })).toHaveCount(0);
});

test("pantry search and sorting compose with dates, preserve batches, editing, Undo and navigation", async ({ page, request }) => {
  const pantry = [
    { id: "rice-late", name: "rice", measure: "400 g", useBy: "2026-10-26" },
    { id: "rice-early", name: "Rice", measure: "100 g", useBy: TODAY },
    { id: "cooked", name: "cooked rice", measure: "200 g" },
    { id: "past", name: "oats", measure: "1 kg", useBy: "2026-10-21" },
    { id: "beans", name: "beans", measure: "" },
  ];
  await save(request, { ...empty(), pantry });
  await openChef(page); await navigate(page, "Pantry");
  const search = page.getByRole("searchbox", { name: "Search pantry", exact: true });
  const sort = page.getByRole("combobox", { name: "Sort pantry", exact: true });
  const rows = page.locator(".unified-pantry-item");
  await search.fill("RICE"); await sort.selectOption("useBy");
  await expect(rows).toHaveCount(3);
  expect(await rows.evaluateAll(items => items.map(item => item.id))).toEqual(["pantry-row-rice-early", "pantry-row-rice-late", "pantry-row-cooked"]);
  await sort.selectOption("name");
  await expect(rows.first()).toHaveAttribute("id", "pantry-row-cooked");
  await sort.selectOption("current");
  await expect(rows.first()).toHaveAttribute("id", "pantry-row-rice-late");
  await sort.selectOption("useBy");
  const before = await read(request);
  await navigate(page, "Recipes"); await navigate(page, "Pantry");
  await expect(search).toHaveValue("RICE"); await expect(sort).toHaveValue("useBy");
  expect(await read(request)).toEqual(before);
  await page.getByRole("button", { name: "Use soon (1)", exact: true }).click();
  await expect(rows).toHaveCount(1); await expect(rows).toHaveAttribute("id", "pantry-row-rice-early");
  const amount = rows.getByRole("textbox", { name: "Available Rice", exact: true });
  await amount.fill("150 g"); await amount.press("Tab");
  await expect.poll(async () => (await read(request)).state.pantry.find((item: { id: string }) => item.id === "rice-early").measure).toBe("150 g");
  await rows.getByRole("button", { name: "Remove Rice", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(rows).toHaveCount(1); await expect(amount).toHaveValue("150 g");
  await page.getByRole("button", { name: "Past entered date (1)", exact: true }).click();
  await expect(page.getByText("No pantry items match your search in this view.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Clear pantry search", exact: true }).click();
  await expect(rows).toHaveCount(1); await expect(rows).toHaveAttribute("id", "pantry-row-past");
  await page.getByRole("button", { name: "All items (5)", exact: true }).click();
  if (test.info().project.name === "mobile") await page.getByRole("button", { name: "Dark mode", exact: true }).click();
  await page.locator(".pantry-browser-controls").scrollIntoViewIfNeeded();
  await narrowScreenshot(page, "pantry-navigation");
  const saved = (await read(request)).state.pantry;
  expect(saved.find((item: { id: string }) => item.id === "rice-late").measure).toBe("400 g");
  expect(saved.find((item: { id: string }) => item.id === "cooked").measure).toBe("200 g");
});

for (const failClipboard of [false, true]) {
  test(`shopping export ${failClipboard ? "offers selectable text when copying fails" : "copies shortages and prints only the portable list"} without changing kitchen state`, async ({ page, request }) => {
    await page.addInitScript(({ fail }) => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => {
        if (fail) throw new Error("Copy unavailable");
        (window as unknown as { copiedList: string }).copiedList = text;
      } } });
      window.print = () => { (window as unknown as { printCalls: number }).printCalls = ((window as unknown as { printCalls?: number }).printCalls ?? 0) + 1; };
    }, { fail: failClipboard });
    const recipes = await catalog(request);
    const recipe = recipes.find(recipe => recipe.id === "fixture-tomato-rice")!;
    const planned: PlannedMeal = { id: "dinner", date: TODAY, recipeId: recipe.id, recipe, title: recipe.title, baseServings: 2, servings: 2, batches: 1, ingredientOverrides: { "1": "to taste" }, locked: false, status: "planned" };
    const futureRecipe = recipes.find(recipe => recipe.id === "fixture-cheese-pasta")!;
    const future = { ...planned, id: "next-week", date: "2026-10-29", recipeId: futureRecipe.id, recipe: futureRecipe, title: futureRecipe.title, ingredientOverrides: {} };
    await save(request, { ...empty(), meals: { [TODAY]: planned, [future.date]: future }, pantry: [{ id: "rice", name: "rice", measure: "50 g" }] });
    await openChef(page); await navigate(page, "Shopping");
    const before = await read(request);
    await page.getByRole("button", { name: "Copy shopping list", exact: true }).click();
    let text: string;
    if (failClipboard) {
      const fallback = page.getByRole("textbox", { name: "Shopping list text", exact: true });
      await expect(fallback).toBeFocused(); text = await fallback.inputValue();
      expect(await fallback.evaluate((element: HTMLTextAreaElement) => element.selectionEnd - element.selectionStart)).toBe(text.length);
      await narrowScreenshot(page, "shopping-copy-fallback");
    } else {
      await expect(page.getByText("Shopping list copied.", { exact: true })).toBeVisible();
      text = await page.evaluate(() => (window as unknown as { copiedList: string }).copiedList);
    }
    expect(text).toContain("2026-10-19 – 2026-10-25");
    expect(text).not.toContain("cheese:"); expect(text).not.toContain("pasta:");
    expect(text).toContain("rice: 150 g"); expect(text).toContain("tomato: to taste"); expect(text).toContain("Review amount");
    expect(await read(request)).toEqual(before);
    // Checking moves the row into a collapsed Bought section, replacing its DOM node.
    await page.getByRole("checkbox", { name: /^Bought rice / }).click();
    await expect(page.locator(".save-indicator")).toHaveText("Saved");
    const afterCheck = await read(request);
    await page.getByRole("button", { name: "Copy shopping list", exact: true }).click();
    const exported = failClipboard ? await page.getByRole("textbox", { name: "Shopping list text", exact: true }).inputValue() : await page.evaluate(() => (window as unknown as { copiedList: string }).copiedList);
    expect(exported).not.toContain("rice:"); expect(exported).toContain("Review amount");
    await page.getByRole("button", { name: "Print", exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { printCalls: number }).printCalls)).toBe(1);
    await page.emulateMedia({ media: "print" });
    const print = page.getByRole("region", { name: "Printable shopping list", exact: true });
    await expect(print).toBeVisible(); await expect(print).toContainText("tomato: to taste"); await expect(print).not.toContainText("rice:");
    await expect(page.locator(".app-shell")).toBeHidden();
    if (!failClipboard) await narrowScreenshot(page, "shopping-print");
    await page.emulateMedia({ media: "screen" });
    await expect(print).toBeHidden();
    expect(await read(request)).toEqual(afterCheck);
    await page.getByRole("checkbox", { name: /^Bought tomato / }).click();
    await expect(page.getByRole("button", { name: "Copy shopping list", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Print", exact: true })).toBeDisabled();
  });
}
