import { revealPantryAdd, revealPantryEditors } from "./ui-controls";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { KitchenState } from "../../app/lib/kitchen-types";

test.skip(process.env.RAG_CHEF_SECURE_LAN_TEST !== "1", "Requires the disposable HTTPS kitchen.");
test.use({ serviceWorkers: "allow" });
const password = process.env.RAG_CHEF_TEST_LAN_PASSWORD!;
let apiSession = "";
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });
async function kitchen(request: APIRequestContext) {
  const response = await request.get("/api/kitchen");
  expect(response.status()).toBe(200);
  return response.json();
}
async function apiLogin(request: APIRequestContext, origin: string, remember = false) {
  const response = await request.post("/api/local-auth/sign-in", { headers: { origin }, data: { username: "chef", password, remember } });
  expect(response.status()).toBe(200);
  apiSession = (await response.json()).localAccess.sessionId;
  return response;
}
async function signIn(page: Page, remember = false, recover = false) {
  await expect(page.getByRole("textbox", { name: "Username", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Username", exact: true }).fill("chef");
  await page.getByLabel("Password", { exact: true }).fill(password);
  if (remember) await page.getByRole("checkbox", { name: "Remember this device for 30 days", exact: true }).check();
  await page.getByRole("button", { name: "Open kitchen", exact: true }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  if (!recover) await expect(page.locator(".save-indicator")).toHaveText("Saved");
}
async function navigate(page: Page, name: string) {
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click();
}

test.beforeEach(async ({ request, baseURL }) => {
  await apiLogin(request, baseURL!);
  const current = await kitchen(request);
  expect((await request.put("/api/kitchen", { headers: { origin: baseURL!, "X-Rag-Chef-Session": apiSession }, data: { revision: current.revision, state: empty() } })).status()).toBe(200);
});

test("anonymous users see the login, while private routes never issue browser challenges", async ({ page, playwright, baseURL }, info) => {
  const anonymous = await playwright.request.newContext({ baseURL, ignoreHTTPSErrors: true });
  try {
    const shell = await page.goto("/");
    expect(shell?.status()).toBe(200);
    expect(shell?.headers()["cache-control"]).toContain("no-store");
    const html = await shell!.text();
    expect(html).not.toContain("aiDefaults");
    expect(html).not.toContain("test-model");
    await expect(page.getByRole("textbox", { name: "Username", exact: true })).toBeVisible();
    await expect(page.locator(".app-shell")).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "Remember this device for 30 days", exact: true })).not.toBeChecked();
    await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("autocomplete", "current-password");
    expect(await (await anonymous.get("/api/session")).json()).toMatchObject({ mode: "local", authenticated: false });
    for (const [path, method] of [["/.rsc?_rsc", "GET"], ["/api/kitchen", "GET"], ["/api/recipes/catalog", "GET"], ["/api/chef", "POST"], ["/api/assistant", "POST"], ["/api/admin/catalog/demo", "POST"], ["/unmatched-app-path", "GET"]]) {
      const response = await anonymous.fetch(path, { method, headers: { origin: baseURL!, ...(path.includes("_rsc") ? { RSC: "1" } : {}) } });
      expect(response.status(), path).toBe(401);
      expect(response.headers()["www-authenticate"], path).toBeUndefined();
      expect(response.headers()["cache-control"], path).toContain("no-store");
      const denied = await response.json();
      expect(denied).not.toHaveProperty("state"); expect(denied).not.toHaveProperty("recipes");
    }
    await page.screenshot({ path: info.outputPath("local-login.png"), fullPage: true });
  } finally { await anonymous.dispose(); }
});

test("visible login supports errors, password visibility, keyboard submission and reload", async ({ page, context, baseURL }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Username", exact: true }).fill("chef");
  await page.getByLabel("Password", { exact: true }).fill("incorrect-test-password");
  await page.getByRole("button", { name: "Show password", exact: true }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Hide password", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Password", { exact: true }).press("Enter");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await expect(page.getByRole("region", { name: "Today’s dinner", exact: true })).toBeVisible();
  const session = await (await context.request.get("/api/session")).json();
  expect(session.localAccess.remembered).toBe(false);
  const remaining = Date.parse(session.localAccess.expiresAt) - Date.now();
  expect(remaining).toBeGreaterThan(11.9 * 3600_000); expect(remaining).toBeLessThanOrEqual(12 * 3600_000);
  const cookie = (await context.cookies(baseURL!)).find(item => item.name.startsWith("__Host-"));
  expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: "Strict", path: "/", expires: -1 });
  await page.reload();
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await expect(page.getByRole("textbox", { name: "Username", exact: true })).toHaveCount(0);
});

test("remembering this device lasts thirty days and logout revokes it across tabs and Back", async ({ page, context, baseURL }) => {
  await page.goto("/"); await signIn(page, true);
  const session = await (await context.request.get("/api/session")).json();
  expect(session.localAccess.remembered).toBe(true);
  const remaining = Date.parse(session.localAccess.expiresAt) - Date.now();
  expect(remaining).toBeGreaterThan(29.9 * 86400_000); expect(remaining).toBeLessThanOrEqual(30 * 86400_000);
  const cookie = (await context.cookies(baseURL!)).find(item => item.name.startsWith("__Host-"))!;
  expect(cookie.expires).toBeGreaterThan(Date.now() / 1000 + 29.9 * 86400);
  const sibling = await context.newPage(); await sibling.goto("/");
  await expect(sibling.locator(".save-indicator")).toHaveText("Saved");
  await navigate(page, "Pantry"); await navigate(page, "Recipes");
  await revealPantryEditors(page);
  await page.getByLabel("Kitchen menu", { exact: true }).click();
  await page.getByRole("button", { name: "Sign out of this device", exact: true }).filter({ visible: true }).first().click();
  await expect(page.getByRole("textbox", { name: "Username", exact: true })).toBeVisible();
  await expect(sibling.getByRole("textbox", { name: "Username", exact: true })).toBeVisible();
  expect((await context.request.get("/api/kitchen")).status()).toBe(401);
  const replay = await context.request.get("/api/kitchen", { headers: { cookie: `${cookie.name}=${cookie.value}` } });
  expect(replay.status()).toBe(401);
  // Back's protected RSC request falls back to a full login-page navigation.
  // Let it finish before testing a separate user-triggered reload.
  const backLoaded = page.waitForEvent("load");
  await page.goBack();
  await expect(page.locator(".app-shell")).toHaveCount(0);
  await backLoaded;
  await expect(page.getByRole("textbox", { name: "Username", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Username", exact: true })).toBeVisible();
});

test("session loss hides the kitchen, and reauthentication recovers an unsaved draft", async ({ page, context }) => {
  await page.goto("/"); await signIn(page);
  await navigate(page, "Pantry");
  await revealPantryEditors(page);
  await page.route("**/api/kitchen", async route => route.request().method() === "PUT" ? route.abort("connectionfailed") : route.continue());
  await revealPantryAdd(page);
  await page.getByRole("textbox", { name: "New pantry ingredient", exact: true }).fill("rice: 500 g");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  await page.getByRole("dialog", { name: "Review pantry ingredients", exact: true }).getByRole("button", { name: "Confirm ingredients", exact: true }).click();
  await revealPantryEditors(page);
  await expect(page.getByRole("textbox", { name: "Available rice", exact: true })).toBeVisible();
  await context.clearCookies();
  await page.evaluate(() => window.dispatchEvent(new Event("rag-chef-session-check")));
  await expect(page.locator(".app-shell")).toHaveCount(0);
  await page.unroute("**/api/kitchen");
  await signIn(page, false, true);
  // Recovery may require an explicit conflict decision; it must not lose the draft.
  const useDraft = page.getByRole("button", { name: "Save this draft", exact: true });
  if (await useDraft.isVisible()) await useDraft.click();
  await navigate(page, "Pantry");
  await revealPantryEditors(page);
  await expect(page.getByRole("textbox", { name: "Available rice", exact: true })).toHaveValue("500 g");
});

test("friendly HTTPS phone login saves to the shared kitchen without offline shell caching", async ({ page, context, request, baseURL }, info) => {
  const friendlyURL = process.env.RAG_CHEF_TEST_FRIENDLY_URL!;
  const pageErrors: string[] = [], shellRequests: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", outgoing => { if (["/kitchen-sw.js", "/kitchen-shell.json"].includes(new URL(outgoing.url()).pathname)) shellRequests.push(outgoing.url()); });
  const response = await page.goto(friendlyURL);
  expect(response?.headers()["x-frame-options"]).toBe("DENY");
  await signIn(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const sharing = page.getByRole("region", { name: "Use your kitchen on other devices", exact: true });
  expect(await sharing.getByRole("textbox", { name: "Kitchen address", exact: true }).evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))).toContain(friendlyURL);
  await navigate(page, "Pantry");
  await revealPantryEditors(page);
  await revealPantryAdd(page);
  await page.getByRole("textbox", { name: "New pantry ingredient", exact: true }).fill("rice: 500 g");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  await page.getByRole("dialog", { name: "Review pantry ingredients", exact: true }).getByRole("button", { name: "Confirm ingredients", exact: true }).click();
  await expect.poll(async () => (await kitchen(request)).state.pantry.length).toBe(1);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  const after = await kitchen(request);
  const rejectedOrigins: Record<string, string>[] = [{}, { origin: "https://untrusted.example" }, { origin: "null" }, { origin: baseURL!, "sec-fetch-site": "cross-site" }];
  for (const headers of rejectedOrigins) {
    const denied = await request.put("/api/kitchen", { headers, data: { revision: after.revision, state: empty() } });
    expect(denied.status()).toBe(403);
  }
  expect(await kitchen(request)).toEqual(after);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  expect(await page.evaluate(async () => (await caches.keys()).filter(key => key.startsWith("rag-chef-shell-")))).toEqual([]);
  expect(shellRequests).toEqual([]); expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("secure-phone-pantry.png"), fullPage: true });
  // A cookie for the friendly name must not authenticate the IP fallback.
  expect((await context.request.get(`${baseURL}/api/kitchen`)).status()).toBe(401);
});
