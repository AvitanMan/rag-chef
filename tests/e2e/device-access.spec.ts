import { test, expect } from "@playwright/test";

test.skip(process.env.RAG_CHEF_SECURE_LAN_TEST !== "1", "Requires the disposable HTTPS kitchen.");

for (const remembered of [false, true]) {
  test(`device access explains ${remembered ? "remembered" : "twelve-hour"} sign-in and this browser’s address`, async ({ page, context, baseURL }, info) => {
    if (info.project.name === "mobile") await page.setViewportSize({ width: 320, height: 844 });
    await page.goto("/");
    await expect(page.locator(".login-address")).toContainText(new URL(baseURL!).origin);
    await expect(page.getByRole("textbox", { name: "Username", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("login-device-address.png"), fullPage: true });
    await page.locator(".login-help > summary").click();
    await expect(page.locator(".login-help")).toContainText("shared username and password");
    await expect(page.locator(".login-help")).toContainText("household computer is awake");
    await expect(page.locator(".login-help")).not.toContainText(".wrangler");
    const remember = page.getByRole("checkbox", { name: "Remember this device for 30 days", exact: true });
    await expect(remember).not.toBeChecked();
    if (remembered) await remember.check();
    await page.getByRole("textbox", { name: "Username", exact: true }).fill("chef");
    await page.getByLabel("Password", { exact: true }).fill(process.env.RAG_CHEF_TEST_LAN_PASSWORD!);
    await page.getByRole("button", { name: "Open kitchen", exact: true }).click();
    await expect(page.locator(".app-shell")).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const access = page.getByRole("region", { name: "This device’s access", exact: true });
    await expect(access).toContainText(remembered ? "Remembered on this browser" : "12-hour sign-in");
    await expect(access.getByRole("textbox", { name: "This browser’s kitchen address", exact: true })).toHaveValue(new URL(baseURL!).origin);
    const session = await (await context.request.get("/api/session")).json();
    expect(session.localAccess.remembered).toBe(remembered);
    await expect(access.locator("time")).toHaveAttribute("datetime", session.localAccess.expiresAt);
    const localTime = await page.evaluate(expiresAt => new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).format(new Date(expiresAt)), session.localAccess.expiresAt);
    await expect(access.locator("time")).toHaveText(localTime);
    await expect(access).not.toContainText(session.localAccess.sessionId);
    await expect(access.getByRole("button", { name: "Sign out of this device", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await access.screenshot({ path: info.outputPath("signed-in-device-access.png") });
  });
}
