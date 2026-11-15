import { test, expect } from "@playwright/test";
import type { KitchenState } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";
import type { KitchenCommand } from "../../app/lib/kitchen-commands";
import { createPlannedMeal, weekStart } from "../../app/lib/kitchen-state";
import { MAX_PENDING_KITCHEN_WRITES } from "../../app/lib/kitchen-write-queue";
import { shoppingForWeek } from "../../app/lib/shopping-purchases";
import { draft, openPendingKitchenOutbox, saved } from "./pending-kitchen-outbox";

const TODAY = "2026-10-22", WEEK = weekStart(TODAY);
const originalStock = { id: "existing-oats", name: "oats", measure: "500 g", location: "cupboard" as const };
const recipe: Recipe = { id: "purchase-rejection-recipe", title: "Purchase test dinner", image: null, category: "Dinner", cuisine: "", tags: [],
  source: { name: "Synthetic test", url: "https://example.test" }, sourceUrl: "https://example.test/purchases", instructions: ["Cook the ingredients."],
  ingredients: [{ name: "rice", measure: "200 g" }, { name: "milk", measure: "200 ml" }, { name: "tomato", measure: "2" }] };

function fixture(): KitchenState {
  const previousKey = `${WEEK}:oats:mass`;
  const state: KitchenState = { schemaVersion: 2, pantry: [{ ...originalStock }], meals: { [TODAY]: createPlannedMeal(TODAY, recipe) },
    shoppingChecked: { [previousKey]: true }, shoppingCycles: { [previousKey]: "previous-oats-cycle" }, favoriteRecipeIds: [], migratedLegacy: true,
    shoppingPurchases: [{ id: "previous-oats-purchase", week: WEEK, at: "2026-10-20T12:00:00.000Z", items: [
      { key: previousKey, cycleId: "previous-oats-cycle", pantry: { ...originalStock } },
    ] }] };
  for (const item of shoppingForWeek(state, WEEK, TODAY)) {
    state.shoppingChecked[item.key] = true;
    state.shoppingCycles![item.key] = `purchase-cycle-${item.name}`;
  }
  return state;
}

test.beforeEach(async ({ page, request, baseURL }) => {
  expect(baseURL, "Run with the disposable isolated preview").toBeTruthy();
  expect(["127.0.0.1", "localhost"]).toContain(new URL(baseURL!).hostname);
  expect(new URL(baseURL!).port).not.toBe("3000");
  await page.clock.install({ time: new Date(`${TODAY}T12:00:00+03:00`) });
  await page.route("**/api/chef", route => route.abort());
  const current = await saved(request);
  const response = await request.put("/api/kitchen", { data: { revision: current.revision, state: fixture() } });
  expect(response.ok(), await response.text()).toBeTruthy();
});

test("rejected purchase additions retain all choices and retry once after real outbox capacity recovers", async ({ page, request }) => {
  const { before, attempts, allowOneSave } = await openPendingKitchenOutbox(page, request, { view: "Shopping" });
  await page.getByRole("button", { name: "Add bought items to pantry", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Add bought items to pantry", exact: true });
  const riceAmount = preview.getByRole("textbox", { name: "Amount bought rice", exact: true });
  const riceDate = preview.getByLabel("Use by rice", { exact: true });
  const riceLocation = preview.getByRole("combobox", { name: "Location for rice", exact: true });
  await riceAmount.fill("375 g");
  await riceDate.fill("2026-10-25");
  await riceLocation.selectOption("freezer");
  await preview.getByRole("textbox", { name: "Amount bought milk", exact: true }).fill("one bottle");
  await preview.getByLabel("Use by milk", { exact: true }).fill("2026-10-26");
  await preview.getByRole("combobox", { name: "Location for milk", exact: true }).selectOption("cupboard");
  await preview.getByRole("button", { name: "Skip purchased tomato", exact: true }).click();
  const batchIds = await preview.locator('input[type="date"]').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).name.slice("useBy-".length)).sort());
  const confirm = preview.getByRole("button", { name: "Confirm pantry additions", exact: true });
  const rejected = preview.getByRole("alert").filter({ hasText: "Purchase additions were not applied" });
  await confirm.click();
  await expect(rejected).toContainText("Your choices are kept");
  await expect(rejected).toContainText("try again");
  await expect(confirm).toBeEnabled();
  await expect(riceAmount).toHaveValue("375 g");
  await expect(riceDate).toHaveValue("2026-10-25");
  await expect(riceLocation).toHaveValue("freezer");
  await expect(preview.getByRole("textbox", { name: "Amount bought tomato", exact: true })).toHaveCount(0);
  await riceAmount.fill("400 g");
  await expect(rejected).toHaveCount(0);
  await confirm.click();
  await expect(rejected).toBeVisible();
  await page.clock.runFor(700);
  expect(await saved(request)).toEqual(before);
  let cached = await draft(page);
  expect(cached.state).toEqual(before.state);
  expect(cached.writeQueue.writes).toHaveLength(MAX_PENDING_KITCHEN_WRITES);
  expect(attempts.every(command => command.type === "SetFavorite")).toBe(true);
  expect(await preview.locator('input[type="date"]').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).name.slice("useBy-".length)).sort())).toEqual(batchIds);

  await allowOneSave();
  await expect(preview).toBeVisible();
  await expect(riceAmount).toHaveValue("400 g");
  await expect(riceDate).toHaveValue("2026-10-25");
  await expect(riceLocation).toHaveValue("freezer");
  await expect(preview.getByRole("textbox", { name: "Amount bought milk", exact: true })).toHaveValue("one bottle");
  await expect(preview.getByLabel("Use by milk", { exact: true })).toHaveValue("2026-10-26");
  await expect(preview.getByRole("combobox", { name: "Location for milk", exact: true })).toHaveValue("cupboard");
  await confirm.click();
  await expect(preview).toHaveCount(0);
  await expect.poll(async () => (await draft(page)).state.shoppingPurchases.length).toBe(2);
  cached = await draft(page);
  const purchases = cached.writeQueue.writes.filter((write: { command: KitchenCommand }) => write.command.type === "RecordPurchase");
  expect(purchases).toHaveLength(1);
  expect(cached.writeQueue.writes).toHaveLength(MAX_PENDING_KITCHEN_WRITES);
  expect(cached.state.pantry[0]).toEqual(originalStock);
  expect(cached.state.pantry).toHaveLength(3);
  expect(new Set(cached.state.pantry.map((stock: { id: string }) => stock.id)).size).toBe(3);
  expect(cached.state.shoppingChecked).toEqual(before.state!.shoppingChecked);
  expect(cached.state.shoppingCycles).toEqual(before.state!.shoppingCycles);
  expect(cached.state.shoppingPurchases[0]).toEqual(before.state!.shoppingPurchases![0]);
  const receipt = cached.state.shoppingPurchases[1];
  expect(receipt.id).toBe(purchases[0].command.commandId);
  expect(receipt.items.map((item: { pantry: { id: string } }) => item.pantry.id).sort()).toEqual(batchIds);
  expect(receipt.items.find((item: { pantry: { name: string } }) => item.pantry.name === "rice").pantry).toMatchObject({ measure: "400 g", useBy: "2026-10-25", location: "freezer" });
  expect(receipt.items.find((item: { pantry: { name: string } }) => item.pantry.name === "milk").pantry).toMatchObject({ measure: "one bottle", useBy: "2026-10-26", location: "cupboard" });
  for (const item of receipt.items) expect(item.cycleId).toBe(before.state!.shoppingCycles![item.key]);
  await page.getByRole("button", { name: "Add bought items to pantry", exact: true }).click();
  await expect(preview.getByRole("textbox", { name: "Amount bought tomato", exact: true })).toBeVisible();
  await expect(preview.getByRole("textbox", { name: "Amount bought rice", exact: true })).toHaveCount(0);
  await expect(preview.getByRole("textbox", { name: "Amount bought milk", exact: true })).toHaveCount(0);
  await preview.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await draft(page)).state.shoppingPurchases).toEqual(cached.state.shoppingPurchases);
});
