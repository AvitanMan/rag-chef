import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { FillEmptyDaysApplyRequest, FillEmptyDaysPreviewResponse } from "../../app/lib/fill-empty-days-contract";
import type { KitchenDocument, KitchenState } from "../../app/lib/kitchen-types";

async function readKitchen(request: APIRequestContext): Promise<KitchenDocument> {
  return (await request.get("/api/kitchen")).json();
}

async function openWeek(page: Page, request: APIRequestContext) {
  const current = await readKitchen(request);
  const state: KitchenState = { schemaVersion: 2, pantry: [{ id: "rice", name: "rice", measure: "some" }], meals: {}, shoppingChecked: {}, migratedLegacy: true };
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state } })).ok()).toBe(true);
  await page.goto("/");
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: /Plan/ }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Next week", exact: true }).click();
}

async function previewAfter(page: Page, action: () => Promise<void>): Promise<FillEmptyDaysPreviewResponse> {
  const response = page.waitForResponse(r => r.url().endsWith("/kitchen/fill-empty-days/preview") && r.ok());
  await action();
  return (await response).json();
}

test("Fill empty days previews exact dinners and weekly shortages, cancels cleanly, and retries a lost save receipt", async ({ page, request }) => {
  await openWeek(page, request);
  const trigger = page.getByRole("button", { name: "Fill empty days", exact: true });
  const dialog = page.getByRole("dialog", { name: "Review dinners" });
  const before = await readKitchen(request);
  await previewAfter(page, () => trigger.click());
  await expect(dialog.getByRole("button", { name: "Apply dinners" })).toBeVisible();
  expect(await readKitchen(request)).toEqual(before);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(trigger).toBeFocused();
  expect(await readKitchen(request)).toEqual(before);

  const { preview, review } = await previewAfter(page, () => trigger.click());
  expect(preview.additions).toHaveLength(7);
  await expect(dialog.getByRole("article")).toHaveCount(7);
  for (const meal of preview.additions) {
    const dinner = dialog.getByRole("article").filter({ has: page.locator(`time[datetime="${meal.date}"]`) });
    await expect(dinner.getByRole("heading")).toContainText(meal.title);
    await expect(dinner).toContainText(meal.servings ? `${meal.servings} servings` : `${meal.batches} recipe batch`);
    for (const item of preview.readinessByDate[meal.date].shopping) {
      await expect(dinner).toContainText(`${item.name} · ${item.measure}${item.needsReview ? " · Review amount" : ""}`);
    }
  }
  const delta = dialog.getByRole("region", { name: "Weekly shopping changes" });
  expect(preview.shoppingDelta.find(row => row.name === "rice")).toMatchObject({ added: null, needsReview: true });
  expect(preview.shoppingDelta.some(row => Boolean(row.added))).toBe(true);
  for (const row of preview.shoppingDelta) {
    await expect(delta).toContainText(`${row.name} · ${row.before ?? "None"} → ${row.after ?? "None"}${row.added ? ` (+${row.added})` : ""}${row.needsReview ? " · Review amount" : ""}`);
  }
  const width = await dialog.evaluate(el => ({ dialog: el.scrollWidth, body: el.clientWidth, viewport: innerWidth }));
  expect(width.dialog).toBeLessThanOrEqual(width.body);
  expect(width.body).toBeLessThanOrEqual(width.viewport);

  const attempts: FillEmptyDaysApplyRequest[] = [];
  await page.route("**/api/kitchen/fill-empty-days/apply", async route => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) {
      const saved = await route.fetch();
      expect(saved.ok()).toBe(true);
      await route.abort("failed");
    } else await route.continue();
  });
  await dialog.getByRole("button", { name: "Apply dinners" }).click();
  await expect(dialog.getByRole("button", { name: "Retry save" })).toBeVisible();
  const committed = await readKitchen(request);
  expect(committed.revision).toBe(before.revision + 1);
  expect(committed.state).toEqual({ ...before.state, meals: Object.fromEntries(preview.additions.map(meal => [meal.date, meal])) });
  const replay = page.waitForResponse(response => response.url().endsWith("/fill-empty-days/apply") && response.ok());
  await dialog.getByRole("button", { name: "Retry save" }).click();
  expect(await (await replay).json()).toMatchObject({ replayed: true });
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(`#dinner-${preview.additions[0].date}`)).toBeFocused();
  expect(attempts).toEqual([{ review, commandId: expect.any(String) }, attempts[0]]);
  expect(await readKitchen(request)).toEqual(committed);
  await page.getByRole("button", { name: "Review shopping", exact: true }).click();
  for (const row of preview.shoppingDelta) {
    await expect(page.getByRole("checkbox", { name: `Bought ${row.name} ${row.after}`, exact: true })).toBeVisible();
  }
});

test("Fill empty days requires a fresh review when another cook chooses a dinner", async ({ page, request }) => {
  await openWeek(page, request);
  const original = await previewAfter(page, () => page.getByRole("button", { name: "Fill empty days", exact: true }).click());
  const dialog = page.getByRole("dialog", { name: "Review dinners" });
  const chosen = { ...original.preview.additions[0], id: "another-cooks-choice", locked: true };
  const current = await readKitchen(request);
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state: { ...current.state, meals: { [chosen.date]: chosen } } } })).ok()).toBe(true);
  const updated = await readKitchen(request);
  await dialog.getByRole("button", { name: "Apply dinners" }).click();
  const reviewAgain = dialog.getByRole("button", { name: "Review again" });
  await expect(reviewAgain).toBeVisible();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(await readKitchen(request)).toEqual(updated);
  const refreshed = await previewAfter(page, () => reviewAgain.click());
  expect(refreshed.review.expectedRevision).toBe(updated.revision);
  expect(refreshed.preview.additions).toHaveLength(6);
  expect(refreshed.preview.additions.some(meal => meal.date === chosen.date)).toBe(false);
  await dialog.getByRole("button", { name: "Apply dinners" }).click();
  await expect(dialog).toHaveCount(0);
  const saved = await readKitchen(request);
  expect(saved.revision).toBe(updated.revision + 1);
  expect(saved.state?.meals).toEqual({ [chosen.date]: chosen, ...Object.fromEntries(refreshed.preview.additions.map(meal => [meal.date, meal])) });
});

test("Fill empty days recovers from a preview outage and explains a week with no eligible dates", async ({ page, request }) => {
  await openWeek(page, request);
  const previous = page.getByRole("button", { name: "Previous week", exact: true });
  await previous.click();
  await previous.click();
  const before = await readKitchen(request);
  await page.route("**/api/kitchen/fill-empty-days/preview", route => route.fulfill({ status: 503, json: { error: { message: "Temporary catalog outage" } } }), { times: 1 });
  await page.getByRole("button", { name: "Fill empty days", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review dinners" });
  await expect(dialog.getByRole("alert")).toContainText("Temporary catalog outage");
  await dialog.getByRole("button", { name: "Retry preview" }).click();
  await expect(dialog).toContainText("No eligible dinners");
  await expect(dialog.getByRole("button", { name: "Apply dinners" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await readKitchen(request)).toEqual(before);
});

test("Fill empty days discards a preview on Back and recovers a submitted save across Close, reload and a later edit", async ({ page, request }) => {
  await openWeek(page, request);
  const trigger = page.getByRole("button", { name: "Fill empty days", exact: true });
  const dialog = page.getByRole("dialog", { name: "Review dinners" });
  await previewAfter(page, () => trigger.click());
  const before = await readKitchen(request);
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  expect(await readKitchen(request)).toEqual(before);
  await page.goForward();
  await expect(dialog).toHaveCount(0);
  const { preview } = await previewAfter(page, () => trigger.click());
  const attempts: FillEmptyDaysApplyRequest[] = [];
  await page.route("**/api/kitchen/fill-empty-days/apply", async route => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) {
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort("failed");
    } else await route.continue();
  });
  await dialog.getByRole("button", { name: "Apply dinners" }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry dinner save" })).toBeVisible();
  await expect(page.locator(".day-card.filled")).toHaveCount(7);

  const committed = await readKitchen(request);
  const first = preview.additions[0], next = preview.additions[1];
  const replacement = { ...next, id: "replacement-after-save", date: first.date };
  expect((await request.put("/api/kitchen", { data: { revision: committed.revision, state: {
    ...committed.state, meals: { ...committed.state?.meals, [first.date]: replacement },
  } } })).ok()).toBe(true);
  const updated = await readKitchen(request);
  await page.reload();
  await page.getByRole("button", { name: "Retry dinner save" }).click();
  await expect(page.getByRole("button", { name: "Retry dinner save" })).toHaveCount(0);
  const replaced = page.locator(`#dinner-${first.date}`);
  await expect(replaced).toContainText(replacement.title);
  await expect(replaced).not.toContainText(preview.reasons[first.date]);
  await expect(page.locator(`#dinner-${next.date}`)).toBeFocused();
  await expect(page.getByText("Dinner save confirmed. The week also includes later edits.")).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(await readKitchen(request)).toEqual(updated);
});
