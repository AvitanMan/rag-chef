import { openChef } from "./open-chef";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { CookingProfile, KitchenState } from "../../app/lib/kitchen-types";

const empty = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });
const profile: CookingProfile = { version: 1, allergies: ["milk"], diet: "Vegan", dislikes: ["mushrooms"], equipment: ["Stovetop"], skillLevel: "Confident beginner", budget: "Medium" };
async function read(request: APIRequestContext) { return (await request.get("/api/kitchen")).json(); }
async function save(request: APIRequestContext, state: KitchenState) {
  const current = await read(request);
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state } })).ok()).toBeTruthy();
}
async function navigate(page: Page, name: string) {
  if (name === "Settings") { await page.getByRole("button", { name, exact: true }).click(); return; }
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click();
}
test.beforeEach(async ({ request }) => { await save(request, empty()); });

test("legacy browser cooking preferences migrate once and the saved profile wins after reload", async ({ page, request }) => {
  await page.addInitScript(legacy => localStorage.setItem("rag-chef-preferences-v2", JSON.stringify({ profile: legacy, settings: { provider: "ollama", ollamaModel: "qwen3.5:9b" } })), profile);
  await openChef(page);
  await expect.poll(async () => (await read(request)).state.cookingProfile).toEqual(profile);
  await navigate(page, "Settings");
  await expect(page.getByRole("button", { name: "Remove allergies milk", exact: true })).toBeVisible();
  await expect(page.getByLabel("Diet", { exact: false })).toHaveValue("Vegan");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("rag-chef-preferences-v2")!).profile)).toBeUndefined();
  const changed = { ...profile, allergies: ["rice"], diet: "No restriction" };
  await save(request, { ...empty(), cookingProfile: changed });
  await page.reload(); await navigate(page, "Settings");
  await expect(page.getByRole("button", { name: "Remove allergies rice", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove allergies milk", exact: true })).toHaveCount(0);
  expect((await read(request)).state.cookingProfile).toEqual(changed);
});

test("saved exclusions refresh another open tab and invalidate incompatible recipe choices", async ({ page, context, request }) => {
  await openChef(page); await navigate(page, "Settings");
  const other = await context.newPage();
  try {
    await other.goto("/"); await navigate(other, "Recipes");
    await other.getByRole("searchbox", { name: "Search recipes", exact: true }).fill("Cheese Pasta");
    await expect(other.locator(".recipe-card")).toHaveCount(1);
    await page.getByRole("textbox", { name: "Allergies", exact: true }).fill("milk");
    await page.getByRole("textbox", { name: "Allergies", exact: true }).press("Enter");
    await expect.poll(async () => (await read(request)).state.cookingProfile?.allergies).toEqual(["milk"]);
    await expect(other.locator(".recipe-card")).toHaveCount(0);
    await navigate(other, "Settings");
    await expect(other.getByRole("button", { name: "Remove allergies milk", exact: true })).toBeVisible();
    await other.getByRole("button", { name: "Remove allergies milk", exact: true }).click();
    await expect.poll(async () => (await read(request)).state.cookingProfile?.allergies).toEqual([]);
    await expect(page.getByRole("button", { name: "Remove allergies milk", exact: true })).toHaveCount(0);
  } finally { await other.close(); }
});

test("cooking preferences export and restore into a fresh browser after explicit review", async ({ page, browser, request, baseURL }) => {
  await save(request, { ...empty(), cookingProfile: profile, pantry: [{ id: "beans", name: "beans", measure: "400 g" }] });
  await openChef(page); await navigate(page, "Settings");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export backup", exact: true }).click();
  const stream = await (await downloading).createReadStream(); let text = "";
  for await (const chunk of stream!) text += chunk;
  const backup = JSON.parse(text);
  expect(backup.backupVersion).toBe(2); expect(backup.state.cookingProfile).toEqual(profile);
  await page.close(); await save(request, empty());
  const fresh = await browser.newContext({ baseURL });
  const restored = await fresh.newPage();
  try {
    await restored.goto("/"); await navigate(restored, "Settings");
    await restored.getByLabel("Restore backup file", { exact: true }).setInputFiles({ name: "kitchen.json", mimeType: "application/json", buffer: Buffer.from(text) });
    const preview = restored.getByRole("region", { name: "Backup preview" });
    await expect(preview).toContainText("Allergies: milk. Diet: Vegan. Equipment: Stovetop.");
    await expect(preview.getByRole("button", { name: "Replace kitchen with backup" })).toBeDisabled();
    await preview.getByRole("checkbox", { name: "I reviewed the cooking preferences, including allergies and equipment." }).check();
    await preview.getByRole("button", { name: "Replace kitchen with backup" }).click();
    await expect.poll(async () => (await read(request)).state.cookingProfile).toEqual(profile);
    await restored.reload(); await navigate(restored, "Settings");
    await expect(restored.getByRole("button", { name: "Remove allergies milk", exact: true })).toBeVisible();
    await expect(restored.getByLabel("Diet", { exact: false })).toHaveValue("Vegan");
    expect((await read(request)).state.pantry).toEqual(backup.state.pantry);
  } finally { await fresh.close(); }
});
