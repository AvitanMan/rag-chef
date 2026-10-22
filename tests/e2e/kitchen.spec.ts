import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const emptyState = () => ({ schemaVersion: 2, pantry: [] as { id: string; name: string; measure: string }[], meals: {}, shoppingChecked: {}, migratedLegacy: false });
async function readKitchen(request: APIRequestContext) { return (await request.get("/api/kitchen")).json(); }
async function saveFixture(request: APIRequestContext, state: ReturnType<typeof emptyState>) {
  const current = await readKitchen(request);
  const result = await request.put("/api/kitchen", { data: { revision: current.revision, state } });
  expect(result.ok()).toBeTruthy();
}
async function navigate(page: Page, name: string) {
  await page.getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click();
}

test.beforeEach(async ({ request }) => {
  await saveFixture(request, emptyState());
});

test("fresh kitchen browses synthetic recipes and persists a selected dinner", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Recipes/ }).filter({ visible: true }).first().click();
  await page.getByRole("searchbox", { name: "Search recipes" }).fill("Tomato Rice");
  const card = page.locator(".recipe-card").filter({ has: page.getByRole("heading", { name: "Tomato Rice", exact: true }) });
  await expect(card).toBeVisible();
  await expect(card).toContainText("0 of 2 ingredients in pantry");
  await card.getByRole("button", { name: /^Add to plan:/ }).click();
  await page.getByRole("dialog", { name: "Choose dinner day" }).getByRole("button", { name: "Add dinner", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Weekly plan", exact: true })).toBeVisible();
  await expect.poll(async () => Object.values((await (await request.get("/api/kitchen")).json()).state?.meals ?? {}).length).toBe(1);
  await page.reload();
  await expect(page.locator(".day-card.filled")).toHaveCount(1);
  await expect(page.locator(".day-card.filled")).toContainText("Tomato Rice");
});

test("zero stock is unavailable and removing duplicate names preserves the other ID", async ({ page, request }) => {
  await saveFixture(request, { ...emptyState(), pantry: [{ id: "rice-zero", name: "rice", measure: "0 g" }, { id: "rice-positive", name: "rice", measure: "400 g" }, { id: "tomato-zero", name: "tomato", measure: "0" }] });
  await page.goto("/");
  await navigate(page, "Recipes");
  await page.getByRole("searchbox", { name: "Search recipes" }).fill("Tomato Rice");
  await expect(page.locator(".recipe-card")).toContainText("1 of 2 ingredients in pantry");
  await navigate(page, "Pantry");
  await page.getByRole("button", { name: "Remove rice", exact: true }).first().click();
  await expect.poll(async () => (await readKitchen(request)).state.pantry.map((row: { id: string }) => row.id)).toEqual(["rice-positive", "tomato-zero"]);
  await page.getByRole("textbox", { name: "Available rice", exact: true }).fill("0 g");
  await navigate(page, "Recipes");
  await expect(page.locator(".recipe-card")).toContainText("0 of 2 ingredients in pantry");
});

test("allergy aliases and diet conflicts agree across browsing, planning and Chef", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Diet", { exact: false }).selectOption("Vegan");
  await page.getByLabel("Allergies", { exact: false }).fill("milk, peanut");
  await navigate(page, "Recipes");
  const cards = page.locator(".recipe-card");
  await expect(cards.filter({ hasText: "Cheese Pasta" })).toHaveCount(0);
  await expect(cards.filter({ hasText: "Peanut Noodles" })).toHaveCount(0);
  await expect(cards.filter({ hasText: "Salmon Bowl" })).toHaveCount(0);
  await expect(cards.filter({ hasText: "Garden Soup" })).toContainText("Diet not verified");
  await navigate(page, "Plan");
  await page.getByRole("button", { name: "Fill empty days" }).click();
  await expect.poll(async () => Object.values((await readKitchen(request)).state.meals).length).toBeGreaterThan(0);
  const titles = Object.values((await readKitchen(request)).state.meals).map((meal) => (meal as { title: string }).title);
  expect(titles).not.toContain("Cheese Pasta");
  expect(titles).not.toContain("Peanut Noodles");
  expect(titles).not.toContain("Salmon Bowl");
  const chef = await request.post("/api/chef", { data: { query: "Tomato Rice", pantry: [], provider: "ollama", profile: { diet: ["Vegan"], allergies: ["milk", "peanut"], equipment: [] } } });
  expect(chef.ok()).toBeTruthy();
  const answer = await chef.json();
  expect(answer.recipes.map((recipe: { title: string }) => recipe.title)).not.toEqual(expect.arrayContaining(["Cheese Pasta", "Peanut Noodles", "Salmon Bowl"]));
  expect(answer.recipes[0].title).toBe("Tomato Rice");
});

test("backup restore previews changes and rejects invalid files without changing saved state", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const before = await readKitchen(request);
  const file = page.getByLabel("Restore backup file", { exact: true });
  await file.setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from('{"backupVersion":99}') });
  await expect(page.getByRole("alert")).toContainText("not supported");
  expect(await readKitchen(request)).toEqual(before);
  const restored = { ...emptyState(), pantry: [{ id: "restored-rice", name: "rice", measure: "300 g" }] };
  await file.setInputFiles({ name: "kitchen.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ backupVersion: 1, exportedAt: "2026-10-22T09:00:00.000Z", state: restored })) });
  const preview = page.getByRole("region", { name: "Backup preview" });
  await expect(preview).toContainText("1 pantry rows");
  expect(await readKitchen(request)).toEqual(before);
  await preview.getByRole("button", { name: "Replace kitchen with backup" }).click();
  await expect.poll(async () => (await readKitchen(request)).state.pantry).toEqual(restored.pantry);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export backup", exact: true }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/\.json$/);
  await page.reload();
  await navigate(page, "Pantry");
  await expect(page.getByRole("textbox", { name: "Available rice", exact: true })).toHaveValue("300 g");
});

test("another tab draft can be reviewed and recovered without deleting its original", async ({ page, request }) => {
  const document = await readKitchen(request);
  const key = "rag-chef-kitchen-v2:draft:another-tab";
  const draft = { ...emptyState(), pantry: [{ id: "recovery-beans", name: "beans", measure: "400 g" }] };
  await page.addInitScript(({ key, draft, revision }) => {
    localStorage.setItem(key, JSON.stringify({ revision, state: draft, dirty: true, updatedAt: "2026-10-22T09:00:00.000Z", reason: "edit" }));
  }, { key, draft, revision: document.revision });
  await page.goto("/");
  await page.getByText(/Unsaved kitchens found/).click();
  await expect(page.locator(".recovery-candidate")).toContainText("1 pantry rows");
  await page.getByRole("button", { name: "Recover this draft" }).click();
  await expect.poll(async () => (await readKitchen(request)).state.pantry).toEqual(draft.pantry);
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).not.toBeNull();
});

test("catalog read failure has an explicit recovery action", async ({ page }) => {
  let failed = false;
  await page.route("**/api/recipes/catalog", async (route) => {
    if (!failed) { failed = true; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Test storage unavailable" }) }); }
    else await route.continue();
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Retry catalog" })).toBeVisible();
  await page.getByRole("button", { name: "Retry catalog" }).click();
  await page.getByRole("button", { name: /Recipes/ }).filter({ visible: true }).first().click();
  await expect(page.locator(".recipe-card")).toHaveCount(7);
});
