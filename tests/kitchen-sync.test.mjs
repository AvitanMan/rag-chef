import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

// Run the actual synchronization hook with controlled hook scheduling, storage,
// timers and HTTP responses. No browser or production kitchen is modified.
const sources = await createSourceLoader({ name: "kitchen-sync", externals: { react: `
let slots = [], cursor = 0, pending = [], stateUpdates = [];
export const runtime = {
  dirty: true, result: null, deferStateUpdates: false,
  reset() { for (const slot of slots) slot?.cleanup?.(); slots = []; pending = []; stateUpdates = []; this.deferStateUpdates = false; this.dirty = true; },
  render(fn) { cursor = 0; this.dirty = false; this.result = fn(); },
  commit() { const jobs = pending; pending = []; for (const job of jobs) job(); },
  replayMountEffects() { for (const slot of slots) if (slot?.effect) { slot.cleanup?.(); slot.cleanup = slot.effect(); } },
  flushStateUpdates() { const jobs = stateUpdates; stateUpdates = []; this.deferStateUpdates = false; for (const job of jobs) job(); },
};
const same = (a,b) => a && b && a.length === b.length && a.every((v,i) => Object.is(v,b[i]));
export const createContext = value => ({ value });
export const useContext = context => context.value;
export function useState(initial) {
  const index = cursor++;
  slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
  return [slots[index].value, value => {
    const apply = () => { const next = typeof value === 'function' ? value(slots[index].value) : value; if (!Object.is(next,slots[index].value)) { slots[index].value = next; runtime.dirty = true; } };
    if (runtime.deferStateUpdates && typeof value === 'function') stateUpdates.push(apply); else apply();
  }];
}
export function useRef(initial) { const index = cursor++; slots[index] ??= { value: {current:initial} }; return slots[index].value; }
export function useCallback(fn,deps) { const index = cursor++; if (!same(slots[index]?.deps,deps)) slots[index] = {value:fn,deps}; return slots[index].value; }
export function useEffect(fn,deps) {
  const index = cursor++;
  if (!same(slots[index]?.deps,deps)) { const cleanup = slots[index]?.cleanup; slots[index] = {deps, effect:fn}; pending.push(() => {cleanup?.(); slots[index].cleanup = fn();}); }
}
` } });
const { runtime } = await sources.import("react");
const { useKitchen } = await sources.import("app/lib/use-kitchen.ts");
const { AppSessionContext } = await sources.import("app/lib/app-session.tsx");
const { scopedStorage, accountStoragePrefix } = await sources.import("app/lib/private-storage.ts");
const localSessionContext = AppSessionContext.value;
const { KITCHEN_CACHE_KEY } = await sources.import("app/lib/kitchen-state.ts");
const { applyKitchenCommand } = await sources.import("app/lib/kitchen-commands.ts");
const old = { fetch: globalThis.fetch, window: globalThis.window, localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, document: globalThis.document };
after(async () => { runtime.reset(); Object.assign(globalThis, old); await sources.dispose(); });

const state = () => ({ schemaVersion: 2, pantry: [{ id: "rice", name: "rice", measure: "1 kg" }], meals: {}, shoppingChecked: {}, migratedLegacy: true });
const document = (revision = 1, value = state()) => ({ revision, state: value, updatedAt: "2026-10-20T00:00:00.000Z" });
const cookingProfile = (allergies = ["milk"]) => ({ version: 1, allergies, diet: "Vegan", dislikes: [], skillLevel: "Confident beginner", budget: "Medium", equipment: ["Stovetop"] });

async function setup({ cached, blocked = false, fetch, existingLocal, existingSession, hosted = false, role = "owner", userId = "owner", householdId = "house-a", replayMountEffects = false } = {}) {
  runtime.reset();
  const timers = new Map();
  const intervals = new Map();
  let nextTimer = 0;
  const storage = () => ({ values: new Map(), blocked: false, get length() { return this.values.size; }, key(index) { return [...this.values.keys()][index] ?? null; }, getItem(key) { return this.values.get(key) ?? null; }, setItem(key, value) { if (this.blocked) throw new Error("storage full"); this.values.set(key, value); }, removeItem(key) { this.values.delete(key); } });
  const local = existingLocal ?? storage(), session = existingSession ?? storage();
  if (cached) local.setItem(KITCHEN_CACHE_KEY, JSON.stringify(cached));
  local.blocked = blocked;
  const events = new EventTarget();
  globalThis.localStorage = local; globalThis.sessionStorage = session;
  globalThis.document = { visibilityState: "visible", addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
  globalThis.window = { localStorage: local, sessionStorage: session, dispatchEvent: events.dispatchEvent.bind(events), setTimeout: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: (id) => timers.delete(id), setInterval: fn => { const id = ++nextTimer; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id), addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
  const prefix = hosted ? accountStoragePrefix(userId, householdId) : "";
  AppSessionContext.value = hosted ? { ...localSessionContext,
    session: { mode: "hosted", authenticated: true, user: { id: userId }, household: { id: householdId, timezone: "UTC", role } },
    local: scopedStorage(() => local, prefix), tab: scopedStorage(() => session, prefix), storageKey: key => prefix + key,
  } : localSessionContext;
  let handler = fetch ?? (() => Response.json(document()));
  const calls = [];
  globalThis.fetch = (url, options = {}) => { calls.push({ url, options }); return handler(url, options); };
  let replayedEffects = false;
  async function pump() {
    for (let i = 0; i < 20; i++) {
      if (runtime.dirty) {
        runtime.render(() => useKitchen([])); runtime.commit();
        if (replayMountEffects && !replayedEffects) { replayedEffects = true; runtime.replayMountEffects(); }
      }
      await new Promise(setImmediate);
    }
    assert.equal(runtime.dirty, false, "hook state settles");
  }
  const tick = async () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach((fn) => fn()); await pump(); };
  const poll = async () => { for (const fn of intervals.values()) fn(); await pump(); };
  await pump();
  return { get result() { return runtime.result; }, pump, tick, poll, calls, local, session, prefix, privateLocal: AppSessionContext.value.local, dispatch: event => events.dispatchEvent(event), respond: (fn) => { handler = fn; } };
}

test("hosted polling refreshes clean snapshots but retains a pending stocktake as an explicit conflict", async () => {
  const h = await setup({ hosted: true });
  const latest = { ...state(), pantry: [...state().pantry, { id: "beans", name: "beans", measure: "2 kg" }] };
  h.respond(() => Response.json(document(2, latest)));
  await h.poll();
  assert.deepEqual(h.result.state, latest);
  h.result.update(current => ({ ...current, pantry: current.pantry.map(row => row.id === "rice" ? { ...row, measure: "500 g" } : row) }));
  await h.pump();
  const changed = { ...latest, pantry: latest.pantry.map(row => row.id === "rice" ? { ...row, measure: "200 g" } : row) };
  h.respond(() => Response.json(document(3, changed)));
  await h.poll();
  assert.equal(h.result.saveState, "conflict");
  assert.equal(h.result.state.pantry[0].measure, "500 g");
  assert.deepEqual(h.result.conflict.state, changed);
  await h.tick();
  assert.ok(h.calls.every(({ options }) => options.method !== "PUT"), "an overlapping stocktake never silently replaces the newer household snapshot");
});

test("a queued command survives an earlier save acknowledgement without accepting later stale commands", async () => {
  const h = await setup();
  h.result.command({ type: "ReplacePantryBatch", snapshot: h.result.state.pantry[0], replacement: { ...h.result.state.pantry[0], measure: "900 g" } });
  await h.pump();
  let acknowledge;
  h.respond((url, options) => new Promise(resolve => {
    assert.equal(url, "/api/kitchen/commands"); assert.equal(options.method, "POST");
    const command = JSON.parse(options.body);
    acknowledge = () => resolve(Response.json({ commandId: command.commandId, applied: true, replayed: false,
      document: document(2, applyKitchenCommand(state(), command, { revision: 1 })) }));
  }));
  await h.tick();
  assert.equal(h.result.saveState, "saving");
  runtime.deferStateUpdates = true;
  const snapshot = h.result.state.pantry[0];
  h.result.dispatch({ type: "ReplacePantryBatch", commandId: "queued-stocktake", expectedRevision: 1, snapshot, replacement: { ...snapshot, measure: "800 g" } });
  acknowledge(); await h.pump();
  assert.equal(h.result.getRevision(), 2);
  runtime.flushStateUpdates(); await h.pump();
  assert.equal(h.result.state.pantry[0].measure, "800 g", "an accepted edit is retained across concurrent rendering and the previous save");
  h.respond((url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(url, "/api/kitchen/commands"); assert.equal(body.expectedRevision, 2); assert.equal(body.replacement.measure, "800 g");
    return Response.json({ commandId: body.commandId, applied: true, replayed: false, document: document(3, h.result.state) });
  });
  await h.tick();
  assert.equal(h.result.saveState, "saved");
  h.result.dispatch({ type: "ReplacePantryBatch", commandId: "stale-stocktake", expectedRevision: 1, snapshot: h.result.state.pantry[0], replacement: { ...snapshot, measure: "700 g" } });
  await h.pump();
  assert.equal(h.result.state.pantry[0].measure, "800 g");
});

test("a lost command response survives reload and replays once before loading later remote edits", async () => {
  let current = document(), receipt;
  const attempts = [];
  const first = await setup({ fetch: (_url, options) => {
    if (options.method !== "POST") return Response.json(current);
    const command = JSON.parse(options.body); attempts.push(command);
    current = document(2, applyKitchenCommand(current.state, command, { revision: current.revision }));
    receipt = { commandId: command.commandId, applied: true, replayed: false, document: current };
    throw new TypeError("Failed to fetch"); // D1 committed, but the response was lost.
  } });
  first.result.command({ type: "ReplacePantryBatch", snapshot: first.result.state.pantry[0], replacement: { ...first.result.state.pantry[0], measure: "900 g" } });
  await first.pump(); await first.tick();
  assert.equal(first.result.saveState, "offline"); assert.equal(current.revision, 2);
  const draft = JSON.parse(first.local.getItem(first.session.getItem(`${KITCHEN_CACHE_KEY}:tab-draft`)));
  assert.deepEqual(draft.writeQueue.writes, [{ kind: "command", command: attempts[0], attempted: true }]);
  current = document(3, { ...current.state, pantry: [...current.state.pantry, { id: "remote", name: "beans", measure: "2 kg" }] });
  const reopened = await setup({ existingLocal: first.local, existingSession: first.session, fetch: (url, options) => {
    if (options.method !== "POST") return Response.json(current);
    assert.equal(url, "/api/kitchen/commands"); attempts.push(JSON.parse(options.body));
    assert.deepEqual(attempts[1], attempts[0]);
    return Response.json({ ...receipt, replayed: true });
  } });
  assert.notEqual(reopened.result.saveState, "conflict", "an attempted command resolves its receipt before comparing newer snapshots");
  assert.equal(reopened.result.state.pantry[0].measure, "900 g");
  await reopened.tick();
  assert.equal(attempts.length, 2); assert.equal(current.revision, 3);
  assert.equal(reopened.result.saveState, "saved"); assert.equal(reopened.result.getRevision(), 3);
  assert.deepEqual(reopened.result.state, current.state, "the old receipt cannot hide a later household edit");
  assert.ok(reopened.calls.every(({ options }) => options.method !== "PUT"));
});

test("an offline command keeps its exact persisted intent across reload before its first successful commit", async () => {
  const first = await setup(); let attempted;
  first.respond((url, options) => { assert.equal(url, "/api/kitchen/commands"); attempted = JSON.parse(options.body); throw new TypeError("Failed to fetch"); });
  first.result.command({ type: "ReplacePantryBatch", snapshot: first.result.state.pantry[0], replacement: { ...first.result.state.pantry[0], measure: "800 g" } });
  await first.pump(); await first.tick();
  const reopened = await setup({ existingLocal: first.local, existingSession: first.session, fetch: (_url, options) => {
    if (options.method !== "POST") return Response.json(document());
    const command = JSON.parse(options.body); assert.deepEqual(command, attempted);
    return Response.json({ commandId: command.commandId, applied: true, replayed: false,
      document: document(2, applyKitchenCommand(state(), command, { revision: 1 })) });
  } });
  assert.equal(reopened.result.state.pantry[0].measure, "800 g");
  await reopened.tick(); assert.equal(reopened.result.saveState, "saved");
  assert.equal(reopened.result.getRevision(), 2); assert.equal(reopened.result.state.pantry[0].measure, "800 g");
});

test("mount effect cleanup and replay preserve the original pending draft and attempted command", async () => {
  const first = await setup(); let attempted;
  first.respond((_url, options) => { attempted = JSON.parse(options.body); throw new TypeError("Failed to fetch"); });
  first.result.command({ type: "ReplacePantryBatch", snapshot: first.result.state.pantry[0], replacement: { ...first.result.state.pantry[0], measure: "900 g" } });
  await first.pump(); await first.tick();
  const originalKey = first.session.getItem(`${KITCHEN_CACHE_KEY}:tab-draft`);
  const originalDraft = first.local.getItem(originalKey);
  const pendingReads = [];
  const reopened = await setup({ existingLocal: first.local, existingSession: first.session, replayMountEffects: true,
    fetch: (url, options) => {
      assert.equal(url, "/api/kitchen"); assert.equal(options.method, undefined);
      return new Promise(resolve => pendingReads.push(resolve));
    } });
  assert.equal(reopened.result.ready, false); assert.equal(pendingReads.length, 2);
  const destination = reopened.session.getItem(`${KITCHEN_CACHE_KEY}:tab-draft`);
  assert.notEqual(destination, originalKey, "a new mount still isolates its destination from the previous tab draft");
  pendingReads[0](Response.json(document(99, { ...state(), pantry: [] })));
  pendingReads[1](Response.json(document())); await reopened.pump();
  assert.equal(reopened.result.ready, true); assert.equal(reopened.result.getRevision(), 1);
  assert.equal(reopened.result.state.pantry[0].measure, "900 g");
  assert.equal(reopened.session.getItem(`${KITCHEN_CACHE_KEY}:tab-draft`), destination);
  assert.equal(reopened.local.getItem(originalKey), originalDraft, "the source draft stays recoverable for its original tab");
  const draft = JSON.parse(reopened.local.getItem(destination));
  assert.deepEqual(draft.writeQueue.writes, [{ kind: "command", command: attempted, attempted: true }]);
  reopened.respond((url, options) => {
    assert.equal(url, "/api/kitchen/commands"); assert.deepEqual(JSON.parse(options.body), attempted);
    return Response.json({ commandId: attempted.commandId, applied: true, replayed: false,
      document: document(2, applyKitchenCommand(state(), attempted, { revision: 1 })) });
  });
  await reopened.tick();
  assert.equal(reopened.result.saveState, "saved"); assert.equal(reopened.result.state.pantry[0].measure, "900 g");
  assert.equal(reopened.calls.filter(({ options }) => options.method === "POST").length, 1);
});

test("an edit accepted while confirming a replay remains a draft when the refresh discovers another write", async () => {
  const h = await setup(); let receipt, finishRefresh;
  h.respond((_url, options) => {
    const command = JSON.parse(options.body);
    receipt = { commandId: command.commandId, applied: true, replayed: false,
      document: document(2, applyKitchenCommand(state(), command, { revision: 1 })) };
    throw new TypeError("Failed to fetch");
  });
  h.result.command({ type: "ReplacePantryBatch", snapshot: h.result.state.pantry[0], replacement: { ...h.result.state.pantry[0], measure: "900 g" } });
  await h.pump(); await h.tick();
  h.respond((_url, options) => options.method === "POST" ? Response.json({ ...receipt, replayed: true }) : new Promise(resolve => { finishRefresh = resolve; }));
  h.result.retrySave(); await h.pump(); await h.tick();
  assert.equal(typeof finishRefresh, "function"); assert.equal(h.result.getRevision(), 2);
  h.result.command({ type: "ReplacePantryBatch", snapshot: h.result.state.pantry[0], replacement: { ...h.result.state.pantry[0], measure: "800 g" } });
  await h.pump();
  const remote = document(3, { ...receipt.document.state, pantry: [...receipt.document.state.pantry, { id: "remote", name: "beans", measure: "1 kg" }] });
  finishRefresh(Response.json(remote)); await h.pump(); await h.tick();
  assert.equal(h.result.saveState, "conflict"); assert.deepEqual(h.result.conflict, remote);
  assert.equal(h.result.state.pantry[0].measure, "800 g");
  assert.equal(h.calls.filter(({ options }) => options.method === "POST").length, 2);
  const draft = JSON.parse(h.local.getItem(h.session.getItem(`${KITCHEN_CACHE_KEY}:tab-draft`)));
  assert.equal(draft.writeQueue.writes.length, 1); assert.equal(draft.writeQueue.writes[0].attempted, false);
  assert.equal(draft.writeQueue.writes[0].command.replacement.measure, "800 g");
});

test("snapshot barriers serialize with commands and retain each later intent", async () => {
  let current = document(); const requests = [];
  const h = await setup({ fetch: (url, options) => {
    if (!options.method) return Response.json(current);
    const body = JSON.parse(options.body); requests.push({ url, body });
    const revision = options.method === "POST" ? body.expectedRevision : body.revision;
    assert.equal(revision, current.revision);
    const next = options.method === "POST" ? applyKitchenCommand(current.state, body, { revision }) : body.state;
    current = document(revision + 1, next);
    return Response.json(options.method === "POST" ? { commandId: body.commandId, applied: true, replayed: false, document: current } : current);
  } });
  h.result.command({ type: "ReplacePantryBatch", snapshot: h.result.state.pantry[0], replacement: { ...h.result.state.pantry[0], measure: "900 g" } });
  await h.pump();
  h.result.update(current => ({ ...current, pantry: [...current.pantry, { id: "bulk", name: "beans", measure: "2 kg" }] }));
  await h.pump();
  h.result.command({ type: "ReplacePantryBatch", snapshot: h.result.state.pantry[0], replacement: { ...h.result.state.pantry[0], measure: "800 g" } });
  await h.pump();
  for (let i = 0; i < 3; i++) await h.tick();
  assert.deepEqual(requests.map(({ url }) => url), ["/api/kitchen/commands", "/api/kitchen", "/api/kitchen/commands"]);
  assert.equal(requests[1].body.state.pantry[0].measure, "900 g", "the snapshot cannot absorb a later command");
  assert.equal(current.revision, 4); assert.equal(h.result.saveState, "saved");
  assert.deepEqual(current.state.pantry, [{ id: "rice", name: "rice", measure: "800 g" }, { id: "bulk", name: "beans", measure: "2 kg" }]);
});

test("removal, immediate undo and a later date edit commit in order without losing the restored batch", async () => {
  const stock = { id: "rice", name: "rice", measure: "300 g", useBy: "2026-10-22" };
  let current = document(1, { ...state(), pantry: [stock] }); const committed = [];
  const h = await setup({ fetch: (url, options) => {
    if (!options.method) return Response.json(current);
    assert.equal(url, "/api/kitchen/commands"); assert.equal(options.method, "POST");
    const command = JSON.parse(options.body); assert.equal(command.expectedRevision, current.revision);
    current = document(current.revision + 1, applyKitchenCommand(current.state, command, { revision: current.revision }));
    committed.push({ type: command.type, document: current });
    return Response.json({ commandId: command.commandId, applied: true, replayed: false, document: current });
  } });
  h.result.command({ type: "RemovePantryBatch", snapshot: stock }); await h.pump();
  h.result.command({ type: "RestoreRemoved", pantry: [stock], meals: [] }); await h.pump();
  h.result.command({ type: "ReplacePantryBatch", snapshot: stock, replacement: { ...stock, useBy: "2026-10-28" } }); await h.pump();
  assert.deepEqual(h.result.state.pantry, [{ ...stock, useBy: "2026-10-28" }]);
  for (let i = 0; i < 3; i++) await h.tick();
  assert.deepEqual(committed.map(entry => entry.type), ["RemovePantryBatch", "RestoreRemoved", "ReplacePantryBatch"]);
  assert.deepEqual(committed[0].document.state.pantry, []);
  assert.deepEqual(committed[1].document.state.pantry, [stock]);
  assert.deepEqual(current.state.pantry, [{ ...stock, useBy: "2026-10-28" }]);
  assert.equal(current.revision, 4); assert.equal(h.result.saveState, "saved");
});

test("a terminal command rejection preserves the outbox without falling back to a snapshot write", async () => {
  const h = await setup();
  h.respond((_url, options) => options.method === "POST"
    ? Response.json({ error: { code: "COMMAND_ID_REUSED", message: "Command ID reused" } }, { status: 409 })
    : Response.json(document()));
  h.result.command({ type: "ReplacePantryBatch", snapshot: h.result.state.pantry[0], replacement: { ...h.result.state.pantry[0], measure: "700 g" } });
  await h.pump(); await h.tick();
  assert.equal(h.result.saveState, "conflict"); assert.equal(h.result.state.pantry[0].measure, "700 g");
  const draft = JSON.parse(h.local.getItem(h.session.getItem(`${KITCHEN_CACHE_KEY}:tab-draft`)));
  assert.equal(draft.writeQueue.writes[0].attempted, true);
  h.result.retrySave(); await h.pump(); await h.tick();
  assert.equal(h.calls.filter(({ options }) => options.method === "POST").length, 1);
  assert.ok(h.calls.every(({ options }) => options.method !== "PUT"));
});

test("a command can save to the database when browser backup storage is unavailable", async () => {
  const h = await setup({ blocked: true });
  h.respond((url, options) => {
    assert.equal(url, "/api/kitchen/commands"); assert.equal(options.method, "POST");
    const command = JSON.parse(options.body);
    return Response.json({ commandId: command.commandId, applied: true, replayed: false,
      document: document(2, applyKitchenCommand(state(), command, { revision: 1 })) });
  });
  h.result.command({ type: "ReplacePantryBatch", snapshot: h.result.state.pantry[0], replacement: { ...h.result.state.pantry[0], measure: "600 g" } });
  await h.pump();
  const warn = new Event("beforeunload", { cancelable: true }); h.dispatch(warn);
  assert.equal(warn.defaultPrevented, true);
  await h.tick();
  assert.equal(h.result.saveState, "saved"); assert.equal(h.result.getRevision(), 2);
  assert.equal(h.result.backupAvailable, false); assert.equal(h.result.recoverable, true);
  assert.equal(h.result.state.pantry[0].measure, "600 g");
  const safeToLeave = new Event("beforeunload", { cancelable: true }); h.dispatch(safeToLeave);
  assert.equal(safeToLeave.defaultPrevented, false);
});

test("hosted caches and recovery discovery ignore standalone and other household drafts", async () => {
  const seeded = await setup();
  seeded.local.setItem(`${KITCHEN_CACHE_KEY}:draft:standalone`, JSON.stringify({ revision: 1, state: state(), dirty: true }));
  const otherPrefix = accountStoragePrefix("other", "house-b");
  seeded.local.setItem(`${otherPrefix}${KITCHEN_CACHE_KEY}:draft:other`, JSON.stringify({ revision: 1, state: state(), dirty: true }));
  const h = await setup({ hosted: true, existingLocal: seeded.local });
  assert.equal(h.result.recoveryCandidates.length, 0);
  assert.ok(h.local.getItem(h.prefix + KITCHEN_CACHE_KEY));
  assert.ok(h.local.getItem(`${otherPrefix}${KITCHEN_CACHE_KEY}:draft:other`));
  h.result.update(current => ({ ...current, pantry: [] })); await h.pump();
  const keys = [...h.local.values.keys()].filter(key => key.includes(":draft:") && key.startsWith(h.prefix));
  assert.ok(keys.length > 0);
});

test("a member restoring a backup retains the household's current requirements", async () => {
  const original = { ...state(), cookingProfile: cookingProfile() };
  const h = await setup({ hosted: true, role: "member", userId: "member", fetch: () => Response.json(document(1, original)) });
  assert.equal(h.result.restoreBackup({ ...original, cookingProfile: cookingProfile([]) }), true); await h.pump();
  assert.deepEqual(h.result.state.cookingProfile.allergies, ["milk"]);
  h.respond((_url, options) => Response.json(document(2, JSON.parse(options.body).state)));
  await h.tick();
  assert.deepEqual(JSON.parse(h.calls.find(({ options }) => options.method === "PUT").options.body).state.cookingProfile.allergies, ["milk"]);
});

test("a fresh kitchen becomes ready without any recipe discovery request", async () => {
  const h = await setup({ fetch: url => {
    assert.equal(url, "/api/kitchen");
    return Response.json(document(0, null));
  } });
  assert.equal(h.result.ready, true);
  assert.deepEqual(h.result.state.pantry, []);
  assert.deepEqual(h.result.state.meals, {});
  assert.equal(h.calls.length, 1);
});

test("legacy browser preferences migrate once without overriding the authoritative kitchen profile", async () => {
  const seed = await setup();
  seed.local.setItem("rag-chef-preferences-v2", JSON.stringify({ profile: cookingProfile(), settings: { provider: "openai" } }));
  const h = await setup({ existingLocal: seed.local });
  assert.deepEqual(h.result.state.cookingProfile, cookingProfile());
  assert.equal(h.result.saveState, "pending");
  h.respond((_url, options) => Response.json(document(2, JSON.parse(options.body).state)));
  await h.tick();
  assert.equal(h.result.saveState, "saved");
  const authoritative = { ...state(), cookingProfile: cookingProfile(["rice"]) };
  const reopened = await setup({ existingLocal: h.local, fetch: () => Response.json(document(3, authoritative)) });
  assert.deepEqual(reopened.result.state.cookingProfile, authoritative.cookingProfile);
  await reopened.tick();
  assert.ok(reopened.calls.every(({ options }) => options.method !== "PUT"));
});

test("a saved-profile storage event refreshes clean tabs and preserves dirty tab conflicts", async () => {
  const original = { ...state(), cookingProfile: cookingProfile() };
  const next = document(2, { ...original, cookingProfile: cookingProfile(["rice"]) });
  const notify = h => h.dispatch(Object.assign(new Event("storage"), { key: KITCHEN_CACHE_KEY, newValue: JSON.stringify({ revision: 2, state: next.state, dirty: false }) }));
  const clean = await setup({ fetch: () => Response.json(document(1, original)) });
  clean.respond(() => Response.json(next)); notify(clean); await clean.pump();
  assert.deepEqual(clean.result.state.cookingProfile.allergies, ["rice"]);
  assert.equal(clean.result.saveState, "saved");
  assert.ok(clean.calls.every(({ options }) => options.method !== "PUT"));
  const dirty = await setup({ fetch: () => Response.json(document(1, original)) });
  dirty.result.update(current => ({ ...current, pantry: [] })); await dirty.pump();
  dirty.respond(() => Response.json(next)); notify(dirty); await dirty.pump();
  assert.equal(dirty.result.saveState, "conflict");
  assert.deepEqual(dirty.result.state.pantry, []);
  assert.deepEqual(dirty.result.state.cookingProfile.allergies, ["milk"]);
  assert.deepEqual(dirty.result.conflict.state.cookingProfile.allergies, ["rice"]);
});

test("old backup restore preserves current cooking exclusions and records a recoverable profile", async () => {
  const original = { ...state(), cookingProfile: cookingProfile() };
  const h = await setup({ fetch: () => Response.json(document(1, original)) });
  assert.equal(h.result.restoreBackup({ ...state(), pantry: [] }), true);
  await h.pump();
  assert.deepEqual(h.result.state.cookingProfile, original.cookingProfile);
  assert.ok(h.result.recoveryCandidates.some(candidate => candidate.reason === "before-restore"));
});

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
  const personalRecipeAmounts = { rice: { contentHash: "a".repeat(64), referenceServings: 4, amounts: [{ ingredientIndex: 0, originalName: "rice", measure: "300 g" }] } };
  h.result.update((current) => ({ ...current, pantry: [], personalRecipeAmounts })); await h.pump();
  h.respond(() => Response.json({ current: document(2) }, { status: 409 })); await h.tick();
  h.respond((_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.revision, 2);
    assert.equal(request.state.pantry.length, 0);
    assert.deepEqual(request.state.personalRecipeAmounts, personalRecipeAmounts);
    return Response.json(document(3, request.state));
  });
  h.result.resolveConflict(true); await h.pump(); await h.tick();
  assert.equal(h.result.saveState, "saved");
  assert.equal(h.result.conflict, null);
  assert.equal(h.result.state.pantry.length, 0);
  assert.deepEqual(h.result.state.personalRecipeAmounts, personalRecipeAmounts);
});

test("refreshing a clean tab adopts another tab's kitchen and revision without writing it back", async () => {
  const h = await setup();
  const next = document(2, { ...state(), pantry: [] });
  h.respond(() => Response.json(next));
  assert.deepEqual(await h.result.refreshSavedKitchen(), next);
  await h.pump(); await h.tick();
  assert.equal(h.result.getRevision(), 2);
  assert.deepEqual(h.result.state.pantry, []);
  assert.equal(h.result.saveState, "saved");
  assert.equal(JSON.parse(h.local.getItem(KITCHEN_CACHE_KEY)).revision, 2);
  assert.ok(h.calls.every(({ options }) => options.method !== "PUT"));
});

test("a refresh preserves edits made during its read and exposes a version conflict", async () => {
  const h = await setup();
  let finish;
  h.respond(() => new Promise((resolve) => { finish = resolve; }));
  const refreshing = h.result.refreshSavedKitchen();
  h.result.update((current) => ({ ...current, pantry: [{ ...current.pantry[0], measure: "900 g" }] }));
  await h.pump();
  finish(Response.json(document(2, { ...state(), pantry: [] })));
  assert.equal(await refreshing, null);
  await h.pump(); await h.tick();
  assert.equal(h.result.state.pantry[0].measure, "900 g");
  assert.equal(h.result.saveState, "conflict");
  assert.equal(h.result.conflict.revision, 2);
  assert.ok([...h.local.values.values()].some((value) => {
    const cached = JSON.parse(value);
    return cached.dirty && cached.state.pantry[0]?.measure === "900 g";
  }));
  assert.ok(h.calls.every(({ options }) => options.method !== "PUT"));
});

test("an unavailable refresh keeps the current kitchen and revision intact", async () => {
  const h = await setup();
  h.respond(() => { throw new TypeError("Failed to fetch"); });
  assert.equal(await h.result.refreshSavedKitchen(), null);
  await h.pump();
  assert.equal(h.result.getRevision(), 1);
  assert.deepEqual(h.result.state, state());
  assert.match(h.result.status, /could not be refreshed/);
});

test("cancelling a refresh cannot install a late kitchen snapshot", async () => {
  const h = await setup();
  let finish;
  h.respond(() => new Promise((resolve) => { finish = resolve; }));
  const controller = new AbortController();
  const refreshing = h.result.refreshSavedKitchen(controller.signal);
  controller.abort();
  finish(Response.json(document(2, { ...state(), pantry: [] })));
  assert.equal(await refreshing, null);
  await h.pump();
  assert.equal(h.result.getRevision(), 1);
  assert.deepEqual(h.result.state, state());
});

test("recoverability follows the current snapshot when both storage destinations fail", async () => {
  const h = await setup({ blocked: true });
  assert.equal(h.result.recoverable, true, "the original server snapshot is recoverable");
  h.respond(() => Response.json({ error: { message: "Unavailable" } }, { status: 503 }));
  h.result.update(current => ({ ...current, pantry: [] }));
  await h.pump(); await h.tick();
  assert.equal(h.result.recoverable, false, "an edited snapshot has neither a browser nor a server copy");
  h.respond((_url, options) => Response.json(document(2, JSON.parse(options.body).state)));
  h.result.retrySave(); await h.pump(); await h.tick();
  assert.equal(h.result.recoverable, true, "a successful server save makes the edited snapshot recoverable");
});
