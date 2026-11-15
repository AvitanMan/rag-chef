import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { KitchenDocument, KitchenState } from "../../app/lib/kitchen-types";
import { isKitchenWrite } from "./kitchen-requests";
import { openPantryIngredientManagement, choosePantryLocation, openPantryAdd, openSpiceChecklist } from "./pantry-helpers";

const TODAY = "2026-10-22";
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });

async function document(request: APIRequestContext): Promise<KitchenDocument> {
  const response = await request.get("/api/kitchen");
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function navigate(page: Page, name: string) {
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click();
}

function placement(page: Page, index: number) {
  return page.getByRole("combobox", { name: `Location for ingredient ${index}`, exact: true });
}

test.beforeEach(async ({ page, request, baseURL }) => {
  expect(baseURL, "Run with the disposable isolated preview").toBeTruthy();
  expect(["127.0.0.1", "localhost"]).toContain(new URL(baseURL!).hostname);
  expect(new URL(baseURL!).port).not.toBe("3000");
  await page.clock.install({ time: new Date(`${TODAY}T12:00:00+03:00`) });
  await page.route("**/api/chef", route => route.abort());
  const current = await document(request);
  const response = await request.put("/api/kitchen", { data: { revision: current.revision, state: empty() } });
  expect(response.ok(), await response.text()).toBeTruthy();
  await page.goto("/");
  await navigate(page, "Pantry");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await openPantryAdd(page);
});

test("explicit draft placements survive storage and page navigation while untouched rows follow the current default", async ({ page, request }) => {
  const before = await document(request), writes: string[] = [];
  page.on("request", request => { if (isKitchenWrite(request)) writes.push(request.url()); });
  const draft = page.getByRole("textbox", { name: "New pantry ingredient", exact: true });
  await draft.fill("milk, rice");
  await placement(page, 1).selectOption("freezer");
  await choosePantryLocation(page, "Fridge");
  await expect(draft).toHaveValue("milk, rice");
  await expect(placement(page, 1)).toHaveValue("freezer");
  await expect(placement(page, 2)).toHaveValue("fridge");
  await choosePantryLocation(page, "All");
  await expect(placement(page, 1)).toHaveValue("freezer");
  await expect(placement(page, 2)).toHaveValue("cupboard");
  await navigate(page, "Recipes");
  await navigate(page, "Pantry");
  await expect(draft).toHaveValue("milk, rice");
  await expect(placement(page, 1)).toHaveValue("freezer");
  await expect(placement(page, 2)).toHaveValue("cupboard");
  await page.clock.runFor(700);
  expect(writes).toEqual([]);
  expect(await document(request)).toEqual(before);

  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  await expect.poll(async () => (await document(request)).state!.pantry.map(stock => ({ name: stock.name, location: stock.location }))).toEqual([
    { name: "milk", location: "freezer" }, { name: "rice", location: "cupboard" },
  ]);
  await openPantryAdd(page);
  await expect(draft).toHaveValue("");
  await draft.fill("milk, rice");
  await expect(placement(page, 1)).toHaveValue("fridge");
});

test("canceling review and adding spices preserve the pending text and its explicit placement", async ({ page, request }) => {
  const before = await document(request);
  const draft = page.getByRole("textbox", { name: "New pantry ingredient", exact: true });
  await draft.fill("rice: 300 g");
  await placement(page, 1).selectOption("freezer");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Review pantry ingredients", exact: true });
  await expect(preview.getByRole("combobox", { name: "Location 1", exact: true })).toHaveValue("freezer");
  await preview.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(draft).toHaveValue("rice: 300 g");
  await expect(placement(page, 1)).toHaveValue("freezer");
  expect(await document(request)).toEqual(before);

  await choosePantryLocation(page, "Spice rack");
  await openSpiceChecklist(page);
  await page.getByRole("checkbox", { name: "salt", exact: true }).check();
  await page.getByRole("button", { name: "Add selected spices", exact: true }).click();
  await expect.poll(async () => (await document(request)).state!.pantry.map(stock => stock.name)).toEqual(["salt"]);
  await expect(draft).toHaveValue("rice: 300 g");
  await expect(placement(page, 1)).toHaveValue("freezer");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  await expect(preview.getByRole("combobox", { name: "Location 1", exact: true })).toHaveValue("freezer");
  await preview.getByRole("button", { name: "Confirm ingredients", exact: true }).click();
  await expect.poll(async () => (await document(request)).state!.pantry.find(stock => stock.name === "rice")).toMatchObject({ measure: "300 g", location: "freezer" });
  await choosePantryLocation(page, "All");
  await openPantryAdd(page);
  await expect(draft).toHaveValue("");
  await draft.fill("rice");
  await expect(placement(page, 1)).toHaveValue("cupboard");
});

test("removed or cleared draft rows do not leave placement overrides for later input", async ({ page }) => {
  const draft = page.getByRole("textbox", { name: "New pantry ingredient", exact: true });
  await draft.fill("rice, milk");
  await placement(page, 1).selectOption("freezer");
  await draft.fill("milk");
  await draft.fill("rice, milk");
  await expect(placement(page, 1)).toHaveValue("cupboard");
  await placement(page, 1).selectOption("");
  await choosePantryLocation(page, "Fridge");
  await expect(placement(page, 1)).toHaveValue("");
  await draft.fill("");
  await draft.fill("rice");
  await expect(placement(page, 1)).toHaveValue("fridge");
});

test("inserting and reordering draft ingredients keeps retained placements and prunes removed rows", async ({ page, request }) => {
  const before = await document(request), writes: string[] = [];
  page.on("request", request => { if (isKitchenWrite(request)) writes.push(request.url()); });
  const draft = page.getByRole("textbox", { name: "New pantry ingredient", exact: true });
  await draft.fill("rice, milk, garlic");
  await placement(page, 2).selectOption("freezer");
  await placement(page, 3).selectOption("");
  await draft.fill("onion, rice, milk, garlic");
  await expect(placement(page, 3)).toHaveValue("freezer");
  await expect(placement(page, 4)).toHaveValue("");
  await draft.fill("milk, garlic, rice, onion");
  await expect(placement(page, 1)).toHaveValue("freezer");
  await expect(placement(page, 2)).toHaveValue("");
  await draft.fill("garlic, rice, onion");
  await expect(placement(page, 1)).toHaveValue("");
  await draft.fill("milk, garlic, rice, onion");
  await expect(placement(page, 1)).toHaveValue("fridge");
  await expect(placement(page, 2)).toHaveValue("");
  await page.clock.runFor(700);
  expect(writes).toEqual([]);
  expect(await document(request)).toEqual(before);
});

test("deleting the first same-name draft keeps the remaining batch's own placement", async ({ page, request }) => {
  const before = await document(request), writes: string[] = [];
  page.on("request", request => { if (isKitchenWrite(request)) writes.push(request.url()); });
  const draft = page.getByRole("textbox", { name: "New pantry ingredient", exact: true });
  await draft.fill("milk: 1 l\nmilk: 2 l");
  await placement(page, 1).selectOption("freezer");
  await placement(page, 2).selectOption("cupboard");
  await draft.fill("milk: 2 l");
  await expect(placement(page, 1)).toHaveValue("cupboard");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Review pantry ingredients", exact: true });
  await expect(preview.getByRole("textbox", { name: "Amount 1", exact: true })).toHaveValue("2 l");
  await expect(preview.getByRole("combobox", { name: "Location 1", exact: true })).toHaveValue("cupboard");
  await page.clock.runFor(700);
  expect(writes).toEqual([]);
  expect(await document(request)).toEqual(before);
  await preview.getByRole("button", { name: "Confirm ingredients", exact: true }).click();
  await expect.poll(async () => (await document(request)).state!.pantry.map(item => ({ name: item.name, measure: item.measure, location: item.location })))
    .toEqual([{ name: "milk", measure: "2 l", location: "cupboard" }]);
});

test("reordering same-name drafts retains their placements while an inserted batch uses its default", async ({ page, request }) => {
  const before = await document(request), writes: string[] = [];
  page.on("request", request => { if (isKitchenWrite(request)) writes.push(request.url()); });
  const draft = page.getByRole("textbox", { name: "New pantry ingredient", exact: true });
  await draft.fill("milk: 1 l\nmilk: 2 l");
  await placement(page, 1).selectOption("freezer");
  await placement(page, 2).selectOption("");
  await draft.fill("milk: 2 l\nmilk: 3 l\nmilk: 1 l");
  await expect(placement(page, 1)).toHaveValue("");
  await expect(placement(page, 2)).toHaveValue("fridge");
  await expect(placement(page, 3)).toHaveValue("freezer");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Review pantry ingredients", exact: true });
  for (const [index, measure] of ["2 l", "3 l", "1 l"].entries()) {
    await expect(preview.getByRole("textbox", { name: `Amount ${index + 1}`, exact: true })).toHaveValue(measure);
  }
  for (const [index, location] of ["", "fridge", "freezer"].entries()) {
    await expect(preview.getByRole("combobox", { name: `Location ${index + 1}`, exact: true })).toHaveValue(location);
  }
  await page.clock.runFor(700);
  expect(writes).toEqual([]);
  expect(await document(request)).toEqual(before);
  await preview.getByRole("button", { name: "Confirm new batches", exact: true }).click();
  await expect.poll(async () => (await document(request)).state!.pantry.map(item => ({ name: item.name, measure: item.measure, location: item.location ?? null })))
    .toEqual([
      { name: "milk", measure: "2 l", location: null },
      { name: "milk", measure: "3 l", location: "fridge" },
      { name: "milk", measure: "1 l", location: "freezer" },
    ]);
});

test("adding another batch appends to the pending ingredient draft and keeps its placement", async ({ page, request }) => {
  const current = await document(request);
  const rice = { id: "saved-rice", name: "rice", measure: "500 g", location: "cupboard" };
  const response = await request.put("/api/kitchen", { data: { revision: current.revision, state: { ...empty(), pantry: [rice] } } });
  expect(response.ok(), await response.text()).toBeTruthy();
  await page.reload();
  await navigate(page, "Pantry");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await openPantryAdd(page);
  const before = await document(request), writes: string[] = [];
  page.on("request", request => { if (isKitchenWrite(request)) writes.push(request.url()); });
  const draft = page.getByRole("textbox", { name: "New pantry ingredient", exact: true });
  await draft.fill("milk, garlic");
  await placement(page, 1).selectOption("freezer");
  await page.locator(".pantry-add-disclosure > summary").click();
  await openPantryIngredientManagement(page, "rice");
  await page.getByRole("button", { name: "Add another batch of rice", exact: true }).click();
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("milk, garlic\nrice: ");
  await expect(placement(page, 1)).toHaveValue("freezer");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Review pantry ingredients", exact: true });
  for (const [index, name] of ["milk", "garlic", "rice"].entries()) {
    await expect(preview.getByRole("textbox", { name: `Ingredient ${index + 1}`, exact: true })).toHaveValue(name);
  }
  await expect(preview.getByRole("combobox", { name: "Location 1", exact: true })).toHaveValue("freezer");
  await page.clock.runFor(700);
  expect(writes).toEqual([]);
  expect(await document(request)).toEqual(before);
  await preview.getByRole("button", { name: "Confirm new batches", exact: true }).click();
  await expect.poll(async () => (await document(request)).state!.pantry.length).toBe(4);
  const added = (await document(request)).state!.pantry;
  expect(added[0]).toEqual(rice);
  expect(added[1]).toMatchObject({ name: "milk", location: "freezer" });
  expect(added.map(item => item.name)).toEqual(["rice", "milk", "garlic", "rice"]);
});

test("Chef quick-add preserves and edits multiline Pantry drafts without joining ingredients", async ({ page, request }) => {
  const before = await document(request), writes: string[] = [];
  page.on("request", request => { if (isKitchenWrite(request)) writes.push(request.url()); });
  const text = "rice: 300 g\nmilk";
  const pantryDraft = page.getByRole("textbox", { name: "New pantry ingredient", exact: true });
  await pantryDraft.fill(text);
  await placement(page, 1).selectOption("freezer");
  await navigate(page, "Chef");
  await page.getByRole("button", { name: "+ Add ingredient", exact: true }).click();
  const chefDraft = page.getByRole("textbox", { name: "Ingredient name", exact: true });
  await expect(chefDraft).toHaveValue(text);
  await chefDraft.press("ControlOrMeta+A");
  await chefDraft.press("ArrowRight");
  await chefDraft.press("Enter");
  await chefDraft.pressSequentially("garlic");
  await expect(chefDraft).toHaveValue(`${text}\ngarlic`);
  await navigate(page, "Pantry");
  await expect(pantryDraft).toHaveValue(`${text}\ngarlic`);
  await expect(placement(page, 1)).toHaveValue("freezer");

  await navigate(page, "Chef");
  await page.getByRole("button", { name: "+ Add ingredient", exact: true }).click();
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Review pantry ingredients", exact: true });
  for (const [index, name] of ["rice", "milk", "garlic"].entries()) {
    await expect(preview.getByRole("textbox", { name: `Ingredient ${index + 1}`, exact: true })).toHaveValue(name);
  }
  await expect(preview.getByRole("textbox", { name: "Amount 1", exact: true })).toHaveValue("300 g");
  await expect(preview.getByRole("combobox", { name: "Location 1", exact: true })).toHaveValue("freezer");
  await preview.getByRole("button", { name: "Cancel", exact: true }).click();
  await navigate(page, "Pantry");
  await expect(pantryDraft).toHaveValue(`${text}\ngarlic`);
  await expect(placement(page, 1)).toHaveValue("freezer");
  await page.clock.runFor(700);
  expect(writes).toEqual([]);
  expect(await document(request)).toEqual(before);
});
