import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { DEFAULT_COOKING_PROFILE, type KitchenState, type PlannedMeal } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";

const TODAY = "2026-10-25";
const key = "rag-chef-kitchen-v2:draft:reviewable";
async function read(request: APIRequestContext) { return (await request.get("/api/kitchen")).json(); }
async function installDraft(page: Page, state: KitchenState, revision: number) {
  await page.evaluate(({ key, state, revision }) => {
    localStorage.setItem(key, JSON.stringify({ revision, state, dirty: true, updatedAt: "2026-10-25T09:00:00.000Z", reason: "edit" }));
    window.dispatchEvent(new Event("storage"));
  }, { key, state, revision });
}
async function openReview(page: Page) {
  const panel = page.locator(".recovery-panel");
  if (await panel.getAttribute("open") === null) await panel.locator(":scope > summary").click();
  await panel.getByRole("button", { name: "Review this draft", exact: true }).first().click();
  return page.getByRole("dialog", { name: "Review browser draft", exact: true });
}
async function fixture(page: Page, request: APIRequestContext) {
  await page.clock.install({ time: new Date(`${TODAY}T12:00:00+02:00`) });
  const catalog = await (await request.get("/api/recipes/catalog")).json();
  const recipe = catalog.recipes.find((recipe: Recipe) => recipe.id === "fixture-tomato-rice") as Recipe;
  const meal: PlannedMeal = { id: "dinner", date: TODAY, recipeId: recipe.id, recipe, title: recipe.title, baseServings: 2, servings: 2, batches: 1, ingredientOverrides: {}, locked: false, status: "planned" };
  const current = await read(request);
  const state: KitchenState = { schemaVersion: 2, migratedLegacy: true, pantry: [{ id: "rice", name: "rice", measure: "100 g", useBy: "2026-10-26" }, { id: "tomato", name: "tomato", measure: "2" }], meals: { [TODAY]: meal }, shoppingChecked: {}, cookingProfile: structuredClone(DEFAULT_COOKING_PROFILE) };
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state } })).ok()).toBe(true);
  await page.goto("/"); await expect(page.locator(".save-indicator")).toHaveText("Saved");
  const saved = await read(request);
  const draft: KitchenState = { ...saved.state, pantry: [{ id: "rice", name: "rice", measure: "350 g", useBy: "2026-10-29" }, { id: "beans", name: "beans", measure: "400 g" }], meals: { [TODAY]: { ...meal, servings: 4 } }, cookingProfile: { ...DEFAULT_COOKING_PROFILE, allergies: ["peanut"] } };
  return { saved, draft };
}

test("recovery shows actual amounts, dates, dinners and preferences before any write", async ({ page, request }, info) => {
  const { saved, draft } = await fixture(page, request);
  await installDraft(page, draft, saved.revision);
  const originalDraft = await page.evaluate(key => localStorage.getItem(key), key);
  const writes: string[] = [];
  page.on("request", request => { if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/kitchen") writes.push(request.url()); });
  const dialog = await openReview(page);
  const rice = dialog.locator(".kitchen-change-row").filter({ has: page.getByText("rice", { exact: true }) });
  await expect(rice).toContainText("100 g"); await expect(rice).toContainText("350 g");
  await expect(rice).toContainText("2026-10-26"); await expect(rice).toContainText("2026-10-29");
  await expect(dialog.getByRole("region", { name: "Changes to dinners", exact: true })).toContainText("2 servings");
  await expect(dialog.getByRole("region", { name: "Changes to dinners", exact: true })).toContainText("4 servings");
  await expect(dialog.getByRole("region", { name: "Changes to cooking preferences", exact: true })).toContainText("peanut");
  await page.screenshot({ path: info.outputPath("draft-recovery.png"), animations: "disabled" });
  expect(writes).toEqual([]);
  expect(await read(request)).toEqual(saved);
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(originalDraft);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await read(request)).toEqual(saved);
  await openReview(page);
  await dialog.getByRole("button", { name: "Recover this draft", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.pantry).toEqual(draft.pantry);
  expect((await read(request)).state.meals[TODAY].servings).toBe(4);
  expect((await read(request)).state.cookingProfile.allergies).toEqual(["peanut"]);
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(originalDraft);
});

test("a changed browser draft requires a fresh comparison before recovery", async ({ page, request }) => {
  const { saved, draft } = await fixture(page, request);
  await installDraft(page, draft, saved.revision);
  const dialog = await openReview(page);
  const changed = { ...draft, pantry: [{ ...draft.pantry[0], measure: "700 g" }] };
  await installDraft(page, changed, saved.revision);
  await dialog.getByRole("button", { name: "Recover this draft", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(/changed/);
  await expect(dialog.getByRole("button", { name: "Recover this draft", exact: true })).toBeDisabled();
  expect(await read(request)).toEqual(saved);
  expect(await page.evaluate(() => Object.values(localStorage).some(value => { try { return JSON.parse(value).reason === "before-recovery"; } catch { return false; } }))).toBe(false);
  await dialog.getByRole("button", { name: "Review latest changes", exact: true }).click();
  await expect(dialog).toContainText("700 g");
  await dialog.getByRole("button", { name: "Recover this draft", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.pantry).toEqual(changed.pantry);
});

test("long draft comparisons keep recovery actions visible on a narrow screen", async ({ page, request }, info) => {
  const { saved, draft } = await fixture(page, request);
  if (info.project.name === "mobile") {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.getByRole("button", { name: "Dark mode", exact: true }).click();
  }
  draft.pantry = Array.from({ length: 40 }, (_, index) => ({ id: `stock-${index}`, name: `ingredient ${index + 1}`, measure: "200 g" }));
  await installDraft(page, draft, saved.revision);
  const dialog = await openReview(page);
  await expect(dialog.getByRole("button", { name: "Close draft review", exact: true })).toBeFocused();
  expect(await dialog.locator(".recovery-review-body").evaluate(element => element.scrollTop)).toBe(0);
  await dialog.locator(".more-kitchen-changes > summary").click();
  await dialog.locator(".kitchen-change-row").last().scrollIntoViewIfNeeded();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Recover this draft", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("long-draft-recovery.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Review this draft", exact: true }).first()).toBeFocused();
  expect(await read(request)).toEqual(saved);
});

test("local save conflicts compare the saved kitchen with the browser draft", async ({ page, request }) => {
  const { saved, draft } = await fixture(page, request);
  await page.evaluate(({ state, revision }) => localStorage.setItem("rag-chef-kitchen-v2", JSON.stringify({ state, revision, dirty: true })), { state: draft, revision: saved.revision - 1 });
  await page.reload();
  const review = page.locator(".local-conflict-review");
  await expect(review).toContainText("Saved kitchen");
  await expect(review).toContainText("This browser draft");
  await expect(review).toContainText("100 g");
  await expect(review).toContainText("350 g");
  await expect(review).toContainText("peanut");
  expect(await read(request)).toEqual(saved);
  await review.getByRole("button", { name: "Load saved version", exact: true }).click();
  await expect(review).not.toBeVisible();
  expect(await read(request)).toEqual(saved);
});

test("short screens keep draft differences and stale-review actions reachable", async ({ page, request }, info) => {
  const { saved, draft } = await fixture(page, request);
  const size = info.project.name === "mobile" ? { width: 320, height: 480 } : { width: 844, height: 390 };
  await page.setViewportSize(size);
  await installDraft(page, draft, saved.revision);
  const dialog = await openReview(page);
  const amount = dialog.locator(".kitchen-change-row dd").first();
  await amount.scrollIntoViewIfNeeded();
  await expect(amount).toBeInViewport({ ratio: 1 });
  await installDraft(page, { ...draft, pantry: [{ ...draft.pantry[0], measure: "700 g" }] }, saved.revision);
  await dialog.getByRole("button", { name: "Recover this draft", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(/changed/);
  await expect(dialog.getByRole("button", { name: "Review latest changes", exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath("short-screen-recovery-error.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "Review latest changes", exact: true }).click();
  await expect(dialog).toContainText("700 g");
  await amount.scrollIntoViewIfNeeded();
  await expect(amount).toBeInViewport({ ratio: 1 });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await read(request)).toEqual(saved);
});
