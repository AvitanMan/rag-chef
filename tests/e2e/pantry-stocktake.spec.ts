import { isKitchenWrite } from "./kitchen-requests";
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { KitchenDocument, KitchenState, PantryStock, PlannedMeal } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";

const TODAY = "2026-10-22";
const PAST = "2026-10-21";
const WEEK = "2026-10-19";
const UNKNOWN_REASON = "Amount is unknown. Enter a measured amount to include this batch in quantity planning.";
const pastReason = (date = PAST) => `Entered planning date ${date} is before today (${TODAY}). Check this batch’s entered date.`;
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
async function pantryReady(page: Page) {
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search pantry", exact: true })).toBeEnabled();
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
}
async function openPantry(page: Page) {
  await page.goto("/");
  await navigate(page, "Pantry");
  // Intentionally do not opt into Show all batches: compact is the default under test.
  await pantryReady(page);
}
function row(page: Page, id: string) { return page.locator(`#pantry-row-${id}`); }
function group(page: Page, name: string) { return page.getByRole("region", { name, exact: true }); }
function stocktake(page: Page) { return group(page, "Pantry stocktake"); }
function reviewButton(page: Page) { return stocktake(page).getByRole("button", { name: "Review pantry", exact: true }); }
function filter(page: Page, label: string) {
  return page.getByRole("group", { name: "Pantry review filters", exact: true })
    .getByRole("button", { name: new RegExp(`^${label} \\(\\d+\\)$`) });
}
function replaceStock(state: KitchenState, stock: PantryStock): KitchenState {
  return { ...state, pantry: state.pantry.map(item => item.id === stock.id ? stock : item) };
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
  // Cross the real 450 ms save debounce, including drafts discarded on blur or dismissal.
  await page.clock.runFor(700);
  expect(writes).toEqual([]);
  expect(await document(request)).toEqual(before);
}
async function expectSaved(page: Page, request: APIRequestContext, state: KitchenState) {
  await expect.poll(() => read(request)).toEqual(state);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
}
async function refreshSavedKitchen(page: Page) {
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/kitchen" && response.request().method() === "GET");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect((await refreshed).ok()).toBeTruthy();
}
async function keyboard(control: Locator, key: "Enter" | "Space" = "Enter") {
  await control.focus();
  await expect(control).toBeFocused();
  await control.press(key);
}
async function expectFitsViewport(page: Page, editor?: Locator) {
  expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (editor) {
    expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await editor.locator(".pantry-batch-editor").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
}
async function reviewBatch(page: Page, name: string, position: number, total: number, reasons: string[]) {
  const editor = page.getByRole("dialog", { name: `Review batch ${name}`, exact: true });
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(editor).toBeVisible();
  await expect(editor.getByText(`Batch ${position} of ${total} in this review pass`, { exact: true })).toBeVisible();
  await expect(editor.getByRole("list", { name: "Reasons to review this batch", exact: true }).getByRole("listitem")).toHaveText(reasons);
  await expect(editor.getByRole("button", { name: "Review next", exact: true })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Finish review", exact: true })).toHaveCount(0);
  return editor;
}
async function submitForm(editor: Locator) {
  // Exercise the submit handler too, rather than relying only on a disabled button.
  await editor.locator("form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
async function source(request: APIRequestContext): Promise<Recipe> {
  const response = await request.get("/api/recipes/catalog");
  expect(response.ok()).toBeTruthy();
  const catalog = await response.json();
  const recipe = catalog.recipes.find((recipe: Recipe) => recipe.id === "fixture-tomato-rice");
  expect(recipe).toBeTruthy();
  return recipe;
}
function meal(recipe: Recipe, date: string, amount: string, title: string): PlannedMeal {
  const ingredients = [{ name: "rice", measure: amount }];
  return { id: `meal:${date}`, date, recipeId: recipe.id, recipe: { ...recipe, ingredients }, title,
    baseServings: recipe.servings ?? null, servings: recipe.servings ?? null, batches: 1,
    ingredientOverrides: {}, planningIngredients: ingredients, status: "planned", locked: false };
}
async function protectedKitchen(request: APIRequestContext, pantry: PantryStock[]): Promise<KitchenState> {
  const recipe = await source(request);
  const neighbor = { id: "receipt-batch", name: "raw rice", measure: "300 g", useBy: "2026-11-05" };
  const cooked: PlannedMeal = { ...meal(recipe, PAST, "100 g", "Previously cooked rice"), status: "cooked",
    completion: { id: "stocktake-completion", at: "2026-10-21T18:00:00.000Z",
      deductions: [{ pantryId: neighbor.id, name: neighbor.name, before: "400 g", after: "300 g", useBy: neighbor.useBy }] } };
  const key = `${WEEK}:rice`;
  return { ...empty(), pantry: [...pantry, neighbor], meals: { [cooked.date]: cooked },
    shoppingChecked: { [key]: true }, shoppingCycles: { [key]: "stocktake-cycle" },
    shoppingPurchases: [{ id: "stocktake-receipt", week: WEEK, at: "2026-10-21T12:00:00.000Z",
      items: [{ key, cycleId: "stocktake-cycle", pantry: { ...neighbor, measure: "400 g" } }] }],
    favoriteRecipeIds: [recipe.id] };
}

test.beforeEach(async ({ page, request, baseURL }) => {
  expect(baseURL, "Use the disposable run-isolated.mjs preview, never the personal kitchen").toBeTruthy();
  const url = new URL(baseURL!);
  expect(["127.0.0.1", "localhost"]).toContain(url.hostname);
  expect(url.port).not.toBe("3000");
  await page.clock.install({ time: new Date("2026-10-22T12:00:00+03:00") });
  await page.route("**/api/chef", route => route.abort());
  await save(request, empty());
});

test("compact physical summaries and keyboard disclosures retain mounted invalid drafts without writes", async ({ page, request, browserName }) => {
  await save(request, { ...empty(), pantry: [
    { id: "past", name: "rice", measure: "500 g", useBy: PAST },
    { id: "known", name: "raw rice", measure: "250 g", useBy: TODAY },
    { id: "cans", name: "rice", measure: "2 cans" },
    { id: "missing", name: "rice", measure: "" },
    { id: "note", name: "rice", measure: "some" },
    { id: "zero", name: "rice", measure: "0 g", useBy: PAST },
    { id: "neighbor", name: "beans", measure: "1 kg" },
  ] });
  await openPantry(page);
  const before = await document(request), writes = watchWrites(page);
  await expect(filter(page, "All items")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("searchbox", { name: "Search pantry", exact: true })).toHaveValue("");
  await expect(page.locator(".pantry-group-body[hidden]")).toHaveCount(2);
  await expect(page.locator(".pantry-batch-row")).toHaveCount(7);
  const rice = group(page, "rice"), disclosure = rice.getByRole("button", { name: "Show batches for rice", exact: true });
  await expect(rice.locator(".pantry-on-hand-summary")).toHaveText("On hand: 750 g · 2 cans + 2 batches with unknown amount");
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  const bodyId = await disclosure.getAttribute("aria-controls");
  expect(bodyId).toBeTruthy();
  await expect(rice.locator(".pantry-group-body")).toHaveAttribute("id", bodyId!);
  const help = page.locator("details.pantry-planning-help");
  await expect(help).not.toHaveAttribute("open");
  await expect(help.getByText("On hand is not the same as available.", { exact: true })).toBeHidden();
  await keyboard(help.locator("summary"));
  await expect(help).toHaveAttribute("open", "");
  await keyboard(help.locator("summary"), "Space");
  await expect(help).not.toHaveAttribute("open");
  await expectFitsViewport(page);

  await keyboard(disclosure);
  const hide = rice.getByRole("button", { name: "Hide batches for rice", exact: true });
  await expect(hide).toHaveAttribute("aria-expanded", "true");
  await expect(hide).toHaveAttribute("aria-controls", bodyId!);
  const amount = row(page, "past").getByRole("textbox", { name: "Available rice", exact: true });
  await amount.fill("-1 g");
  await hide.focus();
  await expect(amount).toHaveAttribute("aria-invalid", "true");
  await expect(row(page, "past").getByRole("alert")).toContainText("Not saved:");
  const originalInput = await amount.elementHandle();
  expect(originalInput).not.toBeNull();
  await keyboard(hide, "Space");
  await expect(row(page, "past")).toBeHidden();
  expect(await originalInput!.evaluate(input => input.isConnected)).toBe(true);
  // macOS WebKit uses Option+Tab to include buttons in native keyboard traversal.
  await disclosure.press(browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab");
  await expect(rice.getByRole("button", { name: "Add another batch of rice", exact: true })).toBeFocused();
  await keyboard(disclosure);
  await expect(amount).toHaveValue("-1 g");
  await expect(amount).toHaveAttribute("aria-invalid", "true");
  await keyboard(page.getByRole("button", { name: "Hide all batches", exact: true }));
  await expect(row(page, "past")).toBeHidden();
  await keyboard(page.getByRole("button", { name: "Show all batches", exact: true }));
  await expect(amount).toHaveValue("-1 g");
  await expect(row(page, "past").getByRole("alert")).toBeVisible();
  await amount.press("Escape");
  await expect(amount).toHaveValue("500 g");
  await expect(amount).toHaveAttribute("aria-invalid", "false");
  await expectFitsViewport(page);
  await expectReadOnly(page, request, before, writes);
});

test("Show all persists through search and filters; Hide all and finished review never remove batches", async ({ page, request }) => {
  await save(request, { ...empty(), pantry: [
    { id: "first", name: "rice", measure: "100 g", useBy: TODAY },
    { id: "second", name: "raw rice", measure: "200 g", useBy: "2026-11-05" },
    { id: "beans", name: "beans", measure: "2 cans", useBy: TODAY },
    { id: "zero-mass", name: "rice", measure: "0 g", useBy: PAST },
    { id: "zero-count", name: "oats", measure: "0 cans", useBy: PAST },
    { id: "unknown", name: "lentils", measure: "some" },
  ] });
  await openPantry(page);
  const before = await document(request), writes = watchWrites(page);
  await page.getByRole("button", { name: "Show all batches", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Hide batches for / })).toHaveCount(4);
  const search = page.getByRole("searchbox", { name: "Search pantry", exact: true });
  await search.fill("raw rice");
  await expect(row(page, "second")).toBeVisible();
  await expect(group(page, "rice")).toContainText("Totals include all 3 batches of this ingredient; 1 shown in this view.");
  await expect(group(page, "rice").locator(".pantry-group-totals > div").filter({ hasText: "Amount on hand" }).locator("dd")).toHaveText("300 g");
  await page.getByRole("button", { name: "Clear pantry search", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Hide batches for / })).toHaveCount(4);
  await filter(page, "Unknown amounts").click();
  await expect(row(page, "unknown")).toBeVisible();
  await filter(page, "All items").click();
  await expect(page.getByRole("button", { name: /^Hide batches for / })).toHaveCount(4);
  await page.getByRole("button", { name: "Hide all batches", exact: true }).click();
  await expect(page.locator(".pantry-group-body[hidden]")).toHaveCount(4);
  await filter(page, "Unknown amounts").click();
  await expect(row(page, "unknown")).toBeVisible();
  await filter(page, "All items").click();
  await expect(page.locator(".pantry-group-body[hidden]")).toHaveCount(4);
  await search.fill("beans");
  await expect(row(page, "beans")).toBeVisible();
  await page.getByRole("button", { name: "Review finished batches", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(filter(page, "Finished batches")).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, "zero-mass")).toBeVisible();
  await expect(row(page, "zero-count")).toBeVisible();
  await expect(page.locator(".pantry-batch-row")).toHaveCount(2);
  await expect(stocktake(page)).toContainText("1 batch to review across your full pantry");
  await expect(group(page, "Recently removed")).toHaveCount(0);
  await expectFitsViewport(page);
  await expectReadOnly(page, request, before, writes);
});

test("Chef deep-links auto-open and focus only the target group, and a new batch reveals itself", async ({ page, request }) => {
  const state = await protectedKitchen(request, [
    { id: "first", name: "rice", measure: "100 g", useBy: TODAY },
    { id: "finished", name: "rice", measure: "0 g" },
    { id: "beans", name: "beans", measure: "2 cans" },
  ]);
  await save(request, state);
  await page.goto("/");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  const before = await document(request), writes = watchWrites(page);
  await page.getByRole("button", { name: "Review pantry rice", exact: true }).click();
  await pantryReady(page);
  await expect(filter(page, "All items")).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, "first").getByRole("textbox", { name: "Available rice", exact: true })).toBeFocused();
  await expect(group(page, "rice").getByRole("button", { name: "Hide batches for rice", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "finished")).toBeVisible();
  await expect(group(page, "beans").getByRole("button", { name: "Show batches for beans", exact: true })).toHaveAttribute("aria-expanded", "false");
  await navigate(page, "Recipes");
  await page.goBack();
  await expect(row(page, "first").getByRole("textbox", { name: "Available rice", exact: true })).toBeFocused();
  await expectReadOnly(page, request, before, writes);

  await page.getByRole("textbox", { name: "New pantry ingredient", exact: true }).fill("lentils: 300 g");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Review pantry ingredients", exact: true });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole("textbox", { name: "Ingredient 1", exact: true })).toHaveValue("lentils");
  await expect(preview.getByRole("textbox", { name: "Amount 1", exact: true })).toHaveValue("300 g");
  await expectReadOnly(page, request, before, writes);
  await preview.getByRole("button", { name: "Confirm ingredients", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect.poll(() => read(request)).toEqual({ ...state, pantry: [...state.pantry, { id: expect.any(String), name: "lentils", measure: "300 g" }] });
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  const addition = (await read(request)).pantry.at(-1)!;
  expect(state.pantry.map(stock => stock.id)).not.toContain(addition.id);
  await expect(row(page, addition.id)).toBeVisible();
  await expect(row(page, addition.id)).toContainText("Just added");
  await expect(row(page, addition.id).getByRole("textbox", { name: "Available lentils", exact: true })).toBeFocused();
  await expect(group(page, "lentils").getByRole("button", { name: "Hide batches for lentils", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expectFitsViewport(page);

  const afterAddition = await document(request), revealWrites = watchWrites(page);
  const search = page.getByRole("searchbox", { name: "Search pantry", exact: true });
  for (const context of ["collapsed added group", "search hiding the added group"] as const) {
    await test.step(`View added batches re-reveals the same ID from a ${context}`, async () => {
      await keyboard(group(page, "lentils").getByRole("button", { name: "Hide batches for lentils", exact: true }));
      await expect(row(page, addition.id)).toHaveCount(1);
      await expect(row(page, addition.id)).toBeHidden();
      await expect(group(page, "lentils").getByRole("button", { name: "Show batches for lentils", exact: true })).toHaveAttribute("aria-expanded", "false");
      if (context === "search hiding the added group") {
        await search.fill("beans");
        await expect(row(page, "beans")).toBeVisible();
        await expect(row(page, addition.id)).toHaveCount(0);
      }
      await keyboard(page.getByRole("button", { name: "View added batches", exact: true }));
      await expect(search).toHaveValue("");
      await expect(filter(page, "All items")).toHaveAttribute("aria-pressed", "true");
      await expect(row(page, addition.id)).toBeVisible();
      await expect(row(page, addition.id).getByRole("textbox", { name: "Available lentils", exact: true })).toBeFocused();
      await expect(row(page, addition.id).getByRole("textbox", { name: "Available lentils", exact: true })).toHaveValue("300 g");
      await expect(group(page, "lentils").getByRole("button", { name: "Hide batches for lentils", exact: true })).toHaveAttribute("aria-expanded", "true");
      await expectReadOnly(page, request, afterAddition, revealWrites);
    });
  }
});

for (const interaction of ["keyboard", "pointer"] as const) {
  test(`Unknown amounts keeps a corrected pinned row and its invalid draft through disclosures (${interaction})`, async ({ page, request, isMobile }) => {
    const state = await protectedKitchen(request, [
      { id: "pinned", name: "lentils", measure: "some", useBy: TODAY },
      { id: "still-unknown", name: "beans", measure: "some" },
    ]);
    await save(request, state);
    await openPantry(page);
    await filter(page, "Unknown amounts").click();
    const batch = row(page, "pinned");
    const amount = batch.getByRole("textbox", { name: "Available lentils", exact: true });
    const date = batch.getByLabel("Use by lentils", { exact: true });
    const before = await document(request), writes = watchWrites(page);
    await expect(batch).toBeVisible();
    await amount.fill("100 g");
    await expectReadOnly(page, request, before, writes);
    await amount.press("Tab");
    await expect(date).toBeFocused();
    await expectSaved(page, request, replaceStock(state, { ...state.pantry[0], measure: "100 g" }));
    await expect(filter(page, "Unknown amounts")).toHaveText("Unknown amounts (1)");
    await expect(filter(page, "Unknown amounts")).toHaveAttribute("aria-pressed", "true");
    await expect(batch).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Showing 1 of 1 batches in this view." }))
      .toContainText("The batch being edited is also kept in view until you leave its group.");

    const committed = await document(request), invalidWrites = watchWrites(page);
    await amount.focus();
    await amount.fill("-1 g");
    await expect(amount).toHaveAttribute("aria-invalid", "true");
    const originalInput = await amount.elementHandle();
    expect(originalInput).not.toBeNull();
    // Do not pre-focus pointer buttons: real pointerdown must handle the field blur.
    const activate = (control: Locator) => interaction === "keyboard" ? keyboard(control) : isMobile ? control.tap() : control.click();
    for (const disclosure of ["all", "group"] as const) {
      await test.step(`${interaction} collapse and reveal using ${disclosure} batches`, async () => {
        // Stay in the same filter and begin each collapse with the invalid amount focused.
        await amount.focus();
        await expect(amount).toBeFocused();
        await activate(page.getByRole("button", { name: disclosure === "all" ? "Hide all batches" : "Hide batches for lentils", exact: true }));
        await expect(batch).toHaveCount(1);
        await expect(batch).toBeHidden();
        expect(await originalInput!.evaluate(input => ({ connected: input.isConnected, value: (input as HTMLInputElement).value })))
          .toEqual({ connected: true, value: "-1 g" });
        await expect(group(page, "lentils").getByRole("button", { name: "Show batches for lentils", exact: true })).toHaveAttribute("aria-expanded", "false");
        await activate(page.getByRole("button", { name: disclosure === "all" ? "Show all batches" : "Show batches for lentils", exact: true }));
        await expect(batch).toBeVisible();
        await expect(amount).toHaveValue("-1 g");
        await expect(amount).toHaveAttribute("aria-invalid", "true");
        await expect(batch.getByRole("alert")).toContainText("Not saved:");
        expect(await originalInput!.evaluate(input => input.isConnected)).toBe(true);
        await expect(filter(page, "Unknown amounts")).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByRole("searchbox", { name: "Search pantry", exact: true })).toHaveValue("");
        await expectReadOnly(page, request, committed, invalidWrites);
      });
    }
  });
}

test("the full-pantry queue ignores filtering and sorting; Skip, Cancel and Escape discard drafts without writes", async ({ page, request }) => {
  const state = await protectedKitchen(request, [
    { id: "unknown", name: "zucchini", measure: "some", useBy: TODAY },
    { id: "undated", name: "oats", measure: "200 g" },
    { id: "past", name: "rice", measure: "500 g", useBy: PAST },
    { id: "zero", name: "rice", measure: "0 cans", useBy: PAST },
    { id: "both", name: "beans", measure: "", useBy: PAST },
  ]);
  await save(request, state);
  await openPantry(page);
  const before = await document(request), writes = watchWrites(page);
  await filter(page, "Finished batches").click();
  await page.getByRole("searchbox", { name: "Search pantry", exact: true }).fill("not present");
  await page.getByRole("combobox", { name: "Sort pantry", exact: true }).selectOption("name");
  await expect(page.locator(".pantry-batch-row")).toHaveCount(0);
  await expect(stocktake(page)).toContainText("3 batches to review across your full pantry");
  await keyboard(reviewButton(page));
  let editor = await reviewBatch(page, "zucchini", 1, 3, [UNKNOWN_REASON]);
  const firstControl = editor.getByRole("button", { name: "Correct batch", exact: true });
  const saveCorrection = editor.getByRole("button", { name: "Save batch correction", exact: true });
  await firstControl.focus();
  await firstControl.press("Shift+Tab");
  await expect(saveCorrection).toBeFocused();
  await saveCorrection.press("Tab");
  await expect(firstControl).toBeFocused();
  await expectFitsViewport(page, editor);
  await editor.getByLabel("Ingredient name / form", { exact: true }).fill("unsaved name");
  await editor.getByLabel("Amount on hand", { exact: true }).fill("-2 g");
  await editor.getByRole("button", { name: "Skip batch", exact: true }).click();
  editor = await reviewBatch(page, "rice", 2, 3, [pastReason()]);
  await editor.getByLabel("Amount on hand", { exact: true }).fill("450 g");
  await editor.getByLabel("Use by · entered planning date", { exact: true }).fill(TODAY);
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(reviewButton(page)).toBeFocused();
  await keyboard(reviewButton(page));
  editor = await reviewBatch(page, "zucchini", 1, 3, [UNKNOWN_REASON]);
  await expect(editor.getByLabel("Ingredient name / form", { exact: true })).toHaveValue("zucchini");
  await expect(editor.getByLabel("Amount on hand", { exact: true })).toHaveValue("some");
  await page.keyboard.press("Escape");
  await expect(reviewButton(page)).toBeFocused();
  await keyboard(reviewButton(page));
  for (const [index, name, reasons] of [[1, "zucchini", [UNKNOWN_REASON]], [2, "rice", [pastReason()]], [3, "beans", [UNKNOWN_REASON, pastReason()]]] as const) {
    editor = await reviewBatch(page, name, index, 3, [...reasons]);
    await editor.getByRole("button", { name: "Skip batch", exact: true }).click();
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Review pass finished." })).toContainText("3 batches still need review. Skipped or unresolved batches remain available for another pass.");
  await expect(reviewButton(page)).toBeFocused();
  await expect(filter(page, "Finished batches")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("searchbox", { name: "Search pantry", exact: true })).toHaveValue("not present");
  await expect(group(page, "Last pantry batch edit")).toHaveCount(0);
  await expectReadOnly(page, request, before, writes);
});

test("confirmed corrections advance unknown and past batches without changing IDs, receipts or neighboring stock", async ({ page, request }) => {
  let state = await protectedKitchen(request, [
    { id: "unknown", name: "zucchini", measure: "some", useBy: TODAY },
    { id: "past", name: "rice", measure: "500 g", useBy: PAST },
    { id: "both", name: "beans", measure: "a handful", useBy: PAST },
    { id: "undated", name: "oats", measure: "200 g" },
    { id: "zero", name: "rice", measure: "0 g", useBy: PAST },
  ]);
  const originalBeans = state.pantry[2];
  await save(request, state);
  await openPantry(page);
  const before = await document(request), writes = watchWrites(page);
  await reviewButton(page).click();
  let editor = await reviewBatch(page, "zucchini", 1, 3, [UNKNOWN_REASON]);
  await editor.getByLabel("Amount on hand", { exact: true }).fill("300 g");
  await expectReadOnly(page, request, before, writes);
  await editor.getByRole("button", { name: "Save batch correction", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("Batch correction applied for zucchini.");
  await expect(editor.getByRole("button", { name: "Skip batch", exact: true })).toHaveCount(0);
  state = replaceStock(state, { ...state.pantry[0], measure: "300 g" });
  await expectSaved(page, request, state);
  await editor.getByRole("button", { name: "Review next", exact: true }).click();
  editor = await reviewBatch(page, "rice", 2, 3, [pastReason()]);
  await expect(editor).toContainText("This is your planning date, not a food-safety assessment.");
  await expect(editor.getByLabel("Amount on hand", { exact: true })).toHaveValue("500 g");
  await editor.getByLabel("Use by · entered planning date", { exact: true }).fill(TODAY);
  await editor.getByRole("button", { name: "Save batch correction", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("Batch correction applied for rice.");
  state = replaceStock(state, { ...state.pantry[1], useBy: TODAY });
  await expectSaved(page, request, state);
  await editor.getByRole("button", { name: "Review next", exact: true }).click();
  editor = await reviewBatch(page, "beans", 3, 3, [UNKNOWN_REASON, pastReason()]);
  await editor.getByLabel("Amount on hand", { exact: true }).fill("200 g");
  await editor.getByLabel("Use by · entered planning date", { exact: true }).fill("");
  await editor.getByRole("button", { name: "Save batch correction", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("Batch correction applied for beans.");
  state = replaceStock(state, { id: originalBeans.id, name: originalBeans.name, measure: "200 g" });
  await expectSaved(page, request, state);
  await expectFitsViewport(page, editor);
  await editor.getByRole("button", { name: "Finish review", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Review pass finished." })).toContainText("No batches currently need amount, past-date, or selected-week unit review.");
  await expect(reviewButton(page)).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeFocused();
  await expect(group(page, "Last pantry batch edit")).toContainText("Last batch edit: beans");
  await keyboard(group(page, "Last pantry batch edit").getByRole("button", { name: "Undo last batch edit", exact: true }));
  await expectSaved(page, request, replaceStock(state, originalBeans));
  await expect(stocktake(page)).toContainText("1 batch to review across your full pantry");
  await expect(row(page, originalBeans.id).getByRole("button", { name: "Edit batch beans", exact: true })).toBeFocused();
});

test("review usage rejects incompatible and excessive amounts; Done ends the pass and only the latest edit is undoable", async ({ page, request }) => {
  let state = await protectedKitchen(request, [
    { id: "past", name: "rice", measure: "500 g", useBy: PAST },
    { id: "unknown", name: "beans", measure: "some", useBy: PAST },
    { id: "later", name: "lentils", measure: "" },
  ]);
  const originalBeans = state.pantry[1];
  await save(request, state);
  await openPantry(page);
  const before = await document(request), writes = watchWrites(page);
  await reviewButton(page).click();
  let editor = await reviewBatch(page, "rice", 1, 3, [pastReason()]);
  await editor.getByRole("button", { name: "Record usage", exact: true }).click();
  for (const invalid of ["1 cup", "600 g"]) {
    await editor.getByLabel("Amount used from this batch", { exact: true }).fill(invalid);
    await expect(editor.getByRole("alert")).toBeVisible();
    await expect(editor.getByRole("button", { name: "Subtract usage", exact: true })).toBeDisabled();
    await submitForm(editor);
  }
  await expectReadOnly(page, request, before, writes);
  await editor.getByLabel("Amount used from this batch", { exact: true }).fill("100 g");
  await expect(editor.locator(".pantry-batch-preview")).toContainText("Amount on hand: 400 g");
  await editor.getByRole("button", { name: "Subtract usage", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("Usage subtracted from rice.");
  state = replaceStock(state, { ...state.pantry[0], measure: "400 g" });
  await expectSaved(page, request, state);
  await editor.getByRole("button", { name: "Review next", exact: true }).click();
  editor = await reviewBatch(page, "beans", 2, 3, [UNKNOWN_REASON, pastReason()]);
  await editor.getByRole("button", { name: "Mark finished", exact: true }).click();
  await editor.getByRole("button", { name: "Confirm finished batch", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("beans marked finished; the empty batch is kept.");
  state = replaceStock(state, { ...originalBeans, measure: "0" });
  await expectSaved(page, request, state);
  await expect(editor.getByRole("button", { name: "Review next", exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(reviewButton(page)).toBeFocused();
  await expect(stocktake(page)).toContainText("2 batches to review across your full pantry");
  await expect(row(page, originalBeans.id)).toBeVisible();
  await expect(row(page, originalBeans.id).getByLabel("Use by beans", { exact: true })).toHaveValue(PAST);
  await expect(group(page, "Last pantry batch edit")).toContainText("Last batch edit: beans");
  await group(page, "Last pantry batch edit").getByRole("button", { name: "Undo last batch edit", exact: true }).click();
  await expectSaved(page, request, replaceStock(state, originalBeans));
  await expect(group(page, "Last pantry batch edit")).toHaveCount(0);
  await reviewButton(page).click();
  editor = await reviewBatch(page, "rice", 1, 3, [pastReason()]);
  await expect(editor.getByLabel("Amount on hand", { exact: true })).toHaveValue("400 g");
  await page.keyboard.press("Escape");
});

test("native invalid review dates block both submission paths and Skip drops the local date and amount draft", async ({ page, request, isMobile }) => {
  await save(request, { ...empty(), pantry: [
    { id: "unknown", name: "rice", measure: "some", useBy: TODAY },
    { id: "past", name: "beans", measure: "400 g", useBy: PAST },
  ] });
  await openPantry(page);
  const before = await document(request), writes = watchWrites(page);
  await reviewButton(page).click();
  let editor = await reviewBatch(page, "rice", 1, 2, [UNKNOWN_REASON]);
  await editor.getByLabel("Amount on hand", { exact: true }).fill("250 g");
  const date = editor.getByLabel("Use by · entered planning date", { exact: true });
  await expect(date).toHaveValue(TODAY);
  // Use real Chromium native validity, not a mocked validity object or malformed text input.
  if (isMobile) {
    await expect(date).toHaveAttribute("max", "9999-12-31");
    await date.fill("10000-10-22");
  } else {
    await date.focus();
    await date.press("Backspace");
  }
  const nativeState = () => date.evaluate((input: HTMLInputElement) => ({ value: input.value, badInput: input.validity.badInput,
    rangeOverflow: input.validity.rangeOverflow, valid: input.validity.valid }));
  const invalid = isMobile
    ? { value: "10000-10-22", badInput: false, rangeOverflow: true, valid: false }
    : { value: "", badInput: true, rangeOverflow: false, valid: false };
  await expect.poll(nativeState).toEqual(invalid);
  const form = editor.locator("form");
  expect(await form.evaluate((element: HTMLFormElement) => element.noValidate)).toBe(false);
  expect(await date.evaluate((input: HTMLInputElement) => input.form !== null)).toBe(true);
  await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
  await expect(date).toHaveAttribute("aria-invalid", "true");
  await expect(editor.getByRole("button", { name: "Save batch correction", exact: true })).toBeDisabled();
  await submitForm(editor);
  await expect.poll(nativeState).toEqual(invalid);
  await expect(editor.getByRole("alert")).toContainText("Complete the calendar date, or clear it if it is unknown.");
  await expect(editor.getByRole("button", { name: "Review next", exact: true })).toHaveCount(0);
  await expectReadOnly(page, request, before, writes);
  await editor.getByRole("button", { name: "Skip batch", exact: true }).click();
  editor = await reviewBatch(page, "beans", 2, 2, [pastReason()]);
  await expect(editor.getByLabel("Amount on hand", { exact: true })).toHaveValue("400 g");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await reviewButton(page).click();
  editor = await reviewBatch(page, "rice", 1, 2, [UNKNOWN_REASON]);
  await expect(editor.getByLabel("Amount on hand", { exact: true })).toHaveValue("some");
  await expect(editor.getByLabel("Use by · entered planning date", { exact: true })).toHaveValue(TODAY);
  await expect(editor.getByLabel("Use by · entered planning date", { exact: true })).toHaveAttribute("aria-invalid", "false");
  await page.keyboard.press("Escape");
  await expect(reviewButton(page)).toBeFocused();
  await expectReadOnly(page, request, before, writes);
});

test("unit review uses uncovered selected-week demand and matching full stock, not visible batches or cooked dinners", async ({ page, request }) => {
  const recipe = await source(request);
  const thursday = meal(recipe, TODAY, "100 g", "Thursday rice");
  thursday.planningIngredients!.push({ name: "beans", measure: "200 g" });
  const friday = meal(recipe, "2026-10-23", "100 g", "Friday rice");
  const cooked: PlannedMeal = { ...meal(recipe, "2026-10-24", "9000 g", "Already cooked rice"), status: "cooked",
    completion: { id: "cooked", at: "2026-10-22T08:00:00.000Z", deductions: [] } };
  const nextWeek = meal(recipe, "2026-10-29", "300 g", "Next Thursday rice");
  const previousWeek = meal(recipe, "2026-10-15", "1 l", "Previous Thursday rice");
  const state: KitchenState = { ...empty(), pantry: [
    { id: "volume", name: "rice", measure: "1 cup" },
    { id: "matching", name: "raw rice", measure: "200 g", useBy: "2026-11-05" },
    { id: "zero", name: "rice", measure: "0 cans", useBy: PAST },
    { id: "different-form", name: "cooked rice", measure: "1 cup" },
    { id: "compatible-shortfall", name: "beans", measure: "100 g" },
  ], meals: Object.fromEntries([thursday, friday, cooked, nextWeek, previousWeek].map(dinner => [dinner.date, dinner])) };
  await save(request, state);
  await openPantry(page);
  const before = await document(request), writes = watchWrites(page);
  await expect(reviewButton(page)).toBeDisabled();
  await filter(page, "No date entered").click();
  await page.getByRole("searchbox", { name: "Search pantry", exact: true }).fill("rice");
  await expect(row(page, "matching")).toHaveCount(0);
  await expect(row(page, "volume")).toBeVisible();
  await expect(reviewButton(page)).toBeDisabled();
  await expect(stocktake(page)).toContainText("No batches currently need review");
  await page.getByRole("button", { name: "Next week for pantry reservations", exact: true }).click();
  await expect(stocktake(page)).toContainText("1 batch to review across your full pantry");
  await reviewButton(page).click();
  const editor = await reviewBatch(page, "rice", 1, 1, [
    "Next Thursday rice (2026-10-29) has an uncovered rice requirement measured in g. This batch’s units are incompatible; no automatic conversion is applied.",
  ]);
  await expect(editor.getByLabel("Amount on hand", { exact: true })).toHaveValue("1 cup");
  await expectFitsViewport(page, editor);
  await expectReadOnly(page, request, before, writes);

  const covered = replaceStock(state, { ...state.pantry[1], measure: "300 g" });
  await save(request, covered);
  const externallySaved = await document(request);
  await refreshSavedKitchen(page);
  await expect(editor.getByRole("list", { name: "Reasons to review this batch", exact: true })).toHaveCount(0);
  await expect(editor).toContainText("No remaining amount, past-date, or selected-week unit issue for this batch.");
  await editor.getByRole("button", { name: "Skip batch", exact: true }).click();
  await expect(reviewButton(page)).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Current week", exact: true }).click();
  await expect(reviewButton(page)).toBeDisabled();
  await expectReadOnly(page, request, externallySaved, writes);
});

test("Review next skips resolved or removed queued IDs, loads a live rename and never appends new issues", async ({ page, request }) => {
  let state = await protectedKitchen(request, [
    { id: "first", name: "rice", measure: "some" },
    { id: "resolved", name: "beans", measure: "some" },
    { id: "removed", name: "oats", measure: "some" },
    { id: "last", name: "lentils", measure: "some" },
  ]);
  await save(request, state);
  await openPantry(page);
  await reviewButton(page).click();
  let editor = await reviewBatch(page, "rice", 1, 4, [UNKNOWN_REASON]);
  await editor.getByLabel("Amount on hand", { exact: true }).fill("100 g");
  await editor.getByRole("button", { name: "Save batch correction", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("Batch correction applied for rice.");
  state = replaceStock(state, { ...state.pantry[0], measure: "100 g" });
  await expectSaved(page, request, state);
  const external = { ...state, pantry: [...state.pantry.filter(stock => stock.id !== "removed").map(stock =>
    stock.id === "resolved" ? { ...stock, measure: "200 g" } : stock.id === "last" ? { ...stock, name: "red lentils" } : stock),
  { id: "new-issue", name: "flour", measure: "some" }] };
  await save(request, external);
  const before = await document(request), writes = watchWrites(page);
  await refreshSavedKitchen(page);
  await expect(page.getByRole("region", { name: "Pantry stocktake", exact: true, includeHidden: true })).toContainText("2 batches to review");
  await editor.getByRole("button", { name: "Review next", exact: true }).click();
  editor = await reviewBatch(page, "red lentils", 4, 4, [UNKNOWN_REASON]);
  await expect(editor.getByLabel("Ingredient name / form", { exact: true })).toHaveValue("red lentils");
  await editor.getByRole("button", { name: "Skip batch", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Review pass finished." })).toContainText("2 batches still need review");
  await expect(reviewButton(page)).toBeFocused();
  await reviewButton(page).click();
  editor = await reviewBatch(page, "red lentils", 1, 2, [UNKNOWN_REASON]);
  await editor.getByRole("button", { name: "Skip batch", exact: true }).click();
  await reviewBatch(page, "flour", 2, 2, [UNKNOWN_REASON]);
  await page.keyboard.press("Escape");
  await expectReadOnly(page, request, before, writes);
});

test("an externally renamed review batch blocks stale submission; Load current batch and page reload discard only local drafts", async ({ page, request }) => {
  const state = await protectedKitchen(request, [
    { id: "first", name: "rice", measure: "some", useBy: TODAY },
    { id: "second", name: "beans", measure: "some", useBy: PAST },
  ]);
  await save(request, state);
  await openPantry(page);
  await reviewButton(page).click();
  let editor = await reviewBatch(page, "rice", 1, 2, [UNKNOWN_REASON]);
  await editor.getByLabel("Amount on hand", { exact: true }).fill("250 g");
  const external = replaceStock(state, { ...state.pantry[0], name: "raw rice", useBy: "2026-11-05" });
  await save(request, external);
  const before = await document(request), writes = watchWrites(page);
  await refreshSavedKitchen(page);
  await expect(editor.getByRole("alert")).toContainText("This batch changed after the editor was opened. Nothing from this editor has overwritten it.");
  await expect(editor.getByLabel("Amount on hand", { exact: true })).toBeDisabled();
  await expect(editor.getByRole("button", { name: "Save batch correction", exact: true })).toBeDisabled();
  await submitForm(editor);
  await expectReadOnly(page, request, before, writes);
  await editor.getByRole("button", { name: "Load current batch", exact: true }).click();
  editor = await reviewBatch(page, "raw rice", 1, 2, [UNKNOWN_REASON]);
  await expect(editor.getByLabel("Amount on hand", { exact: true })).toHaveValue("some");
  await expect(editor.getByLabel("Use by · entered planning date", { exact: true })).toHaveValue("2026-11-05");
  await expect(editor.getByRole("button", { name: "Save batch correction", exact: true })).toBeEnabled();
  await editor.getByRole("button", { name: "Skip batch", exact: true }).click();
  editor = await reviewBatch(page, "beans", 2, 2, [UNKNOWN_REASON, pastReason()]);
  await editor.getByLabel("Amount on hand", { exact: true }).fill("350 g");
  await page.reload();
  await navigate(page, "Pantry");
  await pantryReady(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(group(page, "Last pantry batch edit")).toHaveCount(0);
  await expect(page.locator(".pantry-group-body[hidden]")).toHaveCount(2);
  await reviewButton(page).click();
  editor = await reviewBatch(page, "raw rice", 1, 2, [UNKNOWN_REASON]);
  await editor.getByRole("button", { name: "Skip batch", exact: true }).click();
  editor = await reviewBatch(page, "beans", 2, 2, [UNKNOWN_REASON, pastReason()]);
  await expect(editor.getByLabel("Amount on hand", { exact: true })).toHaveValue("some");
  await page.keyboard.press("Escape");
  await expect(reviewButton(page)).toBeFocused();
  await expectReadOnly(page, request, before, writes);
});

test("a removed current ID cannot be recreated or replaced by a same-name batch during the pass", async ({ page, request }) => {
  const state = await protectedKitchen(request, [
    { id: "first", name: "rice", measure: "some", useBy: TODAY },
    { id: "last", name: "beans", measure: "some", useBy: PAST },
  ]);
  await save(request, state);
  await openPantry(page);
  await reviewButton(page).click();
  let editor = await reviewBatch(page, "rice", 1, 2, [UNKNOWN_REASON]);
  await editor.getByLabel("Amount on hand", { exact: true }).fill("250 g");
  const external = { ...state, pantry: state.pantry.map(stock => stock.id === "first" ? { ...stock, id: "replacement" } : stock) };
  await save(request, external);
  const before = await document(request), writes = watchWrites(page);
  await refreshSavedKitchen(page);
  await expect(editor.getByRole("alert")).toContainText("This batch was removed. Close the editor; it will not recreate the batch.");
  await expect(editor.getByRole("button", { name: "Load current batch", exact: true })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Save batch correction", exact: true })).toBeDisabled();
  await expect(editor.getByLabel("Amount on hand", { exact: true })).toBeDisabled();
  await submitForm(editor);
  await editor.getByRole("button", { name: "Mark finished", exact: true }).click();
  await expect(editor.getByRole("button", { name: "Confirm finished batch", exact: true })).toBeDisabled();
  await submitForm(editor);
  await expectReadOnly(page, request, before, writes);
  await editor.getByRole("button", { name: "Skip batch", exact: true }).click();
  editor = await reviewBatch(page, "beans", 2, 2, [UNKNOWN_REASON, pastReason()]);
  await editor.getByRole("button", { name: "Mark finished", exact: true }).click();
  await editor.getByRole("button", { name: "Confirm finished batch", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("beans marked finished; the empty batch is kept.");
  const finished = replaceStock(external, { ...state.pantry[1], measure: "0" });
  await expectSaved(page, request, finished);
  await editor.getByRole("button", { name: "Finish review", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Review pass finished." })).toContainText("1 batch still needs review");
  await expect(reviewButton(page)).toBeFocused();
  await expect(row(page, "first")).toHaveCount(0);
  await expect(row(page, "replacement")).toHaveCount(1);
  await reviewButton(page).click();
  editor = await reviewBatch(page, "rice", 1, 1, [UNKNOWN_REASON]);
  await expect(editor.getByLabel("Amount on hand", { exact: true })).toHaveValue("some");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expectSaved(page, request, finished);
});
