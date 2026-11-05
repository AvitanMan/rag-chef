import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Execute the real hook with controlled React effects, storage and HTTP. A
// preview must not invoke its existing persistence/recovery mutation path.
const directory = await mkdtemp(join(tmpdir(), 'jff-recovery-preview-'));
await writeFile(join(directory, 'react.mjs'), `
let slots=[], cursor=0, pending=[];
export const runtime={dirty:true,result:null,
 reset(){for(const slot of slots) slot?.cleanup?.();slots=[];pending=[];this.dirty=true;},
 render(fn){cursor=0;this.dirty=false;this.result=fn();},
 commit(){const jobs=pending;pending=[];for(const job of jobs)job();}
};
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
export const createContext=value=>({value});
export const useContext=context=>context.value;
export function useState(initial){const i=cursor++;slots[i]??={value:typeof initial==='function'?initial():initial};return[slots[i].value,value=>{const next=typeof value==='function'?value(slots[i].value):value;if(!Object.is(next,slots[i].value)){slots[i].value=next;runtime.dirty=true;}}];}
export function useRef(value){const i=cursor++;slots[i]??={value:{current:value}};return slots[i].value;}
export function useCallback(fn,deps){const i=cursor++;if(!same(slots[i]?.deps,deps))slots[i]={value:fn,deps};return slots[i].value;}
export function useEffect(fn,deps){const i=cursor++;if(!same(slots[i]?.deps,deps)){const cleanup=slots[i]?.cleanup;slots[i]={deps};pending.push(()=>{cleanup?.();slots[i].cleanup=fn();});}}
`);
for (const name of ['random-id', 'use-kitchen', 'kitchen-state', 'kitchen-types', 'quantities', 'kitchen-validation', 'kitchen-recovery', 'kitchen-change-preview', 'kitchen-merge', 'private-storage', 'app-session']) {
  const source = await readFile(new URL(`../app/lib/${name}.${name === 'app-session' ? 'tsx' : 'ts'}`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replaceAll('"react"', '"./react.mjs"').replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"');
  await writeFile(join(directory, `${name}.mjs`), code);
}
const { runtime } = await import(pathToFileURL(join(directory, 'react.mjs')));
const { useKitchen } = await import(pathToFileURL(join(directory, 'use-kitchen.mjs')));
const { buildKitchenChangePreview } = await import(pathToFileURL(join(directory, 'kitchen-change-preview.mjs')));
const { AppSessionContext } = await import(pathToFileURL(join(directory, 'app-session.mjs')));
const { DEFAULT_COOKING_PROFILE } = await import(pathToFileURL(join(directory, 'kitchen-types.mjs')));
const defaultSession = AppSessionContext.value;
const original = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document };
after(async () => { runtime.reset(); Object.assign(globalThis, original); await rm(directory, { recursive: true, force: true }); });
const state = () => ({ schemaVersion: 2, pantry: [{ id: 'rice', name: 'rice', measure: '1 kg' }], meals: {}, shoppingChecked: {}, migratedLegacy: true });
const recipe = () => ({ id: 'rice-dinner', title: 'Rice dinner', source: { name: 'Test kitchen', url: 'https://example.org/' }, sourceUrl: 'https://example.org/rice', image: null, category: 'Main', cuisine: 'Test', ingredients: [{ name: 'rice', measure: '200 g' }], instructions: ['Cook rice.'], tags: [], servings: 2 });
const meal = () => ({ id: 'meal-one', date: '2026-11-08', recipeId: 'rice-dinner', recipe: recipe(), title: 'Rice dinner', baseServings: 2, servings: 2, batches: 1, locked: false, status: 'planned', ingredientOverrides: {} });
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };

async function setup({ current = state(), candidate = state(), hosted = false, revision = 1, candidateRevision = revision } = {}) {
  runtime.reset();
  const calls = [], writes = [], timers = new Map(); let nextTimer = 0;
  const storage = () => { const values = new Map(); return { values, get length() { return values.size; }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null, setItem(key, value) { writes.push(['set', key]); values.set(key, value); }, removeItem(key) { writes.push(['remove', key]); values.delete(key); } }; };
  const local = storage(), tab = storage(), events = new EventTarget();
  const id = 'rag-chef-kitchen-v2:draft:review-candidate';
  const envelope = value => JSON.stringify({ revision: candidateRevision, state: value, dirty: true, updatedAt: '2026-11-08T12:00:00.000Z' });
  local.setItem(id, envelope(candidate));
  AppSessionContext.value = { ...defaultSession, ...(hosted ? { session: { mode: 'hosted', authenticated: true, household: { id: 'home', timezone: 'UTC', role: 'owner' } } } : {}) };
  globalThis.window = { localStorage: local, sessionStorage: tab, dispatchEvent: events.dispatchEvent.bind(events), addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id), setInterval: () => ++nextTimer };
  globalThis.document = { visibilityState: 'visible', addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
  let server = { revision, state: structuredClone(current), updatedAt: '2026-11-08T12:00:00.000Z' };
  globalThis.fetch = async (url, options = {}) => { calls.push({ url, options }); if (options.method === 'PUT') { const input = JSON.parse(options.body); server = { ...server, revision: server.revision + 1, state: input.state }; } return Response.json(server); };
  const pump = async () => { for (let index = 0; index < 16; index++) { if (runtime.dirty) { runtime.render(() => useKitchen([])); runtime.commit(); } await new Promise(setImmediate); } assert.equal(runtime.dirty, false); };
  await pump();
  return { get result() { return runtime.result; }, id, local, tab, calls, writes, pump, candidateChanged(value) { local.setItem(id, envelope(value)); }, serverChanged(value) { server = { ...server, revision: server.revision + 1, state: structuredClone(value) }; }, async tick() { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); await pump(); } };
}

test('preview shows pantry names, exact quantities, date changes, additions and removals without mutating inputs', () => {
  const before = state(); before.pantry.push({ id: 'old', name: 'milk', measure: '1 carton' });
  const after = state(); after.pantry[0] = { id: 'rice', name: 'cooked rice', measure: '500 g', useBy: '2026-11-09' }; after.pantry.push({ id: 'new', name: 'herbs', measure: '' });
  const preview = buildKitchenChangePreview(freeze(before), freeze(after));
  assert.equal(preview.rows.length, 3);
  assert.deepEqual(preview.rows.find(row => row.id === 'pantry:rice'), { id: 'pantry:rice', category: 'Pantry', label: 'cooked rice', before: 'rice · 1 kg · No use-by date', after: 'cooked rice · 500 g · Use by 2026-11-09', kind: 'changed' });
  assert.match(preview.rows.find(row => row.id === 'pantry:new').after, /Amount unknown/);
  assert.equal(preview.rows.find(row => row.id === 'pantry:old').after, null);
  assert.equal(Object.isFrozen(preview.rows[0]), true); assert.equal(Object.isFrozen(preview.rows), true);
});

test('dated dinner previews include servings, locks, ingredient overrides and changed source text', () => {
  const before = state(), after = state(); before.meals['2026-11-08'] = meal(); after.meals['2026-11-08'] = { ...meal(), servings: 4, locked: true, ingredientOverrides: { '0': '500 g' } };
  after.meals['2026-11-08'].recipe.instructions = ['Steam the rice.'];
  const preview = buildKitchenChangePreview(before, after);
  const dinner = preview.rows.find(row => row.id === 'dinner:2026-11-08');
  assert.match(dinner.before, /2 servings.*Planned.*Unlocked/); assert.match(dinner.after, /4 servings.*Locked.*rice: 500 g/);
  assert.match(preview.rows.find(row => row.id === 'dinner:2026-11-08:recipe').after, /Content changed/);
});

test('unknown-yield dinner previews retain exact fractional batches and cooked or removed status', () => {
  const before = state(), after = state();
  before.meals['2026-11-08'] = { ...meal(), baseServings: null, servings: null, batches: 0.25 };
  after.meals['2026-11-08'] = { ...before.meals['2026-11-08'], batches: 0.75, status: 'cooked' };
  const changed = buildKitchenChangePreview(before, after).rows.find(row => row.id === 'dinner:2026-11-08');
  assert.match(changed.before, /0\.25 recipe batches.*Planned/);
  assert.match(changed.after, /0\.75 recipe batches.*Cooked/);
  const removed = buildKitchenChangePreview(after, state()).rows.find(row => row.id === 'dinner:2026-11-08');
  assert.equal(removed.kind, 'removed'); assert.equal(removed.after, null);
});

test('summaries distinguish equal-count favorites and checklist changes and expose cooking preferences', () => {
  const before = { ...state(), favoriteRecipeIds: ['one'], shoppingChecked: { a: true }, cookingProfile: { ...DEFAULT_COOKING_PROFILE, allergies: ['milk'] } };
  const after = { ...state(), favoriteRecipeIds: ['two'], shoppingChecked: { b: true }, cookingProfile: { ...DEFAULT_COOKING_PROFILE, allergies: ['peanut'] } };
  const preview = buildKitchenChangePreview(before, after);
  assert.deepEqual(preview.rows.find(row => row.id === 'profile:allergies'), { id: 'profile:allergies', category: 'Cooking preferences', label: 'Allergies', before: 'milk', after: 'peanut', kind: 'changed' });
  assert.match(preview.rows.find(row => row.id === 'favorites').after, /Different recipes/);
  assert.match(preview.rows.find(row => row.id === 'shopping:checked').after, /Different items/);
  const reordered = { ...after, pantry: [...after.pantry].reverse(), cookingProfile: Object.fromEntries(Object.entries(after.cookingProfile).reverse()) };
  assert.equal(buildKitchenChangePreview(after, reordered).hasChanges, false);
});

test('opening a recovery preview makes no persistence writes or HTTP calls and applies only on confirmation', async () => {
  const candidate = state(); candidate.pantry[0].measure = '500 g';
  const h = await setup({ candidate });
  const initialWrites = h.writes.length, initialCalls = h.calls.length, initialState = structuredClone(h.result.state);
  const preview = h.result.previewRecoveryDraft(h.id); await h.pump();
  assert.ok(preview); assert.equal(Object.isFrozen(preview), true);
  assert.match(preview.changes.rows[0].before, /1 kg/); assert.match(preview.changes.rows[0].after, /500 g/);
  assert.equal(h.writes.length, initialWrites); assert.equal(h.calls.length, initialCalls); assert.deepEqual(h.result.state, initialState);
  assert.equal(h.result.recoverDraft(h.id, preview), true); await h.pump();
  assert.equal(h.result.state.pantry[0].measure, '500 g');
  await h.tick(); assert.equal(h.calls.filter(call => call.options.method === 'PUT').length, 1);
});

test('confirmation rejects a draft changed in another tab without replacing the kitchen', async () => {
  const candidate = state(); candidate.pantry[0].measure = '500 g';
  const h = await setup({ candidate }), preview = h.result.previewRecoveryDraft(h.id);
  candidate.pantry[0].measure = '250 g'; h.candidateChanged(candidate);
  const writes = h.writes.length, calls = h.calls.length;
  assert.equal(h.result.recoverDraft(h.id, preview), false); await h.pump();
  assert.equal(h.result.state.pantry[0].measure, '1 kg'); assert.equal(h.writes.length, writes); assert.equal(h.calls.length, calls);
  assert.match(h.result.status, /draft changed/);
});

test('confirmation rejects current edits and even a same-content server revision change after preview', async () => {
  const candidate = state(); candidate.pantry[0].measure = '500 g';
  const h = await setup({ candidate });
  const preview = h.result.previewRecoveryDraft(h.id);
  h.result.update(current => ({ ...current, pantry: [{ ...current.pantry[0], measure: '750 g' }] })); await h.pump();
  const writes = h.writes.length;
  assert.equal(h.result.recoverDraft(h.id, preview), false); await h.pump();
  assert.equal(h.result.state.pantry[0].measure, '750 g'); assert.equal(h.writes.length, writes);
  const fresh = await setup({ candidate });
  const nextPreview = fresh.result.previewRecoveryDraft(fresh.id);
  fresh.serverChanged(state()); await fresh.result.refreshSavedKitchen(); await fresh.pump();
  const afterRefresh = fresh.writes.length;
  assert.equal(fresh.result.recoverDraft(fresh.id, nextPreview), false); await fresh.pump();
  assert.equal(fresh.writes.length, afterRefresh); assert.match(fresh.result.status, /after this preview/);
});

test('a background refresh does not replace a recovery error, and a fresh preview clears it', async () => {
  const candidate = state(); candidate.pantry[0].measure = '500 g';
  const h = await setup({ candidate }), preview = h.result.previewRecoveryDraft(h.id);
  candidate.pantry[0].measure = '250 g'; h.candidateChanged(candidate);
  assert.equal(h.result.recoverDraft(h.id, preview), false); await h.pump();
  const error = h.result.recoveryError;
  assert.match(error, /draft changed/);
  h.serverChanged(state());
  await h.result.refreshSavedKitchen(); await h.pump();
  assert.match(h.result.status, /Kitchen refreshed/);
  assert.equal(h.result.recoveryError, error);
  assert.ok(h.result.previewRecoveryDraft(h.id)); await h.pump();
  assert.equal(h.result.recoveryError, '');
  assert.equal(h.calls.filter(call => call.options.method === 'PUT').length, 0);
});

test('hosted recovery previews show the effective retained profile, feedback and history', async () => {
  const current = { ...state(), cookingProfile: { ...DEFAULT_COOKING_PROFILE, allergies: ['milk'] },
    tastePreferences: [{ memberId: 'cook', recipeId: 'rice-dinner', preference: 'cook_again', updatedAt: '2026-11-08T12:00:00.000Z' }],
    recentActionReceipts: [{ id: 'action-current', memberId: 'cook', reviewHash: 'a'.repeat(64), appliedRevision: 1, appliedAt: '2026-11-08T12:00:00.000Z', summary: ['Plan rice dinner'] }] };
  const candidate = state(); candidate.pantry[0].measure = '250 g'; candidate.favoriteRecipeIds = ['rice-dinner'];
  candidate.tastePreferences = [{ ...current.tastePreferences[0], preference: 'less_often' }];
  candidate.recentActionReceipts = [];
  const h = await setup({ current, candidate, hosted: true }), preview = h.result.previewRecoveryDraft(h.id);
  assert.equal(preview.changes.rows.some(row => row.category === 'Cooking preferences' || row.category === 'History'), false);
  assert.equal(h.result.recoverDraft(h.id, preview), true); await h.pump();
  assert.deepEqual(h.result.state.cookingProfile, current.cookingProfile);
  assert.deepEqual(h.result.state.tastePreferences, current.tastePreferences);
  assert.deepEqual(h.result.state.recentActionReceipts, current.recentActionReceipts);
  assert.equal(h.result.recoverDraft(h.id, preview), false, 'a consumed review cannot confirm a second replacement');
});
