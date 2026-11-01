import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { KitchenState, PersonalRecipeAmounts, PlannedMeal } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";

const TODAY = "2026-10-22";
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });
async function read(request: APIRequestContext) { return (await request.get("/api/kitchen")).json(); }
async function save(request: APIRequestContext, state: KitchenState) {
  const current = await read(request);
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state } })).ok()).toBeTruthy();
}
async function catalog(request: APIRequestContext): Promise<{ recipes: Recipe[]; contentHashesByRecipeId: Record<string, string> }> { return (await request.get("/api/recipes/catalog")).json(); }
async function navigate(page: Page, name: string) {
  if (name === "Settings") { await page.getByRole("button", { name, exact: true }).click(); return; }
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click();
}
async function openRecipe(page: Page, title = "Tomato Rice") {
  await navigate(page, "Recipes");
  await page.getByRole("searchbox", { name: "Search recipes", exact: true }).fill(title);
  await page.locator(".recipe-card").getByRole("button", { name: title, exact: true }).click();
  return page.getByRole("dialog", { name: title, exact: true });
}
function amounts(recipe: Recipe, hash: string, measure = "300 g"): PersonalRecipeAmounts {
  return { contentHash: hash, referenceServings: recipe.servings ?? null, amounts: [{ ingredientIndex: 0, originalName: recipe.ingredients[0].name, measure }] };
}
test.beforeEach(async ({ page, request }) => {
  await page.clock.install({ time: new Date(`${TODAY}T12:00:00+03:00`) });
  if (test.info().project.name === "mobile") await page.setViewportSize({ width: 320, height: 740 });
  await save(request, empty());
});

test("personal editor keeps drafts local and saved dinner, shopping, cooking and Chef quantities agree", async ({ page, request }) => {
  await page.goto("/");
  let drawer = await openRecipe(page);
  let editor = drawer.getByRole("region", { name: "Personal amounts", exact: true });
  await expect(editor).toContainText("2 source servings");
  const rice = editor.getByRole("textbox", { name: "Personal amount for rice", exact: true });
  await rice.fill("-1 g");
  await expect(editor.getByRole("button", { name: "Save personal amounts", exact: true })).toBeDisabled();
  expect((await read(request)).state.personalRecipeAmounts).toBeUndefined();
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(rice).toHaveValue("");
  await rice.fill("300 g");
  await editor.getByRole("button", { name: "Save personal amounts", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.personalRecipeAmounts?.["fixture-tomato-rice"]?.amounts[0].measure).toBe("300 g");
  await page.reload(); drawer = await openRecipe(page);
  editor = drawer.getByRole("region", { name: "Personal amounts", exact: true });
  await expect(editor.getByRole("textbox", { name: "Personal amount for rice", exact: true })).toHaveValue("300 g");
  await expect(editor.getByRole("textbox", { name: "Personal amount for tomato", exact: true })).toHaveValue("");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await editor.screenshot({ path: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/personal-editor-${test.info().project.name}.png`, scale: "css" });
  await drawer.getByRole("button", { name: "Choose for tonight", exact: true }).click();
  const dinner = page.getByRole("region", { name: "Chosen dinner", exact: true });
  await dinner.getByText("Adjust amounts", { exact: true }).click();
  await dinner.getByRole("spinbutton", { name: "Dinner portions", exact: true }).fill("1");
  const override = dinner.getByRole("textbox", { name: /rice amount/ });
  await expect(override).toHaveAttribute("placeholder", "150 g");
  await expect(dinner).toContainText("Personal amount · scaled for this dinner");
  await override.fill("175 g");
  await expect(dinner).toContainText("Personal amount · scaled for this dinner · Baseline: 150 g");
  await expect(dinner).toContainText("Dinner override · final amount for this dinner");
  await expect.poll(async () => (await read(request)).state.meals[TODAY]?.ingredientOverrides["0"]).toBe("175 g");
  let document = await read(request);
  const ask = async (query: string) => {
    const response = await request.post("/api/chef", { data: { query, provider: "ollama", context: { kitchenRevision: document.revision, recipeId: "fixture-tomato-rice", mealDate: TODAY, mealId: document.state.meals[TODAY].id, purpose: "planning", today: TODAY } } });
    expect(response.ok()).toBeTruthy(); return response.json();
  };
  const overridden = await ask("How much rice do I need?");
  expect(overridden.planningFacts[0]).toMatchObject({ measure: "175 g", basis: "saved_override" });
  await override.fill("");
  await expect.poll(async () => (await read(request)).state.meals[TODAY]?.ingredientOverrides["0"]).toBeUndefined();
  document = await read(request);
  expect((await ask("How much rice do I need?")).planningFacts[0]).toMatchObject({ measure: "150 g", basis: "personal_scaled" });
  const original = await ask("How much rice does the original recipe use?");
  expect(original.answer).toContain("200 g"); expect(original.planningFacts).toBeUndefined();
  await dinner.getByRole("button", { name: "Weekly shopping", exact: true }).click();
  await expect(page.locator(".shopping-item").filter({ has: page.getByText("rice", { exact: true }) })).toContainText("150 g");
  await navigate(page, "Chef");
  await page.getByRole("button", { name: "Cook dinner", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.getByText("Ingredients for this dinner", { exact: true }).click();
  const ingredients = cooking.getByRole("region", { name: "Ingredients for this dinner", exact: true });
  await expect(ingredients).toContainText("150 g"); await expect(ingredients).toContainText("Personal amount");
  await cooking.screenshot({ path: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/personal-cooking-${test.info().project.name}.png` });
});

test("changing personal defaults invalidates Chef previews and uses the new amounts on the next question", async ({ page, request }) => {
  const source = await catalog(request), recipe = source.recipes.find(item => item.id === "fixture-tomato-rice")!;
  await save(request, { ...empty(), personalRecipeAmounts: { [recipe.id]: amounts(recipe, source.contentHashesByRecipeId[recipe.id]) } });
  await page.goto("/"); let drawer = await openRecipe(page);
  await drawer.getByRole("button", { name: "Ask Chef about this recipe", exact: true }).click();
  async function ask() {
    await page.getByRole("textbox", { name: "Follow-up question", exact: true }).fill("How much rice do I need?");
    const responding = page.waitForResponse(response => response.url().endsWith("/api/chef") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Ask recipe question", exact: true }).click();
    const response = await responding; expect(response.ok()).toBeTruthy(); return response.json();
  }
  expect((await ask()).planningFacts[0].measure).toBe("300 g");
  await expect(page.locator(".chef-answer")).toContainText("300 g");
  drawer = await openRecipe(page);
  const editor = drawer.getByRole("region", { name: "Personal amounts", exact: true });
  await editor.getByRole("textbox", { name: "Personal amount for rice", exact: true }).fill("500 g");
  await editor.getByRole("button", { name: "Save personal amounts", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.personalRecipeAmounts[recipe.id].amounts[0].measure).toBe("500 g");
  await drawer.getByRole("button", { name: "Close recipe", exact: true }).click(); await navigate(page, "Chef");
  await expect(page.locator(".chef-answer")).toHaveCount(0);
  expect((await ask()).planningFacts[0]).toMatchObject({ measure: "500 g", basis: "personal_scaled" });
  await expect(page.locator(".chef-answer")).toContainText("500 g");
});

test("editing and resetting personal defaults preserves existing dinners and Cook again uses the new default", async ({ page, request }) => {
  const source = await catalog(request), recipe = source.recipes.find(item => item.id === "fixture-tomato-rice")!;
  const personal = amounts(recipe, source.contentHashesByRecipeId[recipe.id]);
  const old: PlannedMeal = { id: "old", date: "2026-10-21", recipeId: recipe.id, recipe, title: recipe.title, baseServings: 2, servings: 2, batches: 1, locked: false, status: "cooked", ingredientOverrides: {}, planningIngredients: [{ ...recipe.ingredients[0], measure: "300 g" }, recipe.ingredients[1]], personalAmountIndices: [0], completion: { id: "done", at: "2026-10-21T18:00:00.000Z", deductions: [] } };
  await save(request, { ...empty(), personalRecipeAmounts: { [recipe.id]: personal }, meals: { [old.date]: old } });
  await page.goto("/"); let drawer = await openRecipe(page);
  let editor = drawer.getByRole("region", { name: "Personal amounts", exact: true });
  await editor.getByRole("textbox", { name: "Personal amount for rice", exact: true }).fill("500 g");
  await editor.getByRole("button", { name: "Save personal amounts", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.personalRecipeAmounts[recipe.id].amounts[0].measure).toBe("500 g");
  expect((await read(request)).state.meals[old.date]).toEqual(old);
  await drawer.getByRole("button", { name: "Close recipe", exact: true }).click();
  await page.getByRole("button", { name: "Cook again", exact: true }).click();
  await page.getByRole("button", { name: "Cook again for tonight: Tomato Rice", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.meals[TODAY]?.planningIngredients[0].measure).toBe("500 g");
  const captured = (await read(request)).state.meals;
  await page.getByRole("button", { name: "Recipe details", exact: true }).click();
  drawer = page.getByRole("dialog", { name: "Tomato Rice", exact: true });
  editor = drawer.getByRole("region", { name: "Personal amounts", exact: true });
  await editor.getByRole("button", { name: "Reset to source amounts", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.personalRecipeAmounts).toEqual({});
  expect((await read(request)).state.meals).toEqual(captured);
});

test("changed source rows retain previous labels read-only and require fresh personal input", async ({ page, request }) => {
  const source = await catalog(request), recipe = source.recipes.find(item => item.id === "fixture-tomato-rice")!;
  await save(request, { ...empty(), personalRecipeAmounts: { [recipe.id]: amounts(recipe, source.contentHashesByRecipeId[recipe.id]) } });
  await page.route("**/api/recipes/catalog", async route => {
    const data = structuredClone(source); const changed = data.recipes.find(item => item.id === recipe.id)!;
    changed.ingredients.reverse(); changed.servings = 4; changed.instructions = ["Simmer gently."];
    data.contentHashesByRecipeId[recipe.id] = "b".repeat(64);
    await route.fulfill({ json: data });
  });
  await page.goto("/"); const drawer = await openRecipe(page);
  const editor = drawer.getByRole("region", { name: "Personal amounts", exact: true });
  const previous = editor.getByRole("region", { name: "Previous personal amounts", exact: true });
  await expect(previous).toContainText("2 source servings"); await expect(previous).toContainText("rice"); await expect(previous).toContainText("300 g");
  await expect(previous.getByRole("textbox")).toHaveCount(0);
  await expect(editor).toContainText("Amounts for 4 source servings");
  await expect(editor.getByRole("textbox", { name: "Personal amount for rice", exact: true })).toHaveValue("");
  await expect(editor.getByRole("textbox", { name: "Personal amount for tomato", exact: true })).toHaveValue("");
  await editor.getByRole("textbox", { name: "Personal amount for tomato", exact: true }).fill("3");
  await editor.getByRole("button", { name: "Save personal amounts", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.personalRecipeAmounts[recipe.id].amounts).toEqual([{ ingredientIndex: 0, originalName: "tomato", measure: "3" }]);
  await drawer.getByRole("button", { name: "Choose for tonight", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.meals[TODAY]?.planningIngredients).toEqual([{ name: "tomato", measure: "3" }, { name: "rice", measure: "200 g" }]);
});

test("unknown-yield batches, backup replacement and recovery retain personal amount records", async ({ page, request }) => {
  const source = await catalog(request), recipe = source.recipes.find(item => item.id === "fixture-unknown-soup")!;
  const personal = amounts(recipe, source.contentHashesByRecipeId[recipe.id], "600 ml");
  await save(request, { ...empty(), personalRecipeAmounts: { [recipe.id]: personal } });
  await page.goto("/"); const drawer = await openRecipe(page, recipe.title);
  await expect(drawer.getByRole("region", { name: "Personal amounts", exact: true })).toContainText("one recipe batch (source yield unknown)");
  await drawer.getByRole("button", { name: "Choose for tonight", exact: true }).click();
  const dinner = page.getByRole("region", { name: "Chosen dinner", exact: true });
  await dinner.getByText("Adjust amounts", { exact: true }).click();
  await dinner.getByRole("spinbutton", { name: "Dinner portions", exact: true }).fill("2");
  await expect(dinner.getByRole("textbox", { name: /vegetable stock amount/ })).toHaveAttribute("placeholder", "1200 ml");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await navigate(page, "Settings");
  const downloading = page.waitForEvent("download"); await page.getByRole("button", { name: "Export backup", exact: true }).click();
  const stream = await (await downloading).createReadStream(); const chunks = []; for await (const chunk of stream!) chunks.push(chunk);
  const backup = JSON.parse(Buffer.concat(chunks).toString()); expect(backup.state.personalRecipeAmounts[recipe.id]).toEqual(personal);
  const older = { backupVersion: 1, exportedAt: "2026-10-20T12:00:00.000Z", state: empty() };
  await page.getByLabel("Restore backup file").setInputFiles({ name: "old-kitchen.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(older)) });
  const preview = page.getByRole("region", { name: "Backup preview", exact: true });
  await expect(preview).toContainText("1 personal amount sets changed");
  await preview.getByRole("checkbox").check(); await preview.getByRole("button", { name: "Replace kitchen with backup", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.personalRecipeAmounts).toBeUndefined();
  await page.getByText(/Unsaved kitchens found/).click();
  const recovery = page.locator(".recovery-candidate").filter({ hasText: "1 personal amount sets changed" }).first();
  await recovery.getByRole("button", { name: "Recover this draft", exact: true }).click();
  await page.getByRole("button", { name: "Save this draft", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.personalRecipeAmounts?.[recipe.id]).toEqual(personal);
  await expect.poll(async () => (await read(request)).state.meals[TODAY]?.batches).toBe(2);
});
