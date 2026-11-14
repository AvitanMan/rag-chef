import { isKitchenWrite } from "./kitchen-requests";
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { KitchenDocument, KitchenState, PantryStock, PlannedMeal } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";
import { showPantryBatches } from "./pantry-helpers";

const TODAY = "2026-10-22";
const WEEK = "2026-10-19";
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });

// Keep the disposable API fixtures and real navigation used by pantry-semantics.spec.ts.
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
  if (name === "Pantry") await showPantryBatches(page);
}
async function openPantry(page: Page) {
  await page.goto("/");
  await navigate(page, "Pantry");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
}
async function source(request: APIRequestContext): Promise<Recipe> {
  const response = await request.get("/api/recipes/catalog");
  expect(response.ok()).toBeTruthy();
  const catalog = await response.json();
  const recipe = catalog.recipes.find((recipe: Recipe) => recipe.id === "fixture-tomato-rice");
  expect(recipe).toBeTruthy();
  return recipe;
}
function meal(recipe: Recipe, date = TODAY, amount = "200 g", title = recipe.title): PlannedMeal {
  const ingredients = [{ name: "rice", measure: amount }];
  return { id: `meal:${date}`, date, recipeId: recipe.id, recipe: { ...recipe, ingredients }, title,
    baseServings: recipe.servings ?? null, servings: recipe.servings ?? null, batches: 1,
    ingredientOverrides: {}, planningIngredients: ingredients, status: "planned", locked: false };
}
function row(page: Page, id: string) { return page.locator(`#pantry-row-${id}`); }
function total(group: Locator, label: string) {
  return group.locator(".pantry-group-totals > div").filter({ hasText: label }).locator("dd");
}
function filter(page: Page, label: string, count: number) {
  return page.getByRole("group", { name: "Pantry review filters", exact: true }).getByRole("button", { name: `${label} (${count})`, exact: true });
}
function undoPanel(page: Page) {
  // Include the inert background while an editor is open: a draft must not create an undo entry.
  return page.getByRole("region", { name: "Last pantry batch edit", exact: true, includeHidden: true });
}
async function expectRows(page: Page, ids: string[]) {
  await expect.poll(() => page.locator(".pantry-batch-row").evaluateAll(rows => rows.map(row => row.id).sort()))
    .toEqual(ids.map(id => `pantry-row-${id}`).sort());
}
function watchWrites(page: Page) {
  const writes: string[] = [];
  page.on("request", request => {
    if (isKitchenWrite(request)) {
      writes.push(`${request.method()} ${request.postData() ?? ""}`);
    }
  });
  return writes;
}
async function expectReadOnly(page: Page, request: APIRequestContext, before: KitchenDocument, writes: string[]) {
  // Cross the real 450 ms kitchen-save debounce before asserting that nothing was queued.
  await page.clock.runFor(700);
  expect(writes).toEqual([]);
  expect(await document(request)).toEqual(before);
}
async function expectSaved(page: Page, request: APIRequestContext, state: KitchenState) {
  await expect.poll(() => read(request)).toEqual(state);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
}
async function editBatch(page: Page, stock: PantryStock) {
  await row(page, stock.id).getByRole("button", { name: `Edit batch ${stock.name}`, exact: true }).click();
  const editor = page.getByRole("dialog", { name: `Edit batch ${stock.name}`, exact: true });
  await expect(editor).toBeVisible();
  return editor;
}
async function finishEditor(editor: Locator) {
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(editor).toHaveCount(0);
}
async function activateWithKeyboard(button: Locator, key: "Enter" | "Space" = "Enter") {
  await expect(button).toBeEnabled();
  await button.focus();
  await expect(button).toBeFocused();
  await button.press(key);
}
async function useBatch(page: Page, stock: PantryStock, amount = "100 g") {
  const editor = await editBatch(page, stock);
  await editor.getByRole("button", { name: "Record usage", exact: true }).click();
  await editor.getByLabel("Amount used from this batch", { exact: true }).fill(amount);
  await editor.getByRole("button", { name: "Subtract usage", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText(`Usage subtracted from ${stock.name}`);
  await finishEditor(editor);
  await expect(undoPanel(page).getByRole("button", { name: "Undo last batch edit", exact: true })).toBeEnabled();
}
function replaceStock(state: KitchenState, stock: PantryStock): KitchenState {
  return { ...state, pantry: state.pantry.map(item => item.id === stock.id ? stock : item) };
}
async function editFixture(request: APIRequestContext): Promise<KitchenState> {
  const recipe = await source(request);
  const pantry = [
    { id: "editable", name: "rice", measure: "500 g", useBy: TODAY },
    { id: "neighbor", name: "raw rice", measure: "300 g", useBy: "2026-11-05" },
    { id: "unknown", name: "beans", measure: "some", useBy: "2026-10-24" },
    { id: "missing", name: "lentils", measure: "" },
    { id: "finished", name: "oats", measure: "0 g" },
  ];
  const key = `${WEEK}:rice`;
  const cooked: PlannedMeal = { ...meal(recipe, "2026-10-21", "100 g"), status: "cooked",
    completion: { id: "completed-rice", at: "2026-10-21T18:00:00.000Z",
      deductions: [{ pantryId: "editable", name: "rice", before: "600 g", after: "500 g", useBy: TODAY }] } };
  return { ...empty(), pantry, meals: { [cooked.date]: cooked, [TODAY]: meal(recipe) },
    shoppingChecked: { [key]: true }, shoppingCycles: { [key]: "rice-cycle" },
    shoppingPurchases: [{ id: "rice-receipt", week: WEEK, at: "2026-10-21T12:00:00.000Z",
      items: [{ key, cycleId: "rice-cycle", pantry: { ...pantry[0], measure: "600 g" } }] }],
    favoriteRecipeIds: [recipe.id] };
}
async function reservationFixture(request: APIRequestContext): Promise<KitchenState> {
  const recipe = await source(request);
  const cooked: PlannedMeal = { ...meal(recipe, "2026-10-24", "900 g", "Already cooked rice"), status: "cooked",
    completion: { id: "already-completed", at: "2026-10-22T08:00:00.000Z", deductions: [] } };
  return { ...empty(), pantry: [
    { id: "past", name: "rice", measure: "50 g", useBy: "2026-10-21" },
    { id: "early", name: "rice", measure: "100 g", useBy: TODAY },
    { id: "later", name: "raw rice", measure: "500 g", useBy: "2026-11-05" },
    { id: "unknown", name: "rice", measure: "some" },
    { id: "volume", name: "rice", measure: "1 cup" },
    { id: "finished", name: "rice", measure: "0 g" },
  ], meals: {
    "2026-10-23": meal(recipe, "2026-10-23", "300 g", "Friday rice"),
    [TODAY]: meal(recipe, TODAY, "200 g", "Thursday rice"),
    [cooked.date]: cooked,
    "2026-10-29": meal(recipe, "2026-10-29", "400 g", "Next Thursday rice"),
    "2026-10-15": meal(recipe, "2026-10-15", "300 g", "Previous Thursday rice"),
  } };
}
async function expectReservations(batch: Locator, entries: string[]) {
  const details = batch.locator(".pantry-reservation-details");
  await expect(details.locator("summary")).toHaveText(`Reserved for ${entries.length} ${entries.length === 1 ? "dinner" : "dinners"}`);
  if (await details.getAttribute("open") === null) await details.locator("summary").click();
  await expect(details.locator("li > span")).toHaveText(entries);
  await expect(details.getByRole("button", { name: /^Review dinner: / })).toHaveCount(entries.length);
}

test.beforeEach(async ({ page, request, baseURL }) => {
  expect(baseURL, "Use tools/testing/run-isolated.mjs, never the personal kitchen").toBeTruthy();
  const url = new URL(baseURL!);
  expect(["127.0.0.1", "localhost"]).toContain(url.hostname);
  expect(url.port).not.toBe("3000");
  await page.clock.install({ time: new Date("2026-10-22T12:00:00+03:00") });
  await page.route("**/api/chef", route => route.abort());
  await save(request, empty());
});

test("unknown and finished filters count batches independently of dates and search, without treating notes as zero", async ({ page, request }) => {
  const pantry = [
    { id: "blank", name: "rice", measure: "", useBy: TODAY },
    { id: "note", name: "beans", measure: "a handful", useBy: "2026-10-21" },
    { id: "some", name: "lentils", measure: "some" },
    { id: "approximate", name: "oats", measure: "about 200 g", useBy: "2026-11-05" },
    { id: "zero-mass", name: "rice", measure: "0 g", useBy: TODAY },
    { id: "zero-count", name: "beans", measure: "0" },
    { id: "zero-cans", name: "tomatoes", measure: "0 cans", useBy: "2026-10-21" },
    { id: "measured", name: "rice", measure: "200 g", useBy: TODAY },
    { id: "cans", name: "tomatoes", measure: "2 cans", useBy: "2026-11-05" },
    { id: "volume", name: "milk", measure: "1 cup" },
  ];
  await save(request, { ...empty(), pantry });
  await openPantry(page);
  const before = await document(request), writes = watchWrites(page);
  for (const [label, count] of [["All items", 10], ["Use soon", 2], ["Past entered date", 1], ["No date entered", 2], ["Unknown amounts", 4], ["Finished batches", 3]] as const) {
    await expect(filter(page, label, count)).toBeVisible();
  }
  await filter(page, "Unknown amounts", 4).click();
  await expect(filter(page, "Unknown amounts", 4)).toHaveAttribute("aria-pressed", "true");
  await expectRows(page, ["blank", "note", "some", "approximate"]);
  await expect(row(page, "blank")).toContainText("Pantry amount is missing");
  await expect(row(page, "note")).toContainText("Pantry amount “a handful” is unknown");
  await expect(row(page, "some")).toContainText("Pantry amount “some” is unknown");
  await expect(row(page, "approximate")).toContainText("Pantry amount “about 200 g” is unknown");
  await expect(row(page, "note").getByLabel("Use by beans", { exact: true })).toHaveValue("2026-10-21");
  await expect(row(page, "blank").getByLabel("Use by rice", { exact: true })).toHaveValue(TODAY);
  await expect(row(page, "approximate").getByLabel("Use by oats", { exact: true })).toHaveValue("2026-11-05");
  await page.getByRole("searchbox", { name: "Search pantry", exact: true }).fill("not present");
  await expect(page.getByText("Showing 0 of 4 batches in this view.", { exact: true })).toBeVisible();
  await expect(filter(page, "Unknown amounts", 4)).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Clear pantry search", exact: true }).click();
  await expectRows(page, ["blank", "note", "some", "approximate"]);
  await filter(page, "Finished batches", 3).click();
  await expectRows(page, ["zero-mass", "zero-count", "zero-cans"]);
  for (const id of ["zero-mass", "zero-count", "zero-cans"]) await expect(row(page, id)).toContainText("Pantry amount is zero");
  await filter(page, "Use soon", 2).click();
  await expectRows(page, ["blank", "measured"]);
  await filter(page, "Past entered date", 1).click();
  await expectRows(page, ["note"]);
  await filter(page, "No date entered", 2).click();
  await expectRows(page, ["some", "volume"]);
  await expectReadOnly(page, request, before, writes);
});

test("Back and Forward restore both new filters, while an unrecognized history filter falls back to All items", async ({ page, request }) => {
  await save(request, { ...empty(), pantry: [
    { id: "unknown", name: "rice", measure: "some" },
    { id: "finished", name: "beans", measure: "0 g" },
    { id: "known", name: "oats", measure: "100 g" },
  ] });
  await openPantry(page);
  const before = await document(request), writes = watchWrites(page);
  await filter(page, "Unknown amounts", 1).click();
  await filter(page, "Finished batches", 1).click();
  await navigate(page, "Recipes");
  await page.goBack();
  await expect(filter(page, "Finished batches", 1)).toHaveAttribute("aria-pressed", "true");
  await expectRows(page, ["finished"]);
  await page.goBack();
  await expect(filter(page, "Unknown amounts", 1)).toHaveAttribute("aria-pressed", "true");
  await expectRows(page, ["unknown"]);
  await page.goBack();
  await expect(filter(page, "All items", 3)).toHaveAttribute("aria-pressed", "true");
  await page.goForward();
  await expect(filter(page, "Unknown amounts", 1)).toHaveAttribute("aria-pressed", "true");
  await expectRows(page, ["unknown"]);
  await page.goForward();
  await expect(filter(page, "Finished batches", 1)).toHaveAttribute("aria-pressed", "true");
  await expectRows(page, ["finished"]);
  await page.goForward();
  await expect(page.getByRole("searchbox", { name: "Search recipes", exact: true })).toBeVisible();
  await page.goBack();
  await expect(filter(page, "Finished batches", 1)).toHaveAttribute("aria-pressed", "true");
  // Simulate an obsolete history entry, not a mocked PantryView or synthetic popstate handler.
  await page.evaluate(() => window.history.replaceState({ ...window.history.state,
    ragChefNavigation: { ...window.history.state.ragChefNavigation, pantryFilter: "obsolete-filter" } }, ""));
  await navigate(page, "Recipes");
  await page.goBack();
  await expect(filter(page, "All items", 3)).toHaveAttribute("aria-pressed", "true");
  await expectRows(page, ["unknown", "finished", "known"]);
  expect(await page.evaluate(() => window.history.state.ragChefNavigation.pantryFilter)).toBe("all");
  await expectReadOnly(page, request, before, writes);
});

test("reservation details attribute each dinner to its batch and retain full-pantry totals through search and week changes", async ({ page, request }) => {
  await save(request, await reservationFixture(request));
  await openPantry(page);
  const before = await document(request), writes = watchWrites(page);
  const group = page.getByRole("region", { name: "rice", exact: true });
  const week = page.getByRole("group", { name: "Pantry reservation week", exact: true });
  await expect(week).toContainText("Mon, Oct 19 – Sun, Oct 25");
  await expect(week.getByRole("button", { name: "Current week", exact: true })).toBeDisabled();
  await expect(page.locator(".pantry-planning-help")).toContainText("2 saved, uncooked dinners");
  await expect(total(group, "Amount on hand")).toContainText("650 g · 240 ml");
  await expect(total(group, "Amount on hand")).toContainText("Plus 1 batch with an unknown amount");
  await expect(total(group, "Reserved for selected week")).toHaveText("500 g");
  await expect(total(group, "Available today after reservations")).toHaveText("100 g · 240 ml");
  await expectReservations(row(page, "early"), ["Thu, Oct 22 · Thursday rice · 100 g"]);
  await expectReservations(row(page, "later"), ["Thu, Oct 22 · Thursday rice · 100 g", "Fri, Oct 23 · Friday rice · 300 g"]);
  await expect(row(page, "later")).toContainText("Reserved for selected week: 400 g");
  for (const id of ["past", "unknown", "volume", "finished"]) await expect(row(page, id).locator(".pantry-reservation-details")).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search pantry", exact: true }).fill("raw");
  await expectRows(page, ["later"]);
  await expect(group).toContainText("Totals include all 6 batches of this ingredient; 1 shown in this view");
  await expect(total(group, "Reserved for selected week")).toHaveText("500 g");
  await expect(total(group, "Available today after reservations")).toHaveText("100 g · 240 ml");
  await expectReservations(row(page, "later"), ["Thu, Oct 22 · Thursday rice · 100 g", "Fri, Oct 23 · Friday rice · 300 g"]);
  await week.getByRole("button", { name: "Next week for pantry reservations", exact: true }).click();
  await expect(week).toContainText("Mon, Oct 26 – Sun, Nov 1");
  await expect(page.locator(".pantry-planning-help")).toContainText("1 saved, uncooked dinner");
  await expect(total(group, "Amount on hand")).toContainText("650 g · 240 ml");
  await expect(total(group, "Reserved for selected week")).toHaveText("400 g");
  await expect(total(group, "Available today after reservations")).toHaveText("200 g · 240 ml");
  await expectReservations(row(page, "later"), ["Thu, Oct 29 · Next Thursday rice · 400 g"]);
  await week.getByRole("button", { name: "Previous week for pantry reservations", exact: true }).click();
  await expect(total(group, "Reserved for selected week")).toHaveText("500 g");
  await week.getByRole("button", { name: "Previous week for pantry reservations", exact: true }).click();
  await expect(week).toContainText("Mon, Oct 12 – Sun, Oct 18");
  await expect(total(group, "Reserved for selected week")).toHaveText("300 g");
  await expect(total(group, "Available today after reservations")).toHaveText("300 g · 240 ml");
  await expectReservations(row(page, "later"), ["Thu, Oct 15 · Previous Thursday rice · 200 g"]);
  await week.getByRole("button", { name: "Current week", exact: true }).click();
  await expect(week.getByRole("button", { name: "Current week", exact: true })).toBeDisabled();
  await expect(total(group, "Reserved for selected week")).toHaveText("500 g");
  await page.getByRole("button", { name: "Clear pantry search", exact: true }).click();
  await filter(page, "Use soon", 1).click();
  await expectRows(page, ["early"]);
  await expect(total(group, "Reserved for selected week")).toHaveText("500 g");
  await expectReservations(row(page, "early"), ["Thu, Oct 22 · Thursday rice · 100 g"]);
  expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectReadOnly(page, request, before, writes);
});

test("Review dinner opens the selected reservation's saved dinner, not tonight, without writing kitchen state", async ({ page, request }) => {
  await save(request, await reservationFixture(request));
  await openPantry(page);
  const before = await document(request), writes = watchWrites(page);
  let chefRequests = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/chef") chefRequests++; });
  await page.getByRole("button", { name: "Next week for pantry reservations", exact: true }).click();
  await expectReservations(row(page, "later"), ["Thu, Oct 29 · Next Thursday rice · 400 g"]);
  await row(page, "later").getByRole("button", { name: "Review dinner: Next Thursday rice on 2026-10-29", exact: true }).click();
  const dinner = page.getByRole("region", { name: "Chosen dinner", exact: true });
  await expect(dinner).toContainText("Dinner for Thu, Oct 29");
  await expect(dinner.getByRole("heading", { name: "Next Thursday rice", exact: true })).toBeFocused();
  await expect(dinner.getByRole("button", { name: "Cook dinner", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole("group", { name: "Pantry reservation week", exact: true })).toContainText("Mon, Oct 26 – Sun, Nov 1");
  await showPantryBatches(page);
  await expectReservations(row(page, "later"), ["Thu, Oct 29 · Next Thursday rice · 400 g"]);
  await expectReadOnly(page, request, before, writes);
  expect(chefRequests).toBe(0);
});

test("usage and Undo double-clicks each apply once, preserving the batch ID, receipt and saved meals", async ({ page, request }) => {
  const state = await editFixture(request), stock = state.pantry[0];
  await save(request, state);
  await openPantry(page);
  const before = await document(request), writes = watchWrites(page);
  const editor = await editBatch(page, stock);
  await editor.getByRole("button", { name: "Record usage", exact: true }).click();
  await editor.getByLabel("Amount used from this batch", { exact: true }).fill("100 g");
  await expect(editor.locator(".pantry-batch-preview")).toContainText("Amount on hand: 400 g");
  await expect(undoPanel(page)).toHaveCount(0);
  await expectReadOnly(page, request, before, writes);
  await editor.getByRole("button", { name: "Subtract usage", exact: true }).dblclick();
  await expectSaved(page, request, replaceStock(state, { ...stock, measure: "400 g" }));
  // The second pointer click can dismiss the resized confirmation; persistence must still be exactly once.
  if (await editor.isVisible()) await finishEditor(editor);
  await expect(undoPanel(page)).toHaveCount(1);
  await expect(undoPanel(page)).toContainText("rice: 500 g");
  await expect(undoPanel(page)).toContainText("rice: 400 g");
  expect(writes).toHaveLength(1);
  expect((await document(request)).revision).toBe(before.revision + 1);
  await undoPanel(page).getByRole("button", { name: "Undo last batch edit", exact: true }).dblclick();
  await expectSaved(page, request, state);
  await expect(undoPanel(page)).toHaveCount(0);
  await expect(page.getByText("Undid the last batch edit for rice. Follow the kitchen save indicator for sync status.", { exact: true })).toBeVisible();
  await page.clock.runFor(700);
  expect(writes).toHaveLength(2);
  expect((await document(request)).revision).toBe(before.revision + 2);
});

test("correction Undo restores the exact name, amount and date snapshot rather than creating or merging a batch", async ({ page, request }) => {
  const state = await editFixture(request), stock = state.pantry[0];
  await save(request, state);
  await openPantry(page);
  const before = await document(request), writes = watchWrites(page);
  const editor = await editBatch(page, stock);
  await editor.getByLabel("Ingredient name / form", { exact: true }).fill("cooked rice");
  await editor.getByLabel("Amount on hand", { exact: true }).fill("0.4 kg");
  await editor.getByLabel("Use by · entered planning date", { exact: true }).fill("");
  await expect(undoPanel(page)).toHaveCount(0);
  await expectReadOnly(page, request, before, writes);
  await editor.getByRole("button", { name: "Save batch correction", exact: true }).click();
  const corrected = { id: stock.id, name: "cooked rice", measure: "0.4 kg" };
  await expectSaved(page, request, replaceStock(state, corrected));
  await finishEditor(editor);
  await expect(row(page, stock.id).getByLabel("Use by cooked rice", { exact: true })).toHaveValue("");
  await expect(undoPanel(page)).toContainText("Last batch edit: cooked rice");
  await expect(undoPanel(page)).toContainText("Entered date Thu, Oct 22");
  await expect(undoPanel(page)).toContainText("No date entered");
  await activateWithKeyboard(undoPanel(page).getByRole("button", { name: "Undo last batch edit", exact: true }));
  await expect(row(page, stock.id).getByRole("button", { name: "Edit batch rice", exact: true })).toBeFocused();
  await expectSaved(page, request, state);
  await expect(row(page, stock.id).getByRole("textbox", { name: "Available rice", exact: true })).toHaveValue("500 g");
  await expect(row(page, stock.id).getByLabel("Use by rice", { exact: true })).toHaveValue(TODAY);
  await expect(page.getByRole("region", { name: "cooked rice", exact: true })).toHaveCount(0);
  await expect(undoPanel(page)).toHaveCount(0);
  expect(writes).toHaveLength(2);
});

test("finishing known, note-only and missing amounts can be undone without losing their original amount or optional date", async ({ page, request }) => {
  const state = await editFixture(request);
  await save(request, state);
  await openPantry(page);
  for (const stock of [state.pantry[0], state.pantry[2], state.pantry[3]]) {
    await test.step(`Finish and undo ${stock.name}: ${stock.measure || "missing"}`, async () => {
      const editor = await editBatch(page, stock);
      await editor.getByRole("button", { name: "Mark finished", exact: true }).click();
      await expect(undoPanel(page)).toHaveCount(0);
      await editor.getByRole("button", { name: "Confirm finished batch", exact: true }).click();
      const finished = { ...stock, measure: stock.id === "editable" ? "0 g" : "0" };
      await expectSaved(page, request, replaceStock(state, finished));
      await finishEditor(editor);
      await filter(page, "Finished batches", 2).click();
      await expectRows(page, [stock.id, "finished"]);
      await expect(row(page, stock.id)).toContainText("Pantry amount is zero");
      await expect(undoPanel(page).getByRole("button", { name: "Undo last batch edit", exact: true })).toBeEnabled();
      await activateWithKeyboard(undoPanel(page).getByRole("button", { name: "Undo last batch edit", exact: true }), "Space");
      await expectSaved(page, request, state);
      await expect(undoPanel(page)).toHaveCount(0);
      await expectRows(page, ["finished"]);
      await expect(filter(page, "Finished batches", 1)).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeFocused();
      await filter(page, "All items", 5).click();
      await expect(row(page, stock.id).getByRole("textbox", { name: `Available ${stock.name}`, exact: true })).toHaveValue(stock.measure);
      await expect(row(page, stock.id).getByLabel(`Use by ${stock.name}`, { exact: true })).toHaveValue(stock.useBy ?? "");
      await expect(filter(page, "Unknown amounts", 2)).toBeVisible();
    });
  }
});

test("only the latest applied editor action is undoable; no-op corrections and finished batches preserve exact zero-unit text", async ({ page, request }) => {
  const state = await editFixture(request);
  const finishedBatches = [state.pantry[4], ...["0 kg", "0 cups", "0 pieces", "0 cans"].map((measure, index) => ({
    id: `finished-unit-${index}`, name: "oats", measure,
  }))];
  state.pantry.push(...finishedBatches.slice(1));
  await save(request, state);
  await openPantry(page);
  const used = { ...state.pantry[0], measure: "400 g" };
  await useBatch(page, state.pantry[0]);
  const first = replaceStock(state, used);
  await expectSaved(page, request, first);
  const neighbor = state.pantry[1], corrected = { ...neighbor, measure: "250 g", useBy: "2026-11-06" };
  let editor = await editBatch(page, neighbor);
  await editor.getByLabel("Amount on hand", { exact: true }).fill(corrected.measure);
  await editor.getByLabel("Use by · entered planning date", { exact: true }).fill(corrected.useBy);
  await editor.getByRole("button", { name: "Save batch correction", exact: true }).click();
  await expectSaved(page, request, replaceStock(first, corrected));
  await finishEditor(editor);
  await expect(undoPanel(page)).toHaveCount(1);
  await expect(undoPanel(page)).toContainText("Last batch edit: raw rice");
  const remembered = await undoPanel(page).innerText();
  const before = await document(request), writes = watchWrites(page);
  editor = await editBatch(page, used);
  await editor.getByRole("button", { name: "Save batch correction", exact: true }).click();
  await finishEditor(editor);
  await expect(undoPanel(page)).toHaveText(remembered, { useInnerText: true });
  await expectReadOnly(page, request, before, writes);
  for (const stock of finishedBatches) {
    await test.step(`Mark finished preserves ${stock.measure} and the previous undo`, async () => {
      const amount = row(page, stock.id).getByRole("textbox", { name: `Available ${stock.name}`, exact: true });
      await expect(amount).toHaveValue(stock.measure);
      const finishedEditor = await editBatch(page, stock);
      await finishedEditor.getByRole("button", { name: "Mark finished", exact: true }).click();
      await expect(finishedEditor.locator(".pantry-batch-preview")).toContainText(`Amount on hand: ${stock.measure}`);
      await finishedEditor.getByRole("button", { name: "Confirm finished batch", exact: true }).click();
      await finishEditor(finishedEditor);
      await expect(amount).toHaveValue(stock.measure);
      await expect(undoPanel(page)).toHaveText(remembered, { useInnerText: true });
      await expect(undoPanel(page).getByRole("button", { name: "Undo last batch edit", exact: true })).toBeEnabled();
      await expectReadOnly(page, request, before, writes);
    });
  }
  await activateWithKeyboard(undoPanel(page).getByRole("button", { name: "Undo last batch edit", exact: true }));
  await expect(row(page, neighbor.id).getByRole("button", { name: `Edit batch ${neighbor.name}`, exact: true })).toBeFocused();
  await expectSaved(page, request, first);
  await expect(undoPanel(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo last batch edit", exact: true })).toHaveCount(0);
});

test("a later inline edit invalidates Undo even when its new amount is physically equivalent", async ({ page, request }) => {
  const state = await editFixture(request), stock = state.pantry[0];
  await save(request, state);
  await openPantry(page);
  await useBatch(page, stock);
  await expectSaved(page, request, replaceStock(state, { ...stock, measure: "400 g" }));
  const amount = row(page, stock.id).getByRole("textbox", { name: "Available rice", exact: true });
  await amount.fill("0.4 kg");
  await amount.press("Enter");
  await expectSaved(page, request, replaceStock(state, { ...stock, measure: "0.4 kg" }));
  await expect(undoPanel(page)).toContainText("This batch has been edited or used since this change. Undo would overwrite later changes.");
  await expect(undoPanel(page).getByRole("button", { name: "Undo last batch edit", exact: true })).toBeDisabled();
  await expect(undoPanel(page)).toContainText("rice: 400 g");
  const before = await document(request), writes = watchWrites(page);
  await expectReadOnly(page, request, before, writes);
});

for (const change of ["changed", "removed"] as const) {
  test(`an externally ${change} batch disables the stale editor and Undo without overwriting or recreating stock`, async ({ page, request }) => {
    const state = await editFixture(request), stock = state.pantry[0];
    await save(request, state);
    await openPantry(page);
    const used = { ...stock, measure: "400 g" }, applied = replaceStock(state, used);
    await useBatch(page, stock);
    await expectSaved(page, request, applied);
    const editor = await editBatch(page, used);
    await editor.getByLabel("Amount on hand", { exact: true }).fill("350 g");
    const external = change === "changed"
      ? replaceStock(applied, { ...used, name: "raw rice", useBy: "2026-10-24" })
      : { ...applied, pantry: [...applied.pantry.filter(item => item.id !== stock.id), { ...used, id: "replacement-id" }] };
    await save(request, external);
    const before = await document(request), writes = watchWrites(page);
    // Exercise the app's real clean-tab refresh without unmounting Pantry and losing its undo entry.
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/kitchen" && response.request().method() === "GET");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    expect((await refreshed).ok()).toBeTruthy();
    await expect(editor.getByRole("alert")).toContainText(change === "changed" ? "This batch changed after the editor was opened" : "This batch was removed");
    await expect(editor.getByRole("button", { name: "Save batch correction", exact: true })).toBeDisabled();
    await expect(editor.getByLabel("Amount on hand", { exact: true })).toBeDisabled();
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(undoPanel(page)).toHaveCount(1);
    await expect(undoPanel(page)).toContainText("rice: 500 g");
    await expect(undoPanel(page)).toContainText("rice: 400 g");
    await expect(undoPanel(page)).toContainText(change === "changed" ? "Undo would overwrite later changes" : "This batch has been removed. Undo will not recreate it.");
    await expect(undoPanel(page).getByRole("button", { name: "Undo last batch edit", exact: true })).toBeDisabled();
    if (change === "removed") {
      await expect(row(page, stock.id)).toHaveCount(0);
      await expect(row(page, "replacement-id")).toBeVisible();
    } else {
      await expect(row(page, stock.id).getByLabel("Use by raw rice", { exact: true })).toHaveValue("2026-10-24");
    }
    expect((await read(request))).toEqual(external);
    await expectReadOnly(page, request, before, writes);
    await test.step(`Keyboard dismissal focuses the ${change === "removed" ? "pantry heading" : "current batch's edit button"}`, async () => {
      await activateWithKeyboard(undoPanel(page).getByRole("button", { name: "Dismiss edit undo", exact: true }), "Space");
      await expect(undoPanel(page)).toHaveCount(0);
      const target = change === "removed"
        ? page.getByRole("heading", { name: "Your pantry", exact: true })
        : row(page, stock.id).getByRole("button", { name: "Edit batch raw rice", exact: true });
      await expect(target).toBeFocused();
      await expectReadOnly(page, request, before, writes);
    });
  });
}

test("keyboard dismissal restores visible or hidden target focus; leaving Pantry and reload also drop only the in-memory undo", async ({ page, request }) => {
  let state = await editFixture(request);
  await save(request, state);
  await openPantry(page);
  for (const [reason, measure] of [["dismiss-visible", "400 g"], ["dismiss-hidden", "300 g"], ["leave", "200 g"], ["reload", "100 g"]] as const) {
    await test.step(reason, async () => {
      const stock = state.pantry[0];
      await useBatch(page, stock);
      state = replaceStock(state, { ...stock, measure });
      await expectSaved(page, request, state);
      const before = await document(request), writes = watchWrites(page);
      if (reason === "dismiss-visible" || reason === "dismiss-hidden") {
        await filter(page, "Unknown amounts", 2).click();
        await expectRows(page, ["unknown", "missing"]);
        await expect(undoPanel(page).getByRole("button", { name: "Undo last batch edit", exact: true })).toBeEnabled();
        if (reason === "dismiss-visible") await filter(page, "All items", 5).click();
        await activateWithKeyboard(undoPanel(page).getByRole("button", { name: "Dismiss edit undo", exact: true }));
        await expect(undoPanel(page)).toHaveCount(0);
        if (reason === "dismiss-visible") {
          await expect(row(page, stock.id).getByRole("button", { name: "Edit batch rice", exact: true })).toBeFocused();
        } else {
          await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeFocused();
          await expect(filter(page, "Unknown amounts", 2)).toHaveAttribute("aria-pressed", "true");
          await expectRows(page, ["unknown", "missing"]);
          await filter(page, "All items", 5).click();
        }
      } else if (reason === "leave") {
        await navigate(page, "Recipes");
        await page.goBack();
        await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeVisible();
        await showPantryBatches(page);
      } else {
        await page.reload();
        await navigate(page, "Pantry");
        await expect(page.locator(".save-indicator")).toHaveText("Saved");
      }
      await expect(undoPanel(page)).toHaveCount(0);
      await expect(row(page, stock.id).getByRole("textbox", { name: "Available rice", exact: true })).toHaveValue(measure);
      await expectReadOnly(page, request, before, writes);
    });
  }
});
