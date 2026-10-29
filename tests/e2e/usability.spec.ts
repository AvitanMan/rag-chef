import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { KitchenState, PlannedMeal } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";

async function discussFirstRecipe(page: Page) {
  await page.locator(".recipe-card").first().getByRole("button", { name: /^View / }).click();
  await page.getByRole("button", { name: "Ask Chef about this recipe", exact: true }).click();
}

async function restartDiscovery(page: Page) {
  const change = page.getByRole("region", { name: "Chosen dinner", exact: true }).getByRole("button", { name: "Change dinner", exact: true });
  if (await change.isVisible()) await change.click();
  else await page.getByRole("button", { name: "New dinner search", exact: true }).click();
}

const TODAY = "2026-10-25";
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });
async function read(request: APIRequestContext) { return (await request.get("/api/kitchen")).json(); }
async function save(request: APIRequestContext, state: KitchenState) {
  const current = await read(request);
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state } })).ok()).toBeTruthy();
}
async function navigate(page: Page, name: string) {
  await page.getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click();
}
async function recipe(request: APIRequestContext): Promise<Recipe> {
  return (await (await request.get("/api/recipes/catalog")).json()).recipes.find((r: Recipe) => r.id === "fixture-tomato-rice");
}
function meal(source: Recipe): PlannedMeal {
  return { id: "sunday-dinner", date: TODAY, recipeId: source.id, recipe: source, title: source.title, baseServings: 2, servings: 2, batches: 1, status: "planned", locked: false, ingredientOverrides: {} };
}
test.beforeEach(async ({ page, request }) => {
  await page.clock.install({ time: new Date("2026-10-25T12:00:00+03:00") });
  await save(request, empty());
});

test("invalid pantry drafts do not block valid edits and correction saves", async ({ page, request }) => {
  await save(request, { ...empty(), pantry: [{ id: "rice", name: "rice", measure: "100 g" }, { id: "beans", name: "beans", measure: "400 g" }] });
  await page.goto("/"); await navigate(page, "Pantry");
  const rice = page.getByRole("textbox", { name: "Available rice", exact: true });
  await rice.fill("-2 g");
  await expect(rice).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toContainText("Not saved: Amount");
  await page.getByRole("textbox", { name: "Available beans", exact: true }).fill("500 g");
  await expect.poll(async () => (await read(request)).state.pantry.map((r: { measure: string }) => r.measure)).toEqual(["100 g", "500 g"]);
  await rice.fill("1/0 cup"); await expect(rice).toHaveAttribute("aria-invalid", "true");
  await rice.fill("300 g");
  await expect.poll(async () => (await read(request)).state.pantry[0].measure).toBe("300 g");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.reload(); await navigate(page, "Pantry");
  await expect(rice).toHaveValue("300 g");
});

test("servings allow clear and retype while invalid bounds and overrides stay unsaved", async ({ page, request }) => {
  const source = await recipe(request);
  await save(request, { ...empty(), meals: { [TODAY]: meal(source) } });
  await page.goto("/");
  await navigate(page, "Plan");
  const servings = page.getByRole("spinbutton", { name: "Servings Sun, Oct 25", exact: true });
  await servings.fill(""); await expect(servings).toHaveValue("");
  await servings.fill("101"); await expect(servings).toHaveAttribute("aria-invalid", "true");
  expect((await read(request)).state.meals[TODAY].servings).toBe(2);
  await servings.fill("4");
  await page.locator("#amounts-2026-10-25 > summary").click();
  const override = page.getByRole("textbox", { name: "rice amount Sun, Oct 25", exact: true });
  await override.fill("-5 g"); await servings.fill("6");
  await expect.poll(async () => (await read(request)).state.meals[TODAY].servings).toBe(6);
  expect((await read(request)).state.meals[TODAY].ingredientOverrides).toEqual({});
  await override.press("Escape"); await expect(override).toHaveValue("");
});

test("chip editing and removal handle pointer, Escape and keyboard focus without merging values", async ({ page }) => {
  await page.goto("/"); await navigate(page, "Settings");
  const input = page.getByRole("textbox", { name: "Allergies", exact: true });
  await input.pressSequentially("milk,peanut"); await input.press("Enter");
  await page.getByRole("button", { name: "Edit allergies milk", exact: true }).click();
  await input.fill("soy");
  await page.getByRole("button", { name: "Remove allergies milk", exact: true }).click();
  await expect(page.getByRole("list", { name: "Saved allergies", exact: true })).not.toContainText("soy");
  await expect(page.getByRole("button", { name: "Edit allergies peanut", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit allergies peanut", exact: true }).click();
  await input.fill("almond"); await input.press("Escape");
  await page.getByRole("button", { name: "Edit allergies peanut", exact: true }).click();
  await input.fill(",");
  await expect(page.getByRole("button", { name: "Edit allergies peanut", exact: true })).toBeVisible();
  await input.fill("egg"); await input.press("Tab");
  await page.getByLabel("Diet", { exact: false }).focus();
  await expect(page.getByRole("button", { name: "Edit allergies egg", exact: true })).toBeVisible();
  const remove = page.getByRole("button", { name: "Remove allergies peanut", exact: true });
  await remove.focus(); await remove.press("Enter");
  await expect(page.getByRole("button", { name: "Edit allergies peanut", exact: true })).toHaveCount(0);
});

test("Recipes choose tonight directly and share an explicit future date with Chef", async ({ page, request }) => {
  await page.goto("/"); await navigate(page, "Recipes");
  await page.getByRole("searchbox", { name: "Search recipes", exact: true }).fill("Tomato Rice");
  await page.getByRole("button", { name: "Choose for tonight: Tomato Rice", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Chosen dinner", exact: true })).toContainText("Tomato Rice");
  await expect.poll(async () => (await read(request)).state.meals[TODAY]?.recipeId).toBe("fixture-tomato-rice");
  await navigate(page, "Recipes");
  await page.getByLabel("Dinner day", { exact: true }).fill("2026-10-30");
  await page.getByRole("button", { name: "Choose for Friday: Tomato Rice", exact: true }).click();
  await expect(page.getByRole("region", { name: "Chosen dinner", exact: true })).toContainText("Fri, Oct 30");
  await expect.poll(async () => Object.keys((await read(request)).state.meals)).toEqual([TODAY, "2026-10-30"]);
});

test("choosing an occupied day requires confirmation and cancelling keeps its dinner", async ({ page, request }) => {
  const source = await recipe(request);
  await save(request, { ...empty(), meals: { [TODAY]: meal(source) } });
  await page.goto("/"); await navigate(page, "Recipes");
  await page.getByRole("searchbox", { name: "Search recipes", exact: true }).fill("Cheese Pasta");
  await page.getByRole("button", { name: "Choose for tonight: Cheese Pasta", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Replace dinner", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep current dinner", exact: true }).click();
  expect((await read(request)).state.meals[TODAY]).toEqual(meal(source));
});

test("long pantry removal has visible Undo and preserves later edits", async ({ page, request }) => {
  const pantry = Array.from({ length: 30 }, (_, i) => ({ id: `item-${i}`, name: `ingredient ${i}`, measure: "100 g" }));
  await save(request, { ...empty(), pantry });
  await page.goto("/"); await navigate(page, "Pantry");
  await page.getByRole("button", { name: "Remove ingredient 0", exact: true }).click();
  const recovery = page.getByRole("region", { name: "Recently removed", exact: true });
  // Removal reveals recovery on the next animation frame; wait for that layout.
  await expect(async () => {
    const box = await recovery.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  }).toPass();
  await page.getByRole("textbox", { name: "Available ingredient 1", exact: true }).fill("200 g");
  await recovery.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Available ingredient 0", exact: true })).toHaveValue("100 g");
  await expect.poll(async () => (await read(request)).state.pantry.find((r: { id: string }) => r.id === "item-1").measure).toBe("200 g");
});

test("Today is immediately actionable and saving reveals and focuses the new dinner", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "Plan");
  const today = page.getByRole("region", { name: "Today’s dinner", exact: true });
  const box = await today.boundingBox();
  expect(box!.y + box!.height).toBeLessThan(page.viewportSize()!.height);
  await today.getByRole("button", { name: "Choose tonight’s dinner", exact: true }).click();
  await page.getByRole("textbox", { name: "Ask your chef", exact: true }).fill("Tomato Rice");
  await page.getByRole("button", { name: /^(Find my dinner|Update dinner ideas)$/, exact: true }).click();
  await page.getByRole("button", { name: "Choose for tonight: Tomato Rice", exact: true }).click();
  await expect(page.getByRole("region", { name: "Chosen dinner", exact: true }).getByRole("heading", { name: "Tomato Rice", exact: true })).toBeFocused();
  const saved = await page.locator(".chosen-dinner").boundingBox();
  expect(saved!.y).toBeGreaterThanOrEqual(0); expect(saved!.y).toBeLessThan(page.viewportSize()!.height);
});

for (const count of [1, 18, 50]) {
  test(`${count}-row import keeps actions visible, including while editing the last row`, async ({ page }) => {
    await page.goto("/"); await navigate(page, "Pantry");
    const input = page.getByRole("textbox", { name: "New pantry ingredient", exact: true });
    const text = Array.from({ length: count }, (_, i) => `ingredient ${i}: 100 g`).join("\n");
    await input.fill(text); await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Review pantry ingredients", exact: true });
    const confirm = dialog.getByRole("button", { name: "Confirm ingredients", exact: true });
    let box = await confirm.boundingBox();
    expect(box!.y).toBeGreaterThan(0); expect(box!.y + box!.height).toBeLessThan(page.viewportSize()!.height);
    const last = dialog.getByRole("textbox", { name: `Amount ${count}`, exact: true });
    await last.fill("200 g");
    box = await confirm.boundingBox();
    expect(box!.y + box!.height).toBeLessThan(page.viewportSize()!.height);
    const lastBox = await last.boundingBox(); expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(box!.y);
    await page.keyboard.press("Escape");
    await expect(input).toHaveValue(text);
    await expect(page.getByRole("button", { name: "Add to pantry", exact: true })).toBeFocused();
  });
}

test("reviewed mains lead instant picks and API failure keeps safe picks with retry", async ({ page, request }) => {
  const catalog = await (await request.get("/api/recipes/catalog")).json();
  const metadataByRecipeId = Object.fromEntries(catalog.recipes.map((r: Recipe) => [r.id, { ...catalog.metadataByRecipeId[r.id], coreDinner: r.id === "fixture-vegan-beans", diets: {}, equipment: [], totalMinutes: null, provenance: {} }]));
  await page.route("**/api/recipes/catalog", route => route.fulfill({ json: { ...catalog, metadataByRecipeId } }));
  await save(request, { ...empty(), pantry: [{ id: "rice", name: "rice", measure: "200 g" }, { id: "tomato", name: "tomato", measure: "2" }] });
  await page.goto("/"); await navigate(page, "Recipes");
  await page.getByRole("button", { name: "Ask Chef", exact: true }).click();
  await expect(page.locator(".recipe-card").first()).toContainText("Garlic Beans");
  let reads = 0;
  await page.route("**/api/chef", route => ++reads === 1 ? route.fulfill({ status: 503, json: { error: { message: "Temporary test outage" } } }) : route.continue());
  await page.getByRole("textbox", { name: "Ask your chef", exact: true }).fill("Tomato Rice");
  await page.getByRole("button", { name: /^(Find my dinner|Update dinner ideas)$/, exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Temporary test outage");
  await expect(page.locator(".recipe-card")).toHaveCount(3);
  await page.getByRole("button", { name: "Retry Chef", exact: true }).click();
  await expect(page.locator(".chef-error")).toHaveCount(0);
  await expect(page.locator(".recipe-card")).toHaveCount(1);
  await expect(page.locator(".recipe-card")).toContainText("Tomato Rice");
  reads = 0;
  await page.getByRole("textbox", { name: "Ask your chef", exact: true }).fill("dairy-free dinner without peanut");
  await page.getByRole("button", { name: /^(Find my dinner|Update dinner ideas)$/, exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Temporary test outage");
  await expect(page.locator(".recipe-card")).not.toHaveCount(0);
  for (const title of ["Cheese Pasta", "Peanut Noodles"]) await expect(page.locator(".recipe-card").filter({ hasText: title })).toHaveCount(0);
});

test("preferences come first and theme follows the system until a manual choice is saved", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Dark mode", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click(); await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload(); await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await navigate(page, "Settings");
  const allergies = await page.getByRole("textbox", { name: "Allergies", exact: true }).boundingBox();
  expect(allergies!.y + allergies!.height).toBeLessThan(page.viewportSize()!.height);
  const backup = await page.getByRole("heading", { name: "Kitchen backup", exact: true }).boundingBox();
  expect(backup!.y).toBeGreaterThan(allergies!.y);
  await page.screenshot({ path: info.outputPath("settings-dark.png"), fullPage: true });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await navigate(page, "Recipes");
  await page.getByRole("searchbox", { name: "Search recipes", exact: true }).fill("Tomato Rice");
  await page.getByRole("button", { name: "View Tomato Rice", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Tomato Rice", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("recipe-dark.png") });
  expect(errors).toEqual([]);
});

test("theme toggle remains usable when preference storage cannot be written", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException("Unavailable", "QuotaExceededError"); }; });
  await page.goto("/");
  await page.getByRole("button", { name: "Dark mode", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("removal recovery stays available across navigation without covering the Chef action", async ({ page, request }) => {
  await save(request, { ...empty(), pantry: [{ id: "rice", name: "rice", measure: "500 g" }] });
  await page.goto("/"); await navigate(page, "Pantry");
  await page.getByRole("button", { name: "Remove rice", exact: true }).click();
  await navigate(page, "Chef");
  const input = page.getByRole("textbox", { name: "Ask your chef", exact: true });
  await input.fill("Tomato Rice");
  const submit = page.getByRole("button", { name: "Find my dinner", exact: true });
  await submit.scrollIntoViewIfNeeded();
  expect(await submit.evaluate(el => { const box = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBe(true);
  const recovery = page.getByRole("region", { name: "Recently removed", exact: true });
  await recovery.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(input).toHaveValue("Tomato Rice");
  await expect.poll(async () => (await read(request)).state.pantry[0]?.measure).toBe("500 g");
});

test("pantry date controls show a full date with a separate readable label at all widths", async ({ page, request }) => {
  await save(request, { ...empty(), pantry: [{ id: "rice", name: "rice", measure: "500 g", useBy: "2026-10-30" }] });
  await page.goto("/"); await navigate(page, "Pantry");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const date = page.getByRole("textbox", { name: "Use by rice", exact: true });
    await expect(date).toHaveValue("2026-10-30");
    const box = await date.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(190);
    expect(await date.evaluate(el => {
      const label = el.closest("label")!;
      const range = document.createRange(); range.selectNode(label.firstChild!);
      return range.getBoundingClientRect().bottom <= el.getBoundingClientRect().top;
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("automatic filling prefers reviewed mains and the wider collection is an explicit choice", async ({ page, request }) => {
  const catalog = await (await request.get("/api/recipes/catalog")).json();
  const mains = ["fixture-vegan-beans", "fixture-eggplant"];
  const metadataByRecipeId = Object.fromEntries(catalog.recipes.map((r: Recipe) => [r.id, { coreDinner: mains.includes(r.id), dinnerRole: mains.includes(r.id) ? "main" : "side", diets: {}, equipment: [], totalMinutes: null, provenance: {} }]));
  await page.route("**/api/recipes/catalog", route => route.fulfill({ json: { ...catalog, metadataByRecipeId } }));
  await save(request, { ...empty(), pantry: [{ id: "rice", name: "rice", measure: "500 g" }] });
  await page.goto("/"); await navigate(page, "Plan");
  await page.locator(".fill-options > summary").click();
  const preference = page.getByRole("checkbox", { name: "Prefer reviewed mains", exact: true });
  await expect(preference).toBeChecked();
  await page.getByRole("button", { name: "Fill empty days", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.meals[TODAY]?.recipeId).toMatch(/fixture-(vegan-beans|eggplant)/);
  await expect(page.getByRole("article", { name: "Sun, Oct 25", exact: true })).toContainText("Reviewed main.");
  await page.getByRole("region", { name: "Plan actions", exact: true }).getByText("More", { exact: true }).click();
  await page.getByRole("button", { name: "Clear unlocked", exact: true }).click();
  await page.getByRole("button", { name: "Remove unlocked meals", exact: true }).click();
  await preference.uncheck();
  await page.getByRole("button", { name: "Fill empty days", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.meals[TODAY]?.recipeId).toMatch(/fixture-(tomato-rice|fish-bowl)/);
});

test("Chef puts choices in view with one composer and applies refinements in one submission", async ({ page, request }) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Ask your chef", exact: true });
  await input.fill("Find a dinner with rice and tomato");
  await page.getByRole("button", { name: /^(Find my dinner|Update dinner ideas)$/, exact: true }).click();
  const first = page.locator(".recipe-card").first();
  await expect(first).toContainText("Tomato Rice");
  await expect(page.getByRole("region", { name: "Chef answer", exact: true })).toBeFocused();
  expect(await page.locator(".chef-search textarea").count()).toBe(1);
  const box = await first.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeLessThan(page.viewportSize()!.height - 100);
  await expect(page.locator(".grounding-disclosure")).not.toHaveAttribute("open");
  await expect(first.getByRole("link", { name: /Source:/ })).toBeVisible();
  await expect(first.locator(".card-source-excerpt")).toContainText("200 g rice");
  const before = await read(request);
  await input.fill("without rice");
  const outgoing = page.waitForRequest(r => r.url().endsWith("/api/chef") && r.method() === "POST");
  const response = page.waitForResponse(r => r.url().endsWith("/api/chef") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Update dinner ideas", exact: true }).click();
  expect((await outgoing).postDataJSON()).toMatchObject({ query: "Find a dinner with rice and tomato", refinements: ["without rice"] });
  expect((await response).ok()).toBeTruthy();
  await expect(page.getByRole("button", { name: "Remove refinement without rice", exact: true })).toBeVisible();
  await expect(page.locator(".recipe-card").filter({ hasText: "Tomato Rice" })).toHaveCount(0);
  const refreshed = page.waitForResponse(r => r.url().endsWith("/api/chef"));
  await page.getByRole("button", { name: "Remove refinement without rice", exact: true }).click();
  expect((await refreshed).ok()).toBeTruthy();
  await expect(page.locator(".recipe-card").first()).toContainText("Tomato Rice");
  await input.fill("Why rinse the rice?");
  const question = page.waitForRequest(r => r.url().endsWith("/api/chef") && r.method() === "POST");
  const answered = page.waitForResponse(r => r.url().endsWith("/api/chef"));
  await page.getByRole("button", { name: "Update dinner ideas", exact: true }).click();
  expect((await question).postDataJSON()).toMatchObject({ query: "Why rinse the rice?", refinements: [] });
  expect((await answered).ok()).toBeTruthy();
  expect(await read(request)).toEqual(before);
});

test("choosing from Plan has a correct return path and a single featured dinner", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Browse recipes", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Back to/ })).toHaveCount(0);
  await navigate(page, "Plan");
  await page.getByRole("button", { name: "Choose dinner Sun, Oct 25", exact: true }).click();
  await expect(page.getByRole("button", { name: "← Back to plan", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "← Back to plan", exact: true }).click();
  await expect(page.getByRole("article", { name: "Sun, Oct 25", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Choose dinner Sun, Oct 25", exact: true }).click();
  await page.getByRole("button", { name: "Choose for tonight: Beef Stew", exact: true }).click();
  await expect(page.getByRole("region", { name: "Chosen dinner", exact: true })).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Next steps for dinner", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cook dinner", exact: true })).toBeVisible();
});

test("bought ingredients reach pantry once through a reviewed preview, with safe undo", async ({ page, request }) => {
  const source = await recipe(request);
  await save(request, { ...empty(), pantry: [{ id: "rice", name: "rice", measure: "100 g" }, { id: "cooked", name: "cooked rice", measure: "500 g" }, { id: "tomato", name: "tomato", measure: "2" }], meals: { [TODAY]: meal(source) } });
  await page.goto("/"); await navigate(page, "Shopping");
  const before = (await read(request)).state;
  const checkbox = page.getByRole("checkbox", { name: "Bought rice 100 g", exact: true });
  // The row moves into the collapsed Bought section when checked.
  await checkbox.click();
  await expect(page.getByRole("button", { name: "Add bought items to pantry", exact: true })).toBeVisible();
  expect((await read(request)).state.pantry).toEqual(before.pantry);
  await page.getByRole("button", { name: "Add bought items to pantry", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Add bought items to pantry", exact: true });
  await expect(preview).toContainText("Cooked and uncooked amounts are kept separate");
  const amount = preview.getByRole("textbox", { name: "Amount bought rice", exact: true });
  await amount.fill("-1 g");
  await expect(preview.getByRole("button", { name: "Confirm pantry additions", exact: true })).toBeDisabled();
  await amount.fill("100 g");
  await preview.getByRole("button", { name: "Confirm pantry additions", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.pantry.length).toBe(4);
  const added = (await read(request)).state as KitchenState;
  expect(added.pantry.find(p => p.id === "rice")!.measure).toBe("100 g");
  expect(added.pantry.find(p => p.id === "cooked")!.measure).toBe("500 g");
  expect(added.shoppingPurchases).toHaveLength(1);
  await page.reload(); await navigate(page, "Shopping");
  await expect(page.getByRole("button", { name: "Add bought items to pantry", exact: true })).toHaveCount(0);
  await page.locator(".purchase-history > summary").click();
  await page.getByRole("button", { name: "Undo pantry additions", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.pantry).toEqual(before.pantry);
  await expect(page.getByRole("button", { name: "Add bought items to pantry", exact: true })).toBeVisible();
});

test("shopping amount review stays in place and updates the list before returning", async ({ page, request }) => {
  const source = { ...await recipe(request), ingredients: [{ name: "rice", measure: "to taste" }] };
  await save(request, { ...empty(), meals: { [TODAY]: meal(source) } });
  await page.goto("/"); await navigate(page, "Shopping");
  await page.getByRole("button", { name: "Review rice for Sun, Oct 25", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review dinner amounts", exact: true });
  await review.getByRole("textbox", { name: "rice amount Sun, Oct 25", exact: true }).fill("200 g");
  await review.getByRole("button", { name: "Back to shopping", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shopping", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Bought rice 200 g", exact: true })).toBeVisible();
  await expect.poll(async () => (await read(request)).state.meals[TODAY].ingredientOverrides["0"]).toBe("200 g");
});

test("timer setup is optional and replacing an active timer requires an explicit choice", async ({ page, request }) => {
  await save(request, { ...empty(), meals: { [TODAY]: meal(await recipe(request)) } });
  await page.goto("/"); await navigate(page, "Plan");
  await page.getByRole("button", { name: "Cook this dinner", exact: true }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await expect(cooking.getByRole("region", { name: "Timer setup", exact: true })).toHaveCount(0);
  await expect(cooking.getByRole("button", { name: "Resume timer", exact: true })).toHaveCount(0);
  await cooking.getByRole("button", { name: "Set timer", exact: true }).click();
  await cooking.getByRole("button", { name: "Start 5 min timer", exact: true }).click();
  await page.clock.fastForward("00:00:30");
  await expect(cooking.getByRole("timer")).toHaveText("04:30");
  await cooking.getByRole("button", { name: "Change timer", exact: true }).click();
  await cooking.getByRole("button", { name: "Start 1 min timer", exact: true }).click();
  await expect(cooking.getByRole("alert")).toContainText("Replace your running timer");
  await expect(cooking.getByRole("timer")).toHaveText("04:30");
  await cooking.getByRole("button", { name: "Keep current timer", exact: true }).click();
  await expect(cooking.getByRole("timer")).toHaveText("04:30");
  await cooking.getByRole("button", { name: "Start 1 min timer", exact: true }).click();
  await cooking.getByRole("button", { name: "Replace timer", exact: true }).click();
  await expect(cooking.getByRole("timer")).toHaveText("01:00");
  await expect(cooking.getByRole("region", { name: "Timer setup", exact: true })).toHaveCount(0);
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await expect(cooking.getByRole("timer")).toHaveText("01:00");
});

test("a seventh refinement keeps all six existing exclusions and retains its draft", async ({ page }) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Ask your chef", exact: true });
  await input.fill("Tomato Rice");
  await page.getByRole("button", { name: "Find my dinner", exact: true }).click();
  await expect(page.locator(".chef-answer")).toBeVisible();
  const filters = ["without salmon", "without peanuts", "without milk", "without eggs", "without lentils", "without mushrooms"];
  for (const filter of filters) {
    await input.fill(filter);
    const response = page.waitForResponse(r => r.url().endsWith("/api/chef"));
    await page.getByRole("button", { name: "Update dinner ideas", exact: true }).click();
    expect((await response).ok()).toBeTruthy();
  }
  await input.fill("without tomato");
  await page.getByRole("button", { name: "Update dinner ideas", exact: true }).click();
  await expect(input).toHaveValue("without tomato");
  await expect(page.locator(".chef-refinements button")).toHaveCount(6);
  for (const filter of filters) await expect(page.getByRole("button", { name: `Remove refinement ${filter}`, exact: true })).toBeVisible();
  await expect(page.getByText(/Six refinements are active/)).toBeVisible();
});

for (const question of ["What can I cook with eggplant?", "Can you find a dinner with eggplant?"]) {
  test(`Chef refinements and chip removal keep the latest dinner question: ${question}`, async ({ page }) => {
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "Ask your chef", exact: true });
    async function submit(text: string, button: string) {
      await input.fill(text);
      const response = page.waitForResponse(r => r.url().endsWith("/api/chef") && r.request().method() === "POST");
      await page.getByRole("button", { name: button, exact: true }).click();
      const result = await response;
      expect(result.ok()).toBeTruthy();
      return result.request().postDataJSON();
    }
    await submit("Find a dinner with rice and tomato", "Find my dinner");
    await expect(page.locator(".chef-request")).toHaveText("Find a dinner with rice and tomato");
    await submit("without fish", "Update dinner ideas");
    await expect(page.getByRole("button", { name: "Remove refinement without fish", exact: true })).toBeVisible();
    expect(await submit(question, "Update dinner ideas")).toMatchObject({ query: question, refinements: ["without fish"] });
    await expect(page.locator(".chef-request")).toHaveText(question);
    expect(await submit("without milk", "Update dinner ideas")).toMatchObject({ query: question, refinements: ["without fish", "without milk"] });
    const refreshed = page.waitForResponse(r => r.url().endsWith("/api/chef") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Remove refinement without fish", exact: true }).click();
    const response = await refreshed;
    expect(response.ok()).toBeTruthy();
    expect(response.request().postDataJSON()).toMatchObject({ query: question, refinements: ["without milk"] });
    await expect(page.locator(".chef-request")).toHaveText(question);
  });
}

test("oversized dinner refinements preserve the draft and choices until corrected without truncating exclusions", async ({ page, request }) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Ask your chef", exact: true });
  await input.fill("Find a dinner with rice and tomato");
  await page.getByRole("button", { name: "Find my dinner", exact: true }).click();
  await expect(page.locator(".recipe-card").first()).toContainText("Tomato Rice");
  const before = await read(request);
  const oversized = "a comforting dinner. ".repeat(10) + "without rice";
  await input.fill(oversized);
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toContainText("Keep dinner refinements to 200 characters");
  await expect(page.getByRole("button", { name: "Update dinner ideas", exact: true })).toBeDisabled();
  await input.press("Control+Enter");
  await expect(input).toHaveValue(oversized);
  await expect(page.locator(".chef-refinements button")).toHaveCount(0);
  await expect(page.locator(".recipe-card").first()).toContainText("Tomato Rice");
  const corrected = "comforting. ".repeat(15).padEnd(188, " ") + "without rice";
  expect(corrected.length).toBe(200);
  await input.fill(corrected);
  await expect(input).toHaveAttribute("aria-invalid", "false");
  await expect(page.getByRole("alert")).toHaveCount(0);
  const response = page.waitForResponse(r => r.url().endsWith("/api/chef") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Update dinner ideas", exact: true }).click();
  const result = await response;
  expect(result.ok()).toBeTruthy();
  expect(result.request().postDataJSON().refinements).toEqual([corrected]);
  expect((await result.json()).retrieval.constraintExcludedCount).toBeGreaterThan(0);
  await expect(page.locator(".chef-refinements button")).toHaveText([`${corrected} ×`]);
  await expect(page.locator(".recipe-card").filter({ hasText: "Tomato Rice" })).toHaveCount(0);
  expect(await read(request)).toEqual(before);
  await restartDiscovery(page);
  const longQuestion = "What can I cook with eggplant? " + "Please use the approved recipe collection. ".repeat(5);
  await input.fill(longQuestion);
  await expect(input).toHaveAttribute("aria-invalid", "false");
  await expect(page.getByRole("button", { name: "Find my dinner", exact: true })).toBeEnabled();
});

test("a second bought batch of the same shortage can reach pantry after the first dinner is cooked", async ({ page, request }) => {
  const source = { ...await recipe(request), ingredients: [{ name: "rice", measure: "200 g" }] };
  const firstDate = "2026-10-24";
  await save(request, { ...empty(), meals: { [firstDate]: { ...meal(source), id: "saturday-dinner", date: firstDate } } });
  await page.goto("/"); await navigate(page, "Shopping");
  await page.getByRole("checkbox", { name: "Bought rice 200 g", exact: true }).click();
  await page.getByRole("button", { name: "Add bought items to pantry", exact: true }).click();
  await page.getByRole("dialog", { name: "Add bought items to pantry", exact: true }).getByRole("button", { name: "Confirm pantry additions", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.shoppingPurchases?.length).toBe(1);
  await navigate(page, "Plan");
  await page.getByRole("button", { name: /^Cook Tomato Rice / }).click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await cooking.getByRole("button", { name: "Finish cooking", exact: true }).click();
  const finish = page.getByRole("region", { name: "Complete dinner", exact: true });
  await finish.getByRole("checkbox").check();
  await finish.getByRole("button", { name: "Mark dinner cooked", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.pantry[0]?.measure).toBe("0 g");
  const used = (await read(request)).state as KitchenState;
  expect(used.meals[firstDate].status).toBe("cooked");
  await save(request, { ...used, meals: { ...used.meals, [TODAY]: meal(source) } });
  await page.reload(); await navigate(page, "Shopping");
  await expect(page.getByRole("button", { name: "Add bought items to pantry", exact: true })).toHaveCount(0);
  await page.locator(".bought-items > summary").click();
  const bought = page.getByRole("checkbox", { name: "Bought rice 200 g", exact: true });
  await expect(bought).toBeChecked();
  await bought.click();
  await bought.click();
  await page.getByRole("button", { name: "Add bought items to pantry", exact: true }).click();
  await page.getByRole("dialog", { name: "Add bought items to pantry", exact: true }).getByRole("button", { name: "Confirm pantry additions", exact: true }).click();
  await expect.poll(async () => (await read(request)).state.shoppingPurchases?.length).toBe(2);
  const updated = (await read(request)).state as KitchenState;
  expect(updated.pantry.map(p => p.measure)).toEqual(["0 g", "200 g"]);
  const [first, second] = updated.shoppingPurchases!;
  expect(first.items[0].key).toBe(second.items[0].key);
  expect(first.items[0].cycleId).not.toBe(second.items[0].cycleId);
  await page.reload(); await navigate(page, "Shopping");
  await expect(page.getByRole("button", { name: "Add bought items to pantry", exact: true })).toHaveCount(0);
  expect((await read(request)).state.pantry).toEqual(updated.pantry);
});

test("a day chosen in Plan survives browsing, recipe discussion and starting a new search", async ({ page, request }) => {
  const friday = "2026-10-30";
  await page.goto("/"); await navigate(page, "Plan");
  await page.getByRole("button", { name: "Next week", exact: true }).click();
  await page.getByRole("button", { name: "Choose dinner Fri, Oct 30", exact: true }).click();
  await page.getByRole("button", { name: "Browse recipes", exact: true }).click();
  await page.getByRole("button", { name: "Ask Chef", exact: true }).click();
  await discussFirstRecipe(page);
  await expect(page.getByRole("textbox", { name: "Dinner day", exact: true })).toHaveValue(friday);
  await restartDiscovery(page);
  await expect(page.getByRole("textbox", { name: "Dinner day", exact: true })).toHaveValue(friday);
  await expect(page.getByRole("status").filter({ hasText: "Choosing dinner for Friday, October 30." })).toBeVisible();
  await page.getByRole("button", { name: "Choose for Friday: Beef Stew", exact: true }).click();
  await expect.poll(async () => Object.keys((await read(request)).state.meals)).toEqual([friday]);
});
