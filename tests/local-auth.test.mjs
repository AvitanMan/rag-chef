import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { localAuthRuntime } from './helpers/local-auth-runtime.mjs';
const runtime = await localAuthRuntime();
const { auth, household, database, binding, store, types } = runtime;
const origin = 'https://ragchef.local:3443';
const password = 'test-only-long-password';
const hash = await auth.sha256(`chef:${password}`);
const settings = { DB: binding, RAG_CHEF_HOSTED: '0', RAG_CHEF_LAN_AUTH: '1', RAG_CHEF_LAN_PASSWORD_SHA256: hash, RAG_CHEF_LAN_ORIGINS: `${origin},https://192.168.1.20:3443` };
const request = (path, { method = 'GET', body, headers = {}, target = origin } = {}) => new Request(`${target}${path}`, { method, headers: { ...(method !== 'GET' ? { origin: target, 'content-type': 'application/json' } : {}), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
async function signIn(remember = false, headers = {}) {
  const response = await auth.signInLocal(request('/api/local-auth/sign-in', { method: 'POST', body: { username: 'chef', password, remember }, headers }));
  assert.equal(response.status, 200);
  return { response, session: await response.clone().json(), cookie: response.headers.get('set-cookie').split(';')[0] };
}
const scopedHeaders = login => ({ cookie: login.cookie, 'x-rag-chef-session': login.session.localAccess.sessionId });
beforeEach(() => { runtime.beforeStatement(undefined); database.exec('DELETE FROM local_auth_sessions; DELETE FROM local_auth_attempts; DELETE FROM kitchen_state'); household.configureHouseholdRuntime(settings); });
after(() => runtime.close());

test('default sign-in creates a twelve-hour opaque server session and a browser-session cookie', async () => {
  const login = await signIn();
  assert.match(login.cookie, /^__Host-rag-chef-local=[A-Za-z0-9_-]{43}$/);
  const cookie = login.response.headers.get('set-cookie');
  for (const flag of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(cookie.includes(flag));
  assert.ok(!cookie.includes('Max-Age')); assert.ok(!cookie.includes('Expires')); assert.ok(!cookie.includes('Domain'));
  const row = database.prepare('SELECT * FROM local_auth_sessions').get();
  assert.equal(row.expires_at - row.created_at, 12 * 60 * 60 * 1000); assert.equal(row.remembered, 0);
  assert.equal(row.token_hash, await auth.sha256(login.cookie.split('=')[1]));
  assert.notEqual(row.credential_version, hash);
  assert.ok(!JSON.stringify(row).includes(password)); assert.ok(!JSON.stringify(row).includes(login.cookie.split('=')[1]));
  assert.deepEqual(await (await auth.localSessionResponse(request('/api/session', { headers: { cookie: login.cookie } }))).json(), login.session);
  assert.equal(await household.authorizeApplicationRequest(request('/api/kitchen', { headers: scopedHeaders(login) })), null);
});

test('remembered sessions last thirty fixed days, survive runtime restart, and are origin-bound', async () => {
  const login = await signIn(true), row = database.prepare('SELECT * FROM local_auth_sessions').get();
  assert.equal(row.expires_at - row.created_at, 30 * 86400000); assert.ok(login.response.headers.get('set-cookie').includes('Max-Age=2592000'));
  household.configureHouseholdRuntime({ ...settings });
  assert.equal((await auth.readLocalSession(request('/api/session', { headers: { cookie: login.cookie } }))).remembered, true);
  assert.equal(await auth.readLocalSession(request('/api/session', { target: 'https://192.168.1.20:3443', headers: { cookie: login.cookie } })), null);
  assert.equal(database.prepare('SELECT expires_at FROM local_auth_sessions').get().expires_at, row.expires_at);
});

test('anonymous status is sanitized and invalid, expired, rotated credentials cannot read a kitchen', async () => {
  assert.deepEqual(await (await auth.localSessionResponse(request('/api/session'))).json(), { mode: 'local', authenticated: false, localServer: { requiresPassword: true } });
  const login = await signIn();
  const invalid = ['__Host-rag-chef-local=malformed', `${login.cookie}; ${login.cookie}`, `${auth.LOCAL_SESSION_COOKIE}=${'x'.repeat(43)}`];
  for (const cookie of invalid) assert.equal((await household.authorizeApplicationRequest(request('/api/kitchen', { headers: { cookie } }))).status, 401);
  database.prepare('UPDATE local_auth_sessions SET expires_at=?').run(Date.now() - 1);
  assert.equal((await household.authorizeApplicationRequest(request('/api/kitchen', { headers: scopedHeaders(login) }))).status, 401);
  const second = await signIn();
  household.configureHouseholdRuntime({ ...settings, RAG_CHEF_LAN_PASSWORD_SHA256: await auth.sha256('chef:replacement-password') });
  assert.equal((await household.authorizeApplicationRequest(request('/api/kitchen', { headers: scopedHeaders(second) }))).status, 401);
});

test('cookie mutations require same origin and the current session scope; Basic never opens browser pages', async () => {
  const login = await signIn();
  for (const headers of [{ cookie: login.cookie }, { ...scopedHeaders(login), 'x-rag-chef-session': 'obsolete' }]) {
    assert.equal((await household.authorizeApplicationRequest(request('/api/kitchen', { method: 'PUT', headers }))).status, 403);
  }
  for (const headers of [{ origin: '' }, { origin: 'https://evil.test' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await household.authorizeApplicationRequest(request('/api/kitchen', { method: 'PUT', headers: { ...scopedHeaders(login), ...headers } }))).status, 403);
    await assert.rejects(auth.signInLocal(request('/api/local-auth/sign-in', { method: 'POST', body: { username: 'chef', password }, headers })), error => error.code === 'CROSS_ORIGIN_WRITE');
  }
  const basic = { authorization: `Basic ${btoa(`chef:${password}`)}` };
  assert.equal((await household.authorizeApplicationRequest(request('/api/kitchen', { headers: basic }))).status, 401);
  assert.equal(await household.authorizeApplicationRequest(request('/api/kitchen', { headers: { ...basic, 'x-rag-chef-client': 'cli' } })), null);
});

test('logout is server-revoked and idempotent, and re-sign-in rejects obsolete tab scopes', async () => {
  const first = await signIn();
  const second = await signIn(false, { cookie: first.cookie });
  assert.equal(await auth.readLocalSession(request('/api/session', { headers: { cookie: first.cookie } })), null);
  await assert.rejects(auth.signOutLocal(request('/api/local-auth/sign-out', { method: 'POST', body: {}, headers: { cookie: second.cookie, 'x-rag-chef-session': first.session.localAccess.sessionId } })), error => error.code === 'SESSION_SCOPE_CHANGED');
  const logout = await auth.signOutLocal(request('/api/local-auth/sign-out', { method: 'POST', body: {}, headers: scopedHeaders(second) }));
  assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0')); assert.equal(database.prepare('SELECT count(*) AS n FROM local_auth_sessions').get().n, 0);
  assert.equal((await auth.signOutLocal(request('/api/local-auth/sign-out', { method: 'POST', body: {}, headers: scopedHeaders(second) }))).status, 200);
});

test('ten failed attempts throttle the kitchen across browser and CLI routes, and reset after fifteen minutes', async () => {
  for (let i = 0; i < 9; i++) assert.equal((await auth.signInLocal(request('/api/local-auth/sign-in', { method: 'POST', body: { username: 'chef', password: 'incorrect-password' } }))).status, 401);
  assert.equal((await household.authorizeApplicationRequest(request('/api/kitchen', { headers: { authorization: `Basic ${btoa('chef:incorrect-password')}`, 'x-rag-chef-client': 'cli' } }))).status, 401);
  await assert.rejects(signIn(), error => error.code === 'LAN_SIGN_IN_THROTTLED' && error.retryAfter > 0);
  const cli = await household.authorizeApplicationRequest(request('/api/kitchen', { headers: { authorization: `Basic ${btoa(`chef:${password}`)}`, 'x-rag-chef-client': 'cli' } }));
  assert.equal(cli.status, 429); assert.ok(Number(cli.headers.get('retry-after')) > 0); assert.equal(cli.headers.get('www-authenticate'), null);
  database.prepare('UPDATE local_auth_attempts SET window_started=?').run(Date.now() - 15 * 60000 - 1);
  await signIn(); assert.equal(database.prepare('SELECT count(*) AS n FROM local_auth_attempts').get().n, 0);
});

test('concurrent wrong guesses cannot consume more than ten accepted failure attempts', async () => {
  const results = await Promise.allSettled(Array.from({ length: 15 }, () => auth.signInLocal(request('/api/local-auth/sign-in', { method: 'POST', body: { username: 'chef', password: 'incorrect-password' } }))));
  assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.status === 401).length, 10);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'LAN_SIGN_IN_THROTTLED').length, 5);
  assert.equal(database.prepare('SELECT failures FROM local_auth_attempts').get().failures, 10);
});

test('malformed or oversized sign-in bodies fail without creating a session', async () => {
  for (const body of ['broken', '[]', '{}'.repeat(1100)]) await assert.rejects(auth.signInLocal(request('/api/local-auth/sign-in', { method: 'POST', body })), error => [400, 413].includes(error.status));
  await assert.rejects(auth.signInLocal(request('/api/local-auth/sign-in', { method: 'POST', body: { username: 'chef', password, remember: 'yes' } })), error => error.status === 400);
  await assert.rejects(auth.signInLocal(request('/api/local-auth/sign-in', { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })), error => error.status === 415);
  assert.equal(database.prepare('SELECT count(*) AS n FROM local_auth_sessions').get().n, 0);
});

test('revocation between validation and atomic insert or update prevents in-flight kitchen writes', async () => {
  for (const revision of [0, 1]) {
    const login = await signIn(), context = await household.requireHousehold(request('/api/kitchen', { headers: scopedHeaders(login) }));
    const state = structuredClone(types.EMPTY_KITCHEN);
    database.exec('DELETE FROM kitchen_state');
    if (revision) database.prepare('INSERT INTO kitchen_state(id,state_json,revision,updated_at) VALUES(?,?,?,?)').run('local-household', JSON.stringify(state), 1, new Date().toISOString());
    let intercepted = false;
    runtime.beforeStatement(sql => {
      if (!intercepted && /^(INSERT INTO kitchen_state|UPDATE kitchen_state)/.test(sql.trim())) {
        intercepted = true; database.prepare('DELETE FROM local_auth_sessions WHERE id=?').run(login.session.localAccess.sessionId);
      }
    });
    await assert.rejects(store.saveKitchenDocument(revision, { ...state, pantry: [{ id: 'rice', name: 'rice', measure: '500 g' }] }, context), error => error.code === 'LAN_SIGN_IN_REQUIRED');
    assert.equal(intercepted, true);
    assert.equal(database.prepare('SELECT revision FROM kitchen_state').get()?.revision ?? 0, revision);
    runtime.beforeStatement(undefined);
  }
});

test('missing migrations fail with actionable guidance while hosted and plain local routes remain separate', async () => {
  database.exec('ALTER TABLE local_auth_sessions RENAME TO hidden_sessions');
  try { await assert.rejects(auth.localSessionResponse(request('/api/session')), error => error.code === 'LAN_AUTH_MIGRATION_REQUIRED'); }
  finally { database.exec('ALTER TABLE hidden_sessions RENAME TO local_auth_sessions'); }
  household.configureHouseholdRuntime({ ...settings, RAG_CHEF_HOSTED: '1' });
  await assert.rejects(auth.signInLocal(request('/api/local-auth/sign-in', { method: 'POST', body: {} })), error => error.status === 404);
});


test('authenticated local setup permits only original starters and retains the catalog administrator boundary', async () => {
  const login = await signIn();
  const demo = (headers = scopedHeaders(login)) => request('/api/admin/catalog/demo', { method: 'POST', headers });
  assert.equal(await runtime.catalog.authorizeCatalogRequest(demo()), null);
  assert.equal((await runtime.catalog.authorizeCatalogRequest(demo({}))).status, 401);
  assert.equal((await runtime.catalog.authorizeCatalogRequest(demo({ ...scopedHeaders(login), origin: 'https://evil.test' }))).status, 403);
  assert.equal((await runtime.catalog.authorizeCatalogRequest(demo({ ...scopedHeaders(login), 'x-rag-chef-session': 'obsolete' }))).status, 403);
  const previous = process.env.CATALOG_ADMIN_TOKEN;
  delete process.env.CATALOG_ADMIN_TOKEN;
  try {
    for (const path of ['/api/admin/catalog', '/api/admin/recipes/import', '/api/admin/recipes/metadata', '/api/admin/catalog/demo/extra']) {
      assert.equal((await runtime.catalog.authorizeCatalogRequest(request(path, { method: 'POST', headers: scopedHeaders(login) }))).status, 503);
    }
  } finally { if (previous === undefined) delete process.env.CATALOG_ADMIN_TOKEN; else process.env.CATALOG_ADMIN_TOKEN = previous; }
  await auth.signOutLocal(request('/api/local-auth/sign-out', { method: 'POST', headers: scopedHeaders(login) }));
  assert.equal((await runtime.catalog.authorizeCatalogRequest(demo())).status, 401);
});

test('expiration while the atomic kitchen statement is queued prevents inserts and updates', async () => {
  for (const revision of [0, 1]) {
    const login = await signIn(), context = await household.requireHousehold(request('/api/kitchen', { headers: scopedHeaders(login) }));
    const state = structuredClone(types.EMPTY_KITCHEN);
    database.exec('DELETE FROM kitchen_state');
    if (revision) database.prepare('INSERT INTO kitchen_state(id,state_json,revision,updated_at) VALUES(?,?,?,?)').run('local-household', JSON.stringify(state), 1, new Date().toISOString());
    let intercepted = false;
    runtime.beforeStatement(sql => {
      if (!intercepted && /^(INSERT INTO kitchen_state|UPDATE kitchen_state)/.test(sql.trim())) {
        intercepted = true;
        // Validation and statement binding have finished. Model a session
        // expiring while D1 queues this write, without changing Date.now().
        database.prepare('UPDATE local_auth_sessions SET expires_at=? WHERE id=?').run(Date.now() + 20, login.session.localAccess.sessionId);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
      }
    });
    try {
      await assert.rejects(store.saveKitchenDocument(revision, { ...state, pantry: [{ id: 'rice', name: 'rice', measure: '500 g' }] }, context), error => error.code === 'LAN_SIGN_IN_REQUIRED');
      assert.equal(intercepted, true);
      assert.equal(database.prepare('SELECT revision FROM kitchen_state').get()?.revision ?? 0, revision);
    } finally { runtime.beforeStatement(undefined); }
  }
});

test('a parallel batch cannot test a correct password after ten reserved guesses', { timeout: 5000 }, async () => {
  const digest = crypto.subtle.digest;
  const checked = [];
  let releaseComparisons, tenStarted, correctStarted;
  const hold = new Promise(resolve => { releaseComparisons = resolve; });
  const tenChecks = new Promise(resolve => { tenStarted = resolve; });
  const correctCheck = new Promise(resolve => { correctStarted = resolve; });
  crypto.subtle.digest = function (algorithm, input) {
    const text = new TextDecoder().decode(input);
    if (!text.startsWith('chef:')) return digest.call(this, algorithm, input);
    checked.push(text);
    if (checked.length === 10) tenStarted();
    if (text === `chef:${password}`) correctStarted();
    return hold.then(() => digest.call(this, algorithm, input));
  };
  try {
    const wrong = Promise.allSettled(Array.from({ length: 20 }, (_, index) => auth.signInLocal(request('/api/local-auth/sign-in', { method: 'POST', body: { username: 'chef', password: `incorrect-password-${index}` } }))));
    await tenChecks;
    // The first ten comparisons are still in flight. A later correct guess
    // must be throttled before its password is evaluated, not accepted later.
    const correct = Promise.allSettled([auth.signInLocal(request('/api/local-auth/sign-in', { method: 'POST', body: { username: 'chef', password } }))]);
    await Promise.race([correct, correctCheck]);
    releaseComparisons();
    const results = [...await wrong, ...await correct];
    assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.status === 401).length, 10);
    assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'LAN_SIGN_IN_THROTTLED').length, 11);
    assert.equal(checked.length, 10, 'only reserved guesses reach the credential comparison');
    assert.equal(checked.includes(`chef:${password}`), false);
    assert.equal(database.prepare('SELECT count(*) AS n FROM local_auth_sessions').get().n, 0);
  } finally { releaseComparisons(); crypto.subtle.digest = digest; }
});

test('valid CLI checks release only their own reservation and browser success resets failures', async () => {
  const wrong = () => auth.signInLocal(request('/api/local-auth/sign-in', { method: 'POST', body: { username: 'chef', password: 'incorrect-password' } }));
  for (let index = 0; index < 9; index++) assert.equal((await wrong()).status, 401);
  const cli = request('/api/kitchen', { headers: { authorization: `Basic ${btoa(`chef:${password}`)}`, 'x-rag-chef-client': 'cli' } });
  for (let index = 0; index < 15; index++) assert.equal(await auth.verifyLocalCli(cli), true);
  assert.equal(database.prepare('SELECT failures FROM local_auth_attempts').get().failures, 9);
  await signIn();
  assert.equal(database.prepare('SELECT count(*) AS n FROM local_auth_attempts').get().n, 0);
  for (let index = 0; index < 10; index++) assert.equal((await wrong()).status, 401);
  await assert.rejects(auth.verifyLocalCli(cli), error => error.code === 'LAN_SIGN_IN_THROTTLED');
});

test('credential rotation starts a fresh attempt budget without retaining the old lockout', async () => {
  for (let index = 0; index < 10; index++) await auth.signInLocal(request('/api/local-auth/sign-in', { method: 'POST', body: { username: 'chef', password: 'incorrect-password' } }));
  const replacement = 'replacement-kitchen-password';
  household.configureHouseholdRuntime({ ...settings, RAG_CHEF_LAN_PASSWORD_SHA256: await auth.sha256(`chef:${replacement}`) });
  const response = await auth.signInLocal(request('/api/local-auth/sign-in', { method: 'POST', body: { username: 'chef', password: replacement } }));
  assert.equal(response.status, 200);
  assert.equal(database.prepare('SELECT count(*) AS n FROM local_auth_attempts').get().n, 0);
});
