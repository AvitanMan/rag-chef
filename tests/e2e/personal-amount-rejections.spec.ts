import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { KitchenState, PersonalRecipeAmounts } from "../../app/lib/kitchen-types";
import type { KitchenCommand } from "../../app/lib/kitchen-commands";
import { MAX_PENDING_KITCHEN_WRITES } from "../../app/lib/kitchen-write-queue";
import { draft, openPendingKitchenOutbox, saved } from "./pending-kitchen-outbox";

const RECIPE_ID = "fixture-tomato-rice";
const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, favoriteRecipeIds: [], migratedLegacy: true });

async function fixture(request: APIRequestContext, personal = true) {
  const catalog = await (await request.get("/api/recipes/catalog")).json();
  const amounts: PersonalRecipeAmounts = { contentHash: catalog.contentHashesByRecipeId[RECIPE_ID], referenceServings: 2,
    amounts: [{ ingredientIndex: 0, originalName: "rice", measure: "300 g" }] };
  const current = await saved(request);
  const state = { ...empty(), ...(personal ? { personalRecipeAmounts: { [RECIPE_ID]: amounts } } : {}) };
  const response = await request.put("/api/kitchen", { data: { revision: current.revision, state } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function editor(page: Page) {
  await page.getByRole("searchbox", { name: "Search recipes", exact: true }).fill("Tomato Rice");
  await page.locator(".recipe-card").getByRole("button", { name: "Tomato Rice", exact: true }).click();
  return page.getByRole("dialog", { name: "Tomato Rice", exact: true }).getByRole("region", { name: "Personal amounts", exact: true });
}

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-22T12:00:00+03:00") });
  await page.route("**/api/chef", route => route.abort());
});

for (const action of ["save", "reset"] as const) {
  test(`a locally rejected personal amount ${action} preserves its draft and succeeds after the outbox has room`, async ({ page, request }) => {
    await fixture(request);
    const outbox = await openPendingKitchenOutbox(page, request, { view: "Recipes" });
    const personal = await editor(page);
    const rice = personal.getByRole("textbox", { name: "Personal amount for rice", exact: true });
    await expect(rice).toHaveValue("300 g");
    await rice.fill("450 g");
    const button = personal.getByRole("button", { name: action === "save" ? "Save personal amounts" : "Reset to source amounts", exact: true });
    await button.click();
    await expect(personal.getByRole("alert")).toContainText(/Personal amounts were not saved.*try again/);
    await expect(rice).toHaveValue("450 g");
    await expect(rice).toBeEnabled();
    await expect(button).toBeEnabled();
    await expect(personal.getByRole("status").filter({ hasText: "Future dinners use" })).toHaveCount(0);
    await page.clock.runFor(700);
    let cached = await draft(page);
    expect(cached.writeQueue.writes).toHaveLength(MAX_PENDING_KITCHEN_WRITES);
    expect(cached.writeQueue.writes.every((write: { command: KitchenCommand }) => write.command.type === "SetFavorite")).toBe(true);
    expect(cached.state.personalRecipeAmounts).toEqual(outbox.before.state!.personalRecipeAmounts);
    expect(await saved(request)).toEqual(outbox.before);

    await outbox.allowOneSave();
    await expect(rice).toHaveValue("450 g");
    await button.click();
    await expect(personal.getByRole("alert")).toHaveCount(0);
    await expect(rice).toHaveValue(action === "save" ? "450 g" : "");
    cached = await draft(page);
    expect(cached.writeQueue.writes).toHaveLength(MAX_PENDING_KITCHEN_WRITES);
    expect(cached.writeQueue.writes.at(-1).command).toMatchObject({ type: "SetPersonalRecipeAmounts", recipeId: RECIPE_ID });
    if (action === "save") expect(cached.state.personalRecipeAmounts[RECIPE_ID].amounts[0].measure).toBe("450 g");
    else expect(cached.state.personalRecipeAmounts[RECIPE_ID]).toBeUndefined();
    expect((await saved(request)).state!.personalRecipeAmounts).toEqual(outbox.before.state!.personalRecipeAmounts);
  });
}

for (const existing of [true, false]) {
  test(`saving unchanged ${existing ? "personal" : "source"} amounts is a local no-op with a full outbox`, async ({ page, request }) => {
    await fixture(request, existing);
    const outbox = await openPendingKitchenOutbox(page, request, { view: "Recipes" });
    const personal = await editor(page);
    const beforeDraft = await draft(page);
    await personal.getByRole("button", { name: "Save personal amounts", exact: true }).click();
    await expect(personal.getByRole("alert")).toHaveCount(0);
    await expect(personal.getByRole("status").filter({ hasText: "Personal amounts saved. Future dinners use these amounts." })).toBeVisible();
    await page.clock.runFor(700);
    expect(await draft(page)).toEqual(beforeDraft);
    expect(outbox.attempts).toHaveLength(1);
    expect(await saved(request)).toEqual(outbox.before);
  });
}
