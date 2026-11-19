import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createPlannedMeal, weekStart } from "../../app/lib/kitchen-state";
import type { KitchenState } from "../../app/lib/kitchen-types";
import type { Recipe } from "../../app/lib/recipe-types";
import { shoppingForWeek } from "../../app/lib/shopping-purchases";
import { isKitchenWrite } from "./kitchen-requests";
import { navigate, saved } from "./pending-kitchen-outbox";

const TODAY = "2026-10-22";
const FRIDAY = "2026-10-23";
const NEXT_TUESDAY = "2026-10-27";
const empty = (): KitchenState => ({ schemaVersion: 2, migratedLegacy: true, meals: {}, pantry: [], shoppingChecked: {} });

async function save(request: APIRequestContext, state: KitchenState) {
  const current = await saved(request);
  const response = await request.put("/api/kitchen", { data: { revision: current.revision, state } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function dinners(request: APIRequestContext, date = TODAY, otherDate = FRIDAY) {
  const response = await request.get("/api/recipes/catalog");
  expect(response.ok()).toBeTruthy();
  const { recipes }: { recipes: Recipe[] } = await response.json();
  const rice = createPlannedMeal(date, recipes.find(recipe => recipe.id === "fixture-tomato-rice")!);
  const salmon = createPlannedMeal(otherDate, recipes.find(recipe => recipe.id === "fixture-fish-bowl")!);
  return { rice, salmon };
}

function button(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true });
}

function origin(page: Page) {
  return page.getByRole("region", { name: "Dinner shopping context", exact: true });
}

async function openShopping(page: Page) {
  await page.getByRole("region", { name: "Chosen dinner", exact: true }).getByRole("button", { name: "Shop for this dinner", exact: true }).click();
  await expect(button(page, "For this dinner")).toHaveAttribute("aria-pressed", "true");
}

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date(`${TODAY}T12:00:00+03:00`) });
});

test("shopping for a pantry pick exports the visible weekly totals and returns to cook with the purchased amount", async ({ page, request }) => {
  const { salmon } = await dinners(request);
  const stock = { id: "existing-rice", name: "rice", measure: "100 g" };
  const state = { ...empty(), pantry: [stock], meals: { [FRIDAY]: salmon } };
  const salmonKey = shoppingForWeek(state, weekStart(TODAY), TODAY).find(item => item.name === "salmon")!.key;
  await save(request, state);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Use manual copy"); } } });
    window.print = () => { document.body.dataset.printed = "yes"; };
  });
  let chefRequests = 0;
  page.on("request", req => { if (new URL(req.url()).pathname === "/api/chef") chefRequests++; });
  await page.goto("/");
  await navigate(page, "Pantry");
  await button(page, "Use rice tonight").click();
  await button(page, "Find dinners").click();
  await button(page, "Choose for tonight: Tomato Rice").click();
  const needs = page.getByRole("region", { name: "Dinner shopping needs" });
  await expect(needs).toContainText("rice: 200 g");
  await expect.poll(async () => (await saved(request)).state?.meals[TODAY]?.recipeId).toBe("fixture-tomato-rice");
  const before = await saved(request);
  await openShopping(page);
  await expect(origin(page)).toContainText("Tomato Rice");
  const rice = page.getByRole("checkbox", { name: "Bought rice 300 g", exact: true });
  await expect(rice).toBeVisible();
  await expect(page.locator(".shopping-item").filter({ has: rice })).toContainText(/Shared weekly total.*Oct 23/);
  await expect(page.locator(".shopping-item")).toHaveCount(2);
  await button(page, "Copy shopping list").click();
  const copy = await page.getByRole("textbox", { name: "Shopping list text" }).inputValue();
  expect(copy).toContain("Tomato Rice");
  expect(copy).toContain(TODAY);
  expect(copy).toContain("Weekly totals");
  expect(copy).toContain("rice: 300 g");
  expect(copy).toContain("tomato: 2");
  expect(copy).not.toContain("- salmon:");
  await button(page, "Print").click();
  await expect(page.locator("body")).toHaveAttribute("data-printed", "yes");
  await page.emulateMedia({ media: "print" });
  const printed = page.getByRole("region", { name: "Printable shopping list", exact: true });
  await expect(printed).toBeVisible();
  expect(await printed.innerText()).toBe(copy);
  await page.emulateMedia({ media: "screen" });
  expect(await saved(request)).toEqual(before);

  await rice.click();
  await button(page, "Whole week").click();
  await page.locator(".bought-items > summary").click();
  await expect(rice).toBeChecked();
  await page.getByRole("checkbox", { name: "Bought salmon 200 g" }).click();
  await button(page, "For this dinner").click();
  await expect.poll(async () => Object.values((await saved(request)).state!.shoppingChecked).filter(Boolean).length).toBe(2);
  const checked = await saved(request);
  expect(checked.state!.pantry).toEqual([stock]);
  await expect(button(page, "Uncheck all")).toHaveCount(0);
  await button(page, "Copy shopping list").click();
  const unchecked = await page.getByRole("textbox", { name: "Shopping list text" }).inputValue();
  expect(unchecked).toContain("tomato: 2");
  expect(unchecked).not.toContain("- rice:");
  await button(page, "Back to dinner").click();
  await expect(needs).toContainText("rice: 200 g");
  await openShopping(page);

  const preview = page.getByRole("dialog", { name: "Add bought items to pantry" });
  await button(page, "Add bought items to pantry").click();
  const amount = preview.getByRole("textbox", { name: "Amount bought rice" });
  await expect(amount).toHaveValue("300 g");
  await expect(preview.getByRole("textbox", { name: "Amount bought salmon" })).toHaveCount(0);
  await amount.fill("150 g");
  await preview.getByRole("button", { name: "Cancel" }).click();
  expect(await saved(request)).toEqual(checked);
  await button(page, "Add bought items to pantry").click();
  await amount.fill("150 g");

  // Lose the first acknowledgement after the server actually committed it.
  const purchaseIds: string[] = [];
  await page.route("**/api/kitchen/commands", async route => {
    const command = route.request().postDataJSON();
    if (command.type !== "RecordPurchase") return route.continue();
    purchaseIds.push(command.commandId);
    if (purchaseIds.length !== 1) return route.continue();
    const receipt = await route.fetch();
    expect(receipt.ok()).toBeTruthy();
    await route.abort("failed");
  });
  await button(page, "Confirm pantry additions").click();
  await button(page, "Retry save").click();
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  expect(purchaseIds).toHaveLength(2);
  expect(purchaseIds[1]).toBe(purchaseIds[0]);
  const after = await saved(request);
  expect(after.state!.shoppingPurchases).toHaveLength(1);
  expect(after.state!.shoppingPurchases![0].items).toHaveLength(1);
  expect(after.state!.pantry).toEqual([stock, expect.objectContaining({ name: "rice", measure: "150 g" })]);
  expect(after.state!.shoppingChecked[salmonKey]).toBe(true);
  await expect(page.locator(".purchase-history")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Bought rice 150 g" })).toBeVisible();
  await button(page, "Whole week").click();
  await page.locator(".bought-items > summary").click();
  await expect(page.getByRole("checkbox", { name: "Bought salmon 200 g" })).toBeChecked();
  await expect(button(page, "Uncheck all")).toBeVisible();
  await page.locator(".purchase-history > summary").click();
  await expect(button(page, "Undo pantry additions")).toBeVisible();
  await button(page, "Back to dinner").click();
  await expect(needs).toContainText("rice: 150 g");
  await button(page, "Cook dinner").click();
  const cooking = page.getByRole("dialog", { name: "Cooking Tomato Rice" });
  await cooking.getByRole("button", { name: /Next step/ }).click();
  await cooking.getByRole("button", { name: "Finish cooking" }).click();
  await expect(cooking.getByRole("checkbox", { name: /Deduct the matching pantry/ })).not.toBeChecked();
  await cooking.getByRole("button", { name: "Mark dinner cooked" }).click();
  await expect.poll(async () => (await saved(request)).state?.meals[TODAY].status).toBe("cooked");
  const finished = await saved(request);
  expect(finished.state!.meals[FRIDAY]).toEqual(salmon);
  expect(finished.state!.pantry).toEqual(after.state!.pantry);
  expect(chefRequests).toBe(0);
  await button(page, "Weekly shopping").click();
  await expect(origin(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Shopping", exact: true })).toBeVisible();
});

test("entering shopping from a scrolled dinner focuses the meal and shows both scopes", async ({ page, request }, info) => {
  const { rice, salmon } = await dinners(request);
  const recipe = { ...rice.recipe!, ingredients: [
    ...rice.recipe!.ingredients,
    ...Array.from({ length: 12 }, (_, index) => ({ name: `Test ingredient ${index + 1}`, measure: "20 g" })),
  ] };
  await save(request, { ...empty(), meals: { [TODAY]: createPlannedMeal(TODAY, recipe), [FRIDAY]: salmon } });
  const mobile = info.project.name === "mobile";
  const widths = mobile ? [320, 390] : [1440];
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : mobile ? 844 : 900 });
    await page.goto("/");
    await expect(page.getByRole("region", { name: "Chosen dinner" })).toBeVisible();
    const inputs = mobile ? ["click", "tap", "keyboard"] : ["click", "keyboard"];
    for (const input of inputs) {
      // A remembered position from the whole list must not hide the next dinner heading.
      await navigate(page, "Shopping");
      await expect(page.getByRole("region", { name: "To buy" })).toBeVisible();
      await page.clock.runFor(100);
      await page.evaluate(() => window.scrollTo({ top: 450, behavior: "instant" }));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
      await navigate(page, "Chef");
      await expect(page.getByRole("region", { name: "Chosen dinner" })).toBeVisible();
      await page.clock.runFor(100);
      const entry = button(page, "Shop for this dinner");
      if (input === "keyboard") {
        await page.getByRole("region", { name: "Chosen dinner" }).getByRole("heading", { name: "Tomato Rice" }).focus();
        await page.keyboard.press("Tab");
        await expect(entry).toBeFocused();
      } else {
        await entry.scrollIntoViewIfNeeded();
      }
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      if (input === "keyboard") await page.keyboard.press("Enter");
      else if (input === "tap") await entry.tap();
      else await entry.click();
      // Measure after the transition without focusing, clicking or scrolling a destination control.
      const context = origin(page);
      await expect(context.getByRole("heading", { name: "Tomato Rice" })).toBeFocused();
      await page.clock.runFor(700);
      const bounds = await context.evaluate(section => {
        const title = section.querySelector("h2")!.getBoundingClientRect();
        const scope = section.querySelector('[role="group"]')!.getBoundingClientRect();
        const nav = document.querySelector(".mobile-nav")!.getBoundingClientRect();
        return { scrollY, titleTop: title.top, scopeBottom: scope.bottom, usableBottom: nav.height ? nav.top : innerHeight };
      });
      expect(bounds.scrollY).toBe(0);
      expect(bounds.titleTop).toBeGreaterThanOrEqual(0);
      expect(bounds.scopeBottom).toBeLessThanOrEqual(bounds.usableBottom);
      await expect(button(page, "For this dinner")).toHaveAttribute("aria-pressed", "true");
      await info.attach(`shopping-${width}-${input}-bounds`, { body: JSON.stringify(bounds), contentType: "application/json" });
      if (input === "click") await page.screenshot({ path: info.outputPath(`shopping-arrival-${width}.png`), animations: "disabled" });
      await button(page, "Whole week").focus();
      await page.keyboard.press("Space");
      await expect(button(page, "Whole week")).toHaveAttribute("aria-pressed", "true");
      await expect(button(page, "Whole week")).toBeFocused();
      await button(page, "Back to dinner").click();
      await expect(page.getByRole("region", { name: "Chosen dinner" }).getByRole("heading", { name: "Tomato Rice" })).toBeFocused();
    }
  }
});

test("future dinner and weekly scope survive browser history while direct Shopping starts with the whole week", async ({ page, request }) => {
  const { rice, salmon } = await dinners(request, NEXT_TUESDAY, "2026-10-28");
  await save(request, { ...empty(), meals: { [rice.date]: rice, [salmon.date]: salmon } });
  const before = await saved(request);
  const writes: string[] = [];
  page.on("request", req => { if (isKitchenWrite(req)) writes.push(req.url()); });
  await page.goto("/");
  await page.locator("details.dinner-context > summary").click();
  await page.getByLabel("Dinner day", { exact: true }).fill(rice.date);
  await openShopping(page);
  await expect(origin(page)).toContainText("Oct 27");
  await expect(page.getByRole("checkbox", { name: "Bought salmon 200 g" })).toHaveCount(0);
  await button(page, "Whole week").click();
  await expect(page.getByRole("checkbox", { name: "Bought salmon 200 g" })).toBeVisible();
  await page.goBack();
  await expect(button(page, "For this dinner")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("checkbox", { name: "Bought salmon 200 g" })).toHaveCount(0);
  await page.goForward();
  await expect(button(page, "Whole week")).toHaveAttribute("aria-pressed", "true");
  await expect(origin(page)).toContainText("Oct 27");
  await navigate(page, "Plan");
  await button(page, "This week").click();
  await navigate(page, "Shopping");
  await expect(origin(page)).toHaveCount(0);
  await expect(button(page, "Back to dinner")).toHaveCount(0);
  await expect(page.getByText(/Week of Mon, Oct 19/)).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Weekly plan", exact: true })).toBeVisible();
  await page.goBack();
  await expect(button(page, "Whole week")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/Week of Mon, Oct 26/)).toBeVisible();
  await button(page, "Back to dinner").click();
  await expect(page.getByRole("region", { name: "Chosen dinner" })).toContainText("Tomato Rice");
  await expect(page.getByRole("region", { name: "Chosen dinner" })).toContainText("Oct 27");
  expect(await saved(request)).toEqual(before);
  expect(writes).toEqual([]);
});

for (const change of ["replaced", "removed", "cooked"] as const) {
  test(`an empty dinner list falls back to the same week when the dinner is ${change}`, async ({ page, request }) => {
    const { rice, salmon } = await dinners(request, NEXT_TUESDAY, "2026-10-28");
    const state: KitchenState = { ...empty(), meals: { [rice.date]: rice, [salmon.date]: salmon }, pantry: [
      { id: "rice", name: "rice", measure: "400 g" }, { id: "tomatoes", name: "tomato", measure: "2" },
    ] };
    await save(request, state);
    await page.goto("/");
    await page.locator("details.dinner-context > summary").click();
    await page.getByLabel("Dinner day", { exact: true }).fill(rice.date);
    await openShopping(page);
    await expect(page.getByText("No weekly shopping items for this dinner.", { exact: true })).toBeVisible();
    await expect(button(page, "Copy shopping list")).toBeDisabled();
    await expect(button(page, "Print")).toBeDisabled();
    await expect(button(page, "Add bought items to pantry")).toHaveCount(0);
    if (change === "replaced") state.meals[rice.date] = { ...rice, id: "replacement-with-same-recipe" };
    if (change === "removed") delete state.meals[rice.date];
    if (change === "cooked") state.meals[rice.date] = { ...rice, status: "cooked",
      completion: { id: "completed-elsewhere", at: "2026-10-22T08:00:00.000Z", deductions: [] } };
    await save(request, state);
    const external = await saved(request);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(origin(page)).toHaveCount(0);
    await expect(button(page, "Back to dinner")).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "Bought salmon 200 g" })).toBeVisible();
    await expect(page.getByText(/Week of Mon, Oct 26/)).toBeVisible();
    expect(await saved(request)).toEqual(external);
  });
}

test("a shopping entry saved before dinner filters opens the household's current week", async ({ page, request }) => {
  const { rice } = await dinners(request, NEXT_TUESDAY);
  await save(request, { ...empty(), meals: { [rice.date]: rice } });
  await page.goto("/");
  await page.locator("details.dinner-context > summary").click();
  await page.getByLabel("Dinner day", { exact: true }).fill(rice.date);
  await openShopping(page);
  await page.evaluate(() => {
    const state = history.state;
    const entry = { ...state.ragChefNavigation };
    delete entry.week;
    delete entry.shoppingDinner;
    history.replaceState({ ...state, ragChefNavigation: entry }, "");
  });
  await navigate(page, "Pantry");
  await page.goBack();
  await expect(page.getByText(/Week of Mon, Oct 19/)).toBeVisible();
  await expect(origin(page)).toHaveCount(0);
  await expect(button(page, "Back to dinner")).toHaveCount(0);
});
