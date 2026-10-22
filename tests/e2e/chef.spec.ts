import { test, expect, type Page } from "@playwright/test";

const modelURL = process.env.RAG_CHEF_TEST_MODEL_URL;
if (!modelURL || new URL(modelURL).hostname !== "127.0.0.1") throw new Error("Use the disposable model stub through pnpm test:e2e.");
async function control(values: { mode?: string; unavailable?: boolean; resetCalls?: boolean; release?: boolean }) {
  const response = await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
  expect(response.ok).toBeTruthy();
  return response.json();
}
async function ask(page: Page, query: string) {
  await page.goto("/");
  await page.getByRole("button", { name: /Recipes/ }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Ask Chef", exact: true }).click();
  await page.getByRole("textbox", { name: "Ask your chef", exact: true }).fill(query);
  const result = page.waitForResponse((response) => response.url().endsWith("/api/chef") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Find my dinner" }).click();
  const response = await result;
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test.beforeEach(async () => { await control({ resetCalls: true }); });
test.afterEach(async () => { await control({ resetCalls: true, release: true }); });

test("Chef evidence quotes approved source records and keeps ingredient quantities intact", async ({ page, request }) => {
  const before = await (await request.get("/api/recipes/catalog")).json();
  const answer = await ask(page, "Tomato Rice");
  expect(answer.generation).toBe("ai");
  expect(answer.sourceFacts).toHaveLength(1);
  expect(answer.sourceFacts[0]).toMatchObject({ recipeId: "fixture-tomato-rice", evidenceId: "I1" });
  expect(answer.sourceFacts[0].fact).toContain("rice");
  expect(answer.sourceFacts[0].fact).toContain("200 g");
  await page.getByRole("button", { name: "View Tomato Rice", exact: true }).click();
  await expect(page.locator(".source-facts")).toContainText(answer.sourceFacts[0].fact);
  await expect(page.getByRole("dialog")).toContainText("Simmer the rice and tomatoes for 10 minutes.");
  expect(await (await request.get("/api/recipes/catalog")).json()).toEqual(before);
});

test("unrelated requests abstain without invoking model generation", async ({ page }) => {
  const answer = await ask(page, "quantum teleportation spacecraft schematics");
  expect(answer.recommendations).toEqual([]);
  expect(answer.recipes).toEqual([]);
  const status = await (await fetch(`${modelURL}/__test/control`)).json() as { calls: Array<{ path: string }> };
  expect(status.calls.filter((call: { path: string }) => call.path === "/api/chat")).toHaveLength(0);
  await expect(page.locator(".chef-answer")).toBeVisible();
  await expect(page.locator(".recipe-card")).toHaveCount(0);
});

test("invalid evidence IDs produce a labeled fallback rather than invented facts", async ({ page }) => {
  await control({ mode: "invalid_evidence", resetCalls: true });
  const answer = await ask(page, "Tomato Rice");
  expect(answer.generation).toBe("catalog_fallback");
  expect(answer.sourceFacts).toEqual([]);
  expect(answer.recommendations[0].recipeId).toBe("fixture-tomato-rice");
  await expect(page.locator(".chef-answer")).toContainText(/catalog|suggestions|unavailable/i);
});

test("provider failure preserves relevant recipe suggestions without changing saved kitchen", async ({ page, request }) => {
  const before = await (await request.get("/api/kitchen")).json();
  await control({ unavailable: true, resetCalls: true });
  const answer = await ask(page, "Tomato Rice");
  expect(answer.generation).toBe("catalog_fallback");
  expect(answer.recommendations[0].recipeId).toBe("fixture-tomato-rice");
  await expect(page.getByRole("button", { name: "View Tomato Rice", exact: true })).toBeVisible();
  expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
});

test("a pending Chef request can be canceled without displaying its late answer", async ({ page }) => {
  await control({ mode: "hold" });
  await page.goto("/");
  await page.getByRole("button", { name: /Recipes/ }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Ask Chef", exact: true }).click();
  await page.getByRole("textbox", { name: "Ask your chef", exact: true }).fill("Tomato Rice");
  await page.getByRole("button", { name: "Find my dinner" }).click();
  await expect.poll(async () => (await (await fetch(`${modelURL}/__test/control`)).json() as { pending: number }).pending).toBe(1);
  const aborted = page.waitForEvent("requestfailed", (request) => request.url().endsWith("/api/chef"));
  await page.getByRole("button", { name: "Cancel request", exact: true }).click();
  await aborted;
  await control({ release: true });
  await expect(page.getByRole("button", { name: "Find my dinner" })).toBeEnabled();
  await expect(page.locator(".chef-answer")).toHaveCount(0);
});

test("a new pantry context and request replace an older pending Chef result", async ({ page }) => {
  await control({ mode: "hold" });
  await page.goto("/");
  await page.getByRole("button", { name: /Recipes/ }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Ask Chef", exact: true }).click();
  await page.getByRole("textbox", { name: "Ask your chef", exact: true }).fill("Tomato Rice");
  await page.getByRole("button", { name: "Find my dinner" }).click();
  await expect.poll(async () => (await (await fetch(`${modelURL}/__test/control`)).json() as { pending: number }).pending).toBe(1);
  await page.getByRole("button", { name: /Pantry/ }).filter({ visible: true }).first().click();
  await page.getByRole("textbox", { name: "New pantry ingredient", exact: true }).fill("beans");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  await page.getByRole("button", { name: /Recipes/ }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Ask Chef", exact: true }).click();
  await page.getByRole("textbox", { name: "Ask your chef", exact: true }).fill("Garlic Beans");
  const response = page.waitForResponse((response) => response.url().endsWith("/api/chef") && response.request().postDataJSON()?.query === "Garlic Beans");
  await page.getByRole("button", { name: "Find my dinner" }).click();
  await control({ release: true });
  expect((await (await response).json()).recommendations[0].recipeId).toBe("fixture-vegan-beans");
  await expect(page.getByRole("button", { name: "View Garlic Beans", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "View Tomato Rice", exact: true })).toHaveCount(0);
});

test("expired and depleted same-name pantry rows never enter the Chef request or model prompt", async ({ page, request }) => {
  await page.clock.install({ time: new Date("2026-10-22T12:00:00+03:00") });
  const current = await (await request.get("/api/kitchen")).json();
  const pantry = [{ id: "expired-rice", name: "rice", measure: "500 g", useBy: "2026-10-21" }, { id: "available-rice", name: "rice", measure: "100 g", useBy: "2026-10-23" }, { id: "depleted-rice", name: "rice", measure: "0 g" }];
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state: { schemaVersion: 2, pantry, meals: {}, shoppingChecked: {}, migratedLegacy: false } } })).ok()).toBeTruthy();
  const outgoing = page.waitForRequest((request) => request.url().endsWith("/api/chef") && request.method() === "POST");
  const answer = await ask(page, "Tomato Rice");
  expect(answer.generation).toBe("ai");
  expect((await outgoing).postDataJSON().pantry).toEqual([{ name: "rice", quantity: "100 g" }]);
  const status = await (await fetch(`${modelURL}/__test/control`)).json() as { calls: Array<{ path: string; body: { messages?: Array<{ role: string; content: string }> } }> };
  const chat = status.calls.find((call) => call.path === "/api/chat");
  expect(chat).toBeTruthy();
  const prompt = chat!.body.messages!.find((message) => message.role === "user")!.content;
  expect(JSON.parse(prompt.slice(prompt.lastIndexOf("\n\n") + 2)).pantry).toEqual([{ name: "rice", quantity: "100 g" }]);
  expect((await (await request.get("/api/kitchen")).json()).state.pantry).toEqual(pantry);
});
