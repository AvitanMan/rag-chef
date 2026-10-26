import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { KitchenState, PlannedMeal } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";

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
async function picker(page: Page) {
  await navigate(page, "Recipes");
  await page.getByRole("searchbox", { name: "Search recipes", exact: true }).fill("Tomato Rice");
  await page.getByRole("button", { name: "Add to plan: Tomato Rice", exact: true }).click();
  return page.getByRole("dialog", { name: "Choose dinner day", exact: true });
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

test("Sunday and future weeks default to upcoming empty dates", async ({ page }) => {
  await page.goto("/");
  let dialog = await picker(page);
  await expect(dialog.getByRole("combobox", { name: "Dinner date", exact: true })).toHaveValue(TODAY);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await navigate(page, "Plan"); await page.getByRole("button", { name: "Next week", exact: true }).click();
  dialog = await picker(page);
  await expect(dialog.getByRole("combobox", { name: "Dinner date", exact: true })).toHaveValue("2026-10-26");
});

test("occupied Sunday and historical weeks require an explicit picker date", async ({ page, request }) => {
  const source = await recipe(request);
  await save(request, { ...empty(), meals: { [TODAY]: meal(source) } });
  await page.goto("/");
  let dialog = await picker(page);
  await expect(dialog.getByRole("combobox", { name: "Dinner date", exact: true })).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Add dinner", exact: true })).toBeDisabled();
  await dialog.getByRole("combobox", { name: "Dinner date", exact: true }).selectOption(TODAY);
  await expect(dialog.getByRole("button", { name: "Replace dinner…", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await navigate(page, "Plan"); await page.getByRole("button", { name: "Previous week", exact: true }).click();
  dialog = await picker(page);
  await expect(dialog.getByRole("combobox", { name: "Dinner date", exact: true })).toHaveValue("");
  await dialog.getByRole("combobox", { name: "Dinner date", exact: true }).selectOption("2026-10-12");
  await expect(dialog.getByRole("button", { name: "Add dinner", exact: true })).toBeEnabled();
});

test("long pantry removal has visible Undo and preserves later edits", async ({ page, request }) => {
  const pantry = Array.from({ length: 30 }, (_, i) => ({ id: `item-${i}`, name: `ingredient ${i}`, measure: "100 g" }));
  await save(request, { ...empty(), pantry });
  await page.goto("/"); await navigate(page, "Pantry");
  await page.getByRole("button", { name: "Remove ingredient 0", exact: true }).click();
  const recovery = page.getByRole("region", { name: "Recently removed", exact: true });
  const box = await recovery.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
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
  await page.getByRole("button", { name: "Find my dinner", exact: true }).click();
  await page.getByRole("button", { name: "Add to Sunday: Tomato Rice", exact: true }).click();
  await expect(page.getByRole("article", { name: "Sun, Oct 25", exact: true })).toBeFocused();
  const saved = await page.locator("#dinner-2026-10-25").boundingBox();
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
  await page.getByRole("button", { name: "Find my dinner", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Temporary test outage");
  await expect(page.locator(".recipe-card")).toHaveCount(3);
  await page.getByRole("button", { name: "Retry Chef", exact: true }).click();
  await expect(page.locator(".chef-error")).toHaveCount(0);
  await expect(page.locator(".recipe-card")).toHaveCount(1);
  await expect(page.locator(".recipe-card")).toContainText("Tomato Rice");
  reads = 0;
  await page.getByRole("textbox", { name: "Ask your chef", exact: true }).fill("dairy-free dinner without peanut");
  await page.getByRole("button", { name: "Find my dinner", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Temporary test outage");
  await expect(page.locator(".recipe-card")).not.toHaveCount(0);
  for (const title of ["Cheese Pasta", "Peanut Noodles"]) await expect(page.locator(".recipe-card").filter({ hasText: title })).toHaveCount(0);
});

test("preferences come first and theme follows the system until a manual choice is saved", async ({ page }, info) => {
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
