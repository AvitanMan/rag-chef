import { expect, type Page } from "@playwright/test";

export async function choosePantryLocation(page: Page, label: string) {
  const location = page.getByRole("combobox", { name: "Location", exact: true });
  if (await location.isVisible()) {
    const option = location.getByRole("option").filter({ hasText: new RegExp(`^${label} \\(\\d+\\)$`) });
    await expect(option).toHaveCount(1);
    await location.selectOption(await option.getAttribute("value") ?? "");
  } else {
    await page.getByRole("group", { name: "Pantry locations", exact: true })
      .getByRole("button", { name: new RegExp(`^${label} \\(\\d+\\)$`) }).click();
  }
}

export async function expectPantryLocation(page: Page, label: string, count: number) {
  const location = page.getByRole("combobox", { name: "Location", exact: true });
  const text = `${label} (${count})`;
  if (await location.isVisible()) {
    await expect(location.locator("option:checked")).toHaveText(text);
  } else {
    await expect(page.getByRole("group", { name: "Pantry locations", exact: true })
      .getByRole("button", { name: text, exact: true })).toHaveAttribute("aria-pressed", "true");
  }
}

export async function openPantryAdd(page: Page) {
  const add = page.locator("details.pantry-add-disclosure");
  await expect(add).toBeVisible();
  if (await add.getAttribute("open") === null) await add.locator("summary").click();
  await expect(page.getByRole("textbox", { name: "New pantry ingredient", exact: true })).toBeVisible();
}

export async function openSpiceChecklist(page: Page) {
  const checklist = page.locator("details").filter({ has: page.locator("summary", { hasText: "Stock your spice rack" }) });
  await expect(checklist).toBeVisible();
  if (await checklist.getAttribute("open") === null) await checklist.locator("summary").click();
}

// Legacy batch-detail tests opt into management through the real Pantry disclosure.
export async function openPantryManagement(page: Page) {
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search pantry", exact: true })).toBeEnabled();
  const management = page.locator("details.pantry-management");
  if (await management.getAttribute("open") === null) {
    await management.locator("summary").filter({ hasText: "Manage amounts, dates and batches" }).click();
  }
  await expect(management).toHaveAttribute("open", "");
}

export async function showPantryBatches(page: Page) {
  await openPantryManagement(page);
  const showAll = page.getByRole("button", { name: "Show all batches", exact: true });
  if (await showAll.isVisible() && await showAll.isEnabled()) await showAll.click();
}
