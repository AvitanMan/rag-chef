import { createHmac } from 'node:crypto';
import { test, expect, type BrowserContext, type APIRequestContext } from '@playwright/test';

test.skip(process.env.RAG_CHEF_HOSTED_TEST !== '1', 'Requires the isolated hosted runner and synthetic signed sessions.');
const baseURL = process.env.RAG_CHEF_TEST_BASE_URL!;
const secret = process.env.RAG_CHEF_TEST_AUTH_SECRET!;
const emptyState = () => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: false });
const profile = { version: 1, allergies: ['peanut'], diet: 'No restriction', dislikes: [], skillLevel: 'Confident beginner', budget: 'Medium', equipment: ['Oven', 'Stovetop'] };
function cookie(user: string) { const token = `token-${user}`, signature = createHmac('sha256', secret).update(token).digest('base64'); return { name: 'better-auth.session_token', value: encodeURIComponent(`${token}.${signature}`), url: baseURL, httpOnly: true, sameSite: 'Lax' as const }; }
async function login(context: BrowserContext, user: string) { await context.clearCookies(); await context.addCookies([cookie(user)]); }
const headers = { origin: baseURL };
async function document(request: APIRequestContext) { const response = await request.get('/api/kitchen'); expect(response.status()).toBe(200); return response.json(); }
function dates() { const today = new Date().toISOString().slice(0, 10), day = new Date(`${today}T12:00:00Z`), offset = (day.getUTCDay() + 6) % 7; day.setUTCDate(day.getUTCDate() - offset); return { today, week: day.toISOString().slice(0, 10) }; }

test('hosted anonymous pages hide kitchens and APIs reject unauthenticated access', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your kitchen, together' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.locator('.side-nav')).toHaveCount(0);
  expect((await request.get('/api/session')).status()).toBe(200);
  for (const path of ['/api/kitchen', '/api/recipes/catalog', '/api/recipes?q=rice', '/api/ai/connections/openai', '/api/health']) expect((await request.get(path)).status(), path).toBe(401);
  expect((await request.post('/api/auth/organization/create', { headers, data: { name: 'Bypass', slug: 'bypass' } })).status()).toBe(404);
  expect((await request.post('/api/auth/sign-in/social', { headers: { origin: 'https://evil.example' }, data: { provider: 'google', callbackURL: '/' } })).status()).toBe(403);
});

test('shared household owner and member journey protects drafts, credentials, writes and private browser state', async ({ page, browser, context }, info) => {
  test.setTimeout(90_000);
  const ownerId = `owner-${info.project.name}`, memberId = `member-${info.project.name}`, otherId = `other-${info.project.name}`;
  const memberContext = await browser.newContext({ baseURL, viewport: page.viewportSize() });
  const otherContext = await browser.newContext({ baseURL, viewport: page.viewportSize() });
  try {
    await login(context, ownerId); await login(memberContext, memberId); await login(otherContext, otherId);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Create family kitchen' })).toBeVisible();
    await page.getByLabel('Kitchen name', { exact: true }).fill(`Family ${info.project.name}`);
    await page.getByLabel('Household timezone', { exact: true }).fill('UTC');
    await page.getByRole('button', { name: 'Create family kitchen' }).click();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    const ownerSession = await (await context.request.get('/api/session')).json();
    const ownerHeaders = { ...headers, "x-rag-chef-actor": ownerId, "x-rag-chef-household": ownerSession.household.id };
    const memberHeaders = { ...headers, "x-rag-chef-actor": memberId, "x-rag-chef-household": ownerSession.household.id };
    expect(ownerSession.household.assistantEnabled).toBe(false);
    await expect(page.getByRole('button', { name: 'Ask Chef: kitchen assistant', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Plan with Chef', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Enable assistant beta', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Disable assistant beta', exact: true })).toBeVisible();
    await page.screenshot({ path: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/hosted-settings-${info.project.name}.png`, fullPage: true });
    await page.locator('.side-nav, .mobile-nav').getByRole('button', { name: /Plan/ }).filter({ visible: true }).first().click();
    await page.getByRole('button', { name: 'Ask Chef: kitchen assistant', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Kitchen assistant', exact: true })).toBeVisible();
    await page.screenshot({ path: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/hosted-assistant-${info.project.name}.png` });
    await page.getByRole('button', { name: 'Close kitchen assistant', exact: true }).click();
    expect(ownerSession.household.role).toBe('owner'); expect(ownerSession.platformAdmin).toBe(false);
    expect((await otherContext.request.post('/api/household', { headers, data: { name: `Other ${info.project.name}`, timezone: 'UTC' } })).status()).toBe(201);
    expect((await context.request.get('/api/admin/catalog')).status()).toBe(403);
    const invite = await context.request.post('/api/household/invitations', { headers, data: { email: `${memberId}@example.test` } });
    expect(invite.status()).toBe(201); const invitation = await invite.json();
    expect((await otherContext.request.post('/api/household/invitations/accept', { headers, data: { invitationId: invitation.invitation.id } })).status()).toBe(409);
    const memberPage = await memberContext.newPage();
    await memberPage.goto(invitation.url);
    await expect(memberPage.getByRole('button', { name: 'Accept kitchen invitation' })).toBeVisible();
    await memberPage.getByRole('button', { name: 'Accept kitchen invitation' }).click();
    await expect(memberPage.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    // Initial browser migration may win this first CAS; refresh the fixture's
    // revision while retaining the normal 409 behavior tested below.
    let save = await context.request.put('/api/kitchen', { headers: ownerHeaders, data: { revision: (await document(context.request)).revision, state: { ...emptyState(), cookingProfile: profile } } });
    if (save.status() === 409) save = await context.request.put('/api/kitchen', { headers: ownerHeaders, data: { revision: (await document(context.request)).revision, state: { ...emptyState(), cookingProfile: profile } } });
    expect(save.status()).toBe(200); const saved = await save.json();
    expect((await document(otherContext.request)).state).toBeNull();
    expect((await memberContext.request.put('/api/kitchen', { headers: memberHeaders, data: { revision: saved.revision, state: { ...saved.state, cookingProfile: { ...profile, allergies: [] } } } })).status()).toBe(403);
    expect((await memberContext.request.post('/api/household/invitations', { headers, data: { email: 'not-allowed@example.test' } })).status()).toBe(403);
    await memberPage.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(memberPage.getByRole('textbox', { name: 'Allergies', exact: true })).toBeDisabled();
    await expect(memberPage.getByRole('button', { name: 'Create invitation link' })).toHaveCount(0);

    const fakeKey = 'sk-isolated-no-network-key-1234567890';
    const keySave = await context.request.put('/api/ai/connections/openai', { headers, data: { apiKey: fakeKey, model: 'gpt-4.1-mini' } });
    expect(keySave.status()).toBe(200); expect(await keySave.text()).not.toContain(fakeKey);
    expect((await (await context.request.get('/api/ai/connections/openai')).json()).openai.configured).toBe(true);
    expect((await (await memberContext.request.get('/api/ai/connections/openai')).json()).openai.configured).toBe(false);
    expect((await (await otherContext.request.get('/api/ai/connections/openai')).json()).openai.configured).toBe(false);
    expect((await context.request.delete('/api/ai/connections/openai', { headers })).status()).toBe(200);

    const baseline = await document(memberContext.request);
    const body = { query: 'Add 2 kg rice', ...dates(), kitchenRevision: baseline.revision, ai: { provider: 'browser_ollama', model: 'isolated-local-model' } };
    const prepared = await memberContext.request.post('/api/assistant', { headers, data: body });
    expect(prepared.status()).toBe(202); const task = (await prepared.json()).task;
    expect(task.ollamaRequest.messages.length).toBeGreaterThan(0);
    expect(await document(memberContext.request)).toEqual(baseline);
    const rawOutput = JSON.stringify({ pantry: [{ kind: 'add', name: 'rice', stockId: null, measure: '2 kg', useBy: null, useBySpecified: false, evidence: 'Add 2 kg rice' }], tastes: [], planningQuery: null, completion: null, clarification: null });
    expect((await context.request.post(`/api/ai/tasks/${task.taskId}/result`, { headers, data: { token: task.token, rawOutput } })).status()).toBe(404);
    const result = await memberContext.request.post(`/api/ai/tasks/${task.taskId}/result`, { headers, data: { token: task.token, rawOutput } });
    expect(result.status()).toBe(200); const draft = (await result.json()).draft;
    expect(draft.memberId).toBe(memberId); expect(await document(memberContext.request)).toEqual(baseline);
    expect((await context.request.post('/api/assistant/apply', { headers, data: { draft } })).status()).toBe(409);
    const applied = await memberContext.request.post('/api/assistant/apply', { headers, data: { draft } });
    expect(applied.status()).toBe(200); const final = await applied.json();
    expect(final.document.state.pantry).toEqual(draft.pantryChanges.map((change: { after: unknown }) => change.after));
    expect(final.document.state.pantry).toEqual([expect.objectContaining({ name: 'rice', measure: '2000 g' })]);
    const replay = await memberContext.request.post('/api/assistant/apply', { headers, data: { draft } });
    expect(replay.status()).toBe(200); expect((await replay.json()).alreadyApplied).toBe(true);
    expect((await document(memberContext.request)).revision).toBe(final.document.revision);
    expect((await context.request.put('/api/kitchen', { headers: ownerHeaders, data: { revision: baseline.revision, state: baseline.state } })).status()).toBe(409);

    const pending = await memberContext.request.post('/api/assistant', { headers, data: { ...body, kitchenRevision: final.document.revision } });
    expect(pending.status()).toBe(202); const cancelled = (await pending.json()).task;
    expect((await memberContext.request.delete(`/api/ai/tasks/${cancelled.taskId}`, { headers, data: { token: cancelled.token } })).status()).toBe(200);
    expect((await memberContext.request.post(`/api/ai/tasks/${cancelled.taskId}/result`, { headers, data: { token: cancelled.token, rawOutput } })).status()).toBe(409);

    await memberPage.evaluate(({ user, household }) => { const prefix = `rag-chef-account:${user}:${household}:`; localStorage.setItem(prefix + 'private-test', 'member draft'); sessionStorage.setItem(prefix + 'private-test', 'member conversation'); }, { user: memberId, household: ownerSession.household.id });
    const roster = await (await context.request.get('/api/household')).json();
    const member = roster.members.find((row: {userId: string}) => row.userId === memberId);
    expect((await context.request.delete(`/api/household/members/${member.id}`, { headers })).status()).toBe(200);
    expect((await memberContext.request.get('/api/kitchen')).status()).toBe(403);
    await memberPage.evaluate(() => window.dispatchEvent(new Event('rag-chef-session-check')));
    await expect(memberPage.getByText('An invitation is needed.', { exact: false })).toBeVisible();
    expect(await memberPage.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter(key => key.endsWith('private-test')))).toEqual([]);

    await page.evaluate(({ user, household }) => { localStorage.setItem(`rag-chef-account:${user}:${household}:private-test`, 'owner draft'); }, { user: ownerId, household: ownerSession.household.id });
    await login(context, otherId);
    expect((await context.request.put('/api/kitchen', { headers: ownerHeaders, data: { revision: 0, state: final.document.state } })).status()).toBe(403);
    await page.evaluate(() => window.dispatchEvent(new Event('rag-chef-session-check')));
    await expect.poll(() => page.evaluate(user => Object.keys(sessionStorage).some(key => key.startsWith(`rag-chef-account:${user}:`)), otherId)).toBe(true);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByText(`Signed in as ${otherId}@example.test`, { exact: false })).toBeVisible();
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.endsWith('private-test')))).toEqual([]);
    expect((await document(context.request)).state?.pantry ?? []).toEqual([]);
  } finally { await memberContext.close(); await otherContext.close(); }
});

test('two household members merge independent pending pantry edits without losing either row', async ({ page, browser, context }, info) => {
  const ownerId = `owner-${info.project.name}`, memberId = `member-${info.project.name}`;
  await login(context, ownerId);
  const session = await (await context.request.get('/api/session')).json();
  const ownerHeaders = { ...headers, 'x-rag-chef-actor': ownerId, 'x-rag-chef-household': session.household.id };
  const memberContext = await browser.newContext({ baseURL, viewport: page.viewportSize() });
  let release: (() => void) | undefined;
  try {
    await login(memberContext, memberId);
    const invitation = await (await context.request.post('/api/household/invitations', { headers: ownerHeaders, data: { email: `${memberId}@example.test` } })).json();
    expect((await memberContext.request.post('/api/household/invitations/accept', { headers, data: { invitationId: invitation.invitation.id } })).status()).toBe(200);
    const memberPage = await memberContext.newPage();
    await page.goto('/'); await memberPage.goto('/');
    for (const current of [page, memberPage]) {
      await current.locator('.side-nav, .mobile-nav').getByRole('button', { name: /Pantry/ }).filter({ visible: true }).first().click();
      await expect(current.getByRole('textbox', { name: 'Available rice', exact: true })).toHaveValue('2000 g');
    }
    let caught!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const arrived = new Promise<void>(resolve => { caught = resolve; });
    let intercept = true;
    await page.route('**/api/kitchen', async route => {
      if (intercept && route.request().method() === 'PUT') { intercept = false; caught(); await held; }
      await route.continue();
    });
    await page.getByRole('textbox', { name: 'Available rice', exact: true }).fill('1500 g');
    await arrived;
    await memberPage.getByRole('textbox', { name: 'New pantry ingredient', exact: true }).fill('beans: 1 kg');
    const memberSave = memberPage.waitForResponse(response => response.url().endsWith('/api/kitchen') && response.request().method() === 'PUT' && response.status() === 200);
    await memberPage.getByRole('button', { name: 'Add to pantry', exact: true }).click();
    await memberPage.getByRole('button', { name: 'Confirm ingredients', exact: true }).click(); await memberSave;
    release!();
    await expect(page.getByRole('heading', { name: 'The household kitchen changed' })).toBeVisible();
    await page.getByRole('button', { name: 'Merge kitchen changes', exact: true }).click();
    await expect.poll(async () => (await document(context.request)).state.pantry.map((row: {name: string;measure: string}) => `${row.name}:${row.measure}`).sort()).toEqual(['beans:1 kg', 'rice:1500 g']);
  } finally { release?.(); await memberContext.close(); }
});

test('a stale tab cannot autosave into a new account and logout unmounts private content despite storage cleanup failure', async ({ page, context }, info) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const ownerId = `owner-${info.project.name}`, otherId = `other-${info.project.name}`;
  await login(context, ownerId); await page.goto('/');
  await page.locator('.side-nav, .mobile-nav').getByRole('button', { name: /Pantry/ }).filter({ visible: true }).first().click();
  await expect(page.getByRole('textbox', { name: 'Available rice', exact: true })).toHaveValue('1500 g');
  await page.bringToFront();
  // Another tab signs into B. A's mounted form and its captured request scope
  // remain unchanged until the server rejects its next actual autosave.
  await login(context, otherId);
  const rejectedSave = page.waitForResponse(response => response.url().endsWith('/api/kitchen') && response.request().method() === 'PUT');
  await page.getByRole('textbox', { name: 'Available rice', exact: true }).fill('999 g');
  expect((await rejectedSave).status()).toBe(403);
  await expect.poll(() => page.evaluate(user => Object.keys(sessionStorage).some(key => key.startsWith(`rag-chef-account:${user}:`)), otherId)).toBe(true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByText(`Signed in as ${otherId}@example.test`, { exact: false })).toBeVisible();
  expect((await document(context.request)).state?.pantry ?? []).toEqual([]);
  // Exercise the new explicit discard decision with real unsaved work, rather
  // than racing the new account's initial save when clicking Sign out.
  await page.route('**/api/kitchen', async route => {
    if (route.request().method() === 'PUT') await route.abort('connectionfailed');
    else await route.continue();
  });
  await page.locator('.side-nav, .mobile-nav').getByRole('button', { name: /Pantry/ }).filter({ visible: true }).first().click();
  await page.getByRole('textbox', { name: 'New pantry ingredient', exact: true }).fill('oats: 50 g');
  await page.getByRole('button', { name: 'Add to pantry', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm ingredients', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Available oats', exact: true })).toHaveValue('50 g');
  await expect(page.locator('.save-indicator')).toHaveText('Offline');
  expect((await document(context.request)).state?.pantry ?? []).toEqual([]);
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find(value => value.startsWith('rag-chef-account:'));
    if (key) localStorage.setItem(key.replace(/:[^:]+$/, ':private-logout-test'), 'private data');
    Storage.prototype.setItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
    Storage.prototype.removeItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
  });
  for (const [label, heading] of [['Recipes', 'Recipes'], ['Plan', 'Weekly plan']]) {
    await page.locator('.side-nav, .mobile-nav').getByRole('button', { name: new RegExp(label) }).filter({ visible: true }).first().click();
    await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => window.history.state?.ragChefNavigation)).toBeUndefined();
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const decision = page.getByRole('dialog', { name: 'Sign out of this device', exact: true });
  await expect(decision).toBeVisible();
  await decision.getByRole('button', { name: 'Discard and sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.locator('.side-nav')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('the initial planning week and refreshed date follow the household timezone', async ({ page, context }, info) => {
  await login(context, `owner-${info.project.name}`);
  expect((await context.request.patch('/api/household', { headers, data: { timezone: 'Pacific/Kiritimati' } })).status()).toBe(200);
  // Monday at home, while this browser is still on Sunday in Jerusalem.
  await page.clock.install({ time: new Date('2026-11-01T12:00:00Z') });
  await page.goto('/');
  await page.locator('.side-nav, .mobile-nav').getByRole('button', { name: /Plan/ }).filter({ visible: true }).first().click();
  await expect(page.getByRole('region', { name: 'Today’s dinner', exact: true })).toContainText('Mon, Nov 2');
  await expect(page.getByRole('button', { name: 'This week', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Household timezone', { exact: true }).fill('UTC');
  await page.getByRole('button', { name: 'Save household details', exact: true }).click();
  await expect.poll(async () => (await (await context.request.get('/api/session')).json()).household.timezone).toBe('UTC');
  await page.locator('.side-nav, .mobile-nav').getByRole('button', { name: /Plan/ }).filter({ visible: true }).first().click();
  await expect(page.getByRole('button', { name: 'This week', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'This week', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Today’s dinner', exact: true })).toContainText('Sun, Nov 1');
});

test('recovering an older private draft preserves newer independent household stock when merged', async ({ page, context }, info) => {
  const ownerId = `owner-${info.project.name}`;
  await login(context, ownerId);
  const session = await (await context.request.get('/api/session')).json();
  const ownerHeaders = { ...headers, 'x-rag-chef-actor': ownerId, 'x-rag-chef-household': session.household.id };
  const current = await document(context.request);
  const rice = { id: 'recovery-rice', name: 'rice', measure: '1 kg' };
  const baseSave = await context.request.put('/api/kitchen', { headers: ownerHeaders, data: { revision: current.revision, state: { ...current.state, pantry: [rice] } } });
  expect(baseSave.status()).toBe(200);
  const original = await baseSave.json();
  const newerSave = await context.request.put('/api/kitchen', { headers: ownerHeaders, data: { revision: original.revision, state: { ...original.state, pantry: [rice, { id: 'recovery-beans', name: 'beans', measure: '2 kg' }] } } });
  expect(newerSave.status()).toBe(200);
  const newer = await newerSave.json();
  await page.goto('/');
  await page.locator('.side-nav, .mobile-nav').getByRole('button', { name: /Pantry/ }).filter({ visible: true }).first().click();
  await expect(page.getByRole('textbox', { name: 'Available rice', exact: true })).toHaveValue('1 kg');
  await expect(page.getByRole('textbox', { name: 'Available beans', exact: true })).toHaveValue('2 kg');
  const cacheKey = `rag-chef-account:${encodeURIComponent(ownerId)}:${encodeURIComponent(session.household.id)}:rag-chef-kitchen-v2:draft:older-private-recovery`;
  const recovered = { revision: original.revision, base: original.state, state: { ...original.state, pantry: [{ ...rice, measure: '500 g' }] }, dirty: true, updatedAt: '2026-10-19T00:00:00.000Z', reason: 'edit' };
  await page.evaluate(({ key, value }) => { localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new Event('storage')); }, { key: cacheKey, value: recovered });
  const recovery = page.locator('.recovery-panel');
  await expect(recovery.locator('summary')).toContainText('Unsaved kitchens found (1)');
  await recovery.locator('summary').click();
  await recovery.getByRole('button', { name: 'Recover this draft', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'The household kitchen changed', exact: true })).toBeVisible();
  expect(await document(context.request)).toEqual(newer);
  const mergedSave = page.waitForResponse(response => response.url().endsWith('/api/kitchen') && response.request().method() === 'PUT' && response.status() === 200);
  await page.getByRole('button', { name: 'Merge kitchen changes', exact: true }).click();
  await mergedSave;
  await expect.poll(async () => (await document(context.request)).state.pantry.map((row: { name: string; measure: string }) => `${row.name}:${row.measure}`).sort()).toEqual(['beans:2 kg', 'rice:500 g']);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), cacheKey)).toEqual(recovered);
});

test('LM Studio browser connection prepares a real assistant draft without changing the kitchen', async ({ page, context }, info) => {
  const ownerId = `owner-${info.project.name}`;
  const model = 'test/lmstudio-model';
  await login(context, ownerId);
  let session = await (await context.request.get('/api/session')).json();
  if (!session.household) {
    expect((await context.request.post('/api/household', { headers, data: { name: `LM Studio ${info.project.name}`, timezone: 'UTC' } })).status()).toBe(201);
    session = await (await context.request.get('/api/session')).json();
  }
  expect((await context.request.patch('/api/household', { headers, data: { assistantEnabled: true } })).status()).toBe(200);
  const prefix = `rag-chef-account:${encodeURIComponent(ownerId)}:${encodeURIComponent(session.household.id)}:`;
  const calls: Array<Record<string, unknown>> = [];
  const rawOutput = { pantry: [{ kind: 'add', name: 'rice', stockId: null, measure: '2 kg', useBy: null, useBySpecified: false, evidence: 'Add 2 kg rice' }], tastes: [], planningQuery: null, completion: null, clarification: null };
  await page.route('http://127.0.0.1:1234/v1/**', async route => {
    const request = route.request();
    expect(request.headers().authorization).toBeUndefined();
    expect(request.headers().cookie).toBeUndefined();
    if (request.url().endsWith('/models')) {
      await route.fulfill({ json: { data: [{ id: model }] } });
      return;
    }
    expect(request.url()).toBe('http://127.0.0.1:1234/v1/chat/completions');
    const body = request.postDataJSON(); calls.push(body);
    expect(body).toMatchObject({ model, stream: false, response_format: { type: 'json_schema', json_schema: { strict: true } } });
    expect(body.format).toBeUndefined();
    const isTest = Boolean(body.response_format.json_schema.schema.properties.ready);
    await route.fulfill({ json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(isTest ? { ready: true } : rawOutput) } }] } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const connections = page.getByRole('region', { name: 'Your AI connections' });
  await connections.locator('.provider-card').filter({ hasText: 'LM Studio' }).click();
  await expect(connections.getByRole('textbox', { name: 'LM Studio on this computer', exact: true })).toHaveValue('http://127.0.0.1:1234');
  await connections.getByRole('button', { name: 'Connect to LM Studio', exact: true }).click();
  await expect(connections.getByRole('combobox', { name: 'Local model', exact: true })).toHaveValue(model);
  await connections.getByRole('button', { name: 'Test and save local model', exact: true }).click();
  await expect(connections.getByRole('status')).toContainText('Keep LM Studio running');
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), prefix + 'rag-chef-lmstudio-ai-v1');
  expect(saved).toMatchObject({ endpoint: 'http://127.0.0.1:1234', model, origin: baseURL });
  await page.screenshot({ path: info.outputPath('lmstudio-browser-connection.png'), fullPage: true });
  await connections.locator('.provider-card').filter({ hasText: 'Local Ollama' }).click();
  await expect(connections.getByRole('textbox', { name: 'Ollama on this computer', exact: true })).toHaveValue('http://127.0.0.1:11434');
  await connections.locator('.provider-card').filter({ hasText: 'LM Studio' }).click();
  await expect(connections.getByRole('combobox', { name: 'Local model', exact: true })).toHaveValue(model);

  await page.locator('.side-nav, .mobile-nav').getByRole('button', { name: /Plan/ }).filter({ visible: true }).first().click();
  await page.getByRole('button', { name: 'Ask Chef: kitchen assistant', exact: true }).click();
  const assistant = page.getByRole('dialog', { name: 'Kitchen assistant', exact: true });
  await assistant.getByRole('textbox', { name: 'Your request', exact: true }).fill('Add 2 kg rice');
  await expect(assistant.getByRole('button', { name: 'Ask Chef', exact: true })).toBeEnabled();
  const before = await document(context.request);
  const prepared = page.waitForResponse(response => new URL(response.url()).pathname === '/api/assistant' && response.request().method() === 'POST');
  await assistant.getByRole('button', { name: 'Ask Chef', exact: true }).click();
  const response = await prepared;
  expect(response.status()).toBe(202);
  expect(response.request().postDataJSON().ai).toEqual({ provider: 'browser_lmstudio', model });
  expect((await response.json()).task.provider).toBe('browser_lmstudio');
  await expect(assistant.getByRole('region', { name: 'Proposed kitchen changes' })).toContainText('rice');
  await expect(assistant.getByRole('button', { name: 'Apply changes', exact: true })).toBeEnabled();
  expect(calls).toHaveLength(2);
  expect(await document(context.request)).toEqual(before);
  await page.getByRole('button', { name: 'Close kitchen assistant', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await connections.getByRole('button', { name: 'Forget connection', exact: true }).click();
  expect(await page.evaluate(key => localStorage.getItem(key), prefix + 'rag-chef-lmstudio-ai-v1')).toBeNull();
});
