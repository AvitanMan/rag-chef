import { expect, type Page } from "@playwright/test";

// Legacy batch-detail tests opt into the expanded view through the real Pantry controls.
export async function showPantryBatches(page: Page) {
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search pantry", exact: true })).toBeEnabled();
  const showAll = page.getByRole("button", { name: "Show all batches", exact: true });
  if (await showAll.isVisible() && await showAll.isEnabled()) await showAll.click();
}
