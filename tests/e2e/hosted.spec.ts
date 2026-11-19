import { isKitchenWrite, kitchenWriteRevision } from "./kitchen-requests";
import { createHmac } from "node:crypto";
import { test, expect, type BrowserContext, type APIRequestContext, type Page } from "@playwright/test";
import type { KitchenDocument, KitchenState } from "../../app/lib/kitchen-types";
import { openPantryManagement, showPantryBatches } from "./pantry-helpers";

test.skip(process.env.RAG_CHEF_HOSTED_TEST !== "1", "Requires disposable hosted identities and signed sessions.");
const baseURL = process.env.RAG_CHEF_TEST_BASE_URL!;
const secret = process.env.RAG_CHEF_TEST_AUTH_SECRET!;
const headers = { origin: baseURL };
const emptyState = (): KitchenState => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });
const profile = { version: 1 as const, allergies: ["peanut"], diet: "No restriction", dislikes: [], skillLevel: "Confident beginner", budget: "Medium", equipment: ["Oven", "Stovetop"] };

async function login(context: BrowserContext, user: string) {
  const token = `token-${user}`, signature = createHmac("sha256", secret).update(token).digest("base64");
  await context.clearCookies();
  await context.addCookies([{ name: "better-auth.session_token", value: encodeURIComponent(`${token}.${signature}`), url: baseURL, httpOnly: true, sameSite: "Lax" }]);
}
async function document(request: APIRequestContext): Promise<KitchenDocument> {
  const response = await request.get("/api/kitchen");
  expect(response.status()).toBe(200);
  return response.json();
}
async function createKitchen(context: BrowserContext, user: string) {
  await login(context, user);
  const response = await context.request.post("/api/household", { headers, data: { name: user, timezone: "UTC" } });
  expect(response.status()).toBe(201);
  const session = await (await context.request.get("/api/session")).json();
  return { session, headers: { ...headers, "x-rag-chef-actor": user, "x-rag-chef-household": session.household.id } };
}
async function joinKitchen(owner: BrowserContext, member: BrowserContext, user: string) {
  await login(member, user);
  const response = await owner.request.post("/api/household/invitations", { headers, data: { email: `${user}@example.test` } });
  expect(response.status()).toBe(201);
  const invitation = await response.json();
  expect((await member.request.post("/api/household/invitations/accept", { headers, data: { invitationId: invitation.invitation.id } })).status()).toBe(200);
  const session = await (await member.request.get("/api/session")).json();
  return { ...headers, "x-rag-chef-actor": user, "x-rag-chef-household": session.household.id };
}
async function save(request: APIRequestContext, identity: Record<string, string>, state: KitchenState) {
  const current = await document(request);
  const response = await request.put("/api/kitchen", { headers: identity, data: { revision: current.revision, state } });
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<KitchenDocument>;
}
async function navigate(page: Page, name: string) {
  await page.locator(".side-nav, .mobile-nav").getByRole("button", { name: new RegExp(name) }).filter({ visible: true }).first().click();
}
async function pantry(page: Page) {
  await page.goto("/");
  await navigate(page, "Pantry");
  await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeVisible();
  await expect(page.locator(".save-indicator")).toHaveText("Saved");
  await openPantryManagement(page);
}

test("anonymous pages hide kitchens and protected APIs reject anonymous access", async ({ page, request }) => {
  const response = await page.goto("/");
  expect(response?.headers()["cache-control"]).toContain("no-store");
  await expect(page.getByRole("heading", { name: "Your kitchen, together" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.locator(".side-nav")).toHaveCount(0);
  const session = await request.get("/api/session");
  expect(session.status()).toBe(200);
  expect(session.headers()["cache-control"]).toContain("no-store");
  for (const path of ["/api/kitchen", "/api/recipes/catalog", "/api/recipes?q=rice", "/api/health"]) expect((await request.get(path)).status(), path).toBe(401);
  expect((await request.post("/api/chef", { headers, data: {} })).status()).toBe(401);
  expect((await request.post("/api/auth/organization/create", { headers, data: { name: "Bypass", slug: "bypass" } })).status()).toBe(404);
  expect((await request.post("/api/auth/sign-in/social", { headers: { origin: "https://evil.example" }, data: { provider: "google", callbackURL: "/" } })).status()).toBe(403);
});

test("owner creation and invitations share one kitchen while protecting requirements and revisions", async ({ page, browser, context }, info) => {
  const owner = `owner-sharing-${info.project.name}`, member = `member-sharing-${info.project.name}`, other = `other-sharing-${info.project.name}`;
  const memberContext = await browser.newContext({ baseURL, viewport: page.viewportSize() });
  const otherContext = await browser.newContext({ baseURL });
  try {
    await login(context, owner);
    await page.goto("/");
    await page.getByLabel("Kitchen name", { exact: true }).fill("Shared test kitchen");
    await page.getByLabel("Household timezone", { exact: true }).fill("UTC");
    await page.getByRole("button", { name: "Create family kitchen" }).click();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.locator(".save-indicator")).toHaveText("Saved");
    const session = await (await context.request.get("/api/session")).json();
    const identity = { ...headers, "x-rag-chef-actor": owner, "x-rag-chef-household": session.household.id };
    expect(session.household.role).toBe("owner");
    expect(session.platformAdmin).toBe(false);
    await createKitchen(otherContext, other);
    await login(memberContext, member);
    const invited = await context.request.post("/api/household/invitations", { headers, data: { email: `${member}@example.test` } });
    expect(invited.status()).toBe(201);
    const invitation = await invited.json();
    expect((await otherContext.request.post("/api/household/invitations/accept", { headers, data: { invitationId: invitation.invitation.id } })).status()).toBe(409);
    const memberPage = await memberContext.newPage();
    await memberPage.goto(invitation.url);
    await memberPage.getByRole("button", { name: "Accept kitchen invitation" }).click();
    await expect(memberPage.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await expect(memberPage.locator(".save-indicator")).toHaveText("Saved");
    const memberHeaders = { ...identity, "x-rag-chef-actor": member };
    const saved = await save(context.request, identity, { ...emptyState(), cookingProfile: profile });
    expect((await document(memberContext.request)).state?.cookingProfile?.allergies).toEqual(["peanut"]);
    expect((await document(otherContext.request)).state).toBeNull();
    expect((await memberContext.request.put("/api/kitchen", { headers: memberHeaders, data: { revision: saved.revision, state: { ...saved.state, cookingProfile: { ...profile, allergies: [] } } } })).status()).toBe(403);
    expect((await memberContext.request.post("/api/household/invitations", { headers, data: { email: "denied@example.test" } })).status()).toBe(403);
    expect((await context.request.get("/api/admin/catalog")).status()).toBe(403);
    expect((await memberContext.request.get("/api/admin/catalog")).status()).toBe(403);
    await memberPage.getByRole("button", { name: "Settings", exact: true }).click();
    const allergies = memberPage.getByRole("textbox", { name: "Allergies", exact: true });
    await expect(allergies).toBeDisabled();
    const sharedSettings = memberPage.getByRole("region", { name: "Shared kitchen settings", exact: true });
    expect((await allergies.boundingBox())!.y).toBeLessThan((await sharedSettings.boundingBox())!.y);
    await expect(memberPage.getByRole("group", { name: "Chef provider", exact: true })).toHaveCount(0);
    await expect(memberPage.getByRole("button", { name: "Create invitation link" })).toHaveCount(0);
    const changed = await save(memberContext.request, memberHeaders, { ...saved.state!, pantry: [{ id: "shared-rice", name: "rice", measure: "1 kg" }] });
    expect((await context.request.put("/api/kitchen", { headers: identity, data: { revision: saved.revision, state: saved.state } })).status()).toBe(409);
    expect(await document(context.request)).toEqual(changed);
    await page.screenshot({ path: info.outputPath("hosted-household.png"), fullPage: true });
  } finally { await memberContext.close(); await otherContext.close(); }
});

test("Combine safe edits preserves independent pantry corrections from two household members", async ({ page, browser, context }, info) => {
  const memberContext = await browser.newContext({ baseURL, viewport: page.viewportSize() });
  let releaseWrite!: () => void;
  const heldWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
  try {
    const owner = await createKitchen(context, `owner-combine-${info.project.name}`);
    await joinKitchen(context, memberContext, `member-combine-${info.project.name}`);
    const starting = await save(context.request, owner.headers, { ...emptyState(), pantry: [
      { id: "shared-rice", name: "rice", measure: "1 kg" },
      { id: "shared-beans", name: "beans", measure: "400 g" },
    ] });
    const member = await memberContext.newPage();
    for (const editor of [page, member]) {
      await pantry(editor);
      await showPantryBatches(editor);
    }
    const beans = member.getByRole("textbox", { name: "Available beans", exact: true });
    const rice = page.getByRole("textbox", { name: "Available rice", exact: true });
    await expect(beans).toHaveValue("400 g");
    await expect(rice).toHaveValue("1 kg");

    // Hold the member's actual request until the owner's edit is committed.
    await member.route("**/api/kitchen**", async route => {
      if (isKitchenWrite(route.request())) await heldWrite;
      await route.continue();
    });
    const pending = member.waitForRequest(isKitchenWrite);
    await beans.fill("600 g");
    await beans.blur();
    expect(kitchenWriteRevision(await pending)).toBe(starting.revision);
    const ownerSave = page.waitForResponse(response => isKitchenWrite(response.request()));
    await rice.fill("2 kg");
    await rice.blur();
    expect((await ownerSave).status()).toBe(200);
    const rejected = member.waitForResponse(response => isKitchenWrite(response.request()));
    releaseWrite();
    expect((await rejected).status()).toBe(409);
    expect((await document(context.request)).state?.pantry.map(stock => stock.measure)).toEqual(["2 kg", "400 g"]);

    const combineButton = member.getByRole("button", { name: "Combine safe edits", exact: true });
    const review = member.getByRole("alert").filter({ has: combineButton });
    await review.screenshot({ path: info.outputPath("combine-safe-edits.png") });
    const combined = member.waitForResponse(response => isKitchenWrite(response.request()));
    await combineButton.click();
    expect((await combined).status()).toBe(200);
    await expect(member.locator(".save-indicator")).toHaveText("Saved");
    for (const editor of [page, member]) {
      await pantry(editor); // Reopen the kitchen with this member's own session.
      await showPantryBatches(editor);
      await expect(editor.getByRole("textbox", { name: "Available rice", exact: true })).toHaveValue("2 kg");
      await expect(editor.getByRole("textbox", { name: "Available beans", exact: true })).toHaveValue("600 g");
    }
  } finally { releaseWrite(); await memberContext.close(); }
});

test("hosted pantry stocktake updates the shared household and dinner shopping history stays private", async ({ page, browser, context }, info) => {
  const owner = `owner-stocktake-${info.project.name}`, member = `member-stocktake-${info.project.name}`, other = `other-stocktake-${info.project.name}`;
  const memberContext = await browser.newContext({ baseURL });
  const otherContext = await browser.newContext({ baseURL });
  try {
    const home = await createKitchen(context, owner);
    await joinKitchen(context, memberContext, member);
    const second = await createKitchen(otherContext, other);
    const untouched = await save(otherContext.request, second.headers, { ...emptyState(), pantry: [{ id: "other-rice", name: "rice", measure: "8 kg" }] });
    await save(context.request, home.headers, { ...emptyState(), pantry: [{ id: "review-rice", name: "rice", measure: "" }, { id: "neighbor-beans", name: "beans", measure: "1 kg" }] });
    await pantry(page);
    const before = await document(context.request);
    await page.getByRole("region", { name: "Pantry stocktake", exact: true }).getByRole("button", { name: "Add amounts for better shopping estimates", exact: true }).click();
    const review = page.getByRole("dialog", { name: "Review batch rice", exact: true });
    await expect(review).toBeVisible();
    expect(await document(context.request)).toEqual(before);
    await review.getByRole("textbox", { name: "Amount on hand", exact: true }).fill("750 g");
    await review.getByRole("button", { name: "Save batch correction", exact: true }).click();
    await expect.poll(async () => (await document(memberContext.request)).state?.pantry).toEqual([
      { id: "review-rice", name: "rice", measure: "750 g" }, { id: "neighbor-beans", name: "beans", measure: "1 kg" },
    ]);
    expect(await document(otherContext.request)).toEqual(untouched);
    await expect(page.locator(".save-indicator")).toHaveText("Saved");

    await review.getByRole("button", { name: "Finish review", exact: true }).click();
    await navigate(page, "Recipes");
    await page.getByRole("searchbox", { name: "Search recipes", exact: true }).fill("Tomato Rice");
    await page.getByRole("button", { name: "Choose for tonight: Tomato Rice", exact: true }).click();
    await page.getByRole("region", { name: "Chosen dinner" }).getByRole("button", { name: "Shop for this dinner", exact: true }).click();
    const shopping = page.getByRole("region", { name: "Dinner shopping context" });
    await expect(shopping.getByRole("button", { name: "For this dinner", pressed: true })).toBeVisible();
    await expect(page.locator(".save-indicator")).toHaveText("Saved");
    const [dinner] = Object.values((await document(memberContext.request)).state!.meals);
    const prefix = `rag-chef-account:${encodeURIComponent(owner)}:${encodeURIComponent(home.session.household.id)}:navigation:`;
    const historyEntry = await page.evaluate(prefix => {
      const state = history.state;
      return { state, scoped: JSON.parse(sessionStorage.getItem(prefix + state.ragChefNavigationRef) ?? "null") };
    }, prefix);
    expect(historyEntry.state.ragChefNavigationRef).toMatch(/^[a-f0-9-]{36}$/);
    expect(historyEntry.state.ragChefNavigation).toBeUndefined();
    expect(historyEntry.scoped.shoppingDinner).toMatchObject({ date: dinner.date, mealId: dinner.id, scope: "dinner" });
    for (const value of [dinner.date, dinner.id, dinner.title]) expect(JSON.stringify(historyEntry.state)).not.toContain(value);

    await navigate(page, "Pantry");
    await expect(page.getByRole("heading", { name: "Your pantry", exact: true })).toBeVisible();
    await page.goBack();
    await expect(shopping.getByRole("button", { name: "For this dinner", pressed: true })).toBeVisible();
    await shopping.getByRole("button", { name: "Back to dinner", exact: true }).click();
    await expect(page.getByRole("region", { name: "Chosen dinner" })).toContainText(dinner.title);
  } finally { await memberContext.close(); await otherContext.close(); }
});

test("revoking a member rejects an open stocktake draft and removes private browser state", async ({ page, browser, context }, info) => {
  const owner = `owner-revocation-${info.project.name}`, member = `member-revocation-${info.project.name}`;
  const ownerContext = await browser.newContext({ baseURL });
  try {
    const home = await createKitchen(ownerContext, owner);
    await joinKitchen(ownerContext, context, member);
    const before = await save(ownerContext.request, home.headers, { ...emptyState(), pantry: [{ id: "revoked-rice", name: "rice", measure: "" }] });
    await pantry(page);
    await page.getByRole("region", { name: "Pantry stocktake", exact: true }).getByRole("button", { name: "Add amounts for better shopping estimates", exact: true }).click();
    const review = page.getByRole("dialog", { name: "Review batch rice", exact: true });
    await review.getByRole("textbox", { name: "Amount on hand", exact: true }).fill("9 kg");
    await page.evaluate(({ user, household }) => {
      const prefix = `rag-chef-account:${encodeURIComponent(user)}:${encodeURIComponent(household)}:`;
      localStorage.setItem(prefix + "private-test", "stocktake draft"); sessionStorage.setItem(prefix + "private-test", "private conversation");
    }, { user: member, household: home.session.household.id });
    const roster = await (await ownerContext.request.get("/api/household")).json();
    const membership = roster.members.find((row: { userId: string }) => row.userId === member);
    expect((await ownerContext.request.delete(`/api/household/members/${membership.id}`, { headers })).status()).toBe(200);
    const rejected = page.waitForResponse(response => isKitchenWrite(response.request()));
    await review.getByRole("button", { name: "Save batch correction", exact: true }).click();
    expect((await rejected).status()).toBe(403);
    await expect(page.getByText("An invitation is needed.", { exact: false })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Review batch rice", exact: true })).toHaveCount(0);
    expect(await document(ownerContext.request)).toEqual(before);
    expect(await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter(key => key.endsWith("private-test")))).toEqual([]);
    expect((await context.request.get("/api/kitchen")).status()).toBe(403);
  } finally { await ownerContext.close(); }
});

test("a stale account cannot autosave into another kitchen and logout tolerates blocked storage", async ({ page, browser, context }, info) => {
  const owner = `owner-switching-${info.project.name}`, other = `other-switching-${info.project.name}`;
  const otherContext = await browser.newContext({ baseURL });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const home = await createKitchen(context, owner);
    await createKitchen(otherContext, other);
    await save(context.request, home.headers, { ...emptyState(), pantry: [{ id: "old-account-rice", name: "rice", measure: "1 kg" }] });
    await pantry(page);
    await page.getByRole("button", { name: "Show all batches", exact: true }).click();
    const amount = page.getByRole("textbox", { name: "Available rice", exact: true });
    await expect(amount).toHaveValue("1 kg");
    await page.bringToFront();
    await login(context, other);
    const rejected = page.waitForResponse(response => isKitchenWrite(response.request()));
    await amount.fill("999 g"); await amount.blur();
    expect((await rejected).status()).toBe(403);
    // A denied write triggers an asynchronous session check and private-tree
    // remount. Open settings only after the new account owns the browser scope.
    await expect.poll(() => page.evaluate(user => Object.keys(sessionStorage).some(key => key.startsWith(`rag-chef-account:${encodeURIComponent(user)}:`)), other)).toBe(true);
    await expect(page.locator("#pantry-row-old-account-rice")).toHaveCount(0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByText(`Signed in as ${other}@example.test`, { exact: false })).toBeVisible();
    expect((await document(context.request)).state?.pantry ?? []).toEqual([]);
    await page.evaluate(() => {
      Storage.prototype.setItem = () => { throw new DOMException("Storage blocked", "SecurityError"); };
      Storage.prototype.removeItem = () => { throw new DOMException("Storage blocked", "SecurityError"); };
    });
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    await expect(page.locator(".side-nav")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await otherContext.close(); }
});

test("planning dates follow the household timezone and refresh when it changes", async ({ page, context }, info) => {
  await createKitchen(context, `owner-timezone-${info.project.name}`);
  expect((await context.request.patch("/api/household", { headers, data: { timezone: "Pacific/Kiritimati" } })).status()).toBe(200);
  await page.clock.install({ time: new Date("2026-11-01T12:00:00Z") });
  await page.goto("/");
  await navigate(page, "Plan");
  await expect(page.getByRole("region", { name: "Today’s dinner", exact: true })).toContainText("Mon, Nov 2");
  await expect(page.getByRole("button", { name: "This week", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Household timezone", { exact: true }).fill("UTC");
  await page.getByRole("button", { name: "Save household details", exact: true }).click();
  await expect.poll(async () => (await (await context.request.get("/api/session")).json()).household.timezone).toBe("UTC");
  await navigate(page, "Plan");
  await expect(page.getByRole("button", { name: "This week", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "This week", exact: true }).click();
  await expect(page.getByRole("region", { name: "Today’s dinner", exact: true })).toContainText("Sun, Nov 1");
});
