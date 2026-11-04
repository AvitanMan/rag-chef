import { openChef } from "./open-chef";
import { test, expect, type APIRequestContext } from "@playwright/test";

const today = "2026-10-22", week = "2026-10-19";
const read = async (request: APIRequestContext) => (await request.get("/api/kitchen")).json();
const intent = () => ({ pantry: [{ kind: "add", name: "rice", measure: "500 g" }], tastes: [], planning: { week, today, count: 2, dates: [], servings: null, batches: null, excludedIngredients: [], diets: [], excludedEquipment: [], priority: "use_soon", allowRepeats: false, replaceDates: [], keepDates: [], perDate: {} } });
test.beforeEach(async ({ page, request }) => {
  await page.clock.install({ time: new Date(`${today}T12:00:00+03:00`) });
  const current = await read(request);
  expect((await request.put("/api/kitchen", { data: { revision: current.revision, state: { schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true } } })).ok()).toBeTruthy();
  // Substitute only interpretation. Real preview, quantity math and Apply execute.
  await page.route("**/api/assistant", async route => {
    const input = route.request().postDataJSON();
    const response = await route.fetch({ postData: JSON.stringify({ ...input, query: "", intent: input.intent ?? intent() }) });
    await route.fulfill({ response });
  });
  await openChef(page); await expect(page.locator(".save-indicator")).toHaveText("Saved");
});

test("combined pantry and dinner preview can be edited and applied once with exact shopping", async ({ page, request }) => {
  const before = await read(request);
  await page.getByRole("button", { name: "Kitchen assistant", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Kitchen assistant", exact: true });
  await dialog.getByLabel("Kitchen update", { exact: true }).fill("Bought 500 g rice. Plan two dinners.");
  await dialog.getByRole("button", { name: "Preview kitchen changes", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply changes", exact: true })).toBeEnabled();
  expect(await read(request)).toEqual(before);
  await dialog.getByLabel("Amount", { exact: true }).fill("750 g");
  await expect(dialog.getByRole("button", { name: "Apply changes", exact: true })).toBeDisabled();
  const preview = page.waitForResponse(response => response.url().endsWith("/api/assistant") && response.status() === 200);
  await dialog.getByRole("button", { name: "Preview edited changes", exact: true }).click();
  const reviewed = (await (await preview).json()).draft;
  expect(reviewed.pantryChanges[0].after.measure).toBe("750 g");
  expect(await read(request)).toEqual(before);
  let submissions = 0;
  page.on("request", request => { if (request.url().endsWith("/api/assistant/apply")) submissions++; });
  await dialog.getByRole("button", { name: "Apply changes", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(dialog.getByText("Reviewed changes saved to your kitchen.", { exact: true })).toBeVisible();
  const saved = await read(request); expect(submissions).toBe(1); expect(saved.revision).toBe(before.revision + 1);
  expect(saved.state.pantry[0].measure).toBe("750 g"); expect(Object.keys(saved.state.meals)).toHaveLength(2);
  const duplicate = await request.post("/api/assistant/apply", { data: { draft: reviewed } });
  expect(duplicate.ok()).toBeTruthy(); expect((await duplicate.json()).alreadyApplied).toBe(true);
  expect(await read(request)).toEqual(saved);
});

test("discard and stale family changes cannot write an obsolete assistant draft", async ({ page, request }) => {
  const before = await read(request);
  await page.getByRole("button", { name: "Kitchen assistant", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Kitchen assistant", exact: true });
  await dialog.getByLabel("Kitchen update", { exact: true }).fill("Bought rice; plan dinners.");
  await dialog.getByRole("button", { name: "Preview kitchen changes", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply changes", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  expect(await read(request)).toEqual(before);
  await dialog.getByLabel("Kitchen update", { exact: true }).fill("Bought rice; plan dinners.");
  await dialog.getByRole("button", { name: "Preview kitchen changes", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply changes", exact: true })).toBeEnabled();
  const changed = await request.put("/api/kitchen", { data: { revision: before.revision, state: { ...before.state, pantry: [{ id: "family-onion", name: "onion", measure: "2" }] } } });
  const newer = await changed.json();
  await dialog.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply changes", exact: true })).toBeDisabled();
  expect(await read(request)).toEqual(newer);
  await dialog.getByRole("button", { name: "Recalculate changes", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply changes", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(dialog.getByText("Reviewed changes saved to your kitchen.", { exact: true })).toBeVisible();
  expect((await read(request)).state.pantry.some((row: { id: string }) => row.id === "family-onion")).toBe(true);
});

test("unavailable AI retains manual kitchen controls", async ({ page, request }) => {
  await page.unroute("**/api/assistant");
  await page.route("**/api/assistant", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Your model is unavailable. Manual kitchen controls still work." } }) }));
  const before = await read(request);
  await page.getByRole("button", { name: "Kitchen assistant", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Kitchen assistant", exact: true });
  await dialog.getByLabel("Kitchen update", { exact: true }).fill("Plan dinners."); await dialog.getByRole("button", { name: "Preview kitchen changes", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(/model is unavailable/);
  await dialog.getByRole("button", { name: "Close kitchen assistant", exact: true }).click();
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: "Plan", exact: true }).filter({ visible: true }).first().click();
  await expect(page.getByRole("button", { name: "Plan with Chef", exact: true })).toBeEnabled();
  expect(await read(request)).toEqual(before);
});
