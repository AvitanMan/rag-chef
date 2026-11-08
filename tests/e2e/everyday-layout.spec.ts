import { test, expect, type Page } from "@playwright/test";
const TODAY = "2026-10-25";
async function navigate(page: Page, name: string) {
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(`^${name}`) }).filter({ visible: true }).first().click();
}
test.beforeEach(async ({ page, request }) => {
  await page.clock.install({ time: new Date(`${TODAY}T12:00:00+02:00`) });
  const catalog = await (await request.get("/api/recipes/catalog")).json();
  const recipe = catalog.recipes.find((item: { id: string }) => item.id === "fixture-tomato-rice");
  const current = await (await request.get("/api/kitchen")).json();
  const meal = (date: string) => ({ id: `meal-${date}`, date, recipeId: recipe.id, recipe, title: recipe.title, baseServings: 2, servings: 2, batches: 1, ingredientOverrides: {}, locked: false, status: "planned" });
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state: { schemaVersion: 2, migratedLegacy: true, pantry: [{ id: "rice", name: "rice", measure: "100 g", useBy: TODAY }], meals: { [TODAY]: meal(TODAY), "2026-10-24": meal("2026-10-24") }, shoppingChecked: {} } } })).ok()).toBe(true);
});
test("pantry starts with visible stock and reveals editing and adding on demand", async ({ page, request }) => {
  await page.goto("/"); await navigate(page, "Pantry");
  const row = page.locator('[data-pantry-name="rice"]');
  await expect(row).toContainText("100 g");
  await expect(row.locator(".pantry-editor > summary")).toHaveAccessibleName(/rice.*100 g.*Use by today.*Edit/);
  await expect(row.locator(".pantry-stock-summary")).toBeInViewport();
  await expect(page.getByRole("textbox", { name: "New pantry ingredient", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Available rice", exact: true })).toHaveCount(0);
  await row.locator(".pantry-editor > summary").click();
  await page.getByRole("textbox", { name: "Available rice", exact: true }).fill("150 g");
  await expect.poll(async () => (await (await request.get("/api/kitchen")).json()).state.pantry[0].measure).toBe("150 g");
  await row.locator(".pantry-editor > summary").click();
  await expect(row).toContainText("150 g");
  await page.locator(".pantry-add > summary").click();
  await page.getByRole("textbox", { name: "New pantry ingredient", exact: true }).fill("beans: 200 g\ncarrot: 2");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Review pantry ingredients", exact: true });
  await expect(preview).toBeVisible();
  expect((await (await request.get("/api/kitchen")).json()).state.pantry).toHaveLength(1);
  await preview.getByRole("button", { name: "Confirm ingredients", exact: true }).click();
  await expect(page.locator(".unified-pantry-item")).toHaveCount(3);
});
test("mobile week collapses past days and reveals dinner controls without losing edits", async ({ page, request }, info) => {
  await page.goto("/");
  const dinner = page.locator(`#dinner-${TODAY}`);
  const servings = dinner.getByRole("spinbutton", { name: "Servings Sun, Oct 25", exact: true });
  if (info.project.name === "mobile") {
    await expect(page.locator("#dinner-2026-10-24")).not.toBeVisible();
    await expect(servings).toHaveCount(0);
    await dinner.getByRole("button", { name: /^(Close details|Details) for Sun, Oct 25$/, exact: true }).click();
    await servings.fill("4");
    await expect.poll(async () => (await (await request.get("/api/kitchen")).json()).state.meals[TODAY].servings).toBe(4);
    await dinner.getByRole("button", { name: /^(Close details|Details) for Sun, Oct 25$/, exact: true }).click();
    await expect(dinner.locator(".day-compact-summary")).toContainText("4 servings");
    await dinner.getByRole("button", { name: "Details for Sun, Oct 25", exact: true }).click();
    await expect(servings).toHaveValue("4");
    await page.getByRole("button", { name: "Earlier this week · 6", exact: true }).click();
    const earlierDinner = page.locator("#dinner-2026-10-24");
    await expect(earlierDinner).toBeVisible();
    await earlierDinner.getByRole("button", { name: "Details for Sat, Oct 24", exact: true }).click();
    await earlierDinner.locator(".meal-review > summary").click();
    await expect(earlierDinner.locator(".meal-review")).toHaveAttribute("open", "");
    await page.getByRole("button", { name: "Hide earlier days · 6", exact: true }).click();
    await expect(earlierDinner).not.toBeVisible();
    await page.getByRole("button", { name: "Earlier this week · 6", exact: true }).click();
    await expect(earlierDinner).toBeVisible();
    await expect(earlierDinner.locator(".meal-review")).not.toHaveAttribute("open", "");
  } else {
    await expect(servings).toBeVisible();
    await expect(page.locator("#dinner-2026-10-24")).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("shopping keeps the checklist first and undo never changes pantry stock", async ({ page, request }) => {
  await page.goto("/"); await navigate(page, "Shopping");
  const before = (await (await request.get("/api/kitchen")).json()).state.pantry;
  const rice = page.getByRole("checkbox", { name: /^Bought rice / });
  await expect(rice).toBeInViewport();
  await expect(page.getByRole("button", { name: "Copy shopping list", exact: true })).toHaveCount(0);
  await rice.click();
  await expect.poll(async () => Object.values((await (await request.get("/api/kitchen")).json()).state.shoppingChecked).some(Boolean)).toBe(true);
  const undo = page.getByRole("button", { name: "Undo checked rice", exact: true });
  await expect(undo).toBeInViewport();
  await undo.click();
  await expect(rice).not.toBeChecked();
  await expect.poll(async () => Object.values((await (await request.get("/api/kitchen")).json()).state.shoppingChecked).some(Boolean)).toBe(false);
  expect((await (await request.get("/api/kitchen")).json()).state.pantry).toEqual(before);
  await page.locator(".shopping-tools > summary").click();
  await expect(page.getByRole("button", { name: "Copy shopping list", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Print", exact: true })).toBeVisible();
});

test("shopping keyboard focus stays below the sticky progress and Undo controls", async ({ page, request }) => {
  const current = await (await request.get("/api/kitchen")).json();
  const meal = current.state.meals[TODAY];
  meal.recipe.ingredients = Array.from({ length: 16 }, (_, index) => ({ name: `ingredient ${index + 1}`, measure: "100 g" }));
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state: { ...current.state, pantry: [], meals: { [TODAY]: meal } } } })).ok()).toBe(true);
  await page.goto("/"); await navigate(page, "Shopping");
  await page.locator('.shopping-list[aria-label="To buy"]').getByRole("checkbox").first().click();
  await expect(page.locator(".shopping-check-undo")).toBeVisible();
  const remaining = page.locator('.shopping-list[aria-label="To buy"]');
  await remaining.getByRole("checkbox").last().focus();
  for (let index = 0; index < 20; index++) {
    await page.keyboard.press("Shift+Tab");
    await expect(async () => {
      const position = await page.evaluate(() => {
        const target = document.activeElement!;
        const box = target.getBoundingClientRect();
        const header = document.querySelector(".shopping-progress")!.getBoundingClientRect();
        return { top: box.top, headerBottom: header.bottom, inList: Boolean(target.closest(".shopping-list")) };
      });
      expect(position.inList).toBe(true);
      expect(position.top).toBeGreaterThanOrEqual(position.headerBottom);
    }).toPass({ timeout: 1000 });
  }
});
