import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { KitchenState } from "../../app/lib/kitchen-types";

test.skip(process.env.RAG_CHEF_LAN_TEST !== "1", "LAN checks require the disposable private-interface runner.");

const TODAY = "2026-11-04";
const modelURL = process.env.RAG_CHEF_TEST_MODEL_URL;
async function modelStatus(reset = false) {
  if (!modelURL || new URL(modelURL).hostname !== "127.0.0.1") throw new Error("Use the disposable server-side model stub.");
  const response = await fetch(`${modelURL}/__test/control`, reset ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resetCalls: true, release: true }) } : undefined);
  expect(response.ok).toBeTruthy();
  return response.json() as Promise<{ calls: Array<{ path: string; body: { model?: string; format?: { properties?: Record<string, unknown> } } }> }>;
}
async function kitchen(request: APIRequestContext) { return (await request.get("/api/kitchen")).json(); }
async function navigate(page: Page, name: string) { await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click(); }

test.beforeEach(async ({ page, request }) => {
  await modelStatus(true);
  await page.clock.install({ time: new Date(`${TODAY}T12:00:00+02:00`) });
  const current = await kitchen(request);
  const state: KitchenState = { schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true };
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state } })).ok()).toBeTruthy();
});
test.afterEach(async () => { await modelStatus(true); });

test("private HTTP devices save pantry and dinners, ask grounded cooking questions, and use the host model", async ({ page, request, baseURL }, info) => {
  test.setTimeout(60_000);
  const pageErrors: string[] = [], browserModelCalls: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", outgoing => {
    const url = new URL(outgoing.url());
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && ["/api/chat", "/api/tags", "/api/embed", "/v1/models", "/v1/chat/completions"].includes(url.pathname)) browserModelCalls.push(outgoing.url());
  });
  await page.goto("/");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  const capabilities = await page.evaluate(() => ({ secure: window.isSecureContext, randomUUID: typeof crypto.randomUUID, subtle: typeof crypto.subtle, randomValues: typeof crypto.getRandomValues, origin: location.origin }));
  expect(capabilities).toMatchObject({ secure: false, randomUUID: "undefined", subtle: "undefined", randomValues: "function", origin: baseURL });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator(".provider-card").filter({ hasText: "Ollama" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "Model", exact: true })).toHaveValue("test-model");
  const sharing = page.getByRole("region", { name: "Use your kitchen on other devices", exact: true });
  await expect(sharing.getByRole("textbox", { name: "Kitchen address", exact: true })).toHaveValue(baseURL!);
  await sharing.screenshot({ path: info.outputPath("lan-phone-address.png") });

  await navigate(page, "Pantry");
  await page.getByRole("textbox", { name: "New pantry ingredient", exact: true }).fill("rice: 500 g");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  await page.getByRole("dialog", { name: "Review pantry ingredients", exact: true }).getByRole("button", { name: "Confirm ingredients", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Available rice", exact: true })).toHaveValue("500 g");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  const withRice = await kitchen(request);
  expect(withRice.state.pantry).toHaveLength(1);
  expect(withRice.state.pantry[0]).toMatchObject({ name: "rice", measure: "500 g" });
  expect(withRice.state.pantry[0].id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);

  await navigate(page, "Recipes");
  await page.getByRole("button", { name: "Ask Chef", exact: true }).click();
  await page.getByRole("textbox", { name: "Dinner request", exact: true }).fill("Tomato Rice");
  const discovery = page.waitForResponse(response => response.url().endsWith("/api/chef") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Find my dinner", exact: true }).click();
  expect((await discovery).ok()).toBeTruthy();
  await page.getByRole("button", { name: "Choose for tonight: Tomato Rice", exact: true }).click();
  await expect.poll(async () => (await kitchen(request)).state.meals[TODAY]?.recipeId).toBe("fixture-tomato-rice");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await navigate(page, "Plan");
  await page.getByRole("button", { name: /Cook (?:this )?dinner/, exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.locator(".cook-help > summary").click();
  await cooking.getByRole("textbox", { name: "Question about this step", exact: true }).fill("What does this step say?");
  const cookingReply = page.waitForResponse(response => response.url().endsWith("/api/chef") && response.request().method() === "POST");
  await cooking.getByRole("button", { name: "Ask Chef about step", exact: true }).click();
  const reply = await cookingReply, cookingRequest = reply.request().postDataJSON();
  expect(reply.ok()).toBeTruthy();
  expect(cookingRequest.context).toMatchObject({ recipeId: "fixture-tomato-rice", mealDate: TODAY, purpose: "cooking" });
  expect(cookingRequest.context.recipeHash).toMatch(/^[\da-f]{64}$/);
  expect(cookingRequest.context.mealHash).toMatch(/^[\da-f]{64}$/);
  expect((await reply.json()).answerStatus).toBe("answered");
  await expect(cooking.locator(".step-chef-reply")).toBeVisible();
  await cooking.locator(".step-chef-reply").scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("lan-cooking-phone.png") });
  await cooking.getByRole("button", { name: "← Exit cooking", exact: true }).click();

  const beforePreview = await kitchen(request);
  await page.getByRole("button", { name: "Kitchen assistant", exact: true }).click();
  const assistant = page.getByRole("dialog", { name: "Kitchen assistant", exact: true });
  await assistant.getByRole("textbox", { name: "Your request", exact: true }).fill("Add 2 onions");
  const assistantReply = page.waitForResponse(response => response.url().endsWith("/api/assistant") && response.request().method() === "POST");
  await assistant.getByRole("button", { name: "Ask Chef", exact: true }).click();
  const prepared = await assistantReply;
  expect(prepared.ok()).toBeTruthy();
  expect(prepared.request().postDataJSON()).toMatchObject({ query: "Add 2 onions", provider: "ollama", model: "test-model" });
  expect(prepared.request().postDataJSON().ai).toBeUndefined();
  const draft = (await prepared.json()).draft;
  expect(draft.pantryChanges[0].after).toMatchObject({ name: "onions", measure: "2" });
  await expect(assistant.getByRole("button", { name: "Apply changes", exact: true })).toBeEnabled();
  expect(await kitchen(request)).toEqual(beforePreview);
  await assistant.getByRole("region", { name: "Proposed kitchen changes", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("lan-assistant-phone.png") });
  await assistant.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(assistant.getByText("Reviewed changes saved to your kitchen.", { exact: true })).toBeVisible();
  const applied = await kitchen(request);
  expect(applied.revision).toBe(beforePreview.revision + 1);
  expect(applied.state.pantry.find((item: { name: string }) => item.name === "onions")).toMatchObject({ measure: "2" });

  const status = await modelStatus();
  expect(status.calls.some(call => call.path === "/api/chat" && call.body.model === "test-model" && call.body.format?.properties?.pantry)).toBe(true);
  expect(status.calls.some(call => call.path === "/api/chat" && call.body.format?.properties?.sourceFacts)).toBe(true);
  expect(browserModelCalls).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
