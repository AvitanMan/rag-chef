import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import type { KitchenState, PlannedMeal } from "../../app/lib/kitchen-types";

const TODAY = "2026-10-22";
async function navigate(page: Page, name: string) { await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click(); }
async function submit(page: Page, text: string, followUp = false) {
  await page.getByRole("textbox", { name: followUp ? "Follow-up question" : "Ask your chef", exact: true }).fill(text);
  const response = page.waitForResponse((response) => response.url().endsWith("/api/chef") && response.request().method() === "POST");
  await page.getByRole("button", { name: followUp ? "Ask follow-up" : "Find my dinner", exact: true }).click();
  const result = await response; expect(result.ok()).toBeTruthy(); return result.json();
}
test.beforeEach(async ({ page, request }) => {
  await page.clock.install({ time: new Date("2026-10-22T12:00:00+03:00") });
  const current = await (await request.get("/api/kitchen")).json();
  const state: KitchenState = { schemaVersion: 2, pantry: [{ id: "rice", name: "rice", measure: "500 g" }, { id: "tomato", name: "tomatoes", measure: "4" }], meals: {}, shoppingChecked: {}, migratedLegacy: true };
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state } })).ok()).toBeTruthy();
});
test("Chef home keeps date, source discussion and portions through planning and shopping", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Ask Chef", exact: true })).toBeVisible();
  await page.getByLabel("Dinner day", { exact: true }).fill("2026-10-23");
  await page.getByLabel("Chef portions", { exact: true }).fill("4");
  const result = await submit(page, "Tomato Rice");
  expect(result.readinessByRecipeId["fixture-tomato-rice"].coveredCount).toBe(2);
  await page.getByRole("button", { name: "Ask about this recipe", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Follow-up question", exact: true })).toBeFocused();
  const follow = await submit(page, "What is the next source direction?", true);
  expect(follow.resolvedContext.recipeId).toBe("fixture-tomato-rice");
  expect(follow.recipes.map((recipe: { id: string }) => recipe.id)).toEqual(["fixture-tomato-rice"]);
  await navigate(page, "Recipes"); await navigate(page, "Chef");
  await expect(page.getByLabel("Dinner day", { exact: true })).toHaveValue("2026-10-23");
  await expect(page.getByText("Discussing Tomato Rice", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add to Friday: Tomato Rice", exact: true }).click();
  await expect(page.getByRole("region", { name: "Next steps for dinner", exact: true })).toBeVisible();
  await expect.poll(async () => (await (await request.get("/api/kitchen")).json()).state.meals["2026-10-23"]?.servings).toBe(4);
  await page.getByRole("button", { name: "Review shopping", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shopping", exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole("heading", { name: "Ask Chef", exact: true })).toBeVisible();
  await expect(page.getByText("Discussing Tomato Rice", { exact: true })).toHaveCount(0);
});
test("cooking step help preserves timers, progress and saved kitchen", async ({ page, request }) => {
  await page.goto("/"); await submit(page, "Tomato Rice");
  await page.getByRole("button", { name: "Choose this dinner: Tomato Rice", exact: true }).click();
  await expect.poll(async () => Boolean((await (await request.get("/api/kitchen")).json()).state.meals[TODAY])).toBe(true);
  const before = await (await request.get("/api/kitchen")).json();
  await page.getByRole("button", { name: "Cook this dinner", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.getByRole("button", { name: "Start 5 min timer", exact: true }).click();
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await cooking.locator(".cook-help > summary").click();
  await cooking.getByLabel("Question about this step", { exact: true }).fill("What does the source say here?");
  const response = page.waitForResponse((response) => response.url().endsWith("/api/chef"));
  await cooking.getByRole("button", { name: "Ask Chef about step", exact: true }).click();
  const answer = await (await response).json();
  expect(answer.resolvedContext.stepEvidenceId).toBe("S2");
  await expect(cooking.locator(".step-chef-reply")).toBeVisible();
  await page.clock.fastForward("00:00:30");
  await expect(cooking.getByRole("timer")).toHaveText("04:30");
  await expect(cooking).toContainText("Step 2");
  expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
  await cooking.getByRole("button", { name: "← Exit cooking", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume cooking", exact: true })).toBeVisible();
});

test("unsupported recipe questions keep source access and do not invent nutritional facts", async ({ page, request }) => {
  await page.goto("/"); await submit(page, "Tomato Rice");
  await page.getByRole("button", { name: "Ask about this recipe", exact: true }).click();
  const modelURL = process.env.RAG_CHEF_TEST_MODEL_URL!;
  try {
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "unsupported" }) });
    const before = await (await request.get("/api/kitchen")).json();
    const answer = await submit(page, "How many calories are in this recipe?", true);
    expect(answer.outcome).toBe("matches"); expect(answer.answerStatus).toBe("unsupported");
    await expect(page.locator(".chef-answer")).toContainText("Question not established by this source");
    await expect(page.getByRole("button", { name: "Open evidence for Tomato Rice", exact: true })).toBeVisible();
    expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
  } finally {
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "valid" }) });
  }
});


async function savedRiceDinner(request: APIRequestContext, date = TODAY, exactStock = false) {
  const catalog = await (await request.get("/api/recipes/catalog")).json();
  const recipe = catalog.recipes.find((row: { id: string }) => row.id === "fixture-tomato-rice");
  const meal: PlannedMeal = { id: `saved-rice-${date}`, date, recipeId: recipe.id, recipe, title: recipe.title, baseServings: 2, servings: 2, batches: 1, status: "planned", locked: false, ingredientOverrides: {} };
  const document = await (await request.get("/api/kitchen")).json();
  const state = document.state as KitchenState;
  state.meals = { [date]: meal };
  if (exactStock) state.pantry = [{ id: "rice", name: "rice", measure: "200 g" }, { id: "tomato", name: "tomato", measure: "2" }];
  expect((await request.put("/api/kitchen", { data: { revision: document.revision, state } })).ok()).toBeTruthy();
  return meal;
}

test("Chef portions survive adding through Recipes and explicit copies keep their own portions", async ({ page, request }) => {
  await page.goto("/");
  await page.getByLabel("Dinner day", { exact: true }).fill("2026-10-23");
  await page.getByLabel("Chef portions", { exact: true }).fill("4");
  await navigate(page, "Recipes");
  await page.getByRole("searchbox", { name: "Search recipes", exact: true }).fill("Tomato Rice");
  await page.getByRole("button", { name: "Add to Friday: Tomato Rice", exact: true }).click();
  const kitchen = async () => (await (await request.get("/api/kitchen")).json()).state as KitchenState;
  await expect.poll(async () => (await kitchen()).meals["2026-10-23"]?.servings).toBe(4);
  await page.getByLabel("Servings Fri, Oct 23", { exact: true }).fill("6");
  await expect.poll(async () => (await kitchen()).meals["2026-10-23"].servings).toBe(6);
  await page.locator("#dinner-2026-10-23 .meal-more > summary").click();
  await page.getByRole("combobox", { name: "Copy Fri, Oct 23 dinner", exact: true }).selectOption(TODAY);
  await expect.poll(async () => (await kitchen()).meals[TODAY]?.servings).toBe(6);
  expect((await kitchen()).meals["2026-10-23"].servings).toBe(6);
  await navigate(page, "Chef");
  await expect(page.getByLabel("Chef portions", { exact: true })).toHaveValue("6");
  const copied = await submit(page, "How much rice is planned for this dinner?", true);
  expect(copied.resolvedContext.servings).toBe(6);
});

test("unplanned cooking help and later Chef questions do not inherit a previously saved dinner", async ({ page, request }) => {
  await page.goto("/");
  await submit(page, "Tomato Rice");
  await page.getByRole("button", { name: "Choose this dinner: Tomato Rice", exact: true }).click();
  await expect.poll(async () => Boolean((await (await request.get("/api/kitchen")).json()).state.meals[TODAY])).toBe(true);
  await navigate(page, "Recipes");
  await page.getByRole("searchbox", { name: "Search recipes", exact: true }).fill("Cheese Pasta");
  await page.getByRole("button", { name: "View Cheese Pasta", exact: true }).click();
  await page.getByRole("dialog", { name: "Cheese Pasta", exact: true }).getByRole("button", { name: "Start cooking", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Cheese Pasta", exact: true });
  const before = await (await request.get("/api/kitchen")).json();
  await cooking.getByRole("button", { name: "Start 5 min timer", exact: true }).click();
  await cooking.locator(".cook-help > summary").click();
  await cooking.getByLabel("Question about this step", { exact: true }).fill("Explain this source step.");
  const outgoing = page.waitForRequest((request) => request.url().endsWith("/api/chef"));
  const response = page.waitForResponse((response) => response.url().endsWith("/api/chef"));
  await cooking.getByRole("button", { name: "Ask Chef about step", exact: true }).click();
  const context = (await outgoing).postDataJSON().context;
  expect(context).toMatchObject({ recipeId: "fixture-cheese-pasta", purpose: "cooking", stepEvidenceId: "S1" });
  expect(context.mealDate).toBeUndefined(); expect(context.mealId).toBeUndefined(); expect(context.servings).toBeUndefined();
  expect((await response).ok()).toBeTruthy();
  await expect(cooking.locator(".step-chef-reply")).toBeVisible();
  await page.clock.fastForward("00:00:30");
  await expect(cooking.getByRole("timer")).toHaveText("04:30");
  expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
  await cooking.getByRole("button", { name: "← Exit cooking", exact: true }).click();
  await navigate(page, "Chef");
  const follow = await submit(page, "What does the next direction say?", true);
  expect(follow.resolvedContext.recipeId).toBe("fixture-cheese-pasta");
  expect(follow.resolvedContext.mealId).toBeUndefined();
});

test("replacing a dinner does not reserve the old dinner's ingredients", async ({ page, request }) => {
  await savedRiceDinner(request, TODAY, true);
  await page.goto("/"); await navigate(page, "Plan");
  await page.getByRole("button", { name: "Change dinner Thu, Oct 22", exact: true }).click();
  const before = await (await request.get("/api/kitchen")).json();
  const answer = await submit(page, "Tomato Rice");
  expect(answer.readinessByRecipeId["fixture-tomato-rice"].coveredCount).toBe(2);
  expect(answer.readinessByRecipeId["fixture-tomato-rice"].shopping).toEqual([]);
  expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
});

test("saved-dinner estimates use new portions and agree with the resulting shopping list", async ({ page, request }) => {
  await savedRiceDinner(request, TODAY, true);
  await page.goto("/"); await navigate(page, "Plan");
  await page.getByRole("button", { name: "Open Tomato Rice on Thu, Oct 22", exact: true }).click();
  await page.getByRole("dialog", { name: "Tomato Rice", exact: true }).getByRole("button", { name: "Ask Chef about this recipe", exact: true }).click();
  await page.getByLabel("Chef portions", { exact: true }).fill("4");
  const before = await (await request.get("/api/kitchen")).json();
  const answer = await submit(page, "How much rice does this dinner need?", true);
  const readiness = answer.readinessByRecipeId["fixture-tomato-rice"];
  expect(readiness.coveredCount).toBe(0); expect(readiness.partialCount).toBe(2);
  expect(readiness.shopping.map((item: { measure: string }) => item.measure)).toEqual(["200 g", "2"]);
  expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
  await page.getByRole("button", { name: "Add to Thursday: Tomato Rice", exact: true }).click();
  await page.getByRole("dialog", { name: "Replace dinner", exact: true }).getByRole("button", { name: "Replace dinner", exact: true }).click();
  await expect.poll(async () => (await (await request.get("/api/kitchen")).json()).state.meals[TODAY]?.servings).toBe(4);
  await page.getByRole("button", { name: "Review shopping", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Bought rice 200 g", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Bought tomato 2", exact: true })).toBeVisible();
});

test("cooking the same recipe on another day starts a fresh meal discussion", async ({ page, request }) => {
  const first = await savedRiceDinner(request);
  const document = await (await request.get("/api/kitchen")).json();
  document.state.meals["2026-10-23"] = { ...first, id: "second-rice-dinner", date: "2026-10-23", servings: 4 };
  expect((await request.put("/api/kitchen", { data: { revision: document.revision, state: document.state } })).ok()).toBeTruthy();
  await page.goto("/"); await navigate(page, "Plan");
  await page.getByRole("button", { name: "Cook Tomato Rice Thu, Oct 22", exact: true }).click();
  const firstCooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await firstCooking.locator(".cook-help > summary").click();
  await firstCooking.getByLabel("Question about this step", { exact: true }).fill("Explain Thursday's source step.");
  const firstResponse = page.waitForResponse((response) => response.url().endsWith("/api/chef"));
  await firstCooking.getByRole("button", { name: "Ask Chef about step", exact: true }).click();
  expect((await firstResponse).ok()).toBeTruthy();
  await expect(firstCooking.locator(".step-chef-reply")).toBeVisible();
  await firstCooking.getByRole("button", { name: "← Exit cooking", exact: true }).click();
  await navigate(page, "Plan");
  await page.getByRole("button", { name: "Cook Tomato Rice Fri, Oct 23", exact: true }).click();
  await page.getByRole("dialog", { name: "Replace cooking session", exact: true }).getByRole("button", { name: "Replace cooking session", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.locator(".cook-help > summary").click();
  await expect(cooking.locator(".step-chef-reply")).toHaveCount(0);
  await cooking.getByLabel("Question about this step", { exact: true }).fill("Explain this step for Friday's dinner.");
  const outgoing = page.waitForRequest((request) => request.url().endsWith("/api/chef"));
  const response = page.waitForResponse((response) => response.url().endsWith("/api/chef"));
  await cooking.getByRole("button", { name: "Ask Chef about step", exact: true }).click();
  const body = (await outgoing).postDataJSON();
  expect(body.context.mealId).toBe("second-rice-dinner");
  expect(body.history).toEqual([]);
  expect((await response).ok()).toBeTruthy();
});
