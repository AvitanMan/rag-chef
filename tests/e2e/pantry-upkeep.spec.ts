import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { KitchenDocument, KitchenState, PantryStock } from "../../app/lib/kitchen-types";
import { isKitchenWrite } from "./kitchen-requests";
import { choosePantryLocation, expectPantryLocation, openPantryIngredientManagement } from "./pantry-helpers";
import { draft, openPendingKitchenOutbox } from "./pending-kitchen-outbox";
import { MAX_PENDING_KITCHEN_WRITES } from "../../app/lib/kitchen-write-queue";

const TODAY = "2026-10-22";
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });
const stocks = (): PantryStock[] => [
  { id: "rice-cupboard", name: "rice", measure: "500 g", useBy: "2026-10-24", location: "cupboard" },
  { id: "rice-freezer", name: "rice", measure: "200 g", useBy: "2026-10-25", location: "freezer" },
  { id: "rice-unknown", name: "rice", measure: "", location: "fridge" },
  { id: "rice-finished", name: "rice", measure: "0 g", useBy: "2026-10-20", location: "cupboard" },
  { id: "rice-past", name: "rice", measure: "50 g", useBy: "2026-10-21", location: "fridge" },
];

async function document(request: APIRequestContext): Promise<KitchenDocument> {
  const response = await request.get("/api/kitchen");
  expect(response.ok()).toBeTruthy();
  return response.json();
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
function details(page: Page, name = "rice") { return page.getByRole("dialog", { name: `Details for ${name}`, exact: true }); }
function batch(page: Page, number: number, name = "rice") { return details(page, name).getByRole("region", { name: `Batch ${number}: ${name}`, exact: true }); }
async function openDetails(page: Page, name = "rice") {
  await page.getByRole("button", { name: `Details for ${name}`, exact: true }).click();
  await expect(details(page, name)).toBeVisible();
  return details(page, name);
}
function editor(page: Page, name = "rice") { return page.getByRole("dialog", { name: `Edit batch ${name}`, exact: true }); }
function watch(page: Page) {
  const writes: string[] = [];
  page.on("request", request => { if (isKitchenWrite(request)) writes.push(request.postData() ?? request.url()); });
  return writes;
}
async function unchanged(page: Page, request: APIRequestContext, before: KitchenDocument, writes: string[]) {
  await page.clock.runFor(700);
  expect(writes).toEqual([]);
  expect(await document(request)).toEqual(before);
}
async function expectPantry(request: APIRequestContext, pantry: PantryStock[]) {
  await expect.poll(async () => (await document(request)).state!.pantry).toEqual(pantry);
}
async function refresh(page: Page) {
  const fetched = page.waitForResponse(response => new URL(response.url()).pathname === "/api/kitchen" && response.request().method() === "GET");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect((await fetched).ok()).toBeTruthy();
}
async function notApplied(scope: Locator) {
  await expect(scope.getByRole("alert").filter({ hasText: /not applied/i })).toContainText(/try again/i);
}

test.beforeEach(async ({ page, request, baseURL }) => {
  expect(baseURL, "Run against the disposable isolated kitchen").toBeTruthy();
  expect(["127.0.0.1", "localhost"]).toContain(new URL(baseURL!).hostname);
  expect(new URL(baseURL!).port).not.toBe("3000");
  await page.clock.install({ time: new Date(`${TODAY}T12:00:00+03:00`) });
  await page.route("**/api/chef", route => route.abort());
  await save(request, { ...empty(), pantry: stocks() });
});

test("Details shows all saved batches across locations and action drafts cancel without writing", async ({ page, request }, info) => {
  await openPantry(page);
  await choosePantryLocation(page, "Cupboard");
  await page.getByRole("searchbox", { name: "Search pantry", exact: true }).fill("rice");
  const before = await document(request), writes = watch(page);
  const trigger = page.getByRole("button", { name: "Details for rice", exact: true });
  const panel = await openDetails(page);
  await expect(panel.getByRole("heading", { name: "rice", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(panel.getByRole("button", { name: "Manage batches", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(batch(page, 1).getByRole("button", { name: "Move", exact: true })).toBeFocused();
  await expect(panel.getByRole("region", { name: /^Batch \d+: rice$/ })).toHaveCount(5);
  await expect(batch(page, 1)).toContainText("Cupboard");
  await expect(batch(page, 2)).toContainText("Freezer");
  await expect(batch(page, 3)).toContainText("Amount unknown");
  await expect(batch(page, 4)).toContainText("Finished");
  await expect(batch(page, 5)).toContainText("Past entered date");
  await expect(batch(page, 3).getByRole("button", { name: "Use some", exact: true })).toBeDisabled();
  await expect(batch(page, 3)).toContainText("Enter a known amount in Edit details");
  await expect(batch(page, 4).getByRole("button", { name: "Use some", exact: true })).toBeDisabled();
  await expect(batch(page, 4).getByRole("button", { name: "Mark finished", exact: true })).toBeDisabled();
  await batch(page, 2).getByRole("button", { name: "Use some", exact: true }).click();
  await expect(editor(page).getByRole("button", { name: "Record usage", exact: true })).toHaveAttribute("aria-pressed", "true");
  await editor(page).getByLabel("Amount used from this batch", { exact: true }).fill("50 g");
  await unchanged(page, request, before, writes);
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await expect(batch(page, 2).getByRole("heading", { name: "Batch 2: rice", exact: true })).toBeFocused();
  await batch(page, 2).getByRole("button", { name: "Move", exact: true }).click();
  const move = page.getByRole("dialog", { name: "Move rice", exact: true });
  await expect(move.getByRole("combobox", { name: "Batch to move", exact: true })).toHaveCount(0);
  await move.getByRole("combobox", { name: "Move to", exact: true }).selectOption("fridge");
  await move.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(panel).toBeVisible();
  const path = info.outputPath("pantry-ingredient-details.png");
  await page.screenshot({ path, animations: "disabled" });
  await info.attach("ingredient details", { path, contentType: "image/png" });
  expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(trigger).toBeFocused();
  await expectPantryLocation(page, "Cupboard", 1);
  await unchanged(page, request, before, writes);
});

test("Use some confirms one measured batch and shared panel Undo restores its exact snapshot", async ({ page, request }) => {
  const original = stocks();
  await openPantry(page);
  await page.getByRole("button", { name: "Use rice tonight", exact: true }).click();
  const before = await document(request), writes = watch(page);
  await openDetails(page);
  await batch(page, 1).getByRole("button", { name: "Use some", exact: true }).click();
  await editor(page).getByLabel("Amount used from this batch", { exact: true }).fill("100 g");
  await expect(editor(page).locator(".pantry-batch-preview")).toContainText("400 g");
  await unchanged(page, request, before, writes);
  await editor(page).getByRole("button", { name: "Subtract usage", exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(details(page)).toBeVisible();
  await expectPantry(request, original.map((stock, index) => index ? stock : { ...stock, measure: "400 g" }));
  await expect(batch(page, 1)).toContainText("400 g");
  await expect(batch(page, 1).getByRole("heading")).toBeFocused();
  const undo = details(page).getByRole("button", { name: "Undo last batch edit", exact: true });
  await undo.focus();
  await undo.press("Enter");
  await expectPantry(request, original);
  await expect(batch(page, 1)).toContainText("500 g");
  await expect(batch(page, 1).getByRole("heading")).toBeFocused();
  await expect(details(page).getByRole("button", { name: "Undo last batch edit", exact: true })).toHaveCount(0);
  await batch(page, 1).getByRole("button", { name: "Use some", exact: true }).click();
  await editor(page).getByLabel("Amount used from this batch", { exact: true }).fill("50 g");
  await editor(page).getByRole("button", { name: "Subtract usage", exact: true }).click();
  await expect(details(page)).toBeVisible();
  const dismiss = details(page).getByRole("button", { name: "Dismiss edit undo", exact: true });
  await dismiss.focus();
  await dismiss.press("Enter");
  await expect(batch(page, 1).getByRole("heading")).toBeFocused();
  await expect(details(page).getByRole("button", { name: "Undo last batch edit", exact: true })).toHaveCount(0);
  await expectPantry(request, original.map((stock, index) => index ? stock : { ...stock, measure: "450 g" }));
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Use rice tonight", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(writes).toHaveLength(3);
});

test("Mark finished retains an unknown batch and Undo restores unknown amount and location", async ({ page, request }) => {
  const original = stocks();
  await openPantry(page);
  const before = await document(request), writes = watch(page);
  await openDetails(page);
  await batch(page, 3).getByRole("button", { name: "Mark finished", exact: true }).click();
  await expect(editor(page).getByRole("button", { name: "Mark finished", exact: true })).toHaveAttribute("aria-pressed", "true");
  await unchanged(page, request, before, writes);
  await editor(page).getByRole("button", { name: "Confirm finished batch", exact: true }).click();
  await expect(details(page)).toBeVisible();
  await expectPantry(request, original.map((stock, index) => index === 2 ? { ...stock, measure: "0" } : stock));
  await expect(batch(page, 3)).toContainText("Finished");
  await expect(batch(page, 3)).toContainText("Fridge");
  await details(page).getByRole("button", { name: "Undo last batch edit", exact: true }).click();
  await expectPantry(request, original);
  await expect(batch(page, 3)).toContainText("Amount unknown");
  await expect(batch(page, 3).getByRole("button", { name: "Use some", exact: true })).toBeDisabled();
  expect(writes).toHaveLength(2);
});

test("unchanged Edit details is a no-op and a rename follows the same batch into its new group with Undo", async ({ page, request }) => {
  const original = [...stocks(), { id: "cooked-existing", name: "cooked rice", measure: "100 g", location: "fridge" as const }];
  await save(request, { ...empty(), pantry: original });
  await openPantry(page);
  const before = await document(request), writes = watch(page);
  await openDetails(page);
  await batch(page, 1).getByRole("button", { name: "Edit details", exact: true }).click();
  await editor(page).getByRole("button", { name: "Save batch correction", exact: true }).click();
  await expect(details(page)).toBeVisible();
  await expect(details(page).getByRole("button", { name: "Undo last batch edit", exact: true })).toHaveCount(0);
  await unchanged(page, request, before, writes);
  await batch(page, 1).getByRole("button", { name: "Edit details", exact: true }).click();
  await editor(page).getByLabel("Ingredient name / form", { exact: true }).fill("cooked rice");
  await editor(page).getByLabel("Amount on hand", { exact: true }).fill("250 g");
  await unchanged(page, request, before, writes);
  await editor(page).getByRole("button", { name: "Save batch correction", exact: true }).click();
  await expect(details(page, "cooked rice")).toBeVisible();
  await expect(details(page, "cooked rice").getByRole("region", { name: /^Batch \d+: cooked rice$/ })).toHaveCount(2);
  await expectPantry(request, original.map((stock, index) => index ? stock : { ...stock, name: "cooked rice", measure: "250 g" }));
  await details(page, "cooked rice").getByRole("button", { name: "Undo last batch edit", exact: true }).click();
  await expect(details(page)).toBeVisible();
  await expectPantry(request, original);
  await expect(details(page).getByRole("region", { name: /^Batch \d+: rice$/ })).toHaveCount(5);
  expect(writes).toHaveLength(2);
});

test("moving the final batch out of a location preserves location and closes to the Pantry heading", async ({ page, request }) => {
  const rice = stocks()[0];
  await save(request, { ...empty(), pantry: [rice] });
  await openPantry(page);
  await choosePantryLocation(page, "Cupboard");
  const before = await document(request), writes = watch(page);
  await openDetails(page);
  await batch(page, 1).getByRole("button", { name: "Move", exact: true }).click();
  const move = page.getByRole("dialog", { name: "Move rice", exact: true });
  await move.getByRole("combobox", { name: "Move to", exact: true }).selectOption("freezer");
  await unchanged(page, request, before, writes);
  await move.getByRole("button", { name: "Move entry", exact: true }).click();
  await expect(details(page)).toBeVisible();
  await expectPantry(request, [{ ...rice, location: "freezer" }]);
  await expect(batch(page, 1)).toContainText("Freezer");
  await details(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeFocused();
  await expectPantryLocation(page, "Cupboard", 0);
  expect(writes).toHaveLength(1);
});

test("a stale usage draft cannot overwrite a later batch and reloading uses its live amount", async ({ page, request }) => {
  await openPantry(page);
  await openDetails(page);
  await batch(page, 1).getByRole("button", { name: "Use some", exact: true }).click();
  await editor(page).getByLabel("Amount used from this batch", { exact: true }).fill("100 g");
  const external = stocks().map((stock, index) => index ? stock : { ...stock, measure: "450 g" });
  await save(request, { ...empty(), pantry: external });
  await refresh(page);
  const before = await document(request), writes = watch(page);
  await expect(editor(page).getByRole("alert")).toContainText("This batch changed after the editor was opened");
  await expect(editor(page).getByRole("button", { name: "Subtract usage", exact: true })).toBeDisabled();
  await unchanged(page, request, before, writes);
  await editor(page).getByRole("button", { name: "Load current batch", exact: true }).click();
  await editor(page).getByLabel("Amount used from this batch", { exact: true }).fill("50 g");
  await editor(page).getByRole("button", { name: "Subtract usage", exact: true }).click();
  await expect(details(page)).toBeVisible();
  await expectPantry(request, external.map((stock, index) => index ? stock : { ...stock, measure: "400 g" }));
  expect(writes).toHaveLength(1);
});

test("locally rejected upkeep actions stay editable and cancel back to Details", async ({ page, request }) => {
  const { before } = await openPendingKitchenOutbox(page, request);
  await openDetails(page);
  await batch(page, 1).getByRole("button", { name: "Use some", exact: true }).click();
  await editor(page).getByLabel("Amount used from this batch", { exact: true }).fill("100 g");
  await editor(page).getByRole("button", { name: "Subtract usage", exact: true }).click();
  await notApplied(editor(page));
  await expect(editor(page).getByRole("button", { name: "Subtract usage", exact: true })).toBeEnabled();
  await editor(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(details(page)).toBeVisible();
  await batch(page, 1).getByRole("button", { name: "Move", exact: true }).click();
  const move = page.getByRole("dialog", { name: "Move rice", exact: true });
  await move.getByRole("combobox", { name: "Move to", exact: true }).selectOption("fridge");
  await move.getByRole("button", { name: "Move entry", exact: true }).click();
  await expect(move.getByRole("alert")).toContainText("not moved");
  await expect(move.getByRole("button", { name: "Move entry", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(details(page)).toBeVisible();
  await expect(details(page).getByRole("button", { name: "Undo last batch edit", exact: true })).toHaveCount(0);
  expect((await draft(page)).writeQueue.writes).toHaveLength(MAX_PENDING_KITCHEN_WRITES);
  expect((await draft(page)).state.pantry).toEqual(before.state!.pantry);
  expect(await document(request)).toEqual(before);
});

test("a panel Undo rejected at the queue limit remains available and keeps the applied batch", async ({ page, request }) => {
  const { before } = await openPendingKitchenOutbox(page, request, { pending: MAX_PENDING_KITCHEN_WRITES - 1 });
  await openDetails(page);
  await batch(page, 1).getByRole("button", { name: "Use some", exact: true }).click();
  await editor(page).getByLabel("Amount used from this batch", { exact: true }).fill("100 g");
  await editor(page).getByRole("button", { name: "Subtract usage", exact: true }).click();
  await expect(details(page)).toBeVisible();
  await details(page).getByRole("button", { name: "Undo last batch edit", exact: true }).click();
  await notApplied(details(page));
  await expect(details(page).getByRole("button", { name: "Undo last batch edit", exact: true })).toBeEnabled();
  await expect(batch(page, 1)).toContainText("400 g");
  const cached = await draft(page);
  expect(cached.writeQueue.writes).toHaveLength(MAX_PENDING_KITCHEN_WRITES);
  expect(cached.writeQueue.writes.at(-1).command.type).toBe("ReplacePantryBatch");
  expect(cached.state.pantry).toEqual(stocks().map((stock, index) => index ? stock : { ...stock, measure: "400 g" }));
  expect(await document(request)).toEqual(before);
});

test("date reminders count scoped batches despite search and preserve storage through navigation and history", async ({ page, request }) => {
  const pantry = [...stocks(),
    { id: "soon-beans", name: "beans", measure: "100 g", useBy: TODAY, location: "cupboard" as const },
    { id: "past-lentils", name: "lentils", measure: "50 g", useBy: "2026-10-21", location: "cupboard" as const },
  ];
  await save(request, { ...empty(), pantry });
  await openPantry(page);
  await choosePantryLocation(page, "Cupboard");
  const before = await document(request), writes = watch(page);
  const search = page.getByRole("searchbox", { name: "Search pantry", exact: true });
  await search.fill("nothing here");
  const reminders = page.getByRole("group", { name: "Pantry date reminders", exact: true });
  await expect(reminders.getByRole("button", { name: "Use soon (2 batches)", exact: true })).toBeVisible();
  await reminders.getByRole("button", { name: "Past entered date (1 batch)", exact: true }).click();
  await expect(search).toHaveValue("");
  await expectPantryLocation(page, "Cupboard", 2);
  await expect(page.getByRole("button", { name: "Past entered date (2)", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".pantry-batch-row")).toHaveCount(1);
  await expect(page.locator("#pantry-row-past-lentils")).toBeVisible();
  await reminders.getByRole("button", { name: "Use soon (2 batches)", exact: true }).click();
  await expect(page.getByRole("button", { name: "Use soon (3)", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".pantry-batch-row")).toHaveCount(2);
  await expect(page.locator("#pantry-row-rice-cupboard")).toBeVisible();
  await expect(page.locator("#pantry-row-soon-beans")).toBeVisible();
  await navigate(page, "Recipes");
  await page.goBack();
  await expectPantryLocation(page, "Cupboard", 2);
  await navigate(page, "Recipes");
  await navigate(page, "Pantry");
  await expectPantryLocation(page, "Cupboard", 2);
  await choosePantryLocation(page, "Fridge");
  await navigate(page, "Recipes");
  await page.goBack();
  await expectPantryLocation(page, "Fridge", 1);
  await unchanged(page, request, before, writes);
});


test("Manage batches reopens a collapsed browser and refocuses the live batch on repeat visits", async ({ page, request }) => {
  await openPantry(page);
  const before = await document(request), writes = watch(page);
  await openPantryIngredientManagement(page, "rice");
  const amount = page.locator("#pantry-row-rice-cupboard").getByRole("textbox", { name: "Available rice", exact: true });
  await expect(amount).toBeFocused();
  const management = page.locator("details.pantry-management");
  await management.locator(":scope > summary").click();
  await expect(management).not.toHaveAttribute("open");
  await openPantryIngredientManagement(page, "rice");
  await expect(management).toHaveAttribute("open", "");
  await expect(amount).toBeFocused();
  await unchanged(page, request, before, writes);
});

test("moving the last Unsorted batch and restoring legacy location history default to All without assigning stock", async ({ page, request }) => {
  const rice: PantryStock = { id: "unsorted-rice", name: "rice", measure: "500 g" };
  const beans: PantryStock = { id: "cupboard-beans", name: "beans", measure: "100 g", location: "cupboard" };
  await save(request, { ...empty(), pantry: [rice, beans] });
  await openPantry(page);
  await choosePantryLocation(page, "Unsorted");
  await openDetails(page);
  await batch(page, 1).getByRole("button", { name: "Move", exact: true }).click();
  const move = page.getByRole("dialog", { name: "Move rice", exact: true });
  await move.getByRole("combobox", { name: "Move to", exact: true }).selectOption("cupboard");
  await move.getByRole("button", { name: "Move entry", exact: true }).click();
  await expect(details(page)).toBeVisible();
  await details(page).getByRole("button", { name: "Close", exact: true }).click();
  await expectPantryLocation(page, "All", 2);
  await expectPantry(request, [{ ...rice, location: "cupboard" }, beans]);
  const before = await document(request), writes = watch(page);
  for (const value of ["unsorted", "obsolete", null]) {
    await page.evaluate(location => {
      const navigation = { ...window.history.state.ragChefNavigation };
      if (location === null) delete navigation.pantryLocation; // An older history entry has no location field.
      else navigation.pantryLocation = location;
      window.history.replaceState({ ...window.history.state, ragChefNavigation: navigation }, "");
    }, value);
    await navigate(page, "Recipes");
    await page.goBack();
    await expectPantryLocation(page, "All", 2);
  }
  await unchanged(page, request, before, writes);
});
