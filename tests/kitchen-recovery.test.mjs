import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const sources = await createSourceLoader({ name: "kitchen-recovery" });
after(() => sources.dispose());
const load = name => sources.import(`app/lib/${name}.ts`);
const { compareKitchens, parseCachedKitchen, readRecoveryDrafts } = await load("kitchen-recovery");
const { KITCHEN_CACHE_KEY } = await load("kitchen-state");
const kitchen = () => ({ schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true });
const week = "2026-11-02";
const riceKey = `${week}:rice`;
const beansKey = `${week}:beans`;
const purchase = (id) => ({ id, week, at: "2026-11-02T10:00:00.000Z", items: [
  { key: riceKey, cycleId: `cycle-${id}`, pantry: { id: `stock-${id}`, name: "rice", measure: "500 g" } },
] });
const noDifferences = {
  pantryAdded: 0, pantryRemoved: 0, pantryChanged: 0,
  mealsAdded: 0, mealsRemoved: 0, mealsChanged: 0,
  shoppingChanged: 0, shoppingCyclesChanged: 0, shoppingPurchasesChanged: 0,
  favoritesChanged: 0, cookingProfileChanged: false, personalAmountsChanged: 0,
};
const storage = (records) => ({
  length: Object.keys(records).length,
  key: (index) => Object.keys(records)[index] ?? null,
  getItem: (id) => records[id] ?? null,
});
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

for (const [label, before, after, count] of [
  ["added", {}, { [riceKey]: "cycle-original" }, 1],
  ["removed", { [riceKey]: "cycle-original" }, {}, 1],
  ["changed", { [riceKey]: "cycle-original" }, { [riceKey]: "cycle-next" }, 1],
  ["moved to another key", { [riceKey]: "cycle-original" }, { [beansKey]: "cycle-original" }, 2],
  ["added, removed and changed", { [riceKey]: "cycle-original", [beansKey]: "cycle-beans" }, { [riceKey]: "cycle-next", [`${week}:oats`]: "cycle-oats" }, 3],
]) {
  test(`cycle-only comparisons count cycles ${label} by shopping key`, () => {
    const current = { ...kitchen(), shoppingCycles: before };
    const candidate = { ...kitchen(), shoppingCycles: after };
    assert.deepEqual(compareKitchens(current, candidate), { ...noDifferences, shoppingCyclesChanged: count });
    assert.deepEqual(compareKitchens(candidate, current), { ...noDifferences, shoppingCyclesChanged: count });
  });
}

test("receipt-only additions and removals are counted without live pantry or shopping changes", () => {
  const current = kitchen();
  const candidate = { ...kitchen(), shoppingPurchases: [purchase("receipt-original")] };
  assert.deepEqual(compareKitchens(current, candidate), { ...noDifferences, shoppingPurchasesChanged: 1 });
  assert.deepEqual(compareKitchens(candidate, current), { ...noDifferences, shoppingPurchasesChanged: 1 });
});

test("receipt changes are counted once per ID, including nested history-only edits", () => {
  const original = purchase("receipt-original");
  const current = { ...kitchen(), shoppingPurchases: [original] };
  for (const changed of [
    { ...original, at: "2026-11-02T11:00:00.000Z" },
    { ...original, items: [{ ...original.items[0], cycleId: "cycle-next" }] },
    { ...original, items: [{ ...original.items[0], pantry: { ...original.items[0].pantry, measure: "1 kg", useBy: "2026-11-09" } }] },
    { ...original, items: [...original.items, { key: beansKey, cycleId: "cycle-beans", pantry: { id: "stock-beans", name: "beans", measure: "2 cans" } }] },
  ]) {
    const candidate = { ...kitchen(), shoppingPurchases: [changed] };
    assert.deepEqual(compareKitchens(current, candidate), { ...noDifferences, shoppingPurchasesChanged: 1 });
    assert.deepEqual(compareKitchens(candidate, current), { ...noDifferences, shoppingPurchasesChanged: 1 });
  }
  const renamed = { ...kitchen(), shoppingPurchases: [{ ...original, id: "receipt-replacement" }] };
  assert.deepEqual(compareKitchens(current, renamed), { ...noDifferences, shoppingPurchasesChanged: 2 });
});

test("receipt totals include additions, removals and changes by ID rather than array position", () => {
  const kept = purchase("receipt-kept"), removed = purchase("receipt-removed"), changed = purchase("receipt-changed");
  const current = { ...kitchen(), shoppingPurchases: [kept, removed, changed] };
  const candidate = { ...kitchen(), shoppingPurchases: [
    { ...changed, items: [{ ...changed.items[0], pantry: { ...changed.items[0].pantry, measure: "1 kg" } }] },
    purchase("receipt-added"), kept,
  ] };
  assert.deepEqual(compareKitchens(current, candidate), { ...noDifferences, shoppingPurchasesChanged: 3 });
  assert.deepEqual(compareKitchens(candidate, current), { ...noDifferences, shoppingPurchasesChanged: 3 });
  assert.deepEqual(compareKitchens(current, { ...current, shoppingPurchases: structuredClone([changed, kept, removed]) }), noDifferences);
});

test("absent and empty history are equivalent for older kitchens", () => {
  const states = [
    kitchen(),
    { ...kitchen(), shoppingCycles: {} },
    { ...kitchen(), shoppingPurchases: [] },
    { ...kitchen(), shoppingCycles: {}, shoppingPurchases: [] },
  ].map(freeze);
  for (const current of states) for (const candidate of states) {
    assert.deepEqual(compareKitchens(current, candidate), noDifferences);
  }
  assert.equal(Object.hasOwn(states[0], "shoppingCycles"), false);
  assert.equal(Object.hasOwn(states[0], "shoppingPurchases"), false);
});

test("history counts are additive and preserve existing summary fields", () => {
  const current = { ...kitchen(), pantry: [{ id: "stock-original", name: "rice", measure: "500 g" }], shoppingChecked: { [beansKey]: false } };
  const candidate = {
    ...current, pantry: [{ ...current.pantry[0], measure: "1 kg" }],
    shoppingChecked: { [riceKey]: true }, favoriteRecipeIds: ["recipe-original"],
  };
  const expected = { ...noDifferences, pantryChanged: 1, shoppingChanged: 1, favoritesChanged: 1 };
  assert.deepEqual(compareKitchens(current, candidate), expected);
  assert.deepEqual(compareKitchens(current, { ...candidate,
    shoppingCycles: { [riceKey]: "cycle-original" }, shoppingPurchases: [purchase("receipt-original")],
  }), { ...expected, shoppingCyclesChanged: 1, shoppingPurchasesChanged: 1 });
});

for (const [label, current, candidate, differences] of [
  ["cycle-only", kitchen(), { ...kitchen(), shoppingCycles: { [riceKey]: "cycle-original" } }, { shoppingCyclesChanged: 1 }],
  ["receipt-only", kitchen(), { ...kitchen(), shoppingPurchases: [purchase("receipt-original")] }, { shoppingPurchasesChanged: 1 }],
  ["receipt-changed", { ...kitchen(), shoppingPurchases: [purchase("receipt-original")] },
    { ...kitchen(), shoppingPurchases: [{ ...purchase("receipt-original"), at: "2026-11-02T11:00:00.000Z" }] }, { shoppingPurchasesChanged: 1 }],
]) {
  test(`${label} drafts have a nonzero recovery summary and preserve their original state`, () => {
    const id = `${KITCHEN_CACHE_KEY}:draft:${label}`;
    const cached = { revision: 7, state: candidate, dirty: true, updatedAt: "2026-11-02T12:00:00.000Z", reason: "before-recovery" };
    const serialized = JSON.stringify(cached);
    const records = freeze({ [id]: serialized });
    const currentBefore = structuredClone(current), candidateBefore = structuredClone(candidate);
    freeze(current); freeze(candidate);
    const entries = readRecoveryDrafts(storage(records), current);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], { serialized, cached, summary: {
      id, revision: cached.revision, updatedAt: cached.updatedAt, reason: cached.reason,
      pantryCount: 0, mealCount: 0, differences: { ...noDifferences, ...differences },
    } });
    assert.deepEqual(current, currentBefore);
    assert.deepEqual(candidate, candidateBefore);
    assert.equal(records[id], serialized);
  });
}

test("comparing and reading recovery history never mutates inputs or regenerates original IDs", () => {
  const receipt = purchase("receipt-original");
  const current = { ...kitchen(), shoppingCycles: { [riceKey]: receipt.items[0].cycleId }, shoppingPurchases: [receipt] };
  const candidate = structuredClone(current);
  candidate.shoppingCycles[riceKey] = "cycle-next";
  candidate.shoppingPurchases.unshift(purchase("receipt-next"));
  const currentBefore = structuredClone(current), candidateBefore = structuredClone(candidate);
  freeze(current); freeze(candidate);
  assert.deepEqual(compareKitchens(current, candidate), { ...noDifferences, shoppingCyclesChanged: 1, shoppingPurchasesChanged: 1 });
  assert.deepEqual(compareKitchens(candidate, current), { ...noDifferences, shoppingCyclesChanged: 1, shoppingPurchasesChanged: 1 });
  const id = `${KITCHEN_CACHE_KEY}:draft:original-tab`;
  const serialized = JSON.stringify({ revision: 7, state: candidate, dirty: true });
  const records = freeze({ [id]: serialized });
  const parsed = parseCachedKitchen(serialized);
  assert.ok(parsed);
  const entries = readRecoveryDrafts(storage(records), current);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].summary.id, id);
  assert.equal(entries[0].serialized, serialized);
  for (const state of [parsed.state, entries[0].cached.state]) {
    assert.deepEqual(state, candidateBefore);
    assert.equal(state.shoppingCycles[riceKey], "cycle-next");
    assert.deepEqual(state.shoppingPurchases.map((item) => item.id), ["receipt-next", "receipt-original"]);
    assert.deepEqual(state.shoppingPurchases.map((item) => item.items[0].cycleId), ["cycle-receipt-next", "cycle-receipt-original"]);
    assert.deepEqual(state.shoppingPurchases.map((item) => item.items[0].pantry.id), ["stock-receipt-next", "stock-receipt-original"]);
  }
  assert.deepEqual(current, currentBefore);
  assert.deepEqual(candidate, candidateBefore);
  assert.equal(records[id], serialized);
});
