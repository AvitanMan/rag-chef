import { expect, test } from "@playwright/test";

for (const disconnected of [false, true]) {
  test(`development theme works with ${disconnected ? "unavailable" : "connected"} HMR`, async ({ page }, info) => {
    const errors: string[] = [];
    let hmrConnected = false;
    page.on("pageerror", error => errors.push(error.message));
    page.on("websocket", socket => socket.on("framereceived", frame => {
      try { if (JSON.parse(String(frame.payload)).type === "connected") hmrConnected = true; } catch { /* Other HMR messages do not establish connection. */ }
    }));
    if (disconnected) await page.routeWebSocket(/.*/, socket => socket.close());
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const toggle = page.getByRole("button", { name: "Dark mode", exact: true });
    await expect(page.locator(".save-indicator")).toHaveText("Saved");
    if (!disconnected) await expect.poll(() => hmrConnected).toBe(true);
    // Logging during a failed initial HMR connection must not generate a new
    // exception and recursively feed the framework's rejection overlay.
    await page.evaluate(() => console.warn("Development connection diagnostic"));
    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const background = await page.locator("body").evaluate(el => getComputedStyle(el).backgroundColor);
    expect(background).toBe("rgb(10, 10, 10)");
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(errors).toEqual([]);
    if (disconnected) {
      // Real failures must still be visible, once, without becoming a flood of
      // secondary transport errors that prevents the user dismissing them.
      await page.evaluate(() => { window.setTimeout(() => { void Promise.reject(new Error("Original development diagnostic")); }, 0); });
      await expect(page.getByRole("heading", { name: "Original development diagnostic", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Dismiss", exact: true }).click();
      await toggle.click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      expect(errors).toEqual(["Original development diagnostic"]);
    }
    await page.screenshot({ path: info.outputPath("theme.png") });
  });
}
