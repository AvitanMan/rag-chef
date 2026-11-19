import { expect, test, type Locator } from "@playwright/test";
import { createPlannedMeal } from "../../app/lib/kitchen-state";
import type { Recipe } from "../../app/lib/recipe-types";
import { saved } from "./pending-kitchen-outbox";

function contrast(first: string, second: string) {
  function luminance(color: string) {
    const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(value => {
      const channel = Number(value) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function tabTo(control: Locator) {
  await expect(control).toBeVisible();
  const page = control.page();
  for (let stop = 0; stop < 40; stop++) {
    if (await control.evaluate(el => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(control).toBeFocused();
}

async function checkFocus(control: Locator) {
  await expect(control).toBeFocused();
  const style = await control.evaluate(element => {
    const css = getComputedStyle(element);
    let parent = element.parentElement!;
    while (parent.parentElement && getComputedStyle(parent).backgroundColor === "rgba(0, 0, 0, 0)") parent = parent.parentElement;
    return { visible: element.matches(":focus-visible"), outline: css.outlineStyle, width: parseFloat(css.outlineWidth),
      ring: css.outlineColor, surface: getComputedStyle(parent).backgroundColor };
  });
  expect(style.visible).toBe(true);
  expect(style.outline).toBe("solid");
  expect(style.width).toBeGreaterThanOrEqual(2);
  expect(contrast(style.ring, style.surface)).toBeGreaterThanOrEqual(3);
}

for (const theme of ["light", "dark"] as const) {
  test(`keyboard navigation, counts and dinner controls are readable in ${theme} mode`, async ({ page, request }) => {
    await page.clock.setFixedTime(new Date("2026-10-22T12:00:00+03:00"));
    const { recipes }: { recipes: Recipe[] } = await (await request.get("/api/recipes/catalog")).json();
    const meal = createPlannedMeal("2026-10-23", recipes.find(recipe => recipe.id === "fixture-tomato-rice")!);
    const { revision } = await saved(request);
    const state = { schemaVersion: 2, migratedLegacy: true, pantry: [{ id: "pear", name: "pear", measure: "1" }],
      meals: { [meal.date]: meal }, shoppingChecked: {} };
    expect((await request.put("/api/kitchen", { data: { revision, state } })).ok()).toBeTruthy();
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("button", { name: "Chef", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("button", { name: "Shopping, 2 items to buy" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Pantry, 1 ingredient" })).toBeVisible();
    const query = page.getByRole("textbox", { name: "Dinner request" });
    await tabTo(query);
    await checkFocus(query);
    const border = await query.evaluate(el => {
      const css = getComputedStyle(el);
      return { color: css.borderTopColor, fill: css.backgroundColor, width: parseFloat(css.borderTopWidth) };
    });
    expect(border.width).toBeGreaterThanOrEqual(1);
    expect(contrast(border.color, border.fill)).toBeGreaterThanOrEqual(3);
    const label = page.locator('label[for="chef-query"]');
    await expect(label).toHaveCSS("text-transform", "none");
    expect(await label.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(14);
    await page.keyboard.press("Tab");
    const submit = page.getByRole("button", { name: "Find my dinner" });
    await checkFocus(submit);
    const action = await submit.evaluate(el => {
      const css = getComputedStyle(el);
      return { color: css.color, fill: css.backgroundColor, height: el.getBoundingClientRect().height };
    });
    expect(contrast(action.color, action.fill)).toBeGreaterThanOrEqual(4.5);
    expect(action.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Shift+Tab");
    await checkFocus(query);
    const plan = nav.getByRole("button", { name: "Plan", exact: true });
    await plan.focus();
    await page.keyboard.press("Tab");
    await checkFocus(nav.getByRole("button", { name: "Chef", exact: true }));
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expect(plan).toHaveAttribute("aria-current", "page");
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);

    const recipesButton = nav.getByRole("button", { name: "Recipes", exact: true });
    await tabTo(recipesButton);
    await page.keyboard.press("Enter");
    const collection = page.getByRole("group", { name: "Recipe collections" });
    // On mobile the navigation follows the results in DOM order.
    // Start at the selected collection to check the local tab sequence on both layouts.
    await collection.getByRole("button", { name: "All recipes" }).focus();
    await checkFocus(collection.getByRole("button", { name: "All recipes" }));
    const search = page.getByRole("searchbox", { name: "Search recipes" });
    await tabTo(search);
    await checkFocus(search);
    const portions = page.locator(".catalog-plan-controls .dinner-context > summary");
    await tabTo(portions);
    await checkFocus(portions);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("spinbutton", { name: "Chef portions" })).toBeVisible();
  });
}
