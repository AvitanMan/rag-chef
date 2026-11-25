import { test, expect, type APIRequestContext } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { KitchenState, PlannedMeal } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";
import type { ChefApiResponse, ChefRequest } from "../../app/lib/chef-schema";
const TODAY = "2026-10-22";
const importedIds: string[] = [];
let catalogCountBefore = 0;
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });
async function read(request: APIRequestContext) { return (await request.get("/api/kitchen")).json(); }
async function save(request: APIRequestContext, state: KitchenState) {
  const current = await read(request);
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state } })).ok()).toBeTruthy();
}
function meal(recipe: Recipe, cooked = false): PlannedMeal {
  return { id: "review-dinner", date: TODAY, recipeId: recipe.id, recipe, title: recipe.title, baseServings: recipe.servings ?? null, servings: recipe.servings ?? null, batches: 1, locked: false, status: cooked ? "cooked" : "planned", ingredientOverrides: {}, ...(cooked ? { completion: { id: "already-completed", at: "2026-10-22T08:00:00.000Z", deductions: [] } } : {}) };
}
async function importRecipe(request: APIRequestContext, title: string, instructions: string[], ingredients = [{ name: "rice", measure: "200 g" }]): Promise<Recipe> {
  const source = { sourceUrl: "https://en.wikibooks.org/wiki/Cookbook:" + title.replaceAll(" ", "_"), title, ingredients, instructions, servings: 2 };
  const reviewHash = createHash("sha256").update(JSON.stringify(source)).digest("hex");
  const response = await request.post("/api/admin/recipes/import", { headers: { "Idempotency-Key": crypto.randomUUID() }, data: { recipes: [{ ...source, reviewed: true, reviewHash }] } });
  expect(response.status()).toBe(202);
  const accepted = await response.json();
  expect(accepted.statusUrl).toBe(`/api/admin/catalog/jobs/${accepted.job.id}`);
  let job = accepted.job;
  await expect.poll(async () => {
    const status = await request.get(accepted.statusUrl);
    expect(status.ok()).toBeTruthy();
    job = (await status.json()).job;
    return job.status;
  }, { timeout: 30_000 }).toBe("succeeded");
  const result = job.result.results[0];
  if (result.catalogId) importedIds.push(result.catalogId);
  expect(result.status).not.toBe("failed");
  const catalog = await (await request.get("/api/recipes/catalog")).json();
  return catalog.recipes.find((item: Recipe) => item.id === result.catalogId);
}
test.beforeEach(async ({ page, request }) => {
  importedIds.length = 0;
  catalogCountBefore = (await (await request.get("/api/recipes/catalog")).json()).recipes.length;
  await page.clock.install({ time: new Date(TODAY + "T12:00:00+03:00") });
  await save(request, empty());
});
test.afterEach(async ({ request }) => {
  if (!importedIds.length) return;
  // Remove only this test's imports from the harness's disposable database.
  const state = process.env.RAG_CHEF_TEST_STATE_DIR;
  if (!state || realpathSync(state) !== realpathSync(resolve(process.cwd(), "..", "d1-state"))) throw new Error("Cooking regressions require the isolated test harness.");
  if (!importedIds.every(id => /^wikibooks:[a-f0-9]{64}$/.test(id))) throw new Error("Unexpected synthetic recipe identity.");
  const sql = `DELETE FROM recipes WHERE id IN (${importedIds.map(id => `'${id}'`).join(",")});`;
  execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--local", "--config", "wrangler.jsonc", "--persist-to", state, "--command", sql], { timeout: 20000, stdio: "pipe" });
  expect((await (await request.get("/api/recipes/catalog")).json()).recipes.length).toBe(catalogCountBefore);
});
test("cooking again from a cooked dinner uses an unattached session and preserves kitchen history", async ({ page, request }) => {
  const catalog = await (await request.get("/api/recipes/catalog")).json();
  const source = catalog.recipes.find((item: Recipe) => item.id === "fixture-tomato-rice")!;
  const cooked = { ...meal(source, true), servings: 4, ingredientOverrides: { "0": "350 g" } };
  const pantry = [{ id: "rice-stock", name: "rice", measure: "500 g" }];
  await save(request, { ...empty(), pantry, meals: { [TODAY]: cooked } });
  await page.goto("/"); await page.getByRole("button", { name: "Recipe details", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: source.title, exact: true });
  await expect(drawer).toContainText("Starting again uses original recipe quantities");
  await drawer.getByRole("button", { name: "Start cooking again", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking " + source.title, exact: true });
  await cooking.getByText("Ingredients for this dinner", { exact: true }).click();
  const ingredients = cooking.getByRole("region", { name: "Ingredients for this dinner", exact: true });
  await expect(ingredients).toContainText("200 g"); await expect(ingredients).not.toContainText("350 g");
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await cooking.getByRole("button", { name: "Finish cooking", exact: true }).click();
  const completion = cooking.getByRole("region", { name: "Complete cooking", exact: true });
  await expect(completion).toContainText("not attached to a saved dinner");
  await cooking.screenshot({ path: process.env.RAG_CHEF_TEST_ARTIFACTS + "/cooked-again-completion-" + test.info().project.name + ".png", scale: "css" });
  await completion.getByRole("button", { name: "Finish session", exact: true }).click();
  await expect(cooking).toHaveCount(0);
  expect((await read(request)).state.meals[TODAY]).toEqual(cooked);
  expect((await read(request)).state.pantry).toEqual(pantry);
  expect(await page.evaluate(() => localStorage.getItem("rag-chef-cooking-v1"))).toBeNull();
});
test("procedural source directions stay in the full method until cooking is finished", async ({ page, request }) => {
  const source = await importRecipe(request, "Cooking Review Directions", ["Boil water.", "Cook rice according to package instructions", "Drain and serve."]);
  expect(source.instructions[1]).toBe("Cook rice according to package instructions");
  await save(request, { ...empty(), meals: { [TODAY]: meal(source) } });
  await page.goto("/"); await page.getByRole("button", { name: "Cook dinner", exact: true }).click();
  await expect(page.getByRole("region", { name: "Choose cooking method", exact: true })).toHaveCount(0);
  const cooking = page.getByRole("dialog", { name: "Cooking " + source.title, exact: true });
  await expect(cooking).toContainText("Boil water.");
  await expect(cooking.getByRole("button", { name: "Finish cooking", exact: true })).toHaveCount(0);
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await expect(cooking).toContainText("Cook rice according to package instructions");
  await cooking.screenshot({ path: process.env.RAG_CHEF_TEST_ARTIFACTS + "/complete-directions-" + test.info().project.name + ".png", scale: "css" });
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await expect(cooking).toContainText("Drain and serve.");
  await expect(cooking.getByRole("button", { name: "Finish cooking", exact: true })).toBeVisible();
});

test("previously saved sessions attached to cooked dinners can finish without replaying completion", async ({ page, request }) => {
  const catalog = await (await request.get("/api/recipes/catalog")).json();
  const source = catalog.recipes.find((item: Recipe) => item.id === "fixture-tomato-rice")!;
  const cooked = { ...meal(source, true), ingredientOverrides: { "0": "350 g" } };
  const pantry = [{ id: "rice-stock", name: "rice", measure: "500 g" }];
  await save(request, { ...empty(), pantry, meals: { [TODAY]: cooked } });
  await page.addInitScript(({ recipe, dinner }) => {
    localStorage.setItem("rag-chef-cooking-v1", JSON.stringify({ version: 1, id: "legacy-cooked-session", recipe, plannedMeal: dinner,
      instructions: recipe.instructions, method: "Main method", step: recipe.instructions.length - 1,
      timer: { durationMs: 300000, remainingMs: 120000, endAt: null, status: "paused" }, soundEnabled: false }));
  }, { recipe: source, dinner: cooked });
  await page.goto("/");
  await page.getByRole("button", { name: "Resume cooking", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking " + source.title, exact: true });
  await expect(cooking.getByRole("timer", { name: "Time remaining", exact: true })).toHaveText("02:00");
  await cooking.getByRole("button", { name: "Finish cooking", exact: true }).click();
  const completion = cooking.getByRole("region", { name: "Complete cooking", exact: true });
  await expect(completion).toContainText("already marked cooked");
  await completion.getByRole("button", { name: "Finish session", exact: true }).click();
  await expect(cooking).toHaveCount(0);
  expect((await read(request)).state.meals[TODAY]).toEqual(cooked);
  expect((await read(request)).state.pantry).toEqual(pantry);
  expect(await page.evaluate(() => localStorage.getItem("rag-chef-cooking-v1"))).toBeNull();
});
test("numbered source directions keep their canonical step evidence IDs in cooking help", async ({ page, request }) => {
  const source = await importRecipe(request, "Cooking Review Numbered Rice", ["1. Rinse the rice.", "2. Simmer the rice for 10 minutes."]);
  expect(source.instructions[0]).toBe("1. Rinse the rice.");
  await save(request, { ...empty(), meals: { [TODAY]: meal(source) } });
  await page.goto("/"); await page.getByRole("button", { name: "Cook dinner", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking " + source.title, exact: true });
  const help = cooking.getByRole("region", { name: "Cooking step help" });
  const question = help.getByRole("textbox", { name: "Question about this step" });
  const reply = help.locator(".step-chef-reply");
  const explanation = reply.locator(".step-explanation");
  const sourceToggle = reply.getByText("Source for this answer", { exact: true });
  const evidence = reply.locator("blockquote");
  const modelControl = `${process.env.RAG_CHEF_TEST_MODEL_URL}/__test/control`;
  try {
    expect((await request.post(modelControl, { data: { mode: "focused_step" } })).ok()).toBeTruthy();
    await expect(cooking.getByText("Rinse the rice.", { exact: true })).toBeVisible();
    await cooking.getByText("Ask about this step", { exact: true }).click();
    await expect(help).not.toContainText("this saved step cannot be matched");

    async function ask(text: string, stepEvidenceId: string) {
      await question.fill(text);
      const responding = page.waitForResponse(response => response.url().endsWith("/api/chef") && response.request().method() === "POST");
      await help.getByRole("button", { name: "Ask Chef about step" }).click();
      const response = await responding;
      expect(response.ok()).toBeTruthy();
      expect(response.request().postDataJSON().context).toMatchObject({ recipeId: source.id, stepEvidenceId });
    }

    await ask("What does this instruction mean?", "S1");
    await expect(explanation).toBeVisible();
    await expect(explanation).toHaveText("Rinse the rice.");
    await sourceToggle.click();
    await expect(evidence).toHaveText([source.instructions[0]]);

    await cooking.getByRole("button", { name: /Next step/ }).click();
    await expect(cooking.getByText("Simmer the rice for 10 minutes.", { exact: true })).toBeVisible();
    await expect(reply).toHaveCount(0);
    await ask("How long does this step take?", "S2");
    await expect(explanation).toBeVisible();
    await expect(explanation).toHaveText(/^Simmer (?:the rice )?for 10 minutes\.$/);
    await sourceToggle.click();
    await expect(evidence).toBeVisible();
    await expect(evidence).toHaveText([source.instructions[1]]);
    await expect(reply).not.toContainText("Rinse the rice.");
    await expect.poll(async () => (await (await request.get("/api/recipes/catalog")).json()).recipes.find((item: Recipe) => item.id === source.id).instructions).toEqual(source.instructions);
    await cooking.screenshot({ path: process.env.RAG_CHEF_TEST_ARTIFACTS + "/numbered-step-help-" + test.info().project.name + ".png", scale: "css" });
  } finally {
    expect((await request.post(modelControl, { data: { mode: "valid", resetCalls: true } })).ok()).toBeTruthy();
  }
});

test("cooking answers follow the selected method and a late reply stays on its original step", async ({ page, request }) => {
  const source = await importRecipe(request, "Cooking Review Method Rice", [
    "Stovetop", "Warm the broth.", "Simmer the rice.", "Oven", "Rinse the rice.", "Warm the sauce gently. Do not let it boil.",
  ]);
  await save(request, { ...empty(), meals: { [TODAY]: meal(source) } });
  const kitchenBefore = await read(request);
  await page.goto("/");
  await page.getByRole("button", { name: "Cook dinner", exact: true }).click();
  await page.getByRole("button", { name: "Cook with Oven", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking " + source.title });
  await expect(cooking).toContainText("Rinse the rice.");
  await cooking.getByRole("button", { name: "Set timer", exact: true }).click();
  await page.clock.pauseAt(new Date(TODAY + "T12:10:00+03:00"));
  await cooking.getByRole("button", { name: "Start 5 min timer", exact: true }).click();
  await cooking.getByText("Ask about this step", { exact: true }).click();
  const help = cooking.getByRole("region", { name: "Cooking step help" });
  const question = help.getByRole("textbox");
  const submit = help.getByRole("button", { name: "Ask Chef about step" });
  const reply = help.locator(".step-chef-reply");
  await question.fill("What does step 2 mean?");
  const posted = page.waitForResponse(response => response.url().endsWith("/api/chef") && response.request().method() === "POST");
  await submit.click();
  const result = await (await posted).json();
  expect(result.resolvedContext).toMatchObject({ stepEvidenceId: "S5", methodStep: { number: 2, evidenceId: "S6" } });
  expect(result.sourceFacts).toContainEqual({ recipeId: source.id, evidenceId: "S6", fact: source.instructions[5] });
  await expect(reply.locator(".step-explanation")).toContainText("Do not let it boil");
  await expect(reply.getByRole("region", { name: "Boiling explained" })).toContainText("large bubbles");
  await expect(reply.locator(".step-explanation + .technique-reference")).toBeVisible();
  await reply.getByText("Source for this answer").click();
  await expect(reply.locator("blockquote")).toHaveText(source.instructions[5]);

  await question.fill("Explain step 3");
  await submit.click();
  await expect(reply).toContainText("couldn’t match step 3");
  await expect(reply.locator("blockquote")).toHaveCount(0);

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  await page.route("**/api/chef", async route => {
    const response = await route.fetch();
    ready();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await question.fill("What does step 2 mean?");
    await submit.click();
    await waiting;
    await cooking.getByRole("button", { name: /Next step/ }).click();
    const delivered = page.waitForResponse(response => response.url().endsWith("/api/chef"));
    release();
    await delivered;
    await expect(submit).toHaveText("Ask Chef about step");
    await expect(reply).toHaveCount(0);
    await cooking.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(reply).toHaveCount(0);
  } finally { release(); }
  await page.clock.fastForward("00:00:30");
  await expect(cooking.getByRole("timer", { name: "Time remaining" })).toHaveText("04:30");
  expect(await read(request)).toEqual(kitchenBefore);
});

test("Chef distinguishes the saved milk amount from the original numbered direction in the selected method", async ({ page, request }) => {
  const source = await importRecipe(request, "Cooking Review Oven Milk Rice", [
    "Stovetop", "Simmer the rice and milk together.", "Oven", "Rinse the rice.", "Pour in 100 ml milk.",
  ], [{ name: "rice", measure: "200 g" }, { name: "milk", measure: "100 ml" }]);
  const dinner = { ...meal(source), ingredientOverrides: { "1": "175 ml" } };
  await save(request, { ...empty(), meals: { [TODAY]: dinner } });
  const before = await read(request);
  await page.goto("/");
  await page.getByRole("button", { name: "Cook dinner", exact: true }).click();
  await page.getByRole("button", { name: "Cook with Oven", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking " + source.title });
  await expect(cooking).toContainText("Rinse the rice.");
  await cooking.getByText("Ask about this step", { exact: true }).click();
  const help = cooking.getByRole("region", { name: "Cooking step help" });
  await help.getByRole("textbox").fill("What do I do in step 2?");
  const posted = page.waitForResponse(response => response.url().endsWith("/api/chef") && response.request().method() === "POST");
  await help.getByRole("button", { name: "Ask Chef about step" }).click();
  const result = await (await posted).json();
  expect(result.resolvedContext).toMatchObject({ stepEvidenceId: "S4", methodStep: { number: 2, evidenceId: "S5" } });
  const reply = help.locator(".step-chef-reply");
  const lead = reply.locator(".step-explanation");
  await expect(lead).toContainText(/saved dinner total:\s*175 ml milk/i);
  await expect(lead).toContainText(/original direction:\s*Pour in 100 ml milk\./i);
  await expect(reply).not.toContainText("Simmer the rice");
  const sourceDisclosure = reply.locator(".step-source-evidence");
  await expect(sourceDisclosure).not.toHaveAttribute("open");
  await sourceDisclosure.locator("summary").click();
  await expect(sourceDisclosure.getByText(source.instructions[4], { exact: true })).toBeVisible();
  await expect(sourceDisclosure).not.toContainText("175 ml");
  expect(await read(request)).toEqual(before);
});

for (const fixture of [
  { title: "Vanilla Milk Pudding", steps: ["Whisk 50 ml of milk with the cornstarch.", "Stir in 150 ml of milk and simmer until thick."], explicit: true },
  { title: "Cinnamon Milk Pudding", steps: ["Whisk some of the milk with the cornstarch.", "Stir in the remaining milk and simmer until thick."], explicit: false },
]) {
  test(`Chef keeps repeated additions separate from the saved dinner total for ${fixture.title}`, async ({ page, request }) => {
    const source = await importRecipe(request, fixture.title, fixture.steps, [{ name: "milk", measure: "200 ml" }, { name: "cornstarch", measure: "10 g" }]);
    await page.goto("/");
    await page.getByRole("textbox", { name: "Dinner request" }).fill(source.title);
    await page.getByRole("button", { name: "Find my dinner", exact: true }).click();
    await page.getByRole("button", { name: `Ask about ${source.title}`, exact: true }).click();
    await page.getByRole("textbox", { name: "Follow-up question" }).fill("How much milk does the original recipe use?");
    await page.getByRole("button", { name: "Ask recipe question" }).click();
    await expect(page.locator(".chef-answer")).toContainText("200 ml milk");
    const evidence = page.locator(".grounding-disclosure");
    if (await evidence.getAttribute("open") === null) await evidence.locator("summary").click();
    await evidence.getByRole("button", { name: `Open evidence for ${source.title}` }).click();
    await page.getByRole("dialog", { name: source.title }).getByRole("button", { name: "Choose for tonight", exact: true }).click();
    const chosen = page.getByRole("region", { name: "Chosen dinner" });
    await chosen.getByText("Adjust amounts", { exact: true }).click();
    await chosen.getByRole("textbox", { name: /milk amount/i }).fill("300 ml");
    await expect.poll(async () => (await read(request)).state.meals[TODAY]?.ingredientOverrides["0"]).toBe("300 ml");
    const before = await read(request);
    const dinner = before.state.meals[TODAY];
    expect(dinner.servings).toBe(2);
    await chosen.getByRole("button", { name: /Cook (?:this )?dinner/i }).click();
    const cooking = page.getByRole("dialog", { name: `Cooking ${source.title}`, exact: true });
    await cooking.getByText("Ask about this step", { exact: true }).click();
    const help = cooking.getByRole("region", { name: "Cooking step help" });
    const reply = help.locator(".step-chef-reply");
    const history: NonNullable<ChefRequest["history"]> = [];
    async function ask(query: string) {
      await help.getByRole("textbox").fill(query);
      const pending = page.waitForResponse(response => response.url().endsWith("/api/chef") && response.request().method() === "POST");
      await help.getByRole("button", { name: "Ask Chef about step" }).click();
      const response = await pending;
      expect(response.ok()).toBeTruthy();
      expect(response.request().postDataJSON().history).toEqual(history);
      const result: ChefApiResponse = await response.json();
      expect(result.resolvedContext).toMatchObject({ recipeId: source.id, mealId: dinner.id, mealDate: TODAY, purpose: "cooking", stepEvidenceId: "S1" });
      expect(result.generation).toBe("catalog_fallback");
      expect(result.timings).toMatchObject({ generationMs: 0, verificationMs: 0 });
      history.push({ role: "user", content: query }, { role: "assistant", content: result.answer });
      return result;
    }
    const control = `${process.env.RAG_CHEF_TEST_MODEL_URL}/__test/control`;
    await request.post(control, { data: { resetCalls: true } });
    const total = await ask("How much milk do I need for this dinner?");
    expect(total.planningFacts).toContainEqual(expect.objectContaining({ name: "milk", measure: "300 ml", basis: "saved_override" }));
    await expect(reply.getByRole("region", { name: "Your dinner amounts" })).toContainText("300 ml");

    for (const [step, question] of ["How much goes in now?", "What about the rest?"].entries()) {
      const result = await ask(question);
      const evidenceId = `S${step + 1}`;
      expect(result.answerStatus).toBe(fixture.explicit ? "answered" : "unsupported");
      expect(result.sourceFacts).toEqual(expect.arrayContaining([
        { recipeId: source.id, evidenceId: "I1", fact: "200 ml milk" },
        { recipeId: source.id, evidenceId, fact: fixture.steps[step] },
      ]));
      expect(result.selectedEvidenceByRecipeId?.[source.id]).toContain(evidenceId);
      expect(result.planningFacts).toContainEqual(expect.objectContaining({ name: "milk", measure: "300 ml", basis: "saved_override" }));
      expect(result.answer).toMatch(/300 ml/i);
      expect(result.answer).toMatch(/(?:saved|dinner).*total|total.*(?:saved|dinner)/i);
      expect(result.answer).toMatch(/(?:saved|dinner)[^.\n]*(?:does not|doesn.t|unknown|unstated|unspecified|no .*split)/i);
      const allowedAmounts = fixture.explicit ? [50, 150, 200, 300] : [200, 300];
      const amounts = Array.from(result.answer.matchAll(/\b(\d+(?:\.\d+)?)\s*ml\b/gi), match => Number(match[1]));
      expect(amounts.filter(value => !allowedAmounts.includes(value))).toEqual([]);
      if (fixture.explicit) expect(result.answer).toMatch(step === 0 ? /\b50 ml\b/i : /\b150 ml\b/i);
      else {
        expect(result.answer).toMatch(step === 0 ? /some|portion/i : /remaining|rest/i);
        expect(result.answer).toMatch(/(?:direction|recipe|source|step)[^.\n]*(?:no measured amount|does not (?:specify|state|give)|unspecified)/i);
      }
      await expect(reply.locator(".step-explanation")).toHaveText(result.answer);
      const disclosure = reply.locator(".step-source-evidence");
      if (await disclosure.getAttribute("open") === null) await disclosure.locator("summary").click();
      await expect(disclosure.getByText(fixture.steps[step], { exact: true })).toBeVisible();
      await expect(disclosure).not.toContainText("300 ml");
    }
    const { calls } = await (await request.get(control)).json();
    expect(calls.filter((call: { path: string }) => call.path === "/api/chat")).toEqual([]);
    expect(await read(request)).toEqual(before);
  });
}
