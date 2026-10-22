import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Run the actual synchronization hook with controlled hook scheduling, storage,
// timers and HTTP responses. No browser or production kitchen is modified.
const dir = await mkdtemp(join(tmpdir(), "jff-kitchen-sync-"));
await writeFile(join(dir, "react.mjs"), `
let slots = [], cursor = 0, pending = [];
export const runtime = {
  dirty: true, result: null,
  reset() { for (const slot of slots) slot?.cleanup?.(); slots = []; pending = []; this.dirty = true; },
  render(fn) { cursor = 0; this.dirty = false; this.result = fn(); },
  commit() { const jobs = pending; pending = []; for (const job of jobs) job(); },
};
const same = (a,b) => a && b && a.length === b.length && a.every((v,i) => Object.is(v,b[i]));
export function useState(initial) {
  const index = cursor++;
  slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
  return [slots[index].value, value => { const next = typeof value === 'function' ? value(slots[index].value) : value; if (!Object.is(next,slots[index].value)) { slots[index].value = next; runtime.dirty = true; } }];
}
export function useRef(initial) { const index = cursor++; slots[index] ??= { value: {current:initial} }; return slots[index].value; }
export function useCallback(fn,deps) { const index = cursor++; if (!same(slots[index]?.deps,deps)) slots[index] = {value:fn,deps}; return slots[index].value; }
export function useEffect(fn,deps) {
  const index = cursor++;
  if (!same(slots[index]?.deps,deps)) { const cleanup = slots[index]?.cleanup; slots[index] = {deps}; pending.push(() => {cleanup?.(); slots[index].cleanup = fn();}); }
}
`);
for (const name of ["use-kitchen", "kitchen-state", "kitchen-types", "quantities", "kitchen-validation", "kitchen-recovery"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replaceAll('"react"', '"./react.mjs"').replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"');
  await writeFile(join(dir, `${name}.mjs`), compiled);
}
const { runtime } = await import(pathToFileURL(join(dir, "react.mjs")).href);
const { useKitchen } = await import(pathToFileURL(join(dir, "use-kitchen.mjs")).href);
const { KITCHEN_CACHE_KEY } = await import(pathToFileURL(join(dir, "kitchen-state.mjs")).href);
const old = { fetch: globalThis.fetch, window: globalThis.window, localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage };
after(async () => { runtime.reset(); Object.assign(globalThis, old); await rm(dir, { recursive: true, force: true }); });

const state = () => ({ schemaVersion: 2, pantry: [{ id: "rice", name: "rice", measure: "1 kg" }], meals: {}, shoppingChecked: {}, migratedLegacy: true });
const document = (revision = 1, value = state()) => ({ revision, state: value, updatedAt: "2026-10-20T00:00:00.000Z" });

async function setup({ cached, blocked = false, fetch, existingLocal, existingSession } = {}) {
  runtime.reset();
  const timers = new Map();
  let nextTimer = 0;
  const storage = () => ({ values: new Map(), blocked: false, get length() { return this.values.size; }, key(index) { return [...this.values.keys()][index] ?? null; }, getItem(key) { return this.values.get(key) ?? null; }, setItem(key, value) { if (this.blocked) throw new Error("storage full"); this.values.set(key, value); }, removeItem(key) { this.values.delete(key); } });
  const local = existingLocal ?? storage(), session = existingSession ?? storage();
  if (cached) local.setItem(KITCHEN_CACHE_KEY, JSON.stringify(cached));
  local.blocked = blocked;
  const events = new EventTarget();
  globalThis.localStorage = local; globalThis.sessionStorage = session;
  globalThis.window = { localStorage: local, setTimeout: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: (id) => timers.delete(id), addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
  let handler = fetch ?? (() => Response.json(document()));
  const calls = [];
  globalThis.fetch = (url, options = {}) => { calls.push({ url, options }); return handler(url, options); };
  async function pump() {
    for (let i = 0; i < 20; i++) {
      if (runtime.dirty) { runtime.render(() => useKitchen([])); runtime.commit(); }
      await new Promise(setImmediate);
    }
    assert.equal(runtime.dirty, false, "hook state settles");
  }
  const tick = async () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach((fn) => fn()); await pump(); };
  await pump();
  return { get result() { return runtime.result; }, pump, tick, calls, local, session, respond: (fn) => { handler = fn; } };
}

test("offline edits remain recoverable after the original tab closes", async () => {
  const first = await setup();
  first.respond(() => { throw new TypeError("Failed to fetch"); });
  first.result.update((current) => ({ ...current, pantry: [{ ...current.pantry[0], measure: "900 g" }] }));
  await first.pump(); await first.tick();
  const reopened = await setup({ existingLocal: first.local, fetch: () => { throw new TypeError("Failed to fetch"); } });
  assert.equal(reopened.result.state.pantry[0].measure, "1 kg");
  assert.equal(reopened.result.recoveryCandidates.length, 1);
  const candidate = reopened.result.recoveryCandidates[0];
  assert.equal(candidate.differences.pantryChanged, 1);
  assert.ok(candidate.updatedAt);
  assert.equal(reopened.result.recoverDraft(candidate.id), true);
  await reopened.pump(); await reopened.tick();
  assert.equal(reopened.result.state.pantry[0].measure, "900 g");
  assert.equal(reopened.result.saveState, "offline");
  assert.ok(reopened.local.getItem(candidate.id), "the source draft may still belong to another tab");
});

test("recovery skips malformed records and never discards a changed live draft", async () => {
  const h = await setup();
  const id = `${KITCHEN_CACHE_KEY}:draft:other-tab`;
  const draft = { revision: 1, dirty: true, state: { ...state(), pantry: [] } };
  h.local.setItem(`${KITCHEN_CACHE_KEY}:draft:damaged`, "{invalid");
  h.local.setItem(id, JSON.stringify(draft));
  const reopened = await setup({ existingLocal: h.local });
  assert.equal(reopened.result.recoveryCandidates.length, 1);
  assert.equal(reopened.result.recoveryCandidates[0].updatedAt, null, "old envelopes remain supported");
  h.local.setItem(id, JSON.stringify({ ...draft, revision: 2 }));
  assert.equal(reopened.result.discardDraft(id), false);
  assert.ok(h.local.getItem(id));
  await reopened.pump();
  assert.equal(reopened.result.discardDraft(id), true);
  assert.equal(h.local.getItem(id), null);
});

test("restore preserves the previous kitchen and uses the current CAS revision", async () => {
  const h = await setup();
  assert.equal(h.result.restoreBackup({ ...state(), pantry: [] }), true);
  await h.pump();
  const preserved = h.result.recoveryCandidates.find((entry) => entry.reason === "before-restore");
  assert.ok(preserved);
  h.respond((_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.revision, 1);
    assert.equal(body.state.pantry.length, 0);
    return Response.json({ current: document(2) }, { status: 409 });
  });
  await h.tick();
  assert.equal(h.result.saveState, "conflict");
  assert.equal(h.result.state.pantry.length, 0);
  assert.equal(h.result.conflict.state.pantry.length, 1);
  assert.ok(h.local.getItem(preserved.id));
});

test("restore works offline and refuses replacement when preservation is unavailable", async () => {
  const offline = await setup({ cached: { revision: 1, state: state(), dirty: false }, fetch: () => { throw new TypeError("Failed to fetch"); } });
  assert.equal(offline.result.restoreBackup({ ...state(), pantry: [] }), true);
  await offline.pump(); await offline.tick();
  assert.equal(offline.result.state.pantry.length, 0);
  assert.equal(offline.result.saveState, "offline");
  const blocked = await setup({ blocked: true });
  assert.equal(blocked.result.restoreBackup({ ...state(), pantry: [] }), false);
  assert.equal(blocked.result.state.pantry.length, 1);
});

test("save state distinguishes clean, pending, failed and successfully retried writes", async () => {
  const h = await setup();
  assert.equal(h.result.saveState, "saved");
  h.result.update((current) => ({ ...current, pantry: [{ ...current.pantry[0], measure: "900 g" }] }));
  await h.pump();
  assert.equal(h.result.saveState, "pending");
  let finish;
  h.respond(() => new Promise((resolve) => { finish = resolve; }));
  await h.tick();
  assert.equal(h.result.saveState, "saving");
  finish(Response.json({ error: { message: "Storage unavailable" } }, { status: 503 })); await h.pump();
  assert.equal(h.result.saveState, "error");
  assert.equal(h.result.backupAvailable, true);
  assert.match(h.result.status, /Storage unavailable/);
  h.respond((_url, options) => Response.json(document(2, JSON.parse(options.body).state)));
  h.result.retrySave(); await h.pump(); await h.tick();
  assert.equal(h.result.saveState, "saved");
  assert.equal(h.result.state.pantry[0].measure, "900 g");
});

test("offline clean kitchens reconnect with a read and do not write unchanged data", async () => {
  const h = await setup({ cached: { revision: 1, state: state(), dirty: false }, fetch: () => { throw new TypeError("Failed to fetch"); } });
  assert.equal(h.result.saveState, "offline");
  await h.tick();
  assert.equal(h.result.saveState, "offline");
  h.respond(() => Response.json(document()));
  h.result.retrySave(); await h.pump(); await h.tick();
  assert.equal(h.result.saveState, "saved");
  assert.ok(h.calls.every(({ options }) => options.method !== "PUT"));
});

test("conflicts preserve the draft until the saved version is explicitly selected", async () => {
  const h = await setup();
  h.result.update((current) => ({ ...current, pantry: [] })); await h.pump();
  h.respond(() => Response.json({ current: document(2) }, { status: 409 })); await h.tick();
  assert.equal(h.result.saveState, "conflict");
  assert.equal(h.result.state.pantry.length, 0);
  assert.equal(h.result.conflict.revision, 2);
  h.result.resolveConflict(false); await h.pump(); await h.tick();
  assert.equal(h.result.saveState, "saved");
  assert.equal(h.result.state.pantry.length, 1);
});

test("backup failures remain explicit even when the database copy is saved", async () => {
  const h = await setup({ blocked: true });
  assert.equal(h.result.saveState, "saved");
  assert.equal(h.result.backupAvailable, false);
  await h.tick();
  assert.equal(h.result.backupAvailable, false);
  assert.match(h.result.status, /backup unavailable/);
});

test("offline reconnect detects newer revisions without overwriting either version", async () => {
  const h = await setup({ cached: { revision: 1, state: state(), dirty: false }, fetch: () => { throw new TypeError("Failed to fetch"); } });
  h.respond(() => Response.json(document(2, { ...state(), pantry: [] })));
  h.result.retrySave(); await h.pump(); await h.tick();
  assert.equal(h.result.saveState, "conflict");
  assert.equal(h.result.state.pantry.length, 1);
  assert.equal(h.result.conflict.state.pantry.length, 0);
  assert.ok(h.calls.every(({ options }) => options.method !== "PUT"));
});

test("keeping a conflicted draft retries against the selected saved revision", async () => {
  const h = await setup();
  h.result.update((current) => ({ ...current, pantry: [] })); await h.pump();
  h.respond(() => Response.json({ current: document(2) }, { status: 409 })); await h.tick();
  h.respond((_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.revision, 2);
    assert.equal(request.state.pantry.length, 0);
    return Response.json(document(3, request.state));
  });
  h.result.resolveConflict(true); await h.pump(); await h.tick();
  assert.equal(h.result.saveState, "saved");
  assert.equal(h.result.conflict, null);
  assert.equal(h.result.state.pantry.length, 0);
});
