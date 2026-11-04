import { test, expect, type APIRequestContext } from "@playwright/test";
import type { KitchenState } from "../../app/lib/kitchen-types";

test.skip(process.env.RAG_CHEF_SECURE_LAN_TEST !== "1", "Secure LAN checks require the disposable TLS runner.");
// Prove the app disables offline shell caching itself, rather than relying on
// the browser test configuration to block registration.
test.use({ serviceWorkers: "allow" });

async function kitchen(request: APIRequestContext) { return (await request.get("/api/kitchen")).json(); }

test("password challenges protect the app shell, RSC, kitchen, Chef, admin and auth paths", async ({ playwright, baseURL }) => {
  // New API contexts inherit Playwright's configured credentials unless
  // explicitly replaced. An empty list prevents a silent authenticated retry.
  const anonymous = await playwright.request.newContext({ baseURL, ignoreHTTPSErrors: true, httpCredentials: [] });
  const wrong = await playwright.request.newContext({ baseURL, ignoreHTTPSErrors: true, httpCredentials: { username: "chef", password: "incorrect-test-password", send: "always" } });
  try {
    for (const [path, method] of [["/", "GET"], ["/.rsc?_rsc", "GET"], ["/api/session", "GET"], ["/api/kitchen", "GET"], ["/api/recipes/catalog", "GET"], ["/api/chef", "POST"], ["/api/assistant", "POST"], ["/api/admin/catalog/demo", "POST"], ["/api/auth/sign-in/social", "POST"], ["/unmatched-app-path", "GET"]]) {
      const response = await anonymous.fetch(path, { method, headers: path.includes("_rsc") ? { RSC: "1" } : undefined });
      expect(response.status(), path).toBe(401);
      expect(response.headers()["www-authenticate"], path).toBe('Basic realm="RAG Chef", charset="UTF-8"');
      expect(response.headers()["cache-control"], path).toContain("no-store");
      const denied = await response.json();
      expect(denied.error.code, path).toBe("LAN_SIGN_IN_REQUIRED");
      expect(denied).not.toHaveProperty("state"); expect(denied).not.toHaveProperty("localServer"); expect(denied).not.toHaveProperty("recipes");
    }
    const wrongResponse = await wrong.get("/api/kitchen");
    expect(wrongResponse.status()).toBe(401);
    expect((await wrongResponse.json()).error.code).toBe("LAN_SIGN_IN_REQUIRED");
  } finally { await anonymous.dispose(); await wrong.dispose(); }
});

test("the friendly HTTPS kitchen saves from a phone and keeps protected pages out of offline caches", async ({ page, context, request, baseURL }, info) => {
  test.setTimeout(60_000);
  const friendlyURL = process.env.RAG_CHEF_TEST_FRIENDLY_URL;
  if (!friendlyURL || new URL(friendlyURL).hostname !== "ragchef.local" || new URL(friendlyURL).protocol !== "https:") throw new Error("Use the disposable secure LAN runner and its friendly hostname.");
  const current = await kitchen(request);
  const state: KitchenState = { schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true };
  const saved = await request.put("/api/kitchen", { headers: { origin: baseURL! }, data: { revision: current.revision, state } });
  expect(saved.ok()).toBeTruthy();

  const shellRequests: string[] = [], serviceWorkers: string[] = [], browserModelRequests: string[] = [], pageErrors: string[] = [];
  context.on("serviceworker", worker => serviceWorkers.push(worker.url()));
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", outgoing => {
    const url = new URL(outgoing.url());
    if (["/kitchen-sw.js", "/kitchen-shell.json"].includes(url.pathname)) shellRequests.push(outgoing.url());
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && ["/api/chat", "/api/tags", "/api/embed", "/v1/models", "/v1/chat/completions"].includes(url.pathname)) browserModelRequests.push(outgoing.url());
  });
  const navigation = await page.goto(friendlyURL);
  expect(navigation?.ok()).toBeTruthy();
  expect(navigation?.headers()["cache-control"]).toContain("no-store");
  expect(navigation?.headers()["x-frame-options"]).toBe("DENY");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  expect(await page.evaluate(() => ({ secure: window.isSecureContext, origin: location.origin, subtle: typeof crypto.subtle, uuid: typeof crypto.randomUUID }))).toEqual({ secure: true, origin: friendlyURL, subtle: "object", uuid: "function" });
  const session = await page.evaluate(async () => (await fetch("/api/session")).json()) as { mode: string; localServer: { requiresPassword: boolean; origins: string[] } };
  expect(session.mode).toBe("local");
  expect(session.localServer.requiresPassword).toBe(true);
  expect(session.localServer.origins).toContain(friendlyURL);
  expect(session.localServer.origins).toContain(baseURL);
  expect(session.localServer).not.toHaveProperty("password");
  expect(session.localServer).not.toHaveProperty("passwordHash");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const sharing = page.getByRole("region", { name: "Use your kitchen on other devices", exact: true });
  expect(await sharing.getByRole("textbox", { name: "Kitchen address", exact: true }).evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))).toContain(friendlyURL);
  await expect(sharing).toContainText("username and password");
  await expect(sharing).toContainText("offline pages are disabled");
  await sharing.screenshot({ path: info.outputPath("secure-lan-phone-address.png") });

  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: /Pantry/ }).filter({ visible: true }).first().click();
  await page.getByRole("textbox", { name: "New pantry ingredient", exact: true }).fill("rice: 500 g");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  await page.getByRole("dialog", { name: "Review pantry ingredients", exact: true }).getByRole("button", { name: "Confirm ingredients", exact: true }).click();
  await expect.poll(async () => (await kitchen(request)).state.pantry.length).toBe(1);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  const afterAdd = await kitchen(request);
  expect(afterAdd.state.pantry[0]).toMatchObject({ name: "rice", measure: "500 g" });
  await page.screenshot({ path: info.outputPath("secure-lan-phone-pantry.png") });

  const rejectedOrigins: Record<string, string>[] = [{}, { origin: "https://untrusted.example" }, { origin: "null" }, { origin: baseURL!, "sec-fetch-site": "cross-site" }];
  for (const headers of rejectedOrigins) {
    const denied = await request.put("/api/kitchen", { headers, data: { revision: afterAdd.revision, state: { ...afterAdd.state, pantry: [] } } });
    expect(denied.status()).toBe(403);
    expect((await denied.json()).error.code).toBe("CROSS_ORIGIN_WRITE");
  }
  expect(await kitchen(request)).toEqual(afterAdd);
  const apiHeaders = (await request.get("/api/kitchen")).headers();
  expect(apiHeaders["cache-control"]).toContain("no-store");
  expect(apiHeaders.vary).toContain("Authorization");
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(registration => registration.scope))).toEqual([]);
  expect(shellRequests).toEqual([]); expect(serviceWorkers).toEqual([]); expect(browserModelRequests).toEqual([]); expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
