import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { KitchenDocument, KitchenState, PlannedMeal } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";
import type { KitchenCommand } from "../../app/lib/kitchen-commands";
import { MAX_PENDING_KITCHEN_WRITES } from "../../app/lib/kitchen-write-queue";
import { draft, openPendingKitchenOutbox, saved } from "./pending-kitchen-outbox";

const TODAY = "2026-10-22";
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [
  { id: "dinner-rice", name: "rice", measure: "500 g", location: "cupboard" },
  { id: "dinner-tomato", name: "tomato", measure: "4", location: "fridge" },
], meals: {}, shoppingChecked: {}, migratedLegacy: true });

async function save(request: APIRequestContext, state: KitchenState) {
  const current = await saved(request);
  const response = await request.put("/api/kitchen", { data: { revision: current.revision, state } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function source(request: APIRequestContext, id = "fixture-tomato-rice"): Promise<Recipe> {
  const response = await request.get("/api/recipes/catalog");
  expect(response.ok()).toBeTruthy();
  const recipe = (await response.json()).recipes.find((recipe: Recipe) => recipe.id === id);
  expect(recipe).toBeTruthy();
  return recipe;
}

function meal(recipe: Recipe): PlannedMeal {
  return { id: "saved-rejection-dinner", date: TODAY, recipeId: recipe.id, recipe, title: recipe.title,
    baseServings: recipe.servings ?? null, servings: recipe.servings ?? null, batches: 1,
    ingredientOverrides: {}, locked: false, status: "planned" };
}

async function rejected(scope: Locator, action: "saved" | "completed") {
  await expect(scope.getByRole("alert").filter({ hasText: new RegExp(`not ${action}`, "i") })).toContainText(/try again/i);
}

async function unchanged(page: Page, request: APIRequestContext, before: KitchenDocument) {
  await page.clock.runFor(700);
  const cached = await draft(page);
  expect(cached.state.pantry).toEqual(before.state!.pantry);
  expect(cached.state.meals).toEqual(before.state!.meals);
  expect(cached.writeQueue.writes).toHaveLength(MAX_PENDING_KITCHEN_WRITES);
  expect(cached.writeQueue.writes.every((write: { command: KitchenCommand }) => write.command.type === "SetFavorite")).toBe(true);
  expect(await saved(request)).toEqual(before);
}

test.beforeEach(async ({ page, request, baseURL }) => {
  expect(baseURL, "Use the disposable isolated preview").toBeTruthy();
  expect(["127.0.0.1", "localhost"]).toContain(new URL(baseURL!).hostname);
  expect(new URL(baseURL!).port).not.toBe("3000");
  await page.clock.install({ time: new Date(`${TODAY}T12:00:00+03:00`) });
  await page.route("**/api/chef", route => route.abort());
  await save(request, empty());
});

test("a rejected dinner choice retains Pantry results and picks without claiming a saved dinner", async ({ page, request }) => {
  const { before } = await openPendingKitchenOutbox(page, request);
  await page.getByRole("button", { name: "Use rice tonight", exact: true }).click();
  await page.getByRole("button", { name: "Use tomato tonight", exact: true }).click();
  await page.getByRole("button", { name: "Find dinners", exact: true }).click();
  const results = page.getByRole("region", { name: "Dinner ideas for tonight", exact: true });
  const choose = results.getByRole("button", { name: "Choose for tonight: Tomato Rice", exact: true });
  await choose.click();
  await rejected(page.locator("main"), "saved");
  await expect(results).toBeVisible();
  await expect(results.getByRole("button", { name: "Remove rice from picks", exact: true })).toBeVisible();
  await expect(results.getByRole("button", { name: "Remove tomato from picks", exact: true })).toBeVisible();
  await expect(choose).toBeEnabled();
  await expect(page.getByRole("region", { name: "Chosen dinner", exact: true })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: /^Dinner saved/ })).toHaveCount(0);
  await choose.click();
  await rejected(page.locator("main"), "saved");
  await results.getByRole("button", { name: "View Tomato Rice", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Tomato Rice", exact: true });
  await drawer.getByRole("button", { name: "Choose for tonight", exact: true }).click();
  await rejected(drawer, "saved");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Choose for tonight", exact: true })).toBeEnabled();
  await drawer.getByRole("button", { name: "Close recipe", exact: true }).click();
  await expect(results).toBeVisible();
  await expect(results.getByRole("button", { name: "Remove rice from picks", exact: true })).toBeVisible();
  await expect(results.getByRole("button", { name: "Remove tomato from picks", exact: true })).toBeVisible();
  await unchanged(page, request, before);
});

test("a rejected replacement keeps its confirmation dialog and the original saved dinner", async ({ page, request }) => {
  const original = meal(await source(request, "fixture-cheese-pasta"));
  await save(request, { ...empty(), meals: { [TODAY]: original } });
  const { before } = await openPendingKitchenOutbox(page, request, { view: "Recipes" });
  await page.getByRole("searchbox", { name: "Search recipes", exact: true }).fill("Tomato Rice");
  await page.getByRole("button", { name: "Choose for tonight: Tomato Rice", exact: true }).click();
  const replace = page.getByRole("dialog", { name: "Replace dinner", exact: true });
  await expect(replace).toContainText("Cheese Pasta");
  await replace.getByRole("button", { name: "Replace dinner", exact: true }).click();
  await rejected(replace, "saved");
  await expect(replace).toBeVisible();
  await expect(replace.getByRole("button", { name: "Replace dinner", exact: true })).toBeEnabled();
  await expect(replace.getByRole("button", { name: "Keep current dinner", exact: true })).toBeEnabled();
  await unchanged(page, request, before);
  await replace.getByRole("button", { name: "Keep current dinner", exact: true }).click();
  await expect(replace).toHaveCount(0);
  await expect(page.getByRole("searchbox", { name: "Search recipes", exact: true })).toHaveValue("Tomato Rice");
});

for (const activeCooking of [false, true]) {
  test(`a rejected ${activeCooking ? "active cooking" : "Plan"} completion leaves the review editable and stock untouched`, async ({ page, request }) => {
    const planned = meal(await source(request));
    await save(request, { ...empty(), meals: { [TODAY]: planned } });
    const { before } = await openPendingKitchenOutbox(page, request, { view: activeCooking ? false : "Plan" });
    let review: Locator;
    if (activeCooking) {
      await page.getByRole("region", { name: "Chosen dinner", exact: true }).getByRole("button", { name: "Cook dinner", exact: true }).click();
      const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
      await cooking.getByRole("button", { name: /Next step/ }).click();
      await cooking.getByRole("button", { name: "Finish cooking", exact: true }).click();
      review = cooking.getByRole("region", { name: "Complete dinner", exact: true });
    } else {
      const card = page.locator(`#dinner-${TODAY}`);
      await card.locator(".meal-more > summary").click();
      await card.getByRole("button", { name: "Mark cooked without cooking mode", exact: true }).click();
      review = page.getByRole("dialog", { name: "Complete dinner", exact: true }).getByRole("region", { name: "Complete dinner", exact: true });
    }
    await expect(review).toContainText("rice: 500 g → 300 g");
    await review.getByRole("checkbox").check();
    await review.getByRole("button", { name: "Mark dinner cooked", exact: true }).click();
    await rejected(review, "completed");
    await expect(review.getByRole("checkbox")).toBeEnabled();
    await expect(review.getByRole("checkbox")).toBeChecked();
    await expect(review.getByRole("button", { name: "Mark dinner cooked", exact: true })).toBeEnabled();
    await expect(review.getByRole("button", { name: "Back to directions", exact: true })).toBeEnabled();
    await expect(review.getByRole("button", { name: "Retry save", exact: true })).toHaveCount(0);
    await expect(review.getByRole("status").filter({ hasText: "Keeping your completion safe" })).toHaveCount(0);
    await review.getByRole("checkbox").uncheck();
    await review.getByRole("button", { name: "Mark dinner cooked", exact: true }).click();
    await rejected(review, "completed");
    await expect(review.getByRole("checkbox")).not.toBeChecked();
    await unchanged(page, request, before);
    await review.getByRole("button", { name: "Back to directions", exact: true }).click();
    if (activeCooking) {
      const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
      await expect(cooking).toBeVisible();
      await expect(cooking).toContainText("Step 2");
      await expect(cooking.getByRole("button", { name: "Finish cooking", exact: true })).toBeEnabled();
    } else await expect(page.getByRole("dialog", { name: "Complete dinner", exact: true })).toHaveCount(0);
  });
}
