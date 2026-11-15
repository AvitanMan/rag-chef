import { expect, type APIRequestContext, type Page } from "@playwright/test";
import type { KitchenDocument } from "../../app/lib/kitchen-types";
import type { KitchenCommand } from "../../app/lib/kitchen-commands";
import { MAX_PENDING_KITCHEN_WRITES } from "../../app/lib/kitchen-write-queue";
import { KITCHEN_CACHE_KEY } from "../../app/lib/kitchen-state";

export async function saved(request: APIRequestContext): Promise<KitchenDocument> {
  const response = await request.get("/api/kitchen");
  const url = new URL(response.url());
  expect(["127.0.0.1", "localhost"]).toContain(url.hostname);
  expect(url.port).not.toBe("3000");
  expect(response.ok()).toBeTruthy();
  return response.json();
}

export async function navigate(page: Page, name: string) {
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click();
}

export async function draft(page: Page) {
  return page.evaluate(cacheKey => {
    const key = sessionStorage.getItem(`${cacheKey}:tab-draft`);
    return key ? JSON.parse(localStorage.getItem(key) ?? "null") : null;
  }, KITCHEN_CACHE_KEY);
}

/** Exercise the production outbox limit through ordinary draft recovery and HTTP. */
export async function openPendingKitchenOutbox(page: Page, request: APIRequestContext,
  { pending = MAX_PENDING_KITCHEN_WRITES, view = "Pantry" }: { pending?: number; view?: string | false } = {}) {
  expect(pending).toBeGreaterThan(0);
  expect(pending).toBeLessThanOrEqual(MAX_PENDING_KITCHEN_WRITES);
  const before = await saved(request);
  expect(before.state).not.toBeNull();
  // Each wire command has a unique ID. Alternating valid favorites project back
  // to the saved favorite list after an even number of entries. No production
  // sender, reducer, queue implementation or capacity limit is replaced.
  const commandPrefix = crypto.randomUUID();
  const favoriteId = "pending-outbox-favorite";
  const favorites = (before.state!.favoriteRecipeIds ?? []).filter(id => id !== favoriteId);
  const state = { ...before.state!, favoriteRecipeIds: pending % 2 ? [...favorites, favoriteId] : favorites };
  await page.addInitScript(({ document, state, pending, cacheKey, favoriteId, commandPrefix }) => {
    const writes = Array.from({ length: pending }, (_, index) => ({
      kind: "command", attempted: false,
      command: { commandId: `${commandPrefix}:${index}`, expectedRevision: document.revision,
        type: "SetFavorite", recipeId: favoriteId, favorite: index % 2 === 0 },
    }));
    const key = `${cacheKey}:draft:local-rejection`;
    localStorage.setItem(key, JSON.stringify({ revision: document.revision, state, dirty: true,
      writeQueue: { version: 1, writes }, reason: "edit", updatedAt: "2026-10-22T09:00:00.000Z" }));
    sessionStorage.setItem(`${cacheKey}:tab-draft`, key);
  }, { document: before, state, pending, cacheKey: KITCHEN_CACHE_KEY, favoriteId, commandPrefix });
  const attempts: KitchenCommand[] = [];
  let allowedSaves = 0;
  await page.route("**/api/kitchen/commands", route => {
    attempts.push(route.request().postDataJSON());
    if (allowedSaves > 0) { allowedSaves--; return route.continue(); }
    return route.abort("failed");
  });
  await page.goto("/");
  if (view) await navigate(page, view);
  await page.clock.runFor(700);
  await expect(page.locator(".save-indicator")).toHaveText("Offline");
  expect((await draft(page)).writeQueue.writes).toHaveLength(pending);
  expect(attempts).toHaveLength(1);
  expect(attempts[0].type).toBe("SetFavorite");
  return { before, attempts, allowOneSave: async () => {
    allowedSaves++;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.clock.runFor(700);
    await expect.poll(async () => (await draft(page)).writeQueue.writes.length).toBe(pending - 1);
  } };
}
