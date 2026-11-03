import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { ChefPlanDraft } from "../../app/lib/chef-plan-types";

const today = "2026-10-22";
const readKitchen = async (request: APIRequestContext) => (await request.get("/api/kitchen")).json();
async function openPlanner(page: Page) {
  await page.goto("/");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await page.getByRole("button", { name: "Plan with Chef", exact: true }).click();
  return page.getByRole("dialog", { name: "Plan dinners with Chef" });
}

test.beforeEach(async ({ page, request }) => {
  await page.clock.install({ time: new Date(`${today}T12:00:00+03:00`) });
  const current = await readKitchen(request);
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state: {
    schemaVersion: 2, pantry: [{ id: "rice", name: "rice", measure: "500 g" }], meals: {}, shoppingChecked: {}, migratedLegacy: true,
  } } })).ok()).toBeTruthy();
});

test("cancelled interpretation cannot replace a later manual preview or write kitchen data", async ({ page, request }) => {
  let first = true, entered = false;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/chef/plan", async route => {
    if (!first) { await route.continue(); return; }
    first = false; entered = true;
    await pending;
    await route.fulfill({ status: 503, json: { error: { message: "Old cancelled interpretation" } } }).catch(() => undefined);
  });
  const dialog = await openPlanner(page);
  const before = await readKitchen(request);
  await dialog.getByLabel("Planning request", { exact: true }).fill("Plan three dinners");
  await dialog.getByRole("button", { name: "Ask Chef to plan", exact: true }).click();
  await expect.poll(() => entered).toBeTruthy();
  await dialog.getByRole("button", { name: "Cancel request", exact: true }).click();
  await dialog.getByLabel("Number of dinners", { exact: true }).fill("1");
  await dialog.getByRole("button", { name: "Preview plan", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply plan", exact: true })).toBeEnabled();
  release();
  await expect(dialog.getByText("Old cancelled interpretation", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("article", { name: /^Proposed dinner/ })).toHaveCount(1);
  expect(await readKitchen(request)).toEqual(before);
});

test("stale apply preserves another tab's pantry update and requires a fresh review", async ({ page, request }) => {
  const dialog = await openPlanner(page);
  await dialog.getByLabel("Number of dinners", { exact: true }).fill("1");
  await dialog.getByLabel("Excluded ingredients", { exact: true }).fill("peanut");
  await dialog.getByRole("button", { name: "Preview plan", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply plan", exact: true })).toBeEnabled();
  const current = await readKitchen(request);
  const saved = await request.put("/api/kitchen", { data: { revision: current.revision, state: { ...current.state, pantry: [...current.state.pantry, { id: "other-tab", name: "onions", measure: "2" }] } } });
  expect(saved.ok()).toBeTruthy();
  const newer = await saved.json();
  await dialog.getByRole("button", { name: "Apply plan", exact: true }).click();
  await expect(dialog.getByText(/This draft needs a fresh preview/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Apply plan", exact: true })).toBeDisabled();
  expect(await readKitchen(request)).toEqual(newer);
  await dialog.getByLabel("Planning request", { exact: true }).fill("Plan two dinners");
  await expect(dialog.getByRole("button", { name: "Revise with Chef", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Preview plan", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply plan", exact: true })).toBeEnabled();
  await expect(dialog.getByLabel("Excluded ingredients", { exact: true })).toHaveValue("peanut");
  await expect(dialog.getByRole("button", { name: "Revise with Chef", exact: true })).toBeEnabled();
  expect(await readKitchen(request)).toEqual(newer);
});

test("an in-flight apply stays open, submits once and refreshes a newer saved kitchen", async ({ page, request }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let applies = 0, committed = false;
  await page.route("**/api/chef/plan/apply", async route => {
    applies++;
    const response = await route.fetch();
    committed = response.ok();
    await pending;
    await route.fulfill({ response });
  });
  const dialog = await openPlanner(page);
  await dialog.getByLabel("Number of dinners", { exact: true }).fill("1");
  await dialog.getByRole("button", { name: "Preview plan", exact: true }).click();
  const apply = dialog.getByRole("button", { name: "Apply plan", exact: true });
  await expect(apply).toBeEnabled();
  await apply.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect.poll(() => committed).toBeTruthy();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close planning workspace", exact: true })).toBeDisabled();
  const current = await readKitchen(request);
  expect(Object.keys(current.state.meals)).toHaveLength(1);
  const saved = await request.put("/api/kitchen", { data: { revision: current.revision, state: { ...current.state, pantry: [...current.state.pantry, { id: "late-tab", name: "onions", measure: "2" }] } } });
  expect(saved.ok()).toBeTruthy();
  const newer = await saved.json();
  release();
  await expect(dialog.getByText("Plan saved. Your weekly shopping list is ready.", { exact: true })).toBeVisible();
  expect(applies).toBe(1);
  expect(await readKitchen(request)).toEqual(newer);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
});

test("closing and reopening retains an unapplied draft in the current tab", async ({ page, request }) => {
  const dialog = await openPlanner(page);
  await dialog.getByLabel("Number of dinners", { exact: true }).fill("1");
  await dialog.getByRole("button", { name: "Preview plan", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply plan", exact: true })).toBeEnabled();
  const before = await readKitchen(request);
  await dialog.getByRole("button", { name: "Close planning workspace", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Plan with Chef", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply plan", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("article", { name: /^Proposed dinner/ })).toHaveCount(1);
  expect(await readKitchen(request)).toEqual(before);
});

test("manual recipe replacement stays selected when portions are reviewed again", async ({ page, request }) => {
  const dialog = await openPlanner(page);
  await dialog.getByLabel("Number of dinners", { exact: true }).fill("1");
  await dialog.getByRole("button", { name: "Preview plan", exact: true }).click();
  const apply = dialog.getByRole("button", { name: "Apply plan", exact: true });
  await expect(apply).toBeEnabled();
  const card = dialog.getByRole("article", { name: `Proposed dinner ${today}`, exact: true });
  const first = await card.getByRole("heading").textContent();
  await card.getByRole("button", { name: `Replace proposed dinner ${today}`, exact: true }).click();
  await expect(apply).toBeEnabled();
  await expect(card.getByRole("heading")).not.toHaveText(first!);
  const replacement = await card.getByRole("heading").textContent();
  await dialog.getByLabel("Plan servings", { exact: true }).fill("3");
  await expect(apply).toBeDisabled();
  await dialog.getByRole("button", { name: "Preview plan", exact: true }).click();
  await expect(apply).toBeEnabled();
  await expect(card.getByRole("heading")).toHaveText(replacement!);
  expect(Object.keys((await readKitchen(request)).state.meals)).toHaveLength(0);
});

test("manual requirements must be previewed before a conversational request can use them", async ({ page, request }) => {
  const dialog = await openPlanner(page);
  const before = await readKitchen(request);
  await dialog.getByLabel("Number of dinners", { exact: true }).fill("1");
  await dialog.getByLabel("Excluded ingredients", { exact: true }).fill("peanut");
  await dialog.getByLabel("Plan servings", { exact: true }).fill("4");
  await dialog.getByLabel("Planning request", { exact: true }).fill("Plan two dinners");
  await expect(dialog.getByRole("button", { name: "Ask Chef to plan", exact: true })).toBeDisabled();
  await expect(dialog.getByText("Your controls changed. Preview them before asking Chef to revise or applying.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Preview plan", exact: true }).click();
  const revise = dialog.getByRole("button", { name: "Revise with Chef", exact: true });
  await expect(revise).toBeEnabled();
  const response = page.waitForResponse(response => response.url().endsWith("/api/chef/plan"));
  await revise.click();
  const draft = (await (await response).json()).draft as ChefPlanDraft;
  expect(draft.intent.count).toBe(2);
  expect(draft.intent.excludedIngredients).toContain("peanut");
  expect(draft.intent.servings).toBe(4);
  expect(draft.changes).toHaveLength(2);
  await expect(dialog.getByRole("button", { name: "Apply plan", exact: true })).toBeEnabled();
  expect(await readKitchen(request)).toEqual(before);
});

test("clarifying a revision keeps the earlier dinner identities and requirements", async ({ page, request }) => {
  const dialog = await openPlanner(page);
  const before = await readKitchen(request);
  await dialog.getByLabel("Number of dinners", { exact: true }).fill("2");
  await dialog.getByLabel("Excluded ingredients", { exact: true }).fill("peanut");
  await dialog.getByLabel("Plan servings", { exact: true }).fill("4");
  const firstResponse = page.waitForResponse(response => response.url().endsWith("/api/chef/plan"));
  await dialog.getByRole("button", { name: "Preview plan", exact: true }).click();
  const original = (await (await firstResponse).json()).draft as ChefPlanDraft;
  const apply = dialog.getByRole("button", { name: "Apply plan", exact: true });
  await expect(apply).toBeEnabled();
  await dialog.getByLabel("Planning request", { exact: true }).fill("Replace it");
  await dialog.getByRole("button", { name: "Revise with Chef", exact: true }).click();
  await expect(dialog.getByText("Which dinner date do you want to change or keep?", { exact: true })).toBeVisible();
  await expect(apply).toBeDisabled();
  await dialog.getByLabel("Planning request", { exact: true }).fill("Keep Thursday and replace Friday");
  const nextResponse = page.waitForResponse(response => response.url().endsWith("/api/chef/plan"));
  await dialog.getByRole("button", { name: "Revise with Chef", exact: true }).click();
  const revised = (await (await nextResponse).json()).draft as ChefPlanDraft;
  expect(revised.intent.excludedIngredients).toContain("peanut");
  expect(revised.intent.servings).toBe(4);
  expect(revised.changes).toHaveLength(2);
  expect(revised.changes.find(change => change.date === today)?.meal).toEqual(original.changes.find(change => change.date === today)?.meal);
  expect(revised.changes.find(change => change.date === "2026-10-23")?.meal.recipeId).not.toBe(original.changes.find(change => change.date === "2026-10-23")?.meal.recipeId);
  await expect(apply).toBeEnabled();
  expect(await readKitchen(request)).toEqual(before);
});
