import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { Recipe } from "../../app/lib/recipe-types";
import type { KitchenState } from "../../app/lib/kitchen-types";

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
  return submitChef(page, query);
}
async function submitChef(page: Page, query: string) {
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
  const before = await (await request.get("/api/recipes/catalog")).json() as { recipes: Recipe[] };
  const answer = await ask(page, "Tomato Rice");
  expect(answer.generation).toBe("ai");
  expect(answer.sourceFacts).toHaveLength(1);
  expect(answer.sourceFacts[0]).toMatchObject({ recipeId: "fixture-tomato-rice", evidenceId: "I1" });
  expect(answer.sourceFacts[0].fact).toContain("rice");
  expect(answer.sourceFacts[0].fact).toContain("200 g");
  const status = await (await fetch(`${modelURL}/__test/control`)).json() as { calls: Array<{ path: string; body: { messages?: Array<{ role: string; content: string }> } }> };
  const prompt = status.calls.find((call) => call.path === "/api/chat")!.body.messages!.find((message) => message.role === "user")!.content;
  const record = JSON.parse(prompt.slice(prompt.lastIndexOf("\n\n") + 2)).retrievedRecipes[0];
  const source = before.recipes.find((recipe) => recipe.id === "fixture-tomato-rice")!;
  expect(Object.hasOwn(record, "ingredients")).toBe(false);
  expect(Object.hasOwn(record, "instructions")).toBe(false);
  expect(record.evidence).toEqual([
    ...source.ingredients.map((ingredient, index) => ({ evidenceId: `I${index + 1}`, text: [ingredient.measure, ingredient.name].filter(Boolean).join(" ") })),
    ...source.instructions.map((text, index) => ({ evidenceId: `S${index + 1}`, text })),
  ]);
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

test("a missing compound dish abstains instead of recommending a dish sharing only one ingredient", async ({ page, request }) => {
  const answer = await ask(page, "Beef Wellington");
  expect(answer.outcome).toBe("no_match");
  expect(answer.recipes).toEqual([]);
  expect(answer.recommendations).toEqual([]);
  await expect(page.locator(".chef-answer")).toContainText("could not find a relevant recipe");
  await expect(page.locator(".recipe-card")).toHaveCount(0);
  const status = await (await fetch(`${modelURL}/__test/control`)).json() as { calls: Array<{ path: string }> };
  expect(status.calls.filter((call) => call.path === "/api/chat")).toHaveLength(0);
  const search = await (await request.get("/api/recipes?q=Beef%20Wellington&pantry=beef,onion")).json();
  expect(search.outcome).toBe("no_match");
  expect(search.recipes).toEqual([]);
  const supported = await (await request.get("/api/recipes?q=beef%20dinner")).json();
  expect(supported.recipes.map((recipe: { title: string }) => recipe.title)).toEqual(["Beef Stew"]);
});

test("named searches and ingredient requests use the same concise shortlist in search and Chef", async ({ page, request }) => {
  for (const query of ["Cheese Pasta", "pasta with cheese"]) {
    const answer = await ask(page, query);
    expect(answer.recipes.map((recipe: { title: string }) => recipe.title)).toEqual(["Cheese Pasta"]);
    await expect(page.locator(".recipe-card")).toHaveCount(1);
    const found = await (await request.get(`/api/recipes?q=${encodeURIComponent(query)}`)).json();
    expect(found.recipes).toEqual(answer.recipes);
    const reason = query === "Cheese Pasta" ? "Matches the recipe you named." : "Matches your search words: pasta, cheese.";
    expect(answer.recommendations[0].matchReason).toBe(reason);
    expect(found.matchReasonsByRecipeId[answer.recipes[0].id]).toBe(reason);
    await expect(page.locator(".match-reason")).toHaveText(`Why this match: ${reason}`);
  }
});

test("invalid evidence IDs produce a labeled fallback rather than invented facts", async ({ page }) => {
  await control({ mode: "invalid_evidence", resetCalls: true });
  const answer = await ask(page, "Tomato Rice");
  expect(answer.generation).toBe("catalog_fallback");
  expect(answer.sourceFacts).toEqual([]);
  expect(answer.recommendations[0].recipeId).toBe("fixture-tomato-rice");
  expect(answer.recommendations[0].matchReason).toBe("Matches the recipe you named.");
  await expect(page.locator(".match-reason")).toHaveText("Why this match: Matches the recipe you named.");
  await expect(page.locator(".recommendation-details")).toContainText("Missing ingredient names:");
  await expect(page.locator(".chef-answer")).toContainText(/catalog|suggestions|unavailable/i);
});

test("provider failure preserves relevant recipe suggestions without changing saved kitchen", async ({ page, request }) => {
  const before = await (await request.get("/api/kitchen")).json();
  await control({ unavailable: true, resetCalls: true });
  const answer = await ask(page, "Tomato Rice");
  expect(answer.generation).toBe("catalog_fallback");
  expect(answer.recommendations[0].recipeId).toBe("fixture-tomato-rice");
  expect(answer.recommendations[0].matchReason).toBe("Matches the recipe you named.");
  await expect(page.locator(".match-reason")).toHaveText("Why this match: Matches the recipe you named.");
  await expect(page.getByRole("button", { name: "View Tomato Rice", exact: true })).toBeVisible();
  expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
});

test("request exclusions filter source recipes before Chef sees them and stay enforced during fallback", async ({ page, request }) => {
  const before = await (await request.get("/api/recipes/catalog")).json();
  for (const [query, forbidden] of [["Dinner but no pasta", ["Cheese Pasta", "Peanut Noodles"]], ["Rice without tomatoes", ["Tomato Rice", "Eggplant Stew"]]] as const) {
    const answer = await ask(page, query);
    expect(answer.recipes.length).toBeGreaterThan(0);
    for (const recipe of answer.recipes) expect(forbidden).not.toContain(recipe.title);
    const found = await (await request.get(`/api/recipes?q=${encodeURIComponent(query)}`)).json();
    expect(found.recipes.length).toBeGreaterThan(0);
    for (const recipe of found.recipes) expect(forbidden).not.toContain(recipe.title);
    const status = await (await fetch(`${modelURL}/__test/control`)).json() as { calls: Array<{ path: string; body: { messages?: Array<{ role: string; content: string }> } }> };
    const chats = status.calls.filter((call) => call.path === "/api/chat");
    const prompt = chats.at(-1)!.body.messages!.find((message) => message.role === "user")!.content;
    const context = JSON.parse(prompt.slice(prompt.lastIndexOf("\n\n") + 2));
    expect(context.adaptationRequested).toBe(false);
    for (const recipe of context.retrievedRecipes) expect(forbidden).not.toContain(recipe.title);
    await control({ unavailable: true });
    const fallback = await (await request.post("/api/chef", { data: { query, provider: "ollama" } })).json();
    expect(fallback.generation).toBe("catalog_fallback");
    expect(fallback.recipes.length).toBeGreaterThan(0);
    for (const recipe of fallback.recipes) expect(forbidden).not.toContain(recipe.title);
    await control({ resetCalls: true });
  }
  expect(await (await request.get("/api/recipes/catalog")).json()).toEqual(before);
});

test("named vegan adaptations remain separate from unchanged source and respect saved exclusions", async ({ page, request }) => {
  const before = await (await request.get("/api/recipes/catalog")).json();
  const original = before.recipes.find((recipe: { id: string }) => recipe.id === "fixture-cheese-pasta");
  const answer = await ask(page, "Make Cheese Pasta vegan");
  expect(answer.recipes).toEqual([original]);
  expect(answer.chefChanges).toHaveLength(1);
  await expect(page.locator(".chef-answer")).toContainText("original recipe is unchanged");
  await page.getByRole("button", { name: "View Cheese Pasta", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toContainText("plant-based cheese substitute");
  await expect(drawer).toContainText("Stir in the cheese.");
  await page.getByRole("button", { name: "Close recipe", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Diet", { exact: false }).selectOption("Vegan");
  const blocked = await ask(page, "Make Cheese Pasta vegan");
  expect(blocked.outcome).toBe("constraints_unsatisfied");
  expect(blocked.recipes).toEqual([]);
  await expect(page.getByRole("button", { name: "View Cheese Pasta", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add to plan: Cheese Pasta", exact: true })).toHaveCount(0);
  expect(await (await request.get("/api/recipes/catalog")).json()).toEqual(before);
});

test.describe("planning directly from Chef", () => {
  const date = "2026-10-23";
  const emptyKitchen = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: false });
  const readKitchen = async (request: APIRequestContext) => (await request.get("/api/kitchen")).json();
  async function saveKitchen(request: APIRequestContext, state: KitchenState) {
    const current = await readKitchen(request);
    const response = await request.put("/api/kitchen", { data: { revision: current.revision, state } });
    expect(response.ok()).toBeTruthy();
  }
  async function openSelection(page: Page, change = false) {
    await page.goto("/");
    await page.getByRole("button", { name: `${change ? "Change" : "Choose"} dinner Fri, Oct 23`, exact: true }).click();
    await page.getByRole("button", { name: "Ask Chef", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Choosing dinner for Friday, October 23." })).toBeVisible();
  }
  test.beforeEach(async ({ page, request }) => {
    await page.clock.install({ time: new Date("2026-10-22T12:00:00+03:00") });
    await saveKitchen(request, emptyKitchen());
  });

  for (const unavailable of [false, true]) {
    test(`a selected day stays visible and ${unavailable ? "fallback" : "Chef"} results add directly without opening a recipe`, async ({ page, request }) => {
      await control({ unavailable });
      await openSelection(page);
      await page.getByRole("button", { name: "← Back to Recipes", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Choosing dinner for Friday, October 23." })).toBeVisible();
      await page.getByRole("button", { name: "Ask Chef", exact: true }).click();
      const answer = await submitChef(page, "Tomato Rice");
      expect(answer.generation).toBe(unavailable ? "catalog_fallback" : "ai");
      await expect(page.getByRole("button", { name: "Plan the week", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Add to Friday: Tomato Rice", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Weekly plan", exact: true })).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect.poll(async () => Object.keys((await readKitchen(request)).state.meals)).toEqual([date]);
      const saved = (await readKitchen(request)).state as KitchenState;
      expect(saved.meals[date].recipe).toEqual(answer.recipes[0]);
      expect(saved.pantry).toEqual([]);
      expect(saved.shoppingChecked).toEqual({});
      await page.reload();
      await expect(page.locator(".day-card.filled")).toHaveCount(1);
      await expect(page.locator(".day-card.filled")).toContainText("Tomato Rice");
    });
  }

  test("without a selected day, Chef cards open the existing day picker", async ({ page, request }) => {
    await ask(page, "Tomato Rice");
    await page.getByRole("button", { name: "Add to plan: Tomato Rice", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Choose dinner day", exact: true });
    await expect(picker).toBeVisible();
    expect((await readKitchen(request)).state.meals).toEqual({});
    await picker.getByRole("combobox", { name: "Dinner date", exact: true }).selectOption(date);
    await picker.getByRole("button", { name: "Add dinner", exact: true }).click();
    await expect.poll(async () => (await readKitchen(request)).state.meals[date]?.recipeId).toBe("fixture-tomato-rice");
  });

  test("canceling a day selection cancels its pending Chef request and clears the target day", async ({ page, request }) => {
    await control({ mode: "hold" });
    await openSelection(page);
    await page.getByRole("textbox", { name: "Ask your chef", exact: true }).fill("Tomato Rice");
    await page.getByRole("button", { name: "Find my dinner", exact: true }).click();
    await expect.poll(async () => (await (await fetch(`${modelURL}/__test/control`)).json() as { pending: number }).pending).toBe(1);
    const aborted = page.waitForEvent("requestfailed", (request) => request.url().endsWith("/api/chef"));
    await page.getByRole("button", { name: "Cancel selection", exact: true }).click();
    await aborted;
    await control({ release: true });
    await expect(page.getByRole("heading", { name: "Weekly plan", exact: true })).toBeVisible();
    expect((await readKitchen(request)).state.meals).toEqual({});
    await page.getByRole("button", { name: /Recipes/ }).filter({ visible: true }).first().click();
    await page.getByRole("button", { name: "Ask Chef", exact: true }).click();
    await expect(page.getByRole("button", { name: "Cancel selection", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Add to plan:/ }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^Add to Friday:/ })).toHaveCount(0);
  });

  test("direct Chef replacement still requires confirmation and preserves other dinners", async ({ page, request }) => {
    const catalog = await (await request.get("/api/recipes/catalog")).json() as { recipes: Recipe[] };
    const original = catalog.recipes.find((recipe) => recipe.id === "fixture-tomato-rice")!;
    const kitchen = emptyKitchen();
    kitchen.meals[date] = { id: "saved-friday", date, recipeId: original.id, recipe: original, title: original.title, baseServings: 2, servings: 2, batches: 1, locked: false, status: "planned", ingredientOverrides: {} };
    kitchen.meals["2026-10-19"] = { ...kitchen.meals[date], id: "saved-monday", date: "2026-10-19", locked: true };
    await saveKitchen(request, kitchen);
    await openSelection(page, true);
    await submitChef(page, "Cheese Pasta");
    await page.getByRole("button", { name: "Add to Friday: Cheese Pasta", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Replace dinner", exact: true });
    await expect(confirmation).toBeVisible();
    expect((await readKitchen(request)).state).toEqual(kitchen);
    await confirmation.getByRole("button", { name: "Keep current dinner", exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await page.getByRole("button", { name: "Add to Friday: Cheese Pasta", exact: true }).click();
    await confirmation.getByRole("button", { name: "Replace dinner", exact: true }).click();
    await expect.poll(async () => (await readKitchen(request)).state.meals[date]?.recipeId).toBe("fixture-cheese-pasta");
    expect((await readKitchen(request)).state.meals["2026-10-19"]).toEqual(kitchen.meals["2026-10-19"]);
    expect(await (await request.get("/api/recipes/catalog")).json()).toEqual(catalog);
  });
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

test("a new day hides yesterday's Chef answer and excludes stock that has just passed its use-by date", async ({ page, request }) => {
  await page.clock.install({ time: new Date("2026-10-22T23:59:45+03:00") });
  const current = await (await request.get("/api/kitchen")).json();
  const state = { schemaVersion: 2, pantry: [{ id: "rice", name: "rice", measure: "200 g", useBy: "2026-10-22" }], meals: {}, shoppingChecked: {}, migratedLegacy: false };
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state } })).ok()).toBeTruthy();
  const answer = await ask(page, "Tomato Rice");
  expect(answer.recommendations[0].pantryMatch).toEqual(["rice"]);
  await expect(page.locator(".chef-answer")).toBeVisible();
  await page.clock.fastForward(31_000);
  await expect(page.locator(".chef-answer")).toHaveCount(0);
  const outgoing = page.waitForRequest((request) => request.url().endsWith("/api/chef") && request.method() === "POST");
  await page.getByRole("button", { name: "Find my dinner" }).click();
  expect((await outgoing).postDataJSON().pantry).toEqual([]);
  await expect(page.locator(".chef-answer")).toBeVisible();
  expect((await (await request.get("/api/kitchen")).json()).state.pantry).toEqual(state.pantry);
});

test("changing the pantry cancels a pending Chef request even without starting a replacement", async ({ page }) => {
  await control({ mode: "hold" });
  await page.goto("/");
  await page.getByRole("button", { name: /Recipes/ }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Ask Chef", exact: true }).click();
  await page.getByRole("textbox", { name: "Ask your chef", exact: true }).fill("Tomato Rice");
  await page.getByRole("button", { name: "Find my dinner" }).click();
  await expect.poll(async () => (await (await fetch(`${modelURL}/__test/control`)).json() as { pending: number }).pending).toBe(1);
  const failed = page.waitForEvent("requestfailed", (request) => request.url().endsWith("/api/chef"));
  await page.getByRole("button", { name: /Pantry/ }).filter({ visible: true }).first().click();
  await page.getByRole("textbox", { name: "New pantry ingredient", exact: true }).fill("unique test beans");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  await failed;
  await control({ release: true });
  await page.getByRole("button", { name: /Recipes/ }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Ask Chef", exact: true }).click();
  await expect(page.getByRole("button", { name: "Find my dinner" })).toBeEnabled();
  await expect(page.locator(".chef-answer")).toHaveCount(0);
});
