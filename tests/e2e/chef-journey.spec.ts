import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import type { KitchenState, PlannedMeal } from "../../app/lib/kitchen-types";

const TODAY = "2026-10-22";
async function navigate(page: Page, name: string) { await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click(); }
async function submit(page: Page, text: string, followUp = false) {
  await page.getByRole("textbox", { name: followUp ? "Follow-up question" : "Ask your chef", exact: true }).fill(text);
  const response = page.waitForResponse((response) => response.url().endsWith("/api/chef") && response.request().method() === "POST");
  await page.getByRole("button", { name: followUp ? "Ask follow-up" : /^(Find my dinner|Update dinner ideas)$/, exact: true }).click();
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
  if (!(await page.getByLabel("Dinner day", { exact: true }).isVisible())) await page.locator(".dinner-context > summary").click();
  await page.getByLabel("Dinner day", { exact: true }).fill("2026-10-23");
  if (!(await page.getByLabel("Dinner day", { exact: true }).isVisible())) await page.locator(".dinner-context > summary").click();
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
  if (await page.locator(".grounding-disclosure").getAttribute("open") === null) await page.locator(".grounding-disclosure > summary").click();
  await page.getByRole("button", { name: "Open evidence for Tomato Rice", exact: true }).click();
  await page.getByRole("dialog", { name: "Tomato Rice", exact: true }).getByRole("button", { name: "Add to Friday", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Dinner saved for" })).toBeVisible();
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
  await cooking.getByRole("button", { name: "Set timer", exact: true }).click();
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
    expect(answer.recommendations).toEqual([]);
    await expect(page.getByRole("heading", { name: "Your chef’s shortlist", exact: true })).toHaveCount(0);
    await expect(page.locator(".chef-answer")).toContainText("Question not established by this source");
    if (await page.locator(".grounding-disclosure").getAttribute("open") === null) await page.locator(".grounding-disclosure > summary").click();
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
  if (!(await page.getByLabel("Dinner day", { exact: true }).isVisible())) await page.locator(".dinner-context > summary").click();
  await page.getByLabel("Dinner day", { exact: true }).fill("2026-10-23");
  if (!(await page.getByLabel("Dinner day", { exact: true }).isVisible())) await page.locator(".dinner-context > summary").click();
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
  await cooking.getByRole("button", { name: "Set timer", exact: true }).click();
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
  if (!(await page.getByLabel("Dinner day", { exact: true }).isVisible())) await page.locator(".dinner-context > summary").click();
  await page.getByLabel("Chef portions", { exact: true }).fill("4");
  const before = await (await request.get("/api/kitchen")).json();
  const answer = await submit(page, "How much rice does this dinner need?", true);
  expect(answer.answerKind).toBe("planning_quantities"); expect(answer.answerStatus).toBe("answered");
  const readiness = answer.readinessByRecipeId["fixture-tomato-rice"];
  expect(readiness.coveredCount).toBe(0); expect(readiness.partialCount).toBe(2);
  expect(readiness.shopping.map((item: { measure: string }) => item.measure)).toEqual(["200 g", "2"]);
  expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
  if (await page.locator(".grounding-disclosure").getAttribute("open") === null) await page.locator(".grounding-disclosure > summary").click();
  await page.getByRole("button", { name: "Open evidence for Tomato Rice", exact: true }).click();
  await page.getByRole("dialog", { name: "Tomato Rice", exact: true }).getByRole("button", { name: "Add to Thursday", exact: true }).click();
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

test("unverified model details are withheld while original recipe evidence remains available", async ({ page, request }) => {
  await page.goto("/"); await submit(page, "Tomato Rice");
  await page.getByRole("button", { name: "Ask about this recipe", exact: true }).click();
  const modelURL = process.env.RAG_CHEF_TEST_MODEL_URL!;
  try {
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "unverified_detail" }) });
    const before = await (await request.get("/api/kitchen")).json();
    const result = await submit(page, "How long does the source say to simmer?", true);
    expect(result.answerStatus).toBe("unverified"); expect(result.generation).toBe("catalog_fallback");
    expect(result.verification.status).toBe("rejected");
    await expect(page.locator(".chef-answer")).toContainText("AI answer withheld · Check original evidence");
    await expect(page.locator(".chef-answer")).not.toContainText("99 minutes");
    await expect(page.getByRole("region", { name: "How Chef found this", exact: true })).not.toContainText("Answer evidence checked");
    await expect(page.getByRole("region", { name: "How Chef found this", exact: true })).toContainText("AI answer withheld · Original source available");
    if (await page.locator(".grounding-disclosure").getAttribute("open") === null) await page.locator(".grounding-disclosure > summary").click();
    await page.getByRole("button", { name: "Open evidence for Tomato Rice", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Tomato Rice", exact: true })).toContainText("Simmer the rice and tomatoes for 10 minutes.");
    expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
  } finally {
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "valid" }) });
  }
});

for (const mode of ["verification_reject", "verification_unavailable"]) {
  test(`${mode}: source evidence and retry recover without changing the kitchen`, async ({ page, request }) => {
    await page.goto("/"); await submit(page, "Tomato Rice");
    await page.getByRole("button", { name: "Ask about this recipe", exact: true }).click();
    const modelURL = process.env.RAG_CHEF_TEST_MODEL_URL!;
    try {
      await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, resetCalls: true }) });
      const before = await (await request.get("/api/kitchen")).json();
      const result = await submit(page, "What does the original recipe say?", true);
      expect(result.verification.status).toBe(mode === "verification_reject" ? "rejected" : "unavailable");
      expect(result.answerStatus).toBe("unverified");
      if (await page.locator(".grounding-disclosure").getAttribute("open") === null) await page.locator(".grounding-disclosure > summary").click();
      await expect(page.getByRole("button", { name: "Open evidence for Tomato Rice", exact: true })).toBeVisible();
      const calls = ((await (await fetch(`${modelURL}/__test/control`)).json()) as { calls: Array<{ path: string }> }).calls;
      expect(calls.filter((call: { path: string }) => call.path === "/api/chat")).toHaveLength(2);
      await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "valid" }) });
      const response = page.waitForResponse((response) => response.url().endsWith("/api/chef"));
      await page.getByRole("button", { name: "Retry answer", exact: true }).click();
      const retried = await (await response).json();
      expect(retried.verification.status).toBe("checked");
      await expect(page.getByRole("region", { name: "How Chef found this", exact: true })).toContainText("Answer evidence checked");
      expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
    } finally {
      await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "valid" }) });
    }
  });
}

test("retrying a rejected cooking answer preserves timer, meal scope, and progress", async ({ page, request }) => {
  await savedRiceDinner(request);
  await page.goto("/"); await navigate(page, "Plan");
  await page.getByRole("button", { name: "Cook Tomato Rice Thu, Oct 22", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  const before = await (await request.get("/api/kitchen")).json();
  await cooking.getByRole("button", { name: "Set timer", exact: true }).click();
  await cooking.getByRole("button", { name: "Start 5 min timer", exact: true }).click();
  await cooking.locator(".cook-help > summary").click();
  const modelURL = process.env.RAG_CHEF_TEST_MODEL_URL!;
  try {
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "verification_reject" }) });
    await cooking.getByLabel("Question about this step", { exact: true }).fill("Explain the current source step.");
    await cooking.getByRole("button", { name: "Ask Chef about step", exact: true }).click();
    await expect(cooking.getByRole("button", { name: "Retry step answer", exact: true })).toBeVisible();
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "valid" }) });
    const outgoing = page.waitForRequest((request) => request.url().endsWith("/api/chef"));
    const response = page.waitForResponse((response) => response.url().endsWith("/api/chef"));
    await cooking.getByRole("button", { name: "Retry step answer", exact: true }).click();
    expect((await outgoing).postDataJSON().context).toMatchObject({ mealId: `saved-rice-${TODAY}`, stepEvidenceId: "S1", purpose: "cooking" });
    expect((await (await response).json()).verification.status).toBe("checked");
    await page.clock.fastForward("00:00:30");
    await expect(cooking.getByRole("timer")).toHaveText("04:30");
    expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
  } finally {
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "valid" }) });
  }
});

test("starting a new search cancels an in-flight evidence check and hides its late answer", async ({ page, request }) => {
  await page.goto("/"); await submit(page, "Tomato Rice");
  await page.getByRole("button", { name: "Ask about this recipe", exact: true }).click();
  const modelURL = process.env.RAG_CHEF_TEST_MODEL_URL!;
  const before = await (await request.get("/api/kitchen")).json();
  try {
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "verification_hold" }) });
    await page.getByRole("textbox", { name: "Follow-up question", exact: true }).fill("Explain this source recipe.");
    await page.getByRole("button", { name: "Ask follow-up", exact: true }).click();
    await expect.poll(async () => ((await (await fetch(`${modelURL}/__test/control`)).json()) as { pending: number }).pending).toBe(1);
    await page.getByRole("button", { name: "New dinner search", exact: true }).click();
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "valid", release: true }) });
    await submit(page, "Cheese Pasta");
    if (await page.locator(".grounding-disclosure").getAttribute("open") === null) await page.locator(".grounding-disclosure > summary").click();
    await expect(page.getByRole("button", { name: "Open evidence for Cheese Pasta", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open evidence for Tomato Rice", exact: true })).toHaveCount(0);
    expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
  } finally {
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "valid", release: true }) });
  }
});

test("described pantry ingredients cover Chef suggestions and deduct consistently through cooking", async ({ page, request }) => {
  const current = await (await request.get("/api/kitchen")).json();
  const pantry = [{ id: "pasta", name: "any small pasta", measure: "500 g" }, { id: "cheese", name: "cheese, grated", measure: "200 g" }, { id: "leftovers", name: "cooked pasta", measure: "150 g" }];
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state: { ...current.state, pantry } } })).ok()).toBeTruthy();
  await page.goto("/");
  const result = await submit(page, "Cheese Pasta");
  expect(result.readinessByRecipeId["fixture-cheese-pasta"].coveredCount).toBe(2);
  await page.getByRole("button", { name: "Choose this dinner: Cheese Pasta", exact: true }).click();
  await page.getByRole("button", { name: "Review shopping", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /^Bought / })).toHaveCount(0);
  await navigate(page, "Plan");
  await page.getByRole("button", { name: "Cook this dinner", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Cheese Pasta", exact: true });
  await cooking.getByRole("button", { name: "Next step →", exact: true }).click();
  await cooking.getByRole("button", { name: "Finish cooking", exact: true }).click();
  const completion = page.getByRole("dialog", { name: "Complete dinner", exact: true });
  await completion.getByRole("checkbox", { name: "Deduct the matching pantry amounts shown below", exact: true }).check();
  await completion.getByRole("button", { name: "Confirm cooked", exact: true }).click();
  await expect.poll(async () => (await (await request.get("/api/kitchen")).json()).state.pantry.map((row: { measure: string }) => row.measure)).toEqual(["300 g", "100 g", "150 g"]);
  await page.getByRole("button", { name: "Undo cooked", exact: true }).click();
  await expect.poll(async () => (await (await request.get("/api/kitchen")).json()).state.pantry.map((row: { measure: string }) => row.measure)).toEqual(["500 g", "200 g", "150 g"]);
});

test("saved amount help works offline in Chef and cooking with source quantities preserved", async ({ page, request }) => {
  const meal = await savedRiceDinner(request);
  const document = await (await request.get("/api/kitchen")).json();
  document.state.meals[TODAY].servings = 4;
  document.state.meals[TODAY].ingredientOverrides = { "0": "350 g" };
  expect((await request.put("/api/kitchen", { data: { revision: document.revision, state: document.state } })).ok()).toBeTruthy();
  const modelURL = process.env.RAG_CHEF_TEST_MODEL_URL!;
  try {
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unavailable: true, resetCalls: true }) });
    await page.goto("/"); await navigate(page, "Plan");
    await page.locator(`#dinner-${TODAY}`).getByRole("button", { name: /^Open Tomato Rice/ }).click();
    await page.getByRole("dialog", { name: "Tomato Rice", exact: true }).getByRole("button", { name: "Ask Chef about this recipe", exact: true }).click();
    const before = await (await request.get("/api/kitchen")).json();
    const answer = await submit(page, "How much rice do I need?", true);
    expect(answer.answerKind).toBe("planning_quantities"); expect(answer.answerStatus).toBe("answered");
    const amounts = page.getByRole("region", { name: "Your dinner amounts", exact: true });
    await expect(amounts).toContainText("4 servings"); await expect(amounts).toContainText("350 g"); await expect(amounts).toContainText("Saved amount override");
    await expect(page.locator(".grounding-source")).toContainText(`${meal.recipe!.ingredients[0].measure} ${meal.recipe!.ingredients[0].name}`);
    await expect(page.getByRole("heading", { name: "Your chef’s shortlist", exact: true })).toHaveCount(0);
    await page.screenshot({ path: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/${test.info().project.name}-calculated-chef.png`, fullPage: true });
    await navigate(page, "Plan");
    await page.locator(`#dinner-${TODAY}`).getByRole("button", { name: /Cook/ }).click();
    const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
    await cooking.getByRole("button", { name: "Set timer", exact: true }).click();
    await cooking.getByRole("button", { name: "Start 5 min timer", exact: true }).click();
    await cooking.locator(".cook-help > summary").click();
    await cooking.getByLabel("Question about this step", { exact: true }).fill("How much rice do I need?");
    const response = page.waitForResponse(response => response.url().endsWith("/api/chef"));
    await cooking.getByRole("button", { name: "Ask Chef about step", exact: true }).click();
    expect((await (await response).json()).answerKind).toBe("planning_quantities");
    await expect(cooking.getByRole("region", { name: "Your dinner amounts", exact: true })).toContainText("350 g");
    await page.clock.fastForward("00:00:30"); await expect(cooking.getByRole("timer")).toHaveText("04:30");
    await page.screenshot({ path: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/${test.info().project.name}-calculated-cooking.png`, fullPage: true });
    expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
    const control = await (await fetch(`${modelURL}/__test/control`)).json() as { calls: unknown[] };
    expect(control.calls).toEqual([]);
  } finally {
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unavailable: false }) });
  }
});

test("mixed quantity and cooking questions show an evidence-checked answer to both parts", async ({ page, request }) => {
  await savedRiceDinner(request);
  await page.goto("/"); await navigate(page, "Plan");
  await page.getByRole("button", { name: "Open Tomato Rice on Thu, Oct 22", exact: true }).click();
  await page.getByRole("dialog", { name: "Tomato Rice", exact: true }).getByRole("button", { name: "Ask Chef about this recipe", exact: true }).click();
  const modelURL = process.env.RAG_CHEF_TEST_MODEL_URL!;
  try {
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "mixed_help", resetCalls: true }) });
    const before = await (await request.get("/api/kitchen")).json();
    const query = "How much rice do I need, and how do I cook it?";
    const answer = await submit(page, query, true);
    expect(answer.generation).toBe("ai"); expect(answer.answerKind).toBeUndefined(); expect(answer.verification.status).toBe("checked");
    await expect(page.locator(".chef-answer")).toContainText("200 g"); await expect(page.locator(".chef-answer")).toContainText("Rinse the rice.");
    await expect(page.getByRole("region", { name: "Your dinner amounts", exact: true })).toHaveCount(0);
    const control = await (await fetch(`${modelURL}/__test/control`)).json() as { calls: Array<{ path: string; body: { messages?: Array<{ role: string; content: string }> } }> };
    const chats = control.calls.filter(call => call.path === "/api/chat"); expect(chats).toHaveLength(2);
    expect(chats[0].body.messages!.find(message => message.role === "user")!.content).toContain(query);
    expect(answer.sourceFacts.some((fact: { evidenceId: string }) => fact.evidenceId === "S1")).toBe(true);
    expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
  } finally {
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "valid" }) });
  }
});

test("open-ended ingredient replacement questions display labeled advice without editing the recipe", async ({ page, request }) => {
  await page.goto("/"); const original = await submit(page, "Cheese Pasta");
  await page.getByRole("button", { name: "Ask about this recipe", exact: true }).click();
  const modelURL = process.env.RAG_CHEF_TEST_MODEL_URL!;
  try {
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "replacement_advice", resetCalls: true }) });
    const before = await (await request.get("/api/kitchen")).json();
    const answer = await submit(page, "Can I replace the cheese?", true);
    expect(answer.generation).toBe("ai"); expect(answer.chefChanges).toHaveLength(1);
    await expect(page.locator(".chef-answer")).toContainText("Suggested change — original recipe unchanged");
    await expect(page.locator(".chef-answer")).toContainText("plant-based cheese substitute");
    expect(answer.recipes[0]).toEqual(original.recipes[0]);
    expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
  } finally {
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "valid" }) });
  }
});

test("an unpinned factual answer is withheld when its evidence check rejects the explanation", async ({ page, request }) => {
  await page.goto("/");
  const modelURL = process.env.RAG_CHEF_TEST_MODEL_URL!;
  try {
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "unverified_cause", resetCalls: true }) });
    const before = await (await request.get("/api/kitchen")).json();
    const answer = await submit(page, "Why Tomato Rice?");
    expect(answer.answerStatus).toBe("unverified"); expect(answer.verification.status).toBe("rejected");
    await expect(page.locator(".chef-answer")).toContainText("AI answer withheld");
    await expect(page.locator(".chef-answer")).not.toContainText("chlorophyll");
    if (await page.locator(".grounding-disclosure").getAttribute("open") === null) await page.locator(".grounding-disclosure > summary").click();
    await expect(page.getByRole("button", { name: "Open evidence for Tomato Rice", exact: true })).toBeVisible();
    expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
  } finally {
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "valid" }) });
  }
});

test("unsupported and clarification labels cannot expose unchecked model explanations", async ({ page, request }) => {
  await page.goto("/"); await submit(page, "Tomato Rice");
  await page.getByRole("button", { name: "Ask about this recipe", exact: true }).click();
  const modelURL = process.env.RAG_CHEF_TEST_MODEL_URL!;
  try {
    const before = await (await request.get("/api/kitchen")).json();
    for (const [mode, status] of [["unsafe_clarification", "needs_clarification"], ["unsafe_unsupported", "unsupported"]]) {
      await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
      const answer = await submit(page, "Why rinse the rice?", true);
      expect(answer.answerStatus).toBe(status); expect(JSON.stringify([answer.answer, answer.warnings, answer.chefChanges, answer.recommendations])).not.toContain("chlorophyll");
      await expect(page.locator(".chef-answer")).not.toContainText("chlorophyll");
      if (await page.locator(".grounding-disclosure").getAttribute("open") === null) await page.locator(".grounding-disclosure > summary").click();
      await expect(page.getByRole("button", { name: "Open evidence for Tomato Rice", exact: true })).toBeVisible();
    }
    expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
  } finally {
    await fetch(`${modelURL}/__test/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "valid" }) });
  }
});
