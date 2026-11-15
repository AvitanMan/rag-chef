import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { KitchenDocument, KitchenState } from "../../app/lib/kitchen-types";
import type { KitchenCommand } from "../../app/lib/kitchen-commands";
import { MAX_PENDING_KITCHEN_WRITES } from "../../app/lib/kitchen-write-queue";
import { openPantryAdd } from "./pantry-helpers";
import { draft, navigate, openPendingKitchenOutbox, saved } from "./pending-kitchen-outbox";

const TODAY = "2026-10-22";
const stock = { id: "rejection-rice", name: "rice", measure: "500 g", location: "cupboard" as const };
const fixture = (): KitchenState => ({ schemaVersion: 2, pantry: [{ ...stock }], meals: {}, shoppingChecked: {}, favoriteRecipeIds: [], migratedLegacy: true });

async function rejection(scope: Locator, verb: "added" | "applied" | "moved") {
  const message = scope.getByRole("alert").filter({ hasText: new RegExp(`not ${verb}`, "i") });
  await expect(message).toContainText(/try again/i);
}

async function unchanged(page: Page, request: APIRequestContext, before: KitchenDocument) {
  await page.clock.runFor(700);
  const cached = await draft(page);
  expect(cached.state.pantry).toEqual(before.state!.pantry);
  expect(cached.writeQueue.writes).toHaveLength(MAX_PENDING_KITCHEN_WRITES);
  expect(cached.writeQueue.writes.every((write: { command: KitchenCommand }) => write.command.type === "SetFavorite")).toBe(true);
  expect(await saved(request)).toEqual(before);
}

async function details(page: Page) {
  await page.getByRole("button", { name: "Details for rice", exact: true }).click();
  const row = page.locator(`#pantry-row-${stock.id}`);
  await expect(row).toBeVisible();
  return row;
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

test("a locally rejected quick addition retains its text and edited location for another attempt", async ({ page, request }) => {
  const { before } = await openPendingKitchenOutbox(page, request);
  await openPantryAdd(page);
  const text = page.getByRole("textbox", { name: "New pantry ingredient", exact: true });
  const location = page.getByRole("combobox", { name: "Location for ingredient 1", exact: true });
  await text.fill("milk");
  await location.selectOption("freezer");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  await rejection(page.locator(".pantry-page"), "added");
  await expect(text).toHaveValue("milk");
  await expect(location).toHaveValue("freezer");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await navigate(page, "Recipes");
  await navigate(page, "Pantry");
  await expect(text).toHaveValue("milk");
  await expect(location).toHaveValue("freezer");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  await rejection(page.locator(".pantry-page"), "added");
  await unchanged(page, request, before);
});

test("a locally rejected measured import remains editable in its review dialog", async ({ page, request }) => {
  const { before } = await openPendingKitchenOutbox(page, request);
  await openPantryAdd(page);
  const text = page.getByRole("textbox", { name: "New pantry ingredient", exact: true });
  await text.fill("lentils: 300 g");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Review pantry ingredients", exact: true });
  await preview.getByRole("button", { name: "Confirm ingredients", exact: true }).click();
  await rejection(preview, "added");
  await expect(preview.getByRole("textbox", { name: "Ingredient 1", exact: true })).toBeEnabled();
  await preview.getByRole("textbox", { name: "Amount 1", exact: true }).fill("400 g");
  await preview.getByRole("combobox", { name: "Location 1", exact: true }).selectOption("freezer");
  await preview.getByRole("button", { name: "Confirm ingredients", exact: true }).click();
  await rejection(preview, "added");
  await expect(preview.getByRole("textbox", { name: "Amount 1", exact: true })).toHaveValue("400 g");
  await expect(preview.getByRole("combobox", { name: "Location 1", exact: true })).toHaveValue("freezer");
  await preview.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(text).toHaveValue("lentils: 300 g");
  await unchanged(page, request, before);
});

test("locally rejected inline and dialog edits keep their drafts and action controls available", async ({ page, request }) => {
  const { before } = await openPendingKitchenOutbox(page, request);
  const row = await details(page);
  const inlineAmount = row.getByRole("textbox", { name: "Available rice", exact: true });
  await inlineAmount.fill("450 g");
  await inlineAmount.press("Enter");
  await rejection(row, "applied");
  await expect(inlineAmount).toBeEnabled();
  await expect(inlineAmount).toHaveValue("450 g");
  await expect(inlineAmount).toHaveAttribute("aria-invalid", "true");
  await row.getByRole("button", { name: "Restore current value", exact: true }).click();
  await expect(inlineAmount).toHaveValue("500 g");
  await expect(inlineAmount).toHaveAttribute("aria-invalid", "false");
  await expect(row.getByRole("alert")).toHaveCount(0);
  await row.getByRole("button", { name: "Edit batch rice", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit batch rice", exact: true });
  const amount = editor.getByRole("textbox", { name: "Amount on hand", exact: true });
  await amount.fill("400 g");
  await editor.getByRole("button", { name: "Save batch correction", exact: true }).click();
  await rejection(editor, "applied");
  await expect(amount).toBeEnabled();
  await expect(amount).toHaveValue("400 g");
  await expect(editor.getByRole("button", { name: "Save batch correction", exact: true })).toBeEnabled();
  await expect(editor.getByRole("status").filter({ hasText: "Applying" })).toHaveCount(0);
  await editor.getByRole("button", { name: "Record usage", exact: true }).click();
  await editor.getByRole("textbox", { name: "Amount used from this batch", exact: true }).fill("100 g");
  await editor.getByRole("button", { name: "Subtract usage", exact: true }).click();
  await rejection(editor, "applied");
  await expect(editor.getByRole("button", { name: "Subtract usage", exact: true })).toBeEnabled();
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(row.getByRole("textbox", { name: "Available rice", exact: true })).toHaveValue("500 g");
  await unchanged(page, request, before);
});

test("a locally rejected move keeps the destination editable instead of waiting forever", async ({ page, request }) => {
  const { before } = await openPendingKitchenOutbox(page, request);
  const row = await details(page);
  await row.getByRole("button", { name: "Move batch rice", exact: true }).click();
  const move = page.getByRole("dialog", { name: "Move rice", exact: true });
  const destination = move.getByRole("combobox", { name: "Move to", exact: true });
  await destination.selectOption("freezer");
  await move.getByRole("button", { name: "Move entry", exact: true }).click();
  await rejection(move, "moved");
  await expect(destination).toBeEnabled();
  await expect(destination).toHaveValue("freezer");
  await expect(move.getByRole("button", { name: "Move entry", exact: true })).toBeEnabled();
  await expect(move.getByRole("status").filter({ hasText: "Moving entry" })).toHaveCount(0);
  await destination.selectOption("fridge");
  await move.getByRole("button", { name: "Move entry", exact: true }).click();
  await rejection(move, "moved");
  await expect(destination).toHaveValue("fridge");
  await move.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(row).toContainText("Cupboard");
  await unchanged(page, request, before);
});

test("a locally rejected removal keeps the batch and creates no removal Undo or success notice", async ({ page, request }) => {
  const { before } = await openPendingKitchenOutbox(page, request);
  const row = await details(page);
  await row.getByRole("button", { name: "Remove rice", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /This removal was not applied/i })).toContainText(/try again/i);
  await expect(row).toBeVisible();
  await expect(row.getByRole("textbox", { name: "Available rice", exact: true })).toHaveValue("500 g");
  await expect(page.getByRole("region", { name: "Recently removed", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Last pantry batch edit", exact: true })).toHaveCount(0);
  await expect(page.getByText("Removed rice.", { exact: true })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Remove rice", exact: true })).toBeEnabled();
  await unchanged(page, request, before);
});

test("Undo stays available when an accepted batch edit fills the local outbox", async ({ page, request }) => {
  const { before } = await openPendingKitchenOutbox(page, request, { pending: MAX_PENDING_KITCHEN_WRITES - 1 });
  const row = await details(page);
  await row.getByRole("button", { name: "Edit batch rice", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit batch rice", exact: true });
  await editor.getByRole("textbox", { name: "Amount on hand", exact: true }).fill("400 g");
  await editor.getByRole("button", { name: "Save batch correction", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("Batch correction applied for rice.");
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  const undo = page.getByRole("region", { name: "Last pantry batch edit", exact: true });
  await undo.getByRole("button", { name: "Undo last batch edit", exact: true }).click();
  await rejection(page.locator(".pantry-page"), "applied");
  await expect(undo.getByRole("button", { name: "Undo last batch edit", exact: true })).toBeEnabled();
  await expect(row.getByRole("textbox", { name: "Available rice", exact: true })).toHaveValue("400 g");
  const cached = await draft(page);
  expect(cached.writeQueue.writes).toHaveLength(MAX_PENDING_KITCHEN_WRITES);
  expect(cached.writeQueue.writes.at(-1).command.type).toBe("ReplacePantryBatch");
  expect(cached.state.pantry).toEqual([{ ...stock, measure: "400 g" }]);
  expect(await saved(request)).toEqual(before);
});
