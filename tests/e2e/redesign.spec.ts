import { test, expect, type Page } from "@playwright/test";

async function navigate(page: Page, name: string) {
  if (name === "Settings") await page.getByRole("button", { name, exact: true }).click();
  else await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click();
}
const TODAY = "2026-10-25";
test.beforeEach(async ({ page, request }) => {
  await page.clock.install({ time: new Date(`${TODAY}T12:00:00+02:00`) });
  const recipes = await (await request.get("/api/recipes/catalog")).json();
  const recipe = recipes.recipes.find((item: { id: string }) => item.id === "fixture-tomato-rice");
  const document = await (await request.get("/api/kitchen")).json();
  const state = { schemaVersion: 2, migratedLegacy: true, pantry: [{ id: "rice", name: "rice", measure: "100 g", useBy: TODAY }],
    meals: { [TODAY]: { id: "design-dinner", date: TODAY, recipeId: recipe.id, recipe, title: recipe.title, baseServings: 2, servings: 2, batches: 1, ingredientOverrides: {}, locked: false, status: "planned" } }, shoppingChecked: {} };
  expect((await request.put("/api/kitchen", { data: { revision: document.revision, state } })).ok()).toBeTruthy();
});

test("home opens tonight's plan, brand returns home, and all five destinations remain reachable", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Weekly plan", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Today’s dinner", exact: true })).toContainText("Tomato Rice");
  await page.reload();
  await expect(page.getByRole("region", { name: "Today’s dinner", exact: true })).toContainText("Tomato Rice");
  expect(errors).toEqual([]);
  await expect(page.getByRole("button", { name: "Cook this dinner", exact: true })).toBeInViewport();
  for (const name of ["Chef", "Recipes", "Shopping", "Pantry", "Plan"]) {
    await navigate(page, name);
    await expect(page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await navigate(page, "Chef");
  const brand = page.getByRole("button", { name: /RAG Chef/ }).first();
  if (await brand.isVisible()) await brand.click();
  else await navigate(page, "Plan");
  await expect(page.getByRole("heading", { name: "Weekly plan", exact: true })).toBeVisible();
});

for (const width of [320, 390, 768, 1440]) for (const theme of ["light", "dark"]) {
  test(`redesign review at ${width}px in ${theme}`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "Explicit viewport matrix runs once.");
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
    await page.addInitScript(value => localStorage.setItem("rag-chef-theme", value), theme);
    await page.goto("/");
    await expect(page.locator(".save-indicator")).toHaveText("Saved");
    for (const name of ["Plan", "Chef", "Recipes", "Shopping", "Pantry", "Settings"]) {
      await navigate(page, name);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name).toBe(true);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: info.outputPath(`${name.toLowerCase()}-${width}-${theme}.png`), fullPage: true, animations: "disabled" });
    }
    await navigate(page, "Plan");
    await page.getByRole("button", { name: "Cook this dinner", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`cooking-${width}-${theme}.png`), animations: "disabled" });
  });
}

test("keyboard navigation and enlarged content keep controls visible", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await page.evaluate(() => { document.body.style.zoom = "2"; });
  await navigate(page, "Settings");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Tab");
  const active = page.locator(":focus");
  await expect(active).toBeVisible();
  await expect(active).toBeInViewport();
});
