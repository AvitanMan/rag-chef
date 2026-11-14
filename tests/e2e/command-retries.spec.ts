import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { KitchenDocument, KitchenState } from "../../app/lib/kitchen-types";
import type { KitchenCommand } from "../../app/lib/kitchen-commands";
import type { KitchenCommandResult } from "../../app/lib/kitchen-command-types";
import { showPantryBatches } from "./pantry-helpers";

async function saved(request: APIRequestContext): Promise<KitchenDocument> {
  const response = await request.get("/api/kitchen");
  expect(response.ok()).toBeTruthy(); return response.json();
}
async function save(request: APIRequestContext, state: KitchenState) {
  const current = await saved(request);
  const response = await request.put("/api/kitchen", { data: { revision: current.revision, state } });
  expect(response.ok(), await response.text()).toBeTruthy();
}
async function pantry(page: Page) {
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: /Pantry/ }).filter({ visible: true }).first().click();
  await showPantryBatches(page);
}
async function subtractRice(page: Page) {
  await page.locator("#pantry-row-retry-rice").getByRole("button", { name: "Edit batch rice", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit batch rice", exact: true });
  await editor.getByRole("button", { name: "Record usage", exact: true }).click();
  await editor.getByLabel("Amount used from this batch", { exact: true }).fill("100 g");
  await editor.getByRole("button", { name: "Subtract usage", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Available rice", exact: true })).toHaveValue("400 g");
}
async function currentDraft(page: Page) {
  return page.evaluate(() => {
    const key = sessionStorage.getItem("rag-chef-kitchen-v2:tab-draft");
    return key ? JSON.parse(localStorage.getItem(key) ?? "null") : null;
  });
}

test.beforeEach(async ({ page, request }) => {
  await page.route("**/api/chef", route => route.abort());
  await save(request, { schemaVersion: 2, pantry: [{ id: "retry-rice", name: "rice", measure: "500 g" }], meals: {}, shoppingChecked: {}, migratedLegacy: true });
  await page.goto("/"); await pantry(page);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
});

test("a lost stocktake response retries the same command after reload and retains later remote edits", async ({ page, request }) => {
  const before = await saved(request);
  const attempts: KitchenCommand[] = [], receipts: KitchenCommandResult[] = [];
  await page.route("**/api/kitchen/commands", async route => {
    attempts.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBeTruthy();
    receipts.push(await response.json());
    if (attempts.length === 1) await route.abort("failed");
    else await route.fulfill({ response });
  });
  await subtractRice(page);
  await expect(page.locator(".save-indicator")).toHaveText("Offline");
  const committed = await saved(request);
  expect(committed.revision).toBe(before.revision + 1);
  expect(committed.state!.pantry[0].measure).toBe("400 g");
  expect(await currentDraft(page)).toMatchObject({ dirty: true, writeQueue: { version: 1, writes: [{ kind: "command", attempted: true, command: attempts[0] }] } });
  await save(request, { ...committed.state!, pantry: [...committed.state!.pantry, { id: "remote-beans", name: "beans", measure: "2 kg" }] });
  const latest = await saved(request);
  await page.reload(); await pantry(page);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
  expect(receipts[0].replayed).toBe(false);
  expect(receipts[1]).toEqual({ ...receipts[0], replayed: true });
  await expect(page.getByRole("textbox", { name: "Available rice", exact: true })).toHaveValue("400 g");
  await expect(page.getByRole("textbox", { name: "Available beans", exact: true })).toHaveValue("2 kg");
  expect(await saved(request)).toEqual(latest);
  expect(await currentDraft(page)).toBeNull();
});

test("an unavailable command endpoint preserves the queued stocktake across reload until retry succeeds", async ({ page, request }) => {
  const before = await saved(request), attempts: KitchenCommand[] = [];
  let online = false;
  await page.route("**/api/kitchen/commands", async route => {
    attempts.push(route.request().postDataJSON());
    if (!online) await route.abort("failed");
    else await route.continue();
  });
  await subtractRice(page);
  await expect(page.locator(".save-indicator")).toHaveText("Offline");
  expect(await saved(request)).toEqual(before);
  const draft = await currentDraft(page);
  await page.reload(); await pantry(page);
  await expect(page.locator(".save-indicator")).toHaveText("Offline");
  await expect(page.getByRole("textbox", { name: "Available rice", exact: true })).toHaveValue("400 g");
  expect((await currentDraft(page)).writeQueue).toEqual(draft.writeQueue);
  expect(await saved(request)).toEqual(before);
  online = true;
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  expect(attempts.length).toBeGreaterThanOrEqual(3);
  for (const attempt of attempts) expect(attempt).toEqual(attempts[0]);
  const committed = await saved(request);
  expect(committed.revision).toBe(before.revision + 1);
  expect(committed.state!.pantry[0].measure).toBe("400 g");
  expect(await currentDraft(page)).toBeNull();
});
