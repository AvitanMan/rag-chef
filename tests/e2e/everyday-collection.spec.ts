import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { DEMO_RECIPES, DEMO_SOURCE } from "../../app/lib/demo-recipes";
import type { KitchenDocument, KitchenState } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";
import { isKitchenWrite } from "./kitchen-requests";

const TODAY = "2026-10-22";
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });

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

async function navigate(page: Page, name: "Recipes" | "Pantry") {
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click();
}

const dinner = (id: string, title: string, names: string[]): Recipe => ({
  id, title, image: null, category: "Dinner", cuisine: "Test kitchen", servings: 2,
  source: { name: "Original test recipes", url: "https://example.test/recipes", licenseId: "MIT" },
  sourceUrl: "https://example.test/recipes", tags: [],
  ingredients: names.map(name => ({ name, measure: "1" })),
  instructions: ["Follow the original directions."],
});

test.beforeEach(async ({ page, request, baseURL }) => {
  expect(baseURL).toBeTruthy();
  expect(["127.0.0.1", "localhost"]).toContain(new URL(baseURL!).hostname);
  expect(new URL(baseURL!).port).not.toBe("3000");
  await page.clock.install({ time: new Date(`${TODAY}T12:00:00+03:00`) });
  await save(request, empty());
});

test("everyday collection can be added to an existing catalog without changing the kitchen", async ({ page, request }, info) => {
  await save(request, { ...empty(), pantry: [{ id: "pasta", name: "pasta", measure: "" }] });
  const catalogBefore = await (await request.get("/api/recipes/catalog")).json();
  expect(catalogBefore.recipes.length).toBeGreaterThan(0);
  const originals = DEMO_RECIPES.map(recipe => ({ ...recipe, id: `${DEMO_SOURCE.id}:${recipe.id}` }));
  const everyday = originals.filter(recipe => recipe.tags.includes("everyday"));
  expect(everyday).toHaveLength(8);
  let added = false;
  const keys: string[] = [];
  // Exercise the UI contract without inserting recipes into the shared E2E fixture.
  // The fresh-install suite separately exercises the actual durable catalog job.
  await page.route("**/api/recipes/catalog", route => route.fulfill({ json: {
    ...catalogBefore,
    recipes: added ? [...catalogBefore.recipes, ...originals] : catalogBefore.recipes,
  } }));
  const statusUrl = "/api/admin/catalog/jobs/everyday-test";
  await page.route("**/api/admin/catalog/demo", route => {
    expect(route.request().method()).toBe("POST");
    keys.push(route.request().headers()["idempotency-key"]);
    return route.fulfill({ status: 202, json: { ok: true, job: { id: "everyday-test", kind: "demo", status: "queued" }, statusUrl } });
  });
  await page.route(`**${statusUrl}`, route => {
    added = true;
    return route.fulfill({ json: { ok: true, job: { id: "everyday-test", kind: "demo", status: "succeeded", result: { ok: true, count: 11 } }, statusUrl } });
  });
  const chefCalls: string[] = [];
  await page.route("**/api/chef", route => { chefCalls.push(route.request().url()); return route.abort(); });
  await page.goto("/");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await navigate(page, "Recipes");
  const before = await saved(request), writes: string[] = [];
  page.on("request", request => { if (isKitchenWrite(request)) writes.push(request.url()); });
  await page.getByRole("button", { name: "Everyday dinners", exact: true }).click();
  const setup = page.getByRole("region", { name: "Add everyday dinners", exact: true });
  await expect(setup).toBeVisible();
  await setup.getByRole("button", { name: "Add everyday dinners", exact: true }).click();
  await expect(page.locator(".recipe-card")).toHaveCount(8);
  await expect(page.locator(".recipe-card .recipe-description")).toHaveCount(8);
  await expect(setup).toHaveCount(0);
  for (const recipe of everyday) await expect(page.getByRole("button", { name: recipe.title, exact: true })).toBeVisible();
  for (const quality of await page.locator(".recipe-card .recipe-quality").allTextContents()) expect(quality).not.toMatch(/\b\d+ min/);
  expect(keys).toHaveLength(1);
  expect(keys[0]).toBeTruthy();
  await page.screenshot({ path: info.outputPath("everyday-collection.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "All recipes", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search recipes", exact: true }).fill(catalogBefore.recipes[0].title);
  await expect(page.getByRole("button", { name: catalogBefore.recipes[0].title, exact: true })).toBeVisible();
  await page.clock.runFor(700);
  expect(writes).toEqual([]);
  expect(chefCalls).toEqual([]);
  expect(await saved(request)).toEqual(before);
  expect(await (await request.get("/api/recipes/catalog")).json()).toEqual(catalogBefore);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("pantry dinners favor food ingredients over seasoning overlap and expose what is missing", async ({ page, request }, info) => {
  const recipes = [
    dinner("fixture-seasoning-overlap", "Chicken Rice", ["rice", "chicken", "cream", "garlic", "salt", "olive oil", "water"]),
    dinner("fixture-food-overlap", "Egg Rice", ["rice", "egg", "onion", "black pepper"]),
  ];
  await save(request, { ...empty(), pantry: ["rice", "eggs", "salt", "olive oil", "water"].map((name, index) => ({ id: `stock-${index}`, name, measure: "" })) });
  await page.route("**/api/recipes/catalog", route => route.fulfill({ json: { recipes, metadataByRecipeId: {} } }));
  const chefCalls: string[] = [];
  await page.route("**/api/chef", route => { chefCalls.push(route.request().url()); return route.abort(); });
  await page.goto("/");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await navigate(page, "Pantry");
  const before = await saved(request), writes: string[] = [];
  page.on("request", request => { if (isKitchenWrite(request)) writes.push(request.url()); });
  await page.getByRole("button", { name: "Use rice tonight", exact: true }).click();
  await page.getByRole("button", { name: "Find dinners", exact: true }).click();
  const results = page.getByRole("region", { name: "Dinner ideas for tonight", exact: true });
  const cards = results.locator(".recipe-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.first().getByRole("button", { name: "Egg Rice", exact: true })).toBeVisible();
  const fit = cards.first().locator(".recipe-pantry-fit");
  await expect(cards.first().locator(".recipe-picks")).toHaveText("Uses your picks: rice");
  await cards.first().locator(".compact-estimate summary").click();
  await expect(fit).toContainText("Also have: egg");
  await expect(fit).toContainText("Missing: onion");
  await expect(fit).toContainText("Also check: black pepper");
  await expect(fit).toContainText("Ingredient names matched");
  await expect(cards.first().locator(".recipe-readiness")).toContainText("Pantry amounts for this dinner");
  await expect(cards.nth(1).locator(".recipe-pantry-fit")).toContainText("Missing: chicken, cream, garlic");
  await page.screenshot({ path: info.outputPath("pantry-food-matches.png"), fullPage: true, animations: "disabled" });
  await page.clock.runFor(700);
  expect(writes).toEqual([]);
  expect(chefCalls).toEqual([]);
  expect(await saved(request)).toEqual(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
