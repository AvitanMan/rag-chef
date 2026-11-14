import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createSourceLoader } from '../tools/testing/load-source.mjs';

const sources = await createSourceLoader({ name: 'hosted-auth' });
const database = new DatabaseSync(':memory:');
database.exec('PRAGMA foreign_keys=ON');
for (const migration of ['0001_friendly_titania.sql', '0005_households_auth.sql']) database.exec(await readFile(new URL(`../drizzle/${migration}`, import.meta.url), 'utf8'));
const authz = await sources.import('app/lib/household.ts');
const auth = await sources.import('app/lib/auth.ts');
const management = await sources.import('app/lib/household-management.ts');
const store = await sources.import('app/lib/kitchen-store.ts');
const kitchenRoute = await sources.import('app/api/kitchen/route.ts');
const { EMPTY_KITCHEN, DEFAULT_COOKING_PROFILE } = await sources.import('app/lib/kitchen-types.ts');
let beforeStatement;
const binding = {
  prepare(sql) {
    let values = [];
    const prepared = {
      bind(...args) { values = args; return prepared; },
      async first() { if (beforeStatement) beforeStatement(sql); return database.prepare(sql).get(...values) ?? null; },
      async all() { if (beforeStatement) beforeStatement(sql); const results = database.prepare(sql).all(...values); const changes = database.prepare('SELECT changes() AS n').get().n; return { success: true, results, meta: { changes } }; },
      async run() { if (beforeStatement) beforeStatement(sql); const result = database.prepare(sql).run(...values); return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
    };
    return prepared;
  },
  async batch(statements) { database.exec('BEGIN'); try { const results = []; for (const s of statements) results.push(await s.all()); database.exec('COMMIT'); return results; } catch (error) { database.exec('ROLLBACK'); throw error; } },
  async exec(sql) { database.exec(sql); return { count: 1, duration: 0 }; },
};
const secret = 'isolated-test-secret-7d9442ace3b443aca55ea515'; // gitleaks:allow -- synthetic signing key for disposable test sessions only.
const settings = { DB: binding, RAG_CHEF_HOSTED: '1', BETTER_AUTH_URL: 'https://chef.test', BETTER_AUTH_SECRET: secret, GOOGLE_CLIENT_ID: 'isolated-client', GOOGLE_CLIENT_SECRET: 'isolated-secret', HOUSEHOLD_OWNER_EMAILS: 'owner@example.test', PLATFORM_ADMIN_EMAILS: 'admin@example.test' };
const at = () => new Date().toISOString();
function seedUser(id, email = `${id}@example.test`, verified = 1) {
  database.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run(id, id, email, verified, at(), at());
  database.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run(`session-${id}`, id, `token-${id}`, new Date(Date.now() + 86400000).toISOString(), at(), at());
}
function seedHousehold(id, owner, members = []) {
  database.prepare('INSERT INTO organization(id,name,slug,createdAt) VALUES(?,?,?,?)').run(id, id, id, at());
  database.prepare('INSERT INTO household_settings(organizationId,timezone) VALUES(?,?)').run(id, 'Asia/Jerusalem');
  for (const [user, role] of [[owner, 'owner'], ...members.map(m => [m, 'member'])]) database.prepare('INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run(`member-${user}`, id, user, role, at());
}
function request(path = '/api/kitchen', user = 'owner', method = 'GET', body, origin = 'https://chef.test') {
  const token = `token-${user}`;
  const signature = createHmac('sha256', secret).update(token).digest('base64');
  return new Request(`https://chef.test${path}`, { method, headers: { cookie: `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`, ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(() => {
  beforeStatement = undefined;
  database.exec('DELETE FROM organization; DELETE FROM user; DELETE FROM kitchen_state; DELETE FROM verification');
  authz.configureHouseholdRuntime(settings);
  for (const id of ['owner', 'member', 'other', 'admin', 'invitee']) seedUser(id);
  seedHousehold('house-a', 'owner', ['member']); seedHousehold('house-b', 'other');
});
after(async () => { database.close(); await sources.dispose(); });

test('real Better Auth signed sessions select membership; unsigned, expired and unverified sessions fail', async () => {
  const context = await authz.requireHousehold(request());
  assert.equal(context.householdId, 'house-a'); assert.equal(context.role, 'owner');
  await assert.rejects(authz.requireHousehold(new Request('https://chef.test/api/kitchen')), /Sign in/);
  database.prepare('UPDATE session SET expiresAt=? WHERE userId=?').run('2020-01-01T00:00:00.000Z', 'member');
  await assert.rejects(authz.requireHousehold(request('/api/kitchen', 'member')), /Sign in/);
  database.prepare('UPDATE user SET emailVerified=0 WHERE id=?').run('other');
  await assert.rejects(authz.requireHousehold(request('/api/kitchen', 'other')), /verified/);
});

test('server household dates follow the household timezone across UTC midnight', async () => {
  const context = await authz.requireHousehold(request());
  const now = new Date('2026-11-01T23:30:00Z');
  assert.equal(authz.householdDate({ ...context, timezone: 'Asia/Jerusalem' }, now), '2026-11-02');
  assert.equal(authz.householdDate({ ...context, timezone: 'America/Los_Angeles' }, now), '2026-11-01');
});

test('hosted configuration fails closed, centralized gate denies cross-origin and separates platform admin', async () => {
  assert.equal((await authz.authorizeApplicationRequest(new Request('https://chef.test/api/recipes'))).status, 401);
  assert.equal((await authz.authorizeApplicationRequest(request('/api/kitchen', 'owner', 'PUT', {}, 'https://evil.test'))).status, 403);
  assert.equal((await authz.authorizeApplicationRequest(request('/api/admin/catalog'))).status, 403);
  const admin = request('/api/admin/catalog', 'admin'); assert.equal(await authz.authorizeApplicationRequest(admin), null); assert.equal(authz.isPlatformAdminRequest(admin), true);
  const switched = request('/api/kitchen', 'other'); switched.headers.set('x-rag-chef-actor', 'owner'); switched.headers.set('x-rag-chef-household', 'house-a');
  await assert.rejects(authz.requireHousehold(switched), /account changed/);
  const moved = request(); moved.headers.set('x-rag-chef-household', 'house-b'); await assert.rejects(authz.requireHousehold(moved), /household changed/);
  authz.configureHouseholdRuntime({ ...settings, BETTER_AUTH_SECRET: '' });
  assert.throws(() => auth.validateHostedConfiguration(), /not configured/);
  assert.equal((await authz.authorizeApplicationRequest(request('/api/session'))).status, 503);
  authz.configureHouseholdRuntime({ ...settings, BETTER_AUTH_URL: 'ftp://localhost' });
  assert.throws(() => auth.validateHostedConfiguration(), /not configured/, 'Only HTTPS or loopback HTTP are valid authentication origins');
});

test('household kitchen isolation, atomic revision CAS, hard requirements and revoked membership', async () => {
  const owner = await authz.requireHousehold(request()), member = await authz.requireHousehold(request('/api/kitchen', 'member')), other = await authz.requireHousehold(request('/api/kitchen', 'other'));
  await assert.rejects(store.getKitchenDocument(), /context/);
  const initial = { ...structuredClone(EMPTY_KITCHEN), cookingProfile: { ...DEFAULT_COOKING_PROFILE, allergies: ['peanuts'] } };
  const saved = await store.saveKitchenDocument(0, initial, owner);
  assert.equal((await store.getKitchenDocument(other)).revision, 0);
  assert.deepEqual((await store.getKitchenDocument(member)).state.cookingProfile.allergies, ['peanuts']);
  await assert.rejects(store.saveKitchenDocument(saved.revision, { ...initial, cookingProfile: DEFAULT_COOKING_PROFILE }, member), /owner/);
  const memberSave = await store.saveKitchenDocument(saved.revision, { ...initial, pantry: [{ id: 'rice', name: 'rice', measure: '1 kg' }] }, member);
  await assert.rejects(store.saveKitchenDocument(saved.revision, initial, owner), store.KitchenConflictError);
  database.prepare('DELETE FROM member WHERE userId=?').run('member');
  await assert.rejects(store.saveKitchenDocument(memberSave.revision, initial, member), /access or settings changed/);
  assert.equal((await store.getKitchenDocument(owner)).revision, 2);
});

test('invitations are owner-only, email-bound, expiring, single-use, and enforce one household', async () => {
  await assert.rejects(management.createInvitation(request('/api/household/invitations', 'member', 'POST', { email: 'invitee@example.test' })), /owner/);
  const created = await (await management.createInvitation(request('/api/household/invitations', 'owner', 'POST', { email: 'invitee@example.test' }))).json();
  assert.ok(created.url.includes(created.invitation.id));
  await assert.rejects(management.acceptInvitation(request('/api/household/invitations/accept', 'admin', 'POST', { invitationId: created.invitation.id })), /different verified email/);
  const accepted = await management.acceptInvitation(request('/api/household/invitations/accept', 'invitee', 'POST', { invitationId: created.invitation.id }));
  assert.equal(accepted.status, 200); assert.equal((await authz.requireHousehold(request('/api/kitchen', 'invitee'))).householdId, 'house-a');
  await assert.rejects(management.acceptInvitation(request('/api/household/invitations/accept', 'invitee', 'POST', { invitationId: created.invitation.id })), /expired, used/);
  const second = await (await management.createInvitation(request('/api/household/invitations', 'other', 'POST', { email: 'invitee@example.test' }))).json();
  await assert.rejects(management.acceptInvitation(request('/api/household/invitations/accept', 'invitee', 'POST', { invitationId: second.invitation.id })), /already belongs/);
  database.prepare('UPDATE invitation SET expiresAt=? WHERE id=?').run('2020-01-01T00:00:00.000Z', second.invitation.id);
  await assert.rejects(management.acceptInvitation(request('/api/household/invitations/accept', 'invitee', 'POST', { invitationId: second.invitation.id })), /expired/);
});

test('removing a member also revokes older outstanding invitations for their email', async () => {
  const created = await (await management.createInvitation(request('/api/household/invitations', 'owner', 'POST', { email: 'member@example.test' }))).json();
  assert.equal((await management.removeMember(request('/api/household/members/member-member', 'owner', 'DELETE'), 'member-member')).status, 200);
  await assert.rejects(management.acceptInvitation(request('/api/household/invitations/accept', 'member', 'POST', { invitationId: created.invitation.id })), /expired, used/);
  assert.equal(await authz.membershipFor('member'), null);
  const renewed = await (await management.createInvitation(request('/api/household/invitations', 'owner', 'POST', { email: 'member@example.test' }))).json();
  assert.equal((await management.acceptInvitation(request('/api/household/invitations/accept', 'member', 'POST', { invitationId: renewed.invitation.id }))).status, 200);
});

test('session response is sanitized, allowlist controls creation, owner deletion removes shared kitchen', async () => {
  const session = await (await management.sessionResponse(request('/api/session'))).json();
  assert.equal(session.household.id, 'house-a'); assert.equal(session.platformAdmin, false);
  assert.ok(!JSON.stringify(session).includes('token-')); assert.ok(!JSON.stringify(session).includes(secret));
  await assert.rejects(management.createHousehold(request('/api/household', 'invitee', 'POST', { name: 'Denied' })), /not been invited/);
  await store.saveKitchenDocument(0, structuredClone(EMPTY_KITCHEN), await authz.requireHousehold(request()));
  await assert.rejects(management.deleteHousehold(request('/api/household', 'member', 'DELETE')), /owner/);
  assert.equal((await management.deleteHousehold(request('/api/household', 'owner', 'DELETE'))).status, 200);
  assert.equal(database.prepare('SELECT count(*) AS n FROM kitchen_state WHERE id=?').get('house-a').n, 0);
  assert.ok(await authz.membershipFor('other')); assert.equal(await authz.membershipFor('member'), null);
});

test('revocation during a write is rechecked inside the CAS, and removed users cannot replay old contexts', async () => {
  const owner = await authz.requireHousehold(request()), member = await authz.requireHousehold(request('/api/kitchen', 'member'));
  await store.saveKitchenDocument(0, structuredClone(EMPTY_KITCHEN), owner);
  beforeStatement = (sql) => { if (sql.startsWith('UPDATE kitchen_state')) { beforeStatement = undefined; database.prepare('DELETE FROM member WHERE userId=?').run('member'); } };
  await assert.rejects(store.saveKitchenDocument(1, { ...EMPTY_KITCHEN, pantry: [{ id: 'rice', name: 'rice', measure: '1 kg' }] }, member), /access or settings changed/);
  assert.equal((await store.getKitchenDocument(owner)).revision, 1);
});

test('allowlisted owner can create one household atomically; Google starts secure OAuth without contacting the provider', async () => {
  database.prepare('DELETE FROM organization WHERE id=?').run('house-a');
  const created = await management.createHousehold(request('/api/household', 'owner', 'POST', { name: 'Family', timezone: 'Asia/Jerusalem' }));
  assert.equal(created.status, 201);
  await assert.rejects(management.createHousehold(request('/api/household', 'owner', 'POST', { name: 'Second' })), /already belongs/);
  const response = await (await auth.getAuth()).handler(request('/api/auth/sign-in/social', 'owner', 'POST', { provider: 'google', callbackURL: '/' }));
  assert.equal(response.status, 200);
  const payload = await response.json(); assert.equal(new URL(payload.url).hostname, 'accounts.google.com');
  assert.match(response.headers.get('set-cookie'), /HttpOnly/); assert.match(response.headers.get('set-cookie'), /Secure/);
});

test('hosted PUT requires the originating tab identity and rejects stale-account writes before touching the new household', async () => {
  const body = { revision: 0, state: structuredClone(EMPTY_KITCHEN) };
  assert.equal((await kitchenRoute.PUT(request('/api/kitchen', 'owner', 'PUT', body))).status, 403);
  const switched = request('/api/kitchen', 'other', 'PUT', body);
  switched.headers.set('x-rag-chef-actor', 'owner'); switched.headers.set('x-rag-chef-household', 'house-a');
  assert.equal((await kitchenRoute.PUT(switched)).status, 403);
  assert.equal((await store.getKitchenDocument(await authz.requireHousehold(request('/api/kitchen', 'other')))).revision, 0);
  const correct = request('/api/kitchen', 'owner', 'PUT', body);
  correct.headers.set('x-rag-chef-actor', 'owner'); correct.headers.set('x-rag-chef-household', 'house-a');
  assert.equal((await kitchenRoute.PUT(correct)).status, 200);
});

test('an accidental public deployment without hosted mode cannot open the local household', async () => {
  authz.configureHouseholdRuntime({ DB: binding, RAG_CHEF_HOSTED: '0' });
  await assert.rejects(authz.requireHousehold(new Request('https://public.example/api/kitchen')), /Standalone kitchens/);
  assert.equal((await authz.authorizeApplicationRequest(new Request('https://public.example/api/session'))).status, 503);
  assert.equal((await authz.requireHousehold(new Request('http://127.0.0.1:4000/api/kitchen'))).mode, 'local');
  assert.equal(await authz.authorizeApplicationRequest(new Request('https://public.example/api/admin/catalog')), null); // The existing token boundary remains responsible for legacy administration.
});

for (const [change, sql] of [
  ['membership removal', "DELETE FROM member WHERE userId='member'"],
  ['session revocation', "DELETE FROM session WHERE userId='member'"],
  ['verified identity loss', "UPDATE user SET emailVerified=0 WHERE id='member'"],
]) test(`kitchen reads deny ${change} between authentication and document retrieval`, async () => {
  const owner = await authz.requireHousehold(request());
  await store.saveKitchenDocument(0, { ...EMPTY_KITCHEN, pantry: [{ id: 'private-stock', name: 'rice', measure: '1 kg' }] }, owner);
  let revoked = false;
  beforeStatement = query => {
    if (!revoked && query.startsWith('SELECT state_json, revision, updated_at FROM kitchen_state')) {
      revoked = true; database.exec(sql);
    }
  };
  const response = await kitchenRoute.GET(request('/api/kitchen', 'member'));
  assert.equal(revoked, true);
  assert.equal(response.status, 403);
  assert.ok(!JSON.stringify(await response.json()).includes('private-stock'));
});

test('household roster reads cannot return member details after access is revoked', async () => {
  let revoked = false;
  beforeStatement = query => {
    if (!revoked && query.startsWith('SELECT m.id,m.userId,m.role,u.name,u.email')) {
      revoked = true; database.exec("DELETE FROM member WHERE userId='member'");
    }
  };
  await assert.rejects(management.readHousehold(request('/api/household', 'member')), error => error.status === 403);
  assert.equal(revoked, true);
});

test('owner mutations recheck verified identity in the write statement', async () => {
  let revoked = false;
  beforeStatement = query => {
    if (!revoked && query.startsWith('INSERT INTO invitation')) {
      revoked = true; database.exec("UPDATE user SET emailVerified=0 WHERE id='owner'");
    }
  };
  await assert.rejects(management.createInvitation(request('/api/household/invitations', 'owner', 'POST', { email: 'invitee@example.test' })));
  assert.equal(revoked, true);
  assert.equal(database.prepare('SELECT count(*) AS n FROM invitation').get().n, 0);
});

test('household creation rechecks verified identity inside its transaction', async () => {
  database.exec("DELETE FROM organization WHERE id='house-a'");
  let revoked = false;
  beforeStatement = query => {
    if (!revoked && query.startsWith('INSERT INTO organization')) {
      revoked = true; database.exec("UPDATE user SET emailVerified=0 WHERE id='owner'");
    }
  };
  await assert.rejects(management.createHousehold(request('/api/household', 'owner', 'POST', { name: 'New household' })));
  assert.equal(revoked, true);
  assert.equal(await authz.membershipFor('owner'), null);
});
