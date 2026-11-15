import { test, expect, type Page } from "@playwright/test";
import { DEFAULT_COOKING_PROFILE, type KitchenState, type PlannedMeal } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";
import { isKitchenWrite } from "../e2e/kitchen-requests";

const TODAY = "2026-10-22";

async function waitForOfflineShell(page: Page) {
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller))).toBe(true);
  // Wait for the app's own cache writes, without populating or mocking them.
  await expect.poll(() => page.evaluate(async () => {
    const manifest = await (await fetch("/kitchen-shell.json")).json() as { urls: string[] };
    const urls = ["/", ...manifest.urls];
    if (urls.length < 2) return false;
    return (await Promise.all(urls.map(url => caches.match(url)))).every(Boolean);
  })).toBe(true);
}

async function navigate(page: Page, name: string) {
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click();
}

test.beforeEach(async ({ page, request }) => {
  await page.clock.install({ time: new Date(`${TODAY}T12:00:00+03:00`) });
  const catalog = await (await request.get("/api/recipes/catalog")).json();
  const recipe: Recipe = catalog.recipes.find((item: Recipe) => item.id === "fixture-tomato-rice");
  expect(recipe).toBeTruthy();
  const meal: PlannedMeal = { id: "smoke-dinner", date: TODAY, recipeId: recipe.id, recipe, title: recipe.title,
    baseServings: 2, servings: 2, batches: 1, ingredientOverrides: {}, locked: false, status: "planned" };
  const state: KitchenState = { schemaVersion: 2, cookingProfile: structuredClone(DEFAULT_COOKING_PROFILE), pantry: [],
    meals: { [TODAY]: meal }, shoppingChecked: {}, migratedLegacy: true };
  const current = await (await request.get("/api/kitchen")).json();
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state } })).ok()).toBeTruthy();
});

test("saved dinner and timer survive a real offline shell reload", async ({ page, context, request }, testInfo) => {
  let chefCalls = 0;
  page.on("request", outgoing => { if (new URL(outgoing.url()).pathname === "/api/chef") chefCalls++; });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Chosen dinner", exact: true })).toContainText("Tomato Rice");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  const before = await (await request.get("/api/kitchen")).json();
  await waitForOfflineShell(page);
  await page.getByRole("button", { name: "Cook dinner", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.getByRole("button", { name: "Set timer", exact: true }).click();
  await cooking.getByRole("spinbutton", { name: "Minutes", exact: true }).fill("0");
  await cooking.getByRole("spinbutton", { name: "Seconds", exact: true }).fill("20");
  await cooking.getByRole("button", { name: "Start custom timer", exact: true }).click();
  await waitForOfflineShell(page);
  await context.setOffline(true);
  // The API is deliberately not cached; this verifies actual network loss.
  expect(await page.evaluate(async () => { try { await fetch("/api/kitchen"); return false; } catch { return true; } })).toBe(true);
  await page.clock.fastForward(5000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".save-indicator")).toHaveText("Offline", { timeout: 15_000 });
  await expect(page.getByRole("region", { name: "Chosen dinner", exact: true })).toContainText("Tomato Rice");
  await page.getByRole("button", { name: "Resume cooking", exact: true }).click();
  await expect(cooking).toBeVisible();
  const timer = cooking.getByRole("timer", { name: "Time remaining", exact: true });
  await expect(timer).not.toHaveText("00:20");
  await page.clock.fastForward(20_000);
  await expect(timer).toHaveText("00:00");
  await expect(cooking.getByRole("status")).toContainText(/timer finished/i);
  await page.screenshot({ path: testInfo.outputPath("offline-cooking.png") });
  await context.setOffline(false);
  await cooking.getByRole("button", { name: "Exit cooking", exact: false }).click();
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  expect((await (await request.get("/api/kitchen")).json()).state).toEqual(before.state);
  expect(chefCalls).toBe(0);
});

test("shopping copy fallback and print layout work without changing kitchen data", async ({ page, request }, testInfo) => {
  // Only OS handoffs are replaced; the real app builds and displays the list.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Clipboard permission unavailable"); } } });
    window.print = () => { document.documentElement.dataset.printRequested = "true"; };
  });
  await page.goto("/");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await navigate(page, "Shopping");
  const before = await (await request.get("/api/kitchen")).json();
  await page.getByRole("button", { name: "Copy shopping list", exact: true }).click();
  const fallback = page.getByRole("textbox", { name: "Shopping list text", exact: true });
  await expect(fallback).toBeFocused();
  await expect(fallback).toHaveValue(/rice: 200 g/);
  await expect(fallback).toHaveValue(/tomato: 2/);
  await page.getByRole("button", { name: "Print", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-print-requested", "true");
  await page.emulateMedia({ media: "print" });
  const printable = page.getByRole("region", { name: "Printable shopping list", exact: true });
  await expect(printable).toBeVisible();
  await expect(printable).toContainText("rice: 200 g");
  await expect(page.locator(".app-shell")).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("shopping-print.png") });
  await page.emulateMedia({ media: "screen" });
  await expect(printable).toBeHidden();
  expect((await (await request.get("/api/kitchen")).json()).state).toEqual(before.state);
});


test("native Pantry Details keeps keyboard boundaries and returns from confirmed usage and Undo", async ({ page, request }, testInfo) => {
  const current = await (await request.get("/api/kitchen")).json();
  const rice = { id: "smoke-pantry-rice", name: "rice", measure: "500 g", useBy: "2026-10-24", location: "cupboard" };
  const state = { ...current.state, pantry: [rice] };
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state } })).ok()).toBeTruthy();
  await page.goto("/");
  await navigate(page, "Pantry");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  const before = await (await request.get("/api/kitchen")).json();
  const writes: string[] = [];
  page.on("request", outgoing => { if (isKitchenWrite(outgoing)) writes.push(outgoing.postData() ?? outgoing.url()); });
  const trigger = page.getByRole("button", { name: "Details for rice", exact: true });
  await trigger.click();
  const panel = page.getByRole("dialog", { name: "Details for rice", exact: true });
  const batch = panel.getByRole("region", { name: "Batch 1: rice", exact: true });
  await expect(panel.getByRole("heading", { name: "rice", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(panel.getByRole("button", { name: "Manage batches", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(batch.getByRole("button", { name: "Move", exact: true })).toBeFocused();
  await batch.getByRole("button", { name: "Use some", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit batch rice", exact: true });
  await editor.getByLabel("Amount used from this batch", { exact: true }).fill("100 g");
  await expect(editor.locator(".pantry-batch-preview")).toContainText("Amount on hand: 400 g");
  await page.clock.runFor(700);
  expect(writes).toEqual([]);
  expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
  await editor.getByRole("button", { name: "Subtract usage", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(batch.getByRole("heading", { name: "Batch 1: rice", exact: true })).toBeFocused();
  await expect.poll(async () => (await (await request.get("/api/kitchen")).json()).state.pantry).toEqual([{ ...rice, measure: "400 g" }]);
  const undo = panel.getByRole("button", { name: "Undo last batch edit", exact: true });
  await undo.focus();
  await undo.press("Enter");
  await expect.poll(async () => (await (await request.get("/api/kitchen")).json()).state).toEqual(before.state);
  await expect(batch.getByRole("heading", { name: "Batch 1: rice", exact: true })).toBeFocused();
  await expect(undo).toHaveCount(0);
  await expect(batch).toContainText("500 g");
  await page.screenshot({ path: testInfo.outputPath("native-pantry-details.png") });
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(trigger).toBeFocused();
  expect(writes).toHaveLength(2);
});
