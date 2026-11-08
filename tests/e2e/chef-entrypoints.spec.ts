import { test, expect, type Page } from "@playwright/test";

async function navigate(page: Page, name: string) {
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name, exact: true }).filter({ visible: true }).first().click();
}

test("Chef entry points distinguish dinner ideas, weekly plans, and kitchen updates", async ({ page, request }, info) => {
  await page.clock.install({ time: new Date("2026-10-22T12:00:00+03:00") });
  const current = await (await request.get("/api/kitchen")).json();
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state: { schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true } } })).ok()).toBe(true);
  const previews: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && ["/api/chef", "/api/chef/plan", "/api/assistant"].includes(path)) previews.push(path);
  });
  await page.goto("/");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  const before = await (await request.get("/api/kitchen")).json();

  await navigate(page, "Chef");
  await expect(page.getByRole("heading", { name: "Dinner ideas", level: 1, exact: true })).toBeVisible();
  await expect(page.getByText("Find one dinner or ask about a recipe.", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Dinner request", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Find my dinner", exact: true })).toBeVisible();
  await navigate(page, "Recipes");
  await page.getByRole("button", { name: "Find dinner ideas", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dinner ideas", level: 1, exact: true })).toBeVisible();

  await navigate(page, "Plan");
  await page.getByRole("button", { name: "Plan with Chef", exact: true }).click();
  const planner = page.getByRole("dialog", { name: "Plan dinners with Chef", exact: true });
  await expect(planner).toContainText("Plan several dinners and review their combined shopping list.");
  await planner.getByRole("textbox", { name: "Planning request", exact: true }).fill("Plan three dinners for two people.");
  await expect(planner.getByRole("button", { name: "Preview dinner plan", exact: true })).toBeEnabled();
  await expect(planner.getByRole("button", { name: "Apply plan", exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath("dinner-planning.png"), animations: "disabled" });
  await planner.getByRole("button", { name: "Close planning workspace", exact: true }).click();

  await page.getByRole("button", { name: "Kitchen assistant", exact: true }).click();
  const assistant = page.getByRole("dialog", { name: "Kitchen assistant", exact: true });
  await expect(assistant.getByRole("heading", { name: "Update your kitchen", exact: true })).toBeVisible();
  await assistant.getByRole("textbox", { name: "Kitchen update", exact: true }).fill("We bought 500 g rice.");
  await expect(assistant.getByRole("button", { name: "Preview kitchen changes", exact: true })).toBeEnabled();
  await assistant.getByRole("button", { name: "Enter updates manually", exact: true }).click();
  await expect(assistant.getByRole("group", { name: "Choose kitchen updates", exact: true })).toBeVisible();
  await assistant.getByRole("button", { name: "Add pantry action", exact: true }).click();
  await assistant.getByLabel("Ingredient", { exact: true }).fill("rice");
  await assistant.getByLabel("Amount", { exact: true }).fill("500 g");
  await expect(assistant.getByRole("button", { name: "Apply changes", exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath("kitchen-assistant.png"), animations: "disabled" });
  await assistant.getByRole("button", { name: "Close kitchen assistant", exact: true }).click();

  expect(previews).toEqual([]);
  expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
  await page.setViewportSize({ width: 320, height: 844 });
  const assistantButton = page.getByRole("button", { name: "Kitchen assistant", exact: true });
  await assistantButton.scrollIntoViewIfNeeded();
  await expect(assistantButton).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
