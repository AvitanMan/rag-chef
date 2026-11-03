import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { fixtureSql } from '../tools/testing/fixtures.mjs';

const directory = await mkdtemp(join(tmpdir(), 'jff-catalog-apply-race-'));
const database = new DatabaseSync(':memory:');
database.exec('PRAGMA foreign_keys=ON');
for (const name of (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) database.exec(await readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
for (const name of ['household', 'kitchen-store', 'kitchen-types', 'kitchen-validation', 'quantities', 'chef-plan-http']) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), 'utf8');
  await writeFile(join(directory, `${name}.mjs`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"'));
}
await writeFile(join(directory, 'recipe-store.mjs'), 'export async function listCatalogRecipes(){throw new Error("This error-mapping test does not load recipes.");}');
const store = await import(pathToFileURL(join(directory, 'kitchen-store.mjs')));
const { planFailure } = await import(pathToFileURL(join(directory, 'chef-plan-http.mjs')));
const household = await import(pathToFileURL(join(directory, 'household.mjs')));
const { EMPTY_KITCHEN } = await import(pathToFileURL(join(directory, 'kitchen-types.mjs')));
let beforeStatement;
const binding = { prepare(sql) {
  let values = [];
  const statement = { bind(...args) { values = args; return statement; }, async first() { beforeStatement?.(sql); return database.prepare(sql).get(...values) ?? null; } };
  return statement;
} };
const context = { mode: 'hosted', userId: 'owner', householdId: 'house', role: 'owner', timezone: 'UTC', assistantEnabled: true, sessionId: 'session-owner' };
beforeEach(() => {
  beforeStatement = undefined;
  database.exec('DELETE FROM organization; DELETE FROM user; DELETE FROM kitchen_state; DELETE FROM recipes; DELETE FROM recipe_sources;');
  database.exec(fixtureSql());
  const at = new Date().toISOString();
  database.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run('owner', 'Owner', 'owner@example.test', 1, at, at);
  database.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run('session-owner', 'owner', 'token', new Date(Date.now() + 86400000).toISOString(), at, at);
  database.prepare('INSERT INTO organization(id,name,slug,createdAt) VALUES(?,?,?,?)').run('house', 'House', 'house', at);
  database.prepare('INSERT INTO household_settings(organizationId,timezone,assistantEnabled) VALUES(?,?,?)').run('house', 'UTC', 1);
  database.prepare('INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run('member', 'house', 'owner', 'owner', at);
  household.configureHouseholdRuntime({ DB: binding, RAG_CHEF_HOSTED: '0' });
});
after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });

const mutations = {
  recipe: "UPDATE recipes SET normalized_content_sha256='changed',version=version+1 WHERE id='fixture-tomato-rice'",
  metadata: "INSERT INTO recipe_metadata(recipe_id,revision,source_content_sha256,payload_json,reviewed_by,reviewed_at) SELECT id,1,normalized_content_sha256,'{}','reviewer','2026-11-04T12:00:00Z' FROM recipes WHERE id='fixture-tomato-rice'",
  source: "UPDATE recipe_sources SET approval_status='suspended' WHERE id='test-fixtures'",
};
for (const mode of ['local', 'hosted']) for (const revision of [0, 1]) for (const [kind, mutation] of Object.entries(mutations)) {
  test(`${mode} Apply revision ${revision} rejects a ${kind} change immediately before its SQL commit`, async () => {
    household.configureHouseholdRuntime({ DB: binding, RAG_CHEF_HOSTED: mode === 'hosted' ? '1' : '0' });
    const actor = mode === 'hosted' ? context : undefined;
    if (revision) await store.saveKitchenDocument(0, structuredClone(EMPTY_KITCHEN), actor);
    const before = await store.getKitchenDocument(actor);
    const catalogRevision = await store.readCatalogRevision();
    // Simulate the admin transaction winning after Apply validates its source
    // records, but immediately before its final kitchen INSERT/UPDATE executes.
    beforeStatement = sql => {
      if (/^(?:INSERT INTO|UPDATE) kitchen_state/.test(sql)) { beforeStatement = undefined; database.exec(mutation); }
    };
    await assert.rejects(store.saveKitchenDocument(revision, { ...EMPTY_KITCHEN, pantry: [{ id: 'rice', name: 'rice', measure: '200 g' }] }, actor, { catalogRevision }), error => error.status === 409 && error.code === 'catalog_changed');
    assert.deepEqual(await store.getKitchenDocument(actor), before);
  });
}

test('an unchanged catalog permits Apply, while repeat submission keeps ordinary revision protection', async () => {
  const catalogRevision = await store.readCatalogRevision();
  const saved = await store.saveKitchenDocument(0, structuredClone(EMPTY_KITCHEN), undefined, { catalogRevision });
  assert.equal(saved.revision, 1);
  await assert.rejects(store.saveKitchenDocument(0, structuredClone(EMPTY_KITCHEN), undefined, { catalogRevision }), store.KitchenConflictError);
  assert.equal((await store.getKitchenDocument()).revision, 1);
  database.exec('BEGIN'); database.exec(mutations.recipe); database.exec('ROLLBACK');
  assert.equal(await store.readCatalogRevision(), catalogRevision, 'Rolled-back catalog mutations do not invalidate drafts');
});

test('missing catalog fence migration fails closed with an actionable setup error', async () => {
  const revision = await store.readCatalogRevision();
  database.exec('DROP TABLE recipe_catalog_revision');
  try {
    const error = await store.readCatalogRevision().catch(error => error);
    const response = planFailure(error);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'catalog_migration_required');
    assert.match(error.message, /database migrations/);
  }
  finally { database.exec(`CREATE TABLE recipe_catalog_revision(id INTEGER PRIMARY KEY NOT NULL CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0); INSERT INTO recipe_catalog_revision VALUES(1,${revision})`); }
});

test('an actual catalog CAS error reaches Apply as a review-required HTTP 409', async () => {
  const catalogRevision = await store.readCatalogRevision();
  database.exec(mutations.recipe);
  const error = await store.saveKitchenDocument(0, structuredClone(EMPTY_KITCHEN), undefined, { catalogRevision }).catch(error => error);
  assert.ok(error instanceof store.KitchenCatalogChangedError);
  const response = planFailure(error);
  assert.equal(response.status, 409);
  assert.deepEqual((await response.json()).error, { code: 'catalog_changed', message: error.message });
  assert.equal((await store.getKitchenDocument()).revision, 0);
});
