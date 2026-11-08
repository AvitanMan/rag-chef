import { revealPantryAdd, revealPantryEditors, revealPlanControls } from "./ui-controls";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { KitchenState } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";

test.skip(process.env.RAG_CHEF_SECURE_LAN_TEST !== "1", "Requires the disposable HTTPS kitchen.");
const password = process.env.RAG_CHEF_TEST_LAN_PASSWORD!;
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });

async function savedKitchen(request: APIRequestContext) {
  const response = await request.get("/api/kitchen"); expect(response.ok()).toBe(true); return response.json();
}
async function signIn(page: Page) {
  await page.getByRole("textbox", { name: "Username", exact: true }).fill("chef");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Open kitchen", exact: true }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
}
async function pantry(page: Page) {
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: /^Pantry/ }).filter({ visible: true }).first().click();
  await revealPantryEditors(page);
}
async function addRice(page: Page) {
  await pantry(page);
  await revealPantryAdd(page);
  await page.getByRole("textbox", { name: "New pantry ingredient", exact: true }).fill("rice: 500 g");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  await page.getByRole("dialog", { name: "Review pantry ingredients", exact: true }).getByRole("button", { name: "Confirm ingredients", exact: true }).click();
  await revealPantryEditors(page);
  await expect(page.getByRole("textbox", { name: "Available rice", exact: true })).toHaveValue("500 g");
}
async function requestSignOut(page: Page) {
  const action = page.getByRole("button", { name: "Sign out of this device", exact: true }).filter({ visible: true }).first();
  if (!await action.isVisible()) await page.getByLabel("Kitchen menu", { exact: true }).click();
  await action.click();
  return page.getByRole("dialog", { name: "Sign out of this device", exact: true });
}

async function startTomatoRice(page: Page, request: APIRequestContext, baseURL: string) {
  const catalog = await (await request.get("/api/recipes/catalog")).json();
  const recipe = catalog.recipes.find((value: Recipe) => value.id === "fixture-tomato-rice") as Recipe;
  expect(recipe).toBeTruthy();
  const date = "2026-10-25";
  await page.clock.install({ time: new Date(`${date}T12:00:00+02:00`) });
  const session = await (await request.get("/api/session")).json();
  const current = await savedKitchen(request);
  const planned = { ...empty(), meals: { [date]: { id: `meal-${date}`, date, recipeId: recipe.id, recipe, title: recipe.title, baseServings: recipe.servings ?? null, servings: recipe.servings ?? null, batches: 1, locked: false, status: "planned", ingredientOverrides: {} } } };
  const response = await request.put("/api/kitchen", { headers: { origin: baseURL, "X-Rag-Chef-Session": session.localAccess.sessionId }, data: { revision: current.revision, state: planned } });
  expect(response.status()).toBe(200);
  await page.goto("/"); await signIn(page);
  await revealPlanControls(page);
  await page.getByRole("button", { name: /^Cook Tomato Rice / }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await expect(cooking).toContainText("Rinse the rice.");
  return cooking;
}

test.beforeEach(async ({ request, baseURL }) => {
  const login = await request.post("/api/local-auth/sign-in", { headers: { origin: baseURL! }, data: { username: "chef", password, remember: false } });
  expect(login.status()).toBe(200);
  const sessionId = (await login.json()).localAccess.sessionId;
  const current = await savedKitchen(request);
  const reset = await request.put("/api/kitchen", { headers: { origin: baseURL!, "X-Rag-Chef-Session": sessionId }, data: { revision: current.revision, state: empty() } });
  expect(reset.status()).toBe(200);
});

test("dirty logout offers keep working and saves reviewed changes before signing out", async ({ page, context, request }) => {
  await page.goto("/"); await signIn(page);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await page.route("**/api/kitchen", route => route.request().method() === "PUT" ? route.abort("connectionfailed") : route.continue());
  await addRice(page);
  const dialog = await requestSignOut(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep working", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await revealPantryEditors(page);
  await expect(page.getByRole("textbox", { name: "Available rice", exact: true })).toHaveValue("500 g");
  await requestSignOut(page);
  await page.unroute("**/api/kitchen");
  await dialog.getByRole("button", { name: "Save and sign out", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Username", exact: true })).toBeVisible();
  expect((await context.request.get("/api/kitchen")).status()).toBe(401);
  expect((await savedKitchen(request)).state.pantry).toMatchObject([{ name: "rice", measure: "500 g" }]);
});

test("failed logout stays signed in and explicit discard removes only the browser draft", async ({ page, context, request }) => {
  await page.goto("/"); await signIn(page);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await page.route("**/api/kitchen", route => route.request().method() === "PUT" ? route.abort("connectionfailed") : route.continue());
  await addRice(page);
  await page.route("**/api/local-auth/sign-out", route => route.abort("connectionfailed"));
  const dialog = await requestSignOut(page);
  await dialog.getByRole("button", { name: "Discard and sign out", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect((await (await context.request.get("/api/session")).json()).authenticated).toBe(true);
  await expect(page.locator(".app-shell")).toBeVisible();
  await page.unroute("**/api/local-auth/sign-out");
  await dialog.getByRole("button", { name: "Discard and sign out", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Username", exact: true })).toBeVisible();
  expect((await savedKitchen(request)).state.pantry).toEqual([]);
  await page.unroute("**/api/kitchen"); await signIn(page);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await pantry(page);
  await expect(page.locator('[data-pantry-name="rice"]')).toHaveCount(0);
});

test("expiry preserves a dirty draft in memory when browser writes are blocked", async ({ page, context, request }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = function () { throw new DOMException("Storage is unavailable", "QuotaExceededError"); };
  });
  await page.goto("/"); await signIn(page);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await page.route("**/api/kitchen", route => route.request().method() === "PUT" ? route.abort("connectionfailed") : route.continue());
  await addRice(page);
  await context.clearCookies();
  await page.evaluate(() => window.dispatchEvent(new Event("rag-chef-session-check")));
  await expect(page.locator(".app-shell")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Keep this tab open");
  await page.unroute("**/api/kitchen"); await signIn(page);
  await expect(page.getByRole("button", { name: "Save this draft", exact: true })).toBeVisible();
  expect((await savedKitchen(request)).state.pantry).toEqual([]);
  await page.getByRole("button", { name: "Save this draft", exact: true }).click();
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await pantry(page);
  await revealPantryEditors(page);
  await expect(page.getByRole("textbox", { name: "Available rice", exact: true })).toHaveValue("500 g");
  expect((await savedKitchen(request)).state.pantry).toMatchObject([{ name: "rice", measure: "500 g" }]);
});

test("requests from an earlier login cannot edit a newly signed-in session", async ({ page, context, baseURL, request }) => {
  await page.goto("/"); await signIn(page);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  const earlier = await (await context.request.get("/api/session")).json();
  await pantry(page);
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: /^Recipes/ }).filter({ visible: true }).first().click();
  await page.getByLabel("Kitchen menu", { exact: true }).click();
  await page.getByRole("button", { name: "Sign out of this device", exact: true }).filter({ visible: true }).first().click();
  await expect(page.getByRole("textbox", { name: "Username", exact: true })).toBeVisible();
  await signIn(page); await expect(page.locator(".save-indicator")).toHaveText("Saved");
  const current = await savedKitchen(request);
  const response = await context.request.put("/api/kitchen", { headers: { origin: baseURL!, "X-Rag-Chef-Session": earlier.localAccess.sessionId }, data: { revision: current.revision, state: { ...empty(), pantry: [{ id: "late", name: "rice", measure: "500 g" }] } } });
  expect(response.status()).toBe(403); expect((await response.json()).error.code).toBe("SESSION_SCOPE_CHANGED");
  expect((await savedKitchen(request)).state.pantry).toEqual([]);
  await page.goBack();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator('[data-pantry-name="rice"]')).toHaveCount(0);
});

test("blocked browser writes keep successive cooking edits in memory without a false tab conflict", async ({ page, context, request, baseURL }) => {
  const cooking = await startTomatoRice(page, request, baseURL!);
  await page.evaluate(() => { Storage.prototype.setItem = function () { throw new DOMException("Storage is unavailable", "QuotaExceededError"); }; });
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await expect(cooking).toContainText("Simmer the rice and tomatoes for 10 minutes.");
  await cooking.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(cooking).toContainText("Rinse the rice.");
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await expect(cooking).toContainText("Simmer the rice and tomatoes for 10 minutes.");
  await cooking.getByRole("button", { name: "Start 10 min from this step", exact: true }).click();
  await expect(cooking.getByRole("button", { name: "Pause timer", exact: true })).toBeVisible();
  await expect(page.getByText("Another tab saved different cooking progress.", { exact: false })).toHaveCount(0);
  await context.clearCookies();
  await page.evaluate(() => window.dispatchEvent(new Event("rag-chef-session-check")));
  await expect(page.locator(".app-shell")).toHaveCount(0);
  await signIn(page);
  await page.getByRole("button", { name: /Resume cooking/ }).click();
  await expect(cooking).toContainText("Simmer the rice and tomatoes for 10 minutes.");
  await expect(cooking.getByRole("button", { name: "Pause timer", exact: true })).toBeVisible();
});

test("recovered browser writes require a choice before replacing another tab's cooking progress", async ({ page, context, request, baseURL }) => {
  const cooking = await startTomatoRice(page, request, baseURL!);
  const other = await context.newPage();
  await other.clock.install({ time: new Date("2026-10-25T12:00:00+02:00") });
  await other.goto("/");
  await other.getByRole("button", { name: /Resume cooking/ }).click();
  const otherCooking = other.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Object.defineProperty(window, "restoreBrowserWrites", { value: () => { Storage.prototype.setItem = original; } });
    Storage.prototype.setItem = function () { throw new DOMException("Storage is unavailable", "QuotaExceededError"); };
  });
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await expect(cooking).toContainText("Simmer the rice and tomatoes for 10 minutes.");
  await otherCooking.getByRole("button", { name: "Set timer", exact: true }).click();
  await otherCooking.getByRole("button", { name: "Start 1 min timer", exact: true }).click();
  await expect(otherCooking.getByRole("button", { name: "Pause timer", exact: true })).toBeVisible();
  const saved = await other.evaluate(() => localStorage.getItem("rag-chef-secure-local:rag-chef-cooking-v1"));
  expect(saved).toBeTruthy();
  await page.evaluate(() => (window as unknown as { restoreBrowserWrites: () => void }).restoreBrowserWrites());
  await cooking.getByRole("button", { name: "Previous", exact: true }).click();
  const conflict = page.getByRole("dialog", { name: "Cooking progress changed", exact: true });
  await expect(conflict).toBeVisible();
  expect(await other.evaluate(() => localStorage.getItem("rag-chef-secure-local:rag-chef-cooking-v1"))).toBe(saved);
  await conflict.getByRole("button", { name: "Use saved session", exact: true }).click();
  await expect(conflict).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(cooking).toContainText("Rinse the rice.");
  await expect(cooking.getByRole("button", { name: "Pause timer", exact: true })).toBeVisible();
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await expect(conflict).toHaveCount(0);
  await expect(cooking).toContainText("Simmer the rice and tomatoes for 10 minutes.");
  const resumed = await page.evaluate(() => JSON.parse(localStorage.getItem("rag-chef-secure-local:rag-chef-cooking-v1")!));
  expect(resumed.step).toBe(1);
  expect(resumed.timer.status).toBe("running");
  await other.close();
});
