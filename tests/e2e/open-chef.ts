import { type Page } from "@playwright/test";

/** Existing Chef journeys start explicitly at Chef; the home page now opens Plan. */
export async function openChef(page: Page) {
  const response = await page.goto("/");
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: "Chef", exact: true }).filter({ visible: true }).first().click();
  return response;
}
