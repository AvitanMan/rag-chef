import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { KitchenDocument, KitchenState, PlannedMeal } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";

const TODAY = "2026-10-22";
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });

async function document(request: APIRequestContext): Promise<KitchenDocument> {
  const response = await request.get("/api/kitchen");
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function read(request: APIRequestContext): Promise<KitchenState> {
  const saved = await document(request);
  expect(saved.state).not.toBeNull();
  return saved.state!;
}
async function save(request: APIRequestContext, state: KitchenState) {
  const current = await document(request);
  const response = await request.put("/api/kitchen", { data: { revision: current.revision, state } });
  expect(response.ok(), await response.text()).toBeTruthy();
}
async function navigate(page: Page, name: string) {
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click();
}
async function openPantry(page: Page) {
  await page.goto("/");
  await navigate(page, "Pantry");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
}
async function previewInput(page: Page, text: string) {
  await page.getByRole("textbox", { name: "New pantry ingredient", exact: true }).fill(text);
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Review pantry ingredients", exact: true });
  await expect(preview).toBeVisible();
  return preview;
}
function total(group: Locator, label: string) {
  return group.locator(".pantry-group-totals > div").filter({ hasText: label }).locator("dd");
}
async function source(request: APIRequestContext): Promise<Recipe> {
  const response = await request.get("/api/recipes/catalog");
  const catalog = await response.json();
  const recipe = catalog.recipes.find((recipe: Recipe) => recipe.id === "fixture-tomato-rice");
  expect(recipe).toBeTruthy();
  return recipe;
}
function meal(recipe: Recipe, date = TODAY, amount = "200 g"): PlannedMeal {
  const ingredients = [{ name: "rice", measure: amount }];
  return { id: `meal:${date}`, date, recipeId: recipe.id, recipe: { ...recipe, ingredients }, title: recipe.title,
    baseServings: recipe.servings ?? null, servings: recipe.servings ?? null, batches: 1,
    ingredientOverrides: {}, planningIngredients: ingredients, status: "planned", locked: false };
}
async function editBatch(page: Page, id: string, name: string) {
  await page.locator(`#pantry-row-${id}`).getByRole("button", { name: `Edit batch ${name}`, exact: true }).click();
  const editor = page.getByRole("dialog", { name: `Edit batch ${name}`, exact: true });
  await expect(editor).toBeVisible();
  return editor;
}

function nativeDateState(date: Locator) {
  return date.evaluate((input: HTMLInputElement) => ({ value: input.value, badInput: input.validity.badInput, rangeOverflow: input.validity.rangeOverflow, valid: input.validity.valid }));
}
async function enterInvalidNativeDate(date: Locator, startingDate: "blank" | "valid", isMobile: boolean) {
  await expect.poll(() => nativeDateState(date)).toEqual({ value: startingDate === "valid" ? TODAY : "", badInput: false, rangeOverflow: false, valid: true });
  // Desktop exposes incomplete segments; mobile whole-date pickers instead support a real range overflow.
  // Both paths must leave native validity false, without substituting a mocked badInput state.
  if (isMobile) {
    await expect(date).toHaveAttribute("max", "9999-12-31");
    await date.fill("10000-10-22");
  } else {
    await date.focus();
    await date.press(startingDate === "blank" ? "ArrowUp" : "Backspace");
  }
  const invalid = isMobile
    ? { value: "10000-10-22", badInput: false, rangeOverflow: true, valid: false }
    : { value: "", badInput: true, rangeOverflow: false, valid: false };
  await expect.poll(() => nativeDateState(date)).toEqual(invalid);
  return invalid;
}
async function commitDate(date: Locator, isMobile: boolean) {
  if (isMobile) {
    await date.blur();
    // Whole-date pickers can retain focus after blur(); moving it ensures a real native blur event.
    await date.page().getByRole("searchbox", { name: "Search pantry", exact: true }).focus();
  } else await date.press("Enter");
  await expect(date).not.toBeFocused();
}

test.beforeEach(async ({ page, request }) => {
  await page.clock.install({ time: new Date("2026-10-22T12:00:00+03:00") });
  await page.route("**/api/chef", route => route.abort());
  await save(request, empty());
});

test("an ambiguous single ingredient requires review, keeps its original text and saves only the confirmed amount and date", async ({ page, request }) => {
  await openPantry(page);
  const before = await document(request);
  let preview = await previewInput(page, "2 large onions");
  await expect(preview.getByRole("textbox", { name: "Ingredient 1", exact: true })).toHaveValue("2 large onions");
  await expect(preview.getByRole("textbox", { name: "Amount 1", exact: true })).toHaveValue("");
  await expect(preview).toContainText("Original input: 2 large onions");
  await expect(preview).toContainText("Text was kept unchanged");
  expect(await document(request)).toEqual(before);
  await preview.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "New pantry ingredient", exact: true })).toHaveValue("2 large onions");
  expect(await document(request)).toEqual(before);

  preview = await previewInput(page, "2 large onions");
  await preview.getByRole("textbox", { name: "Ingredient 1", exact: true }).fill("onion");
  await preview.getByRole("textbox", { name: "Amount 1", exact: true }).fill("2");
  await preview.getByLabel("Use by 1", { exact: true }).fill("2026-10-25");
  expect(await document(request)).toEqual(before);
  await preview.getByRole("button", { name: "Confirm ingredients", exact: true }).click();
  await expect.poll(async () => (await read(request)).pantry.length).toBe(1);
  const [added] = (await read(request)).pantry;
  expect(added).toEqual({ id: expect.any(String), name: "onion", measure: "2", useBy: "2026-10-25" });
  await expect(page.locator(`#pantry-row-${added.id}`)).toContainText("Just added");
  await page.reload(); await navigate(page, "Pantry");
  await expect(page.getByRole("textbox", { name: "Available onion", exact: true })).toHaveValue("2");
  await expect(page.getByLabel("Use by onion", { exact: true })).toHaveValue("2026-10-25");
  expect((await read(request)).pantry).toEqual([added]);
});

test("duplicate ingredients require an explicit new-batch confirmation and never merge amounts, dates or IDs", async ({ page, request }) => {
  const existing = { id: "existing-rice", name: "rice", measure: "100 g", useBy: TODAY };
  await save(request, { ...empty(), pantry: [existing] });
  await openPantry(page);
  const before = await document(request);
  await page.getByRole("button", { name: "Add another batch of rice", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "New pantry ingredient", exact: true })).toHaveValue("rice");
  await expect(page.getByRole("textbox", { name: "New pantry ingredient", exact: true })).toBeFocused();
  expect(await document(request)).toEqual(before);

  let preview = await previewInput(page, "raw rice: 200 g");
  await expect(preview).toContainText("Already in your pantry");
  await expect(preview).toContainText("Existing batch 1: rice · 100 g · Use by 2026-10-22");
  await preview.getByLabel("Use by 1", { exact: true }).fill("2026-10-24");
  expect(await document(request)).toEqual(before);
  await preview.getByRole("button", { name: "Confirm new batch", exact: true }).click();
  await expect.poll(async () => (await read(request)).pantry.length).toBe(2);

  preview = await previewInput(page, "rice: 300 g\nraw rice: 400 g");
  await expect(preview).toContainText("Each row will be added as a separate batch; amounts and dates will not be merged");
  await expect(preview.getByRole("button", { name: "Confirm new batches", exact: true })).toBeEnabled();
  await preview.getByLabel("Use by 1", { exact: true }).fill("2026-10-25");
  await preview.getByLabel("Use by 2", { exact: true }).fill("2026-10-26");
  await preview.getByRole("button", { name: "Confirm new batches", exact: true }).click();
  await expect.poll(async () => (await read(request)).pantry.length).toBe(4);
  const pantry = (await read(request)).pantry;
  expect(pantry[0]).toEqual(existing);
  expect(pantry.map(({ name, measure, useBy }) => ({ name, measure, useBy }))).toEqual([
    { name: "rice", measure: "100 g", useBy: TODAY }, { name: "raw rice", measure: "200 g", useBy: "2026-10-24" },
    { name: "rice", measure: "300 g", useBy: "2026-10-25" }, { name: "raw rice", measure: "400 g", useBy: "2026-10-26" },
  ]);
  expect(new Set(pantry.map(stock => stock.id)).size).toBe(4);
  await expect(page.getByRole("region", { name: "rice", exact: true }).locator(".pantry-batch-row")).toHaveCount(4);

  preview = await previewInput(page, "rice: 999 g");
  await preview.getByRole("button", { name: "Correct existing rice batch 1 for ingredient 1", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.locator("#pantry-row-existing-rice").getByRole("textbox", { name: "Available rice", exact: true })).toBeFocused();
  expect((await read(request)).pantry).toEqual(pantry);
});

test("entry dates distinguish past, use-soon and unknown dates without erasing physical on-hand stock", async ({ page, request }) => {
  await openPantry(page);
  const preview = await previewInput(page, "rice: 100 g\nbeans: 2 cans\nsalt");
  await preview.getByLabel("Use by 1", { exact: true }).fill("2026-10-21");
  await preview.getByLabel("Use by 2", { exact: true }).fill("2026-10-25");
  await expect(preview.getByLabel("Use by 3", { exact: true })).toHaveValue("");
  await preview.getByRole("button", { name: "Confirm ingredients", exact: true }).click();
  await expect.poll(async () => (await read(request)).pantry.length).toBe(3);
  const pantry = (await read(request)).pantry;
  expect(pantry.map(stock => stock.useBy)).toEqual(["2026-10-21", "2026-10-25", undefined]);
  expect(pantry[2]).toEqual({ id: expect.any(String), name: "salt", measure: "" });
  const rice = page.getByRole("region", { name: "rice", exact: true });
  await expect(total(rice, "Amount on hand")).toHaveText("100 g");
  await expect(total(rice, "Available today after reservations")).toHaveText("0 confirmed");
  await expect(rice).toContainText("Still included in physical on-hand totals");
  await page.getByRole("button", { name: "Past entered date (1)", exact: true }).click();
  await expect(page.locator(".pantry-batch-row")).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Available rice", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use soon (1)", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Available beans", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "No date entered (1)", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Available salt", exact: true })).toHaveValue("");
  expect((await read(request)).pantry).toEqual(pantry);
});

test("canonical groups total only compatible dimensions while all batches and material forms remain separate", async ({ page, request }) => {
  const pantry = [
    { id: "mass-a", name: "tomato", measure: ".25 kg", useBy: TODAY },
    { id: "mass-b", name: "tomatoes", measure: "500 g", useBy: "2026-10-24" },
    { id: "cup", name: "tomato", measure: "1 cup" }, { id: "ml", name: "tomato", measure: "250 ml" },
    { id: "cans", name: "tomato", measure: "2 cans" }, { id: "pieces", name: "tomato", measure: "3" },
    { id: "canned", name: "canned tomato", measure: "400 g" },
  ];
  await save(request, { ...empty(), pantry });
  await openPantry(page);
  const group = page.getByRole("region", { name: "tomato", exact: true });
  await expect(group.locator(".pantry-batch-row")).toHaveCount(6);
  await expect(total(group, "Amount on hand")).toHaveText("750 g · 490 ml · 2 cans · 3");
  await expect(total(group, "Available today after reservations")).toHaveText("750 g · 490 ml · 2 cans · 3");
  await expect(total(page.getByRole("region", { name: "canned tomato", exact: true }), "Amount on hand")).toHaveText("400 g");
  await expect(page.locator("#pantry-row-mass-a").getByRole("textbox", { name: "Available tomato", exact: true })).toHaveValue(".25 kg");
  await expect(page.locator("#pantry-row-cans")).toContainText("Package contents are not converted to weight, volume or other counts");
  await page.getByRole("searchbox", { name: "Search pantry", exact: true }).fill("tomatoes");
  await expect(group.locator(".pantry-batch-row")).toHaveCount(1);
  await expect(group).toContainText("Totals include all 6 batches of this ingredient; 1 shown in this view");
  await expect(total(group, "Amount on hand")).toHaveText("750 g · 490 ml · 2 cans · 3");
  expect((await read(request)).pantry).toEqual(pantry);
  expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("decimal and date drafts commit only on blur or Enter and a filtered row stays pinned while editing", async ({ page, request }) => {
  const pantry = [{ id: "early", name: "rice", measure: "100 g", useBy: TODAY }, { id: "later", name: "raw rice", measure: "200 g", useBy: "2026-10-25" }];
  await save(request, { ...empty(), pantry });
  await openPantry(page);
  await page.getByRole("combobox", { name: "Sort pantry", exact: true }).selectOption("useBy");
  await page.getByRole("button", { name: "Use soon (2)", exact: true }).click();
  const row = page.locator("#pantry-row-early");
  const amount = row.getByRole("textbox", { name: "Available rice", exact: true });
  const date = row.getByLabel("Use by rice", { exact: true });
  const writes: string[] = [];
  page.on("request", request => { if (request.method() === "PUT" && request.url().endsWith("/api/kitchen")) writes.push(request.postData() ?? ""); });
  await amount.fill("0");
  await page.clock.runFor(600);
  await expect(amount).toBeFocused();
  await expect(row).toBeVisible();
  await amount.pressSequentially(".");
  await page.clock.runFor(600);
  await amount.pressSequentially("5 kg");
  await page.clock.runFor(600);
  expect(writes).toEqual([]);
  expect((await read(request)).pantry).toEqual(pantry);
  await amount.press("Tab");
  await expect(date).toBeFocused();
  await expect.poll(async () => (await read(request)).pantry[0].measure).toBe("0.5 kg");

  await date.fill("2026-10-28");
  expect((await read(request)).pantry[0].useBy).toBe(TODAY);
  await amount.focus();
  await expect.poll(async () => (await read(request)).pantry[0].useBy).toBe("2026-10-28");
  await expect(page.getByRole("button", { name: "Use soon (1)", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(row).toBeVisible();
  await expect(amount).toBeFocused();
  expect(await page.locator(".pantry-batch-row").evaluateAll(rows => rows.map(row => row.id))).toEqual(["pantry-row-early", "pantry-row-later"]);
  await amount.fill("0 g");
  await amount.press("Tab");
  await expect.poll(async () => (await read(request)).pantry[0].measure).toBe("0 g");
  await expect(date).toBeFocused();
  await expect(row).toBeVisible();
  await page.getByRole("searchbox", { name: "Search pantry", exact: true }).focus();
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "All items (2)", exact: true }).click();
  await amount.fill("125.5 g");
  await amount.press("Enter");
  await expect.poll(async () => (await read(request)).pantry[0].measure).toBe("125.5 g");
  expect((await read(request)).pantry[1]).toEqual(pantry[1]);
});

test("correction, compatible usage and marking finished preserve the batch ID and leave its neighbours untouched", async ({ page, request }) => {
  const pantry = [{ id: "correct-me", name: "rice", measure: "500 g", useBy: TODAY }, { id: "other-rice", name: "raw rice", measure: "300 g", useBy: "2026-10-25" }];
  await save(request, { ...empty(), pantry });
  await openPantry(page);
  let editor = await editBatch(page, "correct-me", "rice");
  await expect(editor).toContainText("Correcting the name does not cook food or convert its amount");
  await editor.getByLabel("Ingredient name / form", { exact: true }).fill("cooked rice");
  await editor.getByLabel("Amount on hand", { exact: true }).fill("0.4 kg");
  await editor.getByLabel("Use by · entered planning date", { exact: true }).fill("2026-10-24");
  expect((await read(request)).pantry).toEqual(pantry);
  await editor.getByRole("button", { name: "Save batch correction", exact: true }).click();
  const corrected = { id: "correct-me", name: "cooked rice", measure: "0.4 kg", useBy: "2026-10-24" };
  await expect.poll(async () => (await read(request)).pantry).toEqual([corrected, pantry[1]]);
  await editor.getByRole("button", { name: "Done", exact: true }).click();

  editor = await editBatch(page, "correct-me", "cooked rice");
  await editor.getByRole("button", { name: "Record usage", exact: true }).click();
  await editor.getByLabel("Amount used from this batch", { exact: true }).fill("1 cup");
  await expect(editor.getByRole("alert")).toContainText("Use compatible units");
  await expect(editor.getByRole("button", { name: "Subtract usage", exact: true })).toBeDisabled();
  await editor.getByLabel("Amount used from this batch", { exact: true }).fill("500 g");
  await expect(editor.getByRole("alert")).toContainText("Usage cannot exceed");
  await editor.getByLabel("Amount used from this batch", { exact: true }).fill("100 g");
  expect((await read(request)).pantry).toEqual([corrected, pantry[1]]);
  await editor.getByRole("button", { name: "Subtract usage", exact: true }).click();
  await expect.poll(async () => (await read(request)).pantry).toEqual([{ ...corrected, measure: "300 g" }, pantry[1]]);
  await editor.getByRole("button", { name: "Done", exact: true }).click();

  editor = await editBatch(page, "correct-me", "cooked rice");
  await editor.getByRole("button", { name: "Mark finished", exact: true }).click();
  await editor.getByRole("button", { name: "Confirm finished batch", exact: true }).click();
  await expect.poll(async () => (await read(request)).pantry).toEqual([{ ...corrected, measure: "0 g" }, pantry[1]]);
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("#pantry-row-correct-me")).toContainText("Pantry amount is zero");
  await page.getByRole("button", { name: "Use soon (1)", exact: true }).click();
  await expect(page.locator("#pantry-row-correct-me")).toHaveCount(0);
  await expect(page.locator("#pantry-row-other-rice")).toBeVisible();
  await page.reload(); await navigate(page, "Pantry");
  expect((await read(request)).pantry).toEqual([{ ...corrected, measure: "0 g" }, pantry[1]]);
});

test("unknown stock cannot fill a shortage and reservations use the full pantry for only the selected week", async ({ page, request }) => {
  const recipe = await source(request);
  const pantry = [
    { id: "past", name: "rice", measure: "50 g", useBy: "2026-10-21" },
    { id: "early", name: "rice", measure: "100 g", useBy: TODAY },
    { id: "later", name: "raw rice", measure: "500 g", useBy: "2026-11-05" },
    { id: "unknown", name: "rice", measure: "some" }, { id: "volume", name: "rice", measure: "1 cup" },
  ];
  const meals = { [TODAY]: meal(recipe), "2026-10-23": meal(recipe, "2026-10-23", "500 g"), "2026-10-29": meal(recipe, "2026-10-29", "1000 g") };
  await save(request, { ...empty(), pantry, meals });
  await openPantry(page);
  const group = page.getByRole("region", { name: "rice", exact: true });
  await expect(total(group, "Amount on hand")).toContainText("650 g · 240 ml");
  await expect(total(group, "Amount on hand")).toContainText("Plus 1 batch with an unknown amount");
  await expect(total(group, "Reserved for selected week")).toHaveText("600 g");
  await expect(total(group, "Available today after reservations")).toHaveText("240 ml");
  await expect(page.locator("#pantry-row-unknown")).toContainText("No confirmed reservation or availability for an unknown amount");
  await page.getByRole("searchbox", { name: "Search pantry", exact: true }).fill("raw");
  await expect(group.locator(".pantry-batch-row")).toHaveCount(1);
  await expect(group).toContainText("Totals include all 5 batches");
  await expect(total(group, "Reserved for selected week")).toHaveText("600 g");
  await expect(page.locator("#pantry-row-later")).toContainText("Reserved for selected week: 500 g");
  await navigate(page, "Shopping");
  await expect(page.getByRole("checkbox", { name: "Bought rice 100 g", exact: true })).toBeVisible();
  await page.locator(".shopping-item").filter({ has: page.getByRole("checkbox", { name: "Bought rice 100 g", exact: true }) }).locator(".calculation-details > summary").click();
  await expect(page.locator(".shopping-item").filter({ hasText: "Pantry amount “some” is unknown" })).toBeVisible();

  await navigate(page, "Plan");
  await page.getByRole("button", { name: "Next week", exact: true }).click();
  await navigate(page, "Pantry");
  await expect(total(group, "Reserved for selected week")).toHaveText("500 g");
  await expect(total(group, "Available today after reservations")).toHaveText("100 g · 240 ml");
  expect((await read(request)).pantry).toEqual(pantry);
  expect((await read(request)).meals).toEqual(meals);
});

test("Use Soon empty review clears search and opens undated batches, including through history", async ({ page, request }) => {
  const pantry = [{ id: "undated", name: "rice", measure: "" }, { id: "empty", name: "beans", measure: "0 g" }, { id: "future", name: "milk", measure: "1 l", useBy: "2026-10-30" }];
  await save(request, { ...empty(), pantry });
  await openPantry(page);
  await page.getByRole("searchbox", { name: "Search pantry", exact: true }).fill("not present");
  await navigate(page, "Chef");
  const summary = page.getByRole("region", { name: "Use soon", exact: true });
  await summary.locator("summary").click();
  await expect(summary).toContainText("Food without a date may still need attention");
  await summary.getByRole("button", { name: "Review pantry", exact: true }).click();
  const filter = page.getByRole("button", { name: "No date entered (1)", exact: true });
  await expect(filter).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("searchbox", { name: "Search pantry", exact: true })).toHaveValue("");
  await expect(page.locator("#pantry-row-undated")).toBeVisible();
  await expect(page.locator("#pantry-row-empty")).toHaveCount(0);
  await navigate(page, "Recipes");
  await page.goBack();
  await expect(filter).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#pantry-row-undated")).toBeVisible();
  expect((await read(request)).pantry).toEqual(pantry);
});

test("Chef pantry chips review the grouped batches instead of deleting any stock", async ({ page, request }) => {
  const pantry = [{ id: "first", name: "rice", measure: "100 g", useBy: TODAY }, { id: "second", name: "raw rice", measure: "some" }, { id: "finished", name: "rice", measure: "0 g" }];
  await save(request, { ...empty(), pantry });
  let chefRequests = 0;
  page.on("request", request => { if (request.url().endsWith("/api/chef")) chefRequests++; });
  await page.goto("/");
  const chip = page.getByRole("button", { name: "Review pantry rice", exact: true });
  // Chef counts eligible batches; review must still retain the finished batch.
  await expect(chip).toContainText("2 batches");
  const before = await document(request);
  await chip.click();
  await expect(page.getByRole("button", { name: "All items (3)", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#pantry-row-first").getByRole("textbox", { name: "Available rice", exact: true })).toBeFocused();
  await expect(page.getByRole("region", { name: "rice", exact: true }).locator(".pantry-batch-row")).toHaveCount(3);
  await expect(page.getByRole("region", { name: "Recently removed", exact: true })).toHaveCount(0);
  expect(await document(request)).toEqual(before);
  expect(chefRequests).toBe(0);
});

for (const startingDate of ["blank", "valid"] as const) {
  test(`inline invalid native date from ${startingDate} stays local, Escape restores the date and explicit clearing is valid`, async ({ page, request, isMobile }) => {
    const original = { id: "partial-date", name: "rice", measure: "500 g", ...(startingDate === "valid" ? { useBy: TODAY } : {}) };
    await save(request, { ...empty(), pantry: [original] });
    await openPantry(page);
    const date = page.getByLabel("Use by rice", { exact: true });
    const before = await document(request);
    const writes: string[] = [];
    page.on("request", request => { if (request.method() === "PUT" && request.url().endsWith("/api/kitchen")) writes.push(request.postData() ?? ""); });
    const invalid = await enterInvalidNativeDate(date, startingDate, isMobile);
    await commitDate(date, isMobile);
    await expect.poll(() => nativeDateState(date)).toEqual(invalid);
    await expect(date).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#pantry-row-partial-date").getByRole("alert")).toContainText("Complete the calendar date");
    await page.clock.runFor(600);
    expect(writes).toEqual([]);
    expect(await document(request)).toEqual(before);

    await date.focus();
    await date.press("Escape");
    await expect.poll(() => nativeDateState(date)).toEqual({ value: startingDate === "valid" ? TODAY : "", badInput: false, rangeOverflow: false, valid: true });
    await expect(date).toHaveAttribute("aria-invalid", "false");
    expect(writes).toEqual([]);
    expect(await document(request)).toEqual(before);
    await enterInvalidNativeDate(date, startingDate, isMobile);
    await date.fill("");
    await expect.poll(() => nativeDateState(date)).toEqual({ value: "", badInput: false, rangeOverflow: false, valid: true });
    await expect(date).toHaveAttribute("aria-invalid", "false");
    expect(writes).toEqual([]);
    expect(await document(request)).toEqual(before);
    await commitDate(date, isMobile);
    await expect.poll(async () => (await read(request)).pantry).toEqual([{ id: original.id, name: "rice", measure: "500 g" }]);
  });
}

for (const kind of ["batch correction", "pantry import", "purchase"] as const) {
  for (const startingDate of ["blank", "valid"] as const) {
    test(`${kind} rejects an invalid native date from ${startingDate} without any commit, then accepts an explicit clear`, async ({ page, request, isMobile }) => {
      let dialog: Locator, date: Locator, amount: Locator, confirm: Locator;
      if (kind === "batch correction") {
        await save(request, { ...empty(), pantry: [{ id: "partial-date", name: "rice", measure: "500 g", ...(startingDate === "valid" ? { useBy: TODAY } : {}) }] });
        await openPantry(page);
        dialog = await editBatch(page, "partial-date", "rice");
        date = dialog.getByLabel("Use by · entered planning date", { exact: true });
        amount = dialog.getByLabel("Amount on hand", { exact: true });
        confirm = dialog.getByRole("button", { name: "Save batch correction", exact: true });
      } else if (kind === "pantry import") {
        await openPantry(page);
        dialog = await previewInput(page, "rice: 100 g");
        date = dialog.getByLabel("Use by 1", { exact: true });
        amount = dialog.getByRole("textbox", { name: "Amount 1", exact: true });
        confirm = dialog.getByRole("button", { name: "Confirm ingredients", exact: true });
        if (startingDate === "valid") await date.fill(TODAY);
      } else {
        await save(request, { ...empty(), meals: { [TODAY]: meal(await source(request)) } });
        await page.goto("/"); await navigate(page, "Shopping");
        await page.getByRole("checkbox", { name: "Bought rice 200 g", exact: true }).click();
        await expect(page.locator(".save-indicator")).toHaveText("Saved");
        await page.getByRole("button", { name: "Add bought items to pantry", exact: true }).click();
        dialog = page.getByRole("dialog", { name: "Add bought items to pantry", exact: true });
        date = dialog.getByLabel("Use by rice", { exact: true });
        amount = dialog.getByRole("textbox", { name: "Amount bought rice", exact: true });
        confirm = dialog.getByRole("button", { name: "Confirm pantry additions", exact: true });
        if (startingDate === "valid") await date.fill(TODAY);
      }
      await expect(date).toHaveValue(startingDate === "valid" ? TODAY : "");
      const before = await document(request);
      const writes: string[] = [];
      page.on("request", request => { if (request.method() === "PUT" && request.url().endsWith("/api/kitchen")) writes.push(request.postData() ?? ""); });
      const invalid = await enterInvalidNativeDate(date, startingDate, isMobile);
      await amount.fill("150 g");
      await expect.poll(() => nativeDateState(date)).toEqual(invalid);
      const form = dialog.locator("form");
      await expect(form).toHaveCount(1);
      expect(await form.evaluate((form: HTMLFormElement) => form.noValidate)).toBe(false);
      expect(await date.evaluate((input: HTMLInputElement) => input.form !== null)).toBe(true);
      // Desktop ArrowUp from blank need not emit input/change; native validation must still block confirmation.
      if (await confirm.isEnabled()) await confirm.click();
      await form.evaluate((form: HTMLFormElement) => form.requestSubmit());
      await expect(date).toHaveAttribute("aria-invalid", "true");
      await expect(dialog.getByRole("alert").first()).toBeVisible();
      // Also exercise the handler's last-moment guard without native submit-event suppression.
      await form.dispatchEvent("submit");
      await page.clock.runFor(600);
      await expect(dialog).toBeVisible();
      await expect.poll(() => nativeDateState(date)).toEqual(invalid);
      expect(writes).toEqual([]);
      expect(await document(request)).toEqual(before);

      await date.fill("");
      await expect.poll(() => nativeDateState(date)).toEqual({ value: "", badInput: false, rangeOverflow: false, valid: true });
      await expect(date).toHaveAttribute("aria-invalid", "false");
      await expect(confirm).toBeEnabled();
      expect(await document(request)).toEqual(before);
      await confirm.click();
      await expect.poll(async () => (await read(request)).pantry.map(({ name, measure, useBy }) => ({ name, measure, useBy }))).toEqual([{ name: "rice", measure: "150 g", useBy: undefined }]);
      const after = await read(request);
      expect(Object.hasOwn(after.pantry[0], "useBy")).toBe(false);
      if (kind === "batch correction") expect(after.pantry[0].id).toBe("partial-date");
      if (kind === "purchase") {
        expect(after.shoppingPurchases).toHaveLength(1);
        expect(after.shoppingPurchases![0].items[0].pantry).toEqual(after.pantry[0]);
      }
    });
  }
}

for (const action of ["Record another purchase", "Need to buy again"]) {
  test(`${action} opens a fresh dated purchase preview and preserves the earlier receipt and batch`, async ({ page, request }) => {
    await save(request, { ...empty(), meals: { [TODAY]: meal(await source(request)) } });
    await page.goto("/"); await navigate(page, "Shopping");
    await page.getByRole("checkbox", { name: "Bought rice 200 g", exact: true }).click();
    await page.getByRole("button", { name: "Add bought items to pantry", exact: true }).click();
    let preview = page.getByRole("dialog", { name: "Add bought items to pantry", exact: true });
    await preview.getByLabel("Use by rice", { exact: true }).fill("2026-10-21");
    await expect(preview).toContainText("Past entered use-by date");
    await preview.getByRole("button", { name: "Confirm pantry additions", exact: true }).click();
    await expect.poll(async () => (await read(request)).shoppingPurchases?.length).toBe(1);
    const first = await read(request);
    const originalBatch = first.pantry[0];
    expect(originalBatch).toEqual({ id: expect.any(String), name: "rice", measure: "200 g", useBy: "2026-10-21" });
    await page.locator(".bought-items > summary").click();
    await page.getByRole("button", { name: `${action} rice`, exact: true }).click();
    if (action === "Need to buy again") {
      const toBuy = page.getByRole("region", { name: "To buy", exact: true }).getByRole("checkbox", { name: "Bought rice 200 g", exact: true });
      await expect(toBuy).not.toBeChecked();
      await expect(page.getByRole("button", { name: "Add bought items to pantry", exact: true })).toHaveCount(0);
      await toBuy.click();
    }
    expect((await read(request)).pantry).toEqual([originalBatch]);
    await page.getByRole("button", { name: "Add bought items to pantry", exact: true }).click();
    preview = page.getByRole("dialog", { name: "Add bought items to pantry", exact: true });
    await expect(preview.getByLabel("Use by rice", { exact: true })).toHaveValue("");
    await preview.getByRole("textbox", { name: "Amount bought rice", exact: true }).fill("300 g");
    await preview.getByLabel("Use by rice", { exact: true }).fill("2026-10-25");
    expect((await read(request)).pantry).toEqual([originalBatch]);
    await preview.getByRole("button", { name: "Confirm pantry additions", exact: true }).click();
    await expect.poll(async () => (await read(request)).shoppingPurchases?.length).toBe(2);
    const after = await read(request);
    expect(after.pantry).toEqual([originalBatch, { id: expect.any(String), name: "rice", measure: "300 g", useBy: "2026-10-25" }]);
    expect(after.pantry[1].id).not.toBe(originalBatch.id);
    expect(after.shoppingPurchases![0]).toEqual(first.shoppingPurchases![0]);
    expect(after.shoppingPurchases![1].items[0].pantry).toEqual(after.pantry[1]);
    expect(after.shoppingPurchases![1].items[0].cycleId).not.toBe(first.shoppingPurchases![0].items[0].cycleId);
    await page.reload(); await navigate(page, "Shopping");
    await expect(page.getByRole("button", { name: "Add bought items to pantry", exact: true })).toHaveCount(0);
    expect((await read(request)).pantry).toEqual(after.pantry);
  });
}
