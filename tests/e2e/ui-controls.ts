import { expect, type Page } from "@playwright/test";

/** Existing editing journeys explicitly reveal the new compact controls. */
export async function revealPantryEditors(page: Page) {
  // The view can mount before its saved rows arrive, especially after sign-in.
  await expect(page.locator(".save-indicator")).not.toHaveText("Loading…");
  for (const editor of await page.locator(".pantry-editor").all()) {
    if (await editor.getAttribute("open") === null) await editor.locator(":scope > summary").click();
  }
}
export async function revealPantryAdd(page: Page) {
  const panel = page.locator(".pantry-add");
  if (await panel.count() && await panel.getAttribute("open") === null) await panel.locator(":scope > summary").click();
}
export async function revealPlanControls(page: Page) {
  const earlier = page.locator(".earlier-days-toggle");
  if (await earlier.isVisible() && await earlier.getAttribute("aria-expanded") === "false") await earlier.click();
  for (const button of await page.locator(".day-options-toggle:visible").all()) {
    if (await button.getAttribute("aria-expanded") === "false") await button.click();
  }
}
export async function revealShoppingTools(page: Page) {
  const tools = page.locator(".shopping-tools");
  if (await tools.count() && await tools.getAttribute("open") === null) await tools.locator(":scope > summary").click();
}
