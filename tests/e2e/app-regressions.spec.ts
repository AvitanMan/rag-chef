import { revealPantryAdd, revealPantryEditors } from "./ui-controls";
import { openChef } from "./open-chef";
import { test, expect, type Page } from "@playwright/test";
import type { KitchenState } from "../../app/lib/kitchen-types";

const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });
async function navigate(page: Page, name: string) {
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click();
}
async function cookRice(page: Page) {
  await navigate(page, "Recipes");
  await page.getByRole("button", { name: "View Tomato Rice", exact: true }).click();
  await page.getByRole("button", { name: "Start cooking", exact: true }).click();
}
test.beforeEach(async ({ request }) => {
  const current = await (await request.get("/api/kitchen")).json();
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state: empty() } })).ok()).toBeTruthy();
});

test("another tab sees running cooking progress and must confirm replacement", async ({ page, context }) => {
  await openChef(page); await expect(page.getByRole("button", { name: "Browse recipes", exact: true })).toBeEnabled();
  const other = await context.newPage(); await openChef(other);
  await expect(other.getByRole("button", { name: "Browse recipes", exact: true })).toBeEnabled();
  await cookRice(page);
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.getByRole("button", { name: "Next step →", exact: true }).click();
  await cooking.getByRole("button", { name: "Start 10 min from this step", exact: true }).click();
  await expect(cooking.getByRole("button", { name: "Pause timer", exact: true })).toBeVisible();
  await expect(other.getByRole("button", { name: "Resume cooking", exact: true })).toBeVisible();
  await cookRice(other);
  const prompt = other.getByRole("dialog", { name: "Replace cooking session", exact: true });
  await expect(prompt).toContainText("running timers");
  await prompt.getByRole("button", { name: "Keep current session", exact: true }).click();
  await other.getByRole("button", { name: "Close recipe", exact: true }).click();
  await other.getByRole("button", { name: "Resume cooking", exact: true }).click();
  const otherCooking = other.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await expect(otherCooking).toContainText("Step 2");
  await expect(otherCooking.getByRole("button", { name: "Pause timer", exact: true })).toBeVisible();
  await otherCooking.getByRole("button", { name: "Pause timer", exact: true }).click();
  await expect(cooking).toContainText("Paused");
  await page.reload(); await page.getByRole("button", { name: "Resume cooking", exact: true }).click();
  await expect(cooking).toContainText("Step 2"); await expect(cooking).toContainText("Paused");
  await other.close();
});

for (const lateFailure of [false, true]) {
  test(`backup selection ignores an earlier late ${lateFailure ? "error" : "success"}`, async ({ page, request }) => {
    await page.addInitScript(() => {
      const original = File.prototype.text;
      File.prototype.text = function () {
        if (this.name !== "slow.json") return original.call(this);
        const text = original.call(this);
        return new Promise<string>((resolve, reject) => {
          Object.assign(window, { finishBackupRead: async (fail: boolean) => fail ? reject(new Error("Late read failure")) : resolve(await text) });
        });
      };
    });
    await openChef(page); await page.getByRole("button", { name: "Settings", exact: true }).click();
    const backup = (count: number) => Buffer.from(JSON.stringify({ backupVersion: 1, exportedAt: "2026-11-01T12:00:00.000Z", state: { ...empty(), pantry: Array.from({ length: count }, (_, i) => ({ id: `stock-${i}`, name: `food ${i}`, measure: "1" })) } }));
    const file = page.getByLabel("Restore backup file", { exact: true });
    await file.setInputFiles({ name: "slow.json", mimeType: "application/json", buffer: backup(1) });
    await file.setInputFiles({ name: "latest.json", mimeType: "application/json", buffer: backup(2) });
    const preview = page.getByRole("region", { name: "Backup preview", exact: true });
    await expect(preview).toContainText("Backup: 2 pantry rows");
    await preview.getByRole("checkbox").check();
    await page.evaluate(async fail => { await (window as unknown as { finishBackupRead: (fail: boolean) => Promise<void> }).finishBackupRead(fail); }, lateFailure);
    await expect(preview).toContainText("Backup: 2 pantry rows");
    await expect(preview.getByRole("button", { name: "Replace kitchen with backup", exact: true })).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await preview.getByRole("button", { name: "Replace kitchen with backup", exact: true }).click();
    await expect.poll(async () => (await (await request.get("/api/kitchen")).json()).state.pantry.length).toBe(2);
  });
}

test("Back and Forward close pantry import and purchase previews", async ({ page, request }) => {
  const catalog = await (await request.get("/api/recipes/catalog")).json();
  const recipe = catalog.recipes.find((r: { id: string }) => r.id === "fixture-tomato-rice");
  const date = "2026-11-01";
  const state = { ...empty(), meals: { [date]: { id: "rice-dinner", date, recipeId: recipe.id, recipe, title: recipe.title, baseServings: 2, servings: 2, batches: 1, ingredientOverrides: {}, locked: false, status: "planned" } } };
  const current = await (await request.get("/api/kitchen")).json();
  await request.put("/api/kitchen", { data: { revision: current.revision, state } });
  await page.clock.install({ time: new Date("2026-11-01T12:00:00+02:00") });
  await openChef(page); await navigate(page, "Recipes"); await navigate(page, "Pantry");
  await revealPantryEditors(page);
  await revealPantryAdd(page);
  await page.getByRole("textbox", { name: "New pantry ingredient", exact: true }).fill("rice: 300 g\nbeans: 400 g");
  await page.getByRole("button", { name: "Add to pantry", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Review pantry ingredients", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog", { name: "Review pantry ingredients", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Recipes", exact: true })).toBeVisible();
  await page.goForward(); await navigate(page, "Shopping");
  await page.getByRole("checkbox", { name: "Bought rice 200 g", exact: true }).click();
  await page.getByRole("button", { name: "Add bought items to pantry", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Add bought items to pantry", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog", { name: "Add bought items to pantry", exact: true })).toHaveCount(0);
  expect((await (await request.get("/api/kitchen")).json()).state.pantry).toEqual([]);
});

test("blocked cooked undo keeps a full pantry and completion saved", async ({ page, request }) => {
  const { completeMeal } = await import("../../app/lib/quantities");
  const catalog = await (await request.get("/api/recipes/catalog")).json();
  const recipe = catalog.recipes.find((r: { id: string }) => r.id === "fixture-tomato-rice");
  const date = "2026-11-01";
  const meal = { id: "rice-dinner", date, recipeId: recipe.id, recipe, title: recipe.title, baseServings: 2, servings: 2, batches: 1, ingredientOverrides: {}, locked: false, status: "planned" as const };
  const cooked = completeMeal({ ...empty(), pantry: [{ id: "rice", name: "rice", measure: "200 g" }], meals: { [date]: meal } }, date, true, "2026-11-01T12:00:00.000Z");
  const state = { ...cooked, pantry: Array.from({ length: 500 }, (_, i) => ({ id: `stock-${i}`, name: `food ${i}`, measure: "1" })) };
  const current = await (await request.get("/api/kitchen")).json();
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state } })).ok()).toBeTruthy();
  await page.clock.install({ time: new Date("2026-11-01T12:00:00+02:00") });
  await openChef(page);
  await page.getByRole("button", { name: "Undo cooked", exact: true }).click();
  await expect(page.getByText(/Make room in your pantry before undoing/)).toBeVisible();
  const after = (await (await request.get("/api/kitchen")).json()).state;
  expect(after).toEqual(state);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export backup", exact: true }).click();
  expect((await download).suggestedFilename()).toContain("backup");
});

test("a storage failure keeps this tab's unsaved timer until an explicit conflict choice", async ({ page, context }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "rag-chef-cooking-v1" && (window as unknown as { blockCookingWrites?: boolean }).blockCookingWrites) throw new Error("Storage full");
      return setItem.call(this, key, value);
    };
  });
  await openChef(page); await expect(page.getByRole("button", { name: "Browse recipes", exact: true })).toBeEnabled();
  const other = await context.newPage(); await openChef(other);
  await expect(other.getByRole("button", { name: "Browse recipes", exact: true })).toBeEnabled();
  await cookRice(page);
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await cooking.getByRole("button", { name: "Next step →", exact: true }).click();
  await expect(other.getByRole("button", { name: "Resume cooking", exact: true })).toBeVisible();
  await other.getByRole("button", { name: "Resume cooking", exact: true }).click();
  const otherCooking = other.getByRole("dialog", { name: "Cooking Tomato Rice", exact: true });
  await expect(otherCooking).toContainText("Step 2");
  await page.evaluate(() => Object.assign(window, { blockCookingWrites: true }));
  await cooking.getByRole("button", { name: "Start 10 min from this step", exact: true }).click();
  await expect(cooking.getByRole("button", { name: "Pause timer", exact: true })).toBeVisible();
  await otherCooking.getByRole("button", { name: "Previous", exact: true }).click();
  const conflict = page.getByRole("dialog", { name: "Cooking progress changed", exact: true });
  await expect(conflict).toBeVisible();
  await expect(cooking).toContainText("Step 2");
  await expect(cooking.getByRole("button", { name: "Pause timer", exact: true })).toBeAttached();
  await page.evaluate(() => Object.assign(window, { blockCookingWrites: false }));
  await page.evaluate(() => new Promise<void>(started => {
    void navigator.locks.request("rag-chef-cooking-v1", () => new Promise<void>(release => {
      Object.assign(window, { releaseCookingLock: release }); started();
    }));
  }));
  await conflict.getByRole("button", { name: "Keep this tab’s progress", exact: true }).click();
  await expect(conflict.getByRole("button", { name: "Use saved session", exact: true })).toBeDisabled();
  await expect(conflict.getByRole("button", { name: "Keep this tab’s progress", exact: true })).toBeDisabled();
  await conflict.press("Escape"); await expect(conflict).toBeVisible();
  await page.evaluate(() => (window as unknown as { releaseCookingLock: () => void }).releaseCookingLock());
  await expect(conflict).toHaveCount(0);
  await expect(otherCooking).toContainText("Step 2");
  await expect(otherCooking.getByRole("button", { name: "Pause timer", exact: true })).toBeVisible();
  await other.close();
});
