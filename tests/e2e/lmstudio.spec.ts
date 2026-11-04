import { test, expect } from "@playwright/test";

test.skip(process.env.RAG_CHEF_HOSTED_TEST === "1", "Standalone provider settings use the local runner.");

test("LM Studio selection persists and reaches Chef, kitchen assistant, and planner", async ({ page }, info) => {
  const model = "test/lmstudio-model";
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route("**/api/health?**", async route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("provider")).toBe("lmstudio");
    expect(url.searchParams.get("model")).toBe(model);
    await route.fulfill({ json: { ok: true, message: "LM Studio connected", capabilities: { generation: { ready: true, message: "LM Studio generation ready" }, verification: { ready: true, message: "LM Studio verification ready" } } } });
  });
  for (const path of ["/api/chef", "/api/assistant", "/api/chef/plan"]) {
    await page.route(`**${path}`, async route => {
      sent.push({ path, body: route.request().postDataJSON() });
      await route.fulfill({ status: 503, json: { error: { code: "ai_unavailable", message: "Test model is offline. Manual controls remain available." } } });
    });
  }
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".provider-card").filter({ hasText: "LM Studio" }).click();
  await page.getByRole("textbox", { name: "Model", exact: true }).fill(model);
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(page.getByText("LM Studio connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Chef capabilities" })).toContainText("LM Studio verification ready");
  await page.screenshot({ path: info.outputPath("lmstudio-settings.png"), fullPage: true });
  await page.locator(".provider-card").filter({ hasText: "Ollama" }).click();
  await expect(page.getByRole("textbox", { name: "Model", exact: true })).not.toHaveValue(model);
  await page.locator(".provider-card").filter({ hasText: "LM Studio" }).click();
  await expect(page.getByRole("textbox", { name: "Model", exact: true })).toHaveValue(model);
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator(".provider-card").filter({ hasText: "LM Studio" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "Model", exact: true })).toHaveValue(model);

  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: /Plan/ }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Kitchen assistant", exact: true }).click();
  const assistant = page.getByRole("dialog", { name: "Kitchen assistant", exact: true });
  await expect(assistant).toContainText(`LM Studio · ${model}`);
  await assistant.getByRole("textbox", { name: "Your request", exact: true }).fill("Add 2 kg rice");
  await assistant.getByRole("button", { name: "Ask Chef", exact: true }).click();
  await expect(assistant.getByRole("alert")).toContainText("Test model is offline");
  await page.getByRole("button", { name: "Close kitchen assistant", exact: true }).click();
  await page.getByRole("button", { name: "Plan with Chef", exact: true }).click();
  await page.getByRole("textbox", { name: "Planning request", exact: true }).fill("Plan one dinner");
  await page.getByRole("button", { name: "Ask Chef to plan", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Plan dinners with Chef" }).getByRole("alert")).toContainText("Test model is offline");
  await page.getByRole("button", { name: "Close planning workspace", exact: true }).click();
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: /Recipes/ }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Ask Chef", exact: true }).click();
  await page.getByRole("textbox", { name: "Dinner request", exact: true }).fill("Recommend a dinner");
  await page.getByRole("button", { name: "Find my dinner", exact: true }).click();
  await expect.poll(() => sent.length).toBe(3);
  expect(sent.map(request => request.path)).toEqual(["/api/assistant", "/api/chef/plan", "/api/chef"]);
  for (const request of sent) expect(request.body, request.path).toMatchObject({ provider: "lmstudio", model });
});
