import { expect, test } from "@playwright/test";

test("fresh installation recovers from setup failure and reaches dinner without AI", async ({ page, request }) => {
  expect((await (await request.get("/api/recipes/catalog")).json()).recipes).toEqual([]);
  let calls = 0;
  await page.route("**/api/admin/catalog/demo", async route => {
    if (++calls === 1) return route.fulfill({ status: 503, json: { error: { message: "Temporary setup failure. Retry to finish." } } });
    return route.continue();
  });
  let chefCalls = 0;
  let discoveryCalls = 0;
  page.on("request", req => {
    const path = new URL(req.url()).pathname;
    if (path === "/api/chef") chefCalls++;
    if (path === "/api/recipes") discoveryCalls++;
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Load starter recipes", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load starter recipes", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Temporary setup failure");
  await page.getByRole("button", { name: "Retry starter recipes", exact: true }).click();
  await page.getByRole("button", { name: "Choose tonight’s dinner", exact: true }).click();
  await expect(page.getByRole("button", { name: "Choose for tonight: Tomato Chickpea Pan", exact: true })).toBeVisible();
  await expect.poll(async () => (await (await request.get("/api/kitchen")).json()).state).not.toBeNull();
  const initial = await (await request.get("/api/kitchen")).json();
  expect(initial.state.pantry).toEqual([]);
  expect(initial.state.meals).toEqual({});
  const catalog = (await (await request.get("/api/recipes/catalog")).json()).recipes;
  expect(catalog).toHaveLength(3);
  expect(catalog.every((recipe: { source: { licenseId: string } }) => recipe.source.licenseId === "MIT")).toBeTruthy();
  // A retried setup is idempotent and does not rewrite the kitchen.
  expect((await request.post("/api/admin/catalog/demo")).ok()).toBeTruthy();
  expect((await (await request.get("/api/recipes/catalog")).json()).recipes).toHaveLength(3);
  expect((await (await request.get("/api/kitchen")).json()).state).toEqual(initial.state);
  expect((await request.post("/api/admin/catalog/demo", { headers: { origin: "https://untrusted.example" } })).status()).toBe(403);
  await page.getByRole("button", { name: "Choose for tonight: Tomato Chickpea Pan", exact: true }).click();
  await expect(page.getByRole("region", { name: "Chosen dinner" })).toContainText("Tomato Chickpea Pan");
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.mouse.move(0, 0);
  await page.screenshot({ fullPage: true, animations: "disabled", path: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/first-dinner-${test.info().project.name}.png` });
  await page.getByRole("button", { name: "Weekly shopping", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy shopping list", exact: true })).toBeVisible();
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.mouse.move(0, 0);
  await expect(page.getByRole("heading", { name: "Shopping", exact: true })).toBeInViewport();
  await page.screenshot({ fullPage: true, animations: "disabled", path: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/first-shopping-${test.info().project.name}.png` });
  await page.getByRole("button", { name: "Back to dinner", exact: true }).click();
  await page.getByRole("button", { name: "Cook dinner", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Cooking Tomato Chickpea Pan" })).toBeVisible();
  expect(chefCalls).toBe(0);
  expect(discoveryCalls).toBe(0);
  if (test.info().project.name === "desktop") await page.setViewportSize({ width: 1280, height: 900 });
  await page.mouse.move(0, 0);
  await page.screenshot({ animations: "disabled", path: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/first-cooking-${test.info().project.name}.png` });
});
