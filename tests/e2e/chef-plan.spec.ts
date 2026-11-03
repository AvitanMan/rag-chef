import { test, expect, type APIRequestContext } from "@playwright/test";
import type { ChefPlanDraft, ChefPlanIntent } from "../../app/lib/chef-plan-types";

const today = "2026-10-22", week = "2026-10-19";
const intent = (patch: Partial<ChefPlanIntent> = {}): ChefPlanIntent => ({ week, today, count: 2, dates: [], servings: null, batches: null, excludedIngredients: [], diets: [], excludedEquipment: [], priority: "use_soon", allowRepeats: false, replaceDates: [], keepDates: [], perDate: {}, ...patch });
const readKitchen = async (request: APIRequestContext) => (await request.get("/api/kitchen")).json();
async function preview(request: APIRequestContext, patch: Partial<ChefPlanIntent> = {}) {
  const kitchen = await readKitchen(request);
  const response = await request.post("/api/chef/plan", { data: { week, today, kitchenRevision: kitchen.revision, intent: intent(patch) } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).draft as ChefPlanDraft;
}

test.beforeEach(async ({ page, request }) => {
  await page.clock.install({ time: new Date(`${today}T12:00:00+03:00`) });
  const kitchen = await readKitchen(request);
  const state = { schemaVersion: 2, pantry: [{ id: "rice", name: "rice", measure: "200 g", useBy: today }], meals: {}, shoppingChecked: {}, migratedLegacy: true };
  expect((await request.put("/api/kitchen", { data: { revision: kitchen.revision, state } })).ok()).toBeTruthy();
});

test("plan previews do not write, apply saves exactly reviewed dinners, duplicate apply conflicts", async ({ request }) => {
  const before = await readKitchen(request);
  const draft = await preview(request);
  expect(draft.changes).toHaveLength(2);
  expect(await readKitchen(request)).toEqual(before);
  const applied = await request.post("/api/chef/plan/apply", { data: { draft } });
  expect(applied.ok(), await applied.text()).toBeTruthy();
  const saved = await applied.json();
  expect(saved.revision).toBe(before.revision + 1);
  expect(Object.values(saved.state.meals)).toEqual(draft.changes.map(change => change.meal));
  expect(saved.state.pantry).toEqual(before.state.pantry);
  const duplicate = await request.post("/api/chef/plan/apply", { data: { draft } });
  expect(duplicate.status()).toBe(409);
  expect(await readKitchen(request)).toEqual(saved);
});

test("stale kitchen and tampered shopping previews fail without writes", async ({ request }) => {
  const draft = await preview(request);
  const before = await readKitchen(request);
  const tampered = structuredClone(draft);
  tampered.shopping = [];
  const invalid = await request.post("/api/chef/plan/apply", { data: { draft: tampered } });
  expect([400, 409]).toContain(invalid.status());
  expect(await readKitchen(request)).toEqual(before);
  const newer = await request.put("/api/kitchen", { data: { revision: before.revision, state: { ...before.state, pantry: [] } } });
  expect(newer.ok()).toBeTruthy();
  expect((await request.post("/api/chef/plan/apply", { data: { draft } })).status()).toBe(409);
  expect(await readKitchen(request)).toEqual(await newer.json());
});

test("saved exclusions and protected dinners survive manual planning requests", async ({ request }) => {
  const first = await preview(request, { count: 1 });
  const meal = { ...first.changes[0].meal, locked: true };
  const before = await readKitchen(request);
  const state = { ...before.state, meals: { [meal.date]: meal }, cookingProfile: { version: 1, allergies: ["peanut"], diet: "No restriction", dislikes: [], skillLevel: "Confident beginner", budget: "Medium", equipment: ["Oven", "Stovetop"] } };
  expect((await request.put("/api/kitchen", { data: { revision: before.revision, state } })).ok()).toBeTruthy();
  const draft = await preview(request, { dates: [today, "2026-10-23"], replaceDates: [today] });
  expect(draft.changes.every(change => change.date !== today)).toBeTruthy();
  expect(draft.changes.every(change => !change.meal.title.includes("Peanut"))).toBeTruthy();
  expect((await readKitchen(request)).state.meals[today]).toEqual(meal);
});

test("a source time limit yields a partial or empty draft without estimates", async ({ request }) => {
  const before = await readKitchen(request);
  const draft = await preview(request, { maxTotalMinutes: 1 });
  expect(draft.changes).toHaveLength(0);
  expect(draft.unresolved.length).toBeGreaterThan(0);
  expect(await readKitchen(request)).toEqual(before);
});

test("review, revise, discard and apply work on desktop and mobile", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: /Plan/ }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Plan with Chef", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Plan dinners with Chef" });
  await dialog.getByLabel("Number of dinners", { exact: true }).fill("2");
  const before = await readKitchen(request);
  await dialog.getByRole("button", { name: "Preview plan", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply plan", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("region", { name: "Plan shopping preview" })).toBeVisible();
  expect(await readKitchen(request)).toEqual(before);
  await dialog.getByLabel("Number of dinners", { exact: true }).fill("1");
  await expect(dialog.getByRole("button", { name: "Apply plan", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Preview plan", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply plan", exact: true })).toBeEnabled();
  expect(await readKitchen(request)).toEqual(before);
  await dialog.getByRole("button", { name: "Discard draft", exact: true }).click();
  expect(await readKitchen(request)).toEqual(before);
  await dialog.getByLabel("Number of dinners", { exact: true }).fill("1");
  await dialog.getByRole("button", { name: "Preview plan", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply plan", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/planning-preview-${test.info().project.name}.png`, fullPage: true });
  await dialog.getByRole("button", { name: "Apply plan", exact: true }).click();
  await expect.poll(async () => Object.keys((await readKitchen(request)).state.meals).length).toBe(1);
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  expect((await readKitchen(request)).state.pantry).toEqual(before.state.pantry);
});

test("unavailable local AI retains manual preview controls", async ({ page, request }) => {
  const provider = process.env.RAG_CHEF_TEST_MODEL_URL;
  expect(provider).toBeTruthy();
  await request.post(`${provider}/__test/control`, { data: { unavailable: true } });
  try {
    await page.goto("/");
    await expect(page.locator(".save-indicator")).toHaveText("Saved");
    await page.getByRole("button", { name: "Plan with Chef", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Plan dinners with Chef" });
    const before = await readKitchen(request);
    await dialog.getByRole("textbox", { name: "Planning request", exact: true }).fill("Plan two dinners");
    await dialog.getByRole("button", { name: "Ask Chef to plan", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await dialog.getByLabel("Number of dinners", { exact: true }).fill("1");
    await dialog.getByRole("button", { name: "Preview plan", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Apply plan", exact: true })).toBeEnabled();
    expect(await readKitchen(request)).toEqual(before);
  } finally { await request.post(`${provider}/__test/control`, { data: { unavailable: false } }); }
});

test("plan routes reject malformed and cross-origin requests without saving", async ({ request }) => {
  const before = await readKitchen(request);
  for (const endpoint of ["/api/chef/plan", "/api/chef/plan/apply"]) {
    expect((await request.post(endpoint, { headers: { origin: "https://example.invalid" }, data: {} })).status()).toBe(403);
    expect((await request.post(endpoint, { headers: { "content-type": "text/plain" }, data: "{}" })).status()).toBe(415);
    expect((await request.post(endpoint, { headers: { "content-type": "application/json" }, data: "{" })).status()).toBe(400);
  }
  expect((await request.post("/api/chef/plan", { data: { week, today, kitchenRevision: before.revision, intent: intent({ count: 99 }) } })).status()).toBe(400);
  expect(await readKitchen(request)).toEqual(before);
});


test("local interpretation reaches the provider through the built worker and remains read-only", async ({ request }) => {
  const before = await readKitchen(request);
  const provider = process.env.RAG_CHEF_TEST_MODEL_URL;
  await request.post(`${provider}/__test/control`, { data: { resetCalls: true } });
  const response = await request.post("/api/chef/plan", { data: { query: "Plan two dinners for four people using food that expires soon.", week, today, kitchenRevision: before.revision } });
  expect(response.ok(), await response.text()).toBeTruthy();
  const { draft } = await response.json();
  expect(draft.interpretation).toBe("ollama");
  expect(draft.intent.count).toBe(2);
  expect(draft.intent.servings).toBe(4);
  expect(draft.changes).toHaveLength(2);
  const calls = (await (await request.get(`${provider}/__test/control`)).json()).calls;
  expect(calls.filter((call: { path: string }) => call.path === "/api/chat")).toHaveLength(1);
  expect(await readKitchen(request)).toEqual(before);
});
