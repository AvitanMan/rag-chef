import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const sources = await createSourceLoader({ name: "kitchen-merge" });
after(() => sources.dispose());
const { combineKitchenEdits } = await sources.import("app/lib/kitchen-merge.ts");
const { DEFAULT_COOKING_PROFILE, EMPTY_KITCHEN } = await sources.import("app/lib/kitchen-types.ts");
const week = "2026-11-16", at = "2026-11-16T13:00:00.000Z";
const riceKey = week + ":rice", beansKey = week + ":beans";
const empty = () => structuredClone(EMPTY_KITCHEN);
const stock = (id, name = "rice", measure = "100 g") => ({ id, name, measure });

function recordPurchase(state, receiptId, batch, key = riceKey, cycleId) {
  const item = { key, ...(cycleId ? { cycleId } : {}), pantry: structuredClone(batch) };
  return { ...state, pantry: [...state.pantry, batch],
    shoppingPurchases: [...(state.shoppingPurchases ?? []), { id: receiptId, week, at, items: [item] }] };
}

function dinner(date, completion) {
  return { id: "dinner-" + date, date, title: "Rice", recipeId: "rice", recipe: null, servings: 2, baseServings: 2, batches: 1,
    locked: false, ingredientOverrides: {}, status: completion ? "cooked" : "planned", ...(completion ? { completion } : {}) };
}

function cooked(date, id) {
  return dinner(date, { id: "cooked-" + date, at, deductions: [{ pantryId: id, name: "rice", before: "100 g", after: "50 g" }] });
}

function merge(base, draft, saved, canEditProfile = true) {
  const result = combineKitchenEdits(base, draft, saved, canEditProfile);
  assert.ok(result.state, result.reason);
  return result.state;
}

function blocked(base, draft, saved, canEditProfile = true) {
  const original = structuredClone([base, draft, saved]);
  const result = combineKitchenEdits(base, draft, saved, canEditProfile);
  assert.ok(result.reason);
  assert.equal(result.state, undefined);
  assert.deepEqual([base, draft, saved], original);
}

test("independent pantry, plan, shopping, favorite and recipe amount changes combine in saved order", () => {
  const base = empty();
  base.pantry = [stock("a"), stock("b")];
  base.favoriteRecipeIds = ["remove", "keep"];
  const draft = structuredClone(base), saved = structuredClone(base);
  draft.pantry.shift();
  draft.pantry.push(stock("c"));
  saved.pantry[1].location = "freezer";
  saved.pantry.push(stock("d"));
  draft.favoriteRecipeIds = ["keep", "draft"];
  saved.favoriteRecipeIds.push("remote");
  draft.meals[week] = dinner(week);
  draft.shoppingChecked[riceKey] = true;
  saved.shoppingChecked[beansKey] = true;
  saved.shoppingCycles = { [beansKey]: "beans-cycle" };
  const amounts = { contentHash: "a".repeat(64), referenceServings: 2, amounts: [{ ingredientIndex: 0, originalName: "rice", measure: "20 g" }] };
  draft.personalRecipeAmounts = { rice: amounts };
  saved.personalRecipeAmounts = { beans: amounts };
  const before = structuredClone([base, draft, saved]);
  const merged = merge(base, draft, saved);
  assert.deepEqual(merged.pantry, [saved.pantry[1], stock("d"), stock("c")]);
  assert.deepEqual(merged.meals, draft.meals);
  assert.deepEqual(merged.favoriteRecipeIds, ["keep", "remote", "draft"]);
  assert.deepEqual(merged.personalRecipeAmounts, { beans: amounts, rice: amounts });
  assert.deepEqual(merged.shoppingChecked, { [beansKey]: true, [riceKey]: true });
  assert.deepEqual(merged.shoppingCycles, saved.shoppingCycles);
  assert.deepEqual([base, draft, saved], before);
});

test("a shared row cannot combine divergent updates or deletion versus edit", () => {
  const base = { ...empty(), pantry: [stock("original")] };
  const saved = { ...base, pantry: [stock("original", "rice", "60 g")] };
  blocked(base, { ...base, pantry: [] }, saved);
  blocked(base, { ...base, pantry: [{ ...stock("original"), location: "fridge" }] }, saved);
});

test("protected dinners and member profile changes cannot overwrite authoritative values", () => {
  for (const protectedDinner of [{ ...dinner(week), locked: true }, cooked(week, "old")]) {
    const base = { ...empty(), meals: { [week]: protectedDinner } };
    blocked(base, { ...base, meals: {} }, { ...base, pantry: [stock("x")] });
  }
  const base = empty(), draft = { ...base, cookingProfile: structuredClone(DEFAULT_COOKING_PROFILE) };
  const saved = { ...base, pantry: [stock("x")] };
  blocked(base, draft, saved, false);
  assert.deepEqual(merge(base, draft, saved, true).cookingProfile, draft.cookingProfile);
  assert.deepEqual(merge(base, saved, draft, false).cookingProfile, draft.cookingProfile);
});

test("duplicate purchases keep the saved receipt and stock IDs across different previews, including legacy cycles", () => {
  for (const cycle of [undefined, "active"]) {
    const base = empty();
    const saved = recordPurchase(base, "receipt-saved", stock("saved"), riceKey, cycle);
    const draft = recordPurchase(base, "receipt-draft", stock("local"), riceKey, cycle);
    assert.strictEqual(merge(base, draft, saved), saved);
    const withOther = recordPurchase(draft, "second", stock("beans", "beans"), beansKey);
    const combined = merge(base, withOther, saved);
    assert.deepEqual(combined.pantry.map(item => item.id), ["saved", "beans"]);
    assert.deepEqual(combined.shoppingPurchases.map(receipt => receipt.id), ["receipt-saved", "second"]);
    for (const field of ["measure", "location", "useBy", "name"]) {
      const changed = structuredClone(draft);
      changed.shoppingPurchases[0].items[0].pantry[field] = { measure: "101 g", location: "freezer", useBy: "2026-12-01", name: "brown rice" }[field];
      blocked(base, changed, saved);
    }
    for (const pantry of [[], [stock("saved", "rice", "0 g")], [{ ...stock("saved"), location: "freezer" }]]) {
      blocked(base, draft, { ...saved, pantry });
    }
  }
});

test("purchases keep edited or removed live stock and withhold Combine for undo against concurrent consumption", () => {
  const base = recordPurchase(empty(), "receipt", stock("batch"));
  const other = { ...base, favoriteRecipeIds: ["rice"] };
  const undo = { ...base, pantry: [], shoppingPurchases: [] };
  for (const pantry of [[], [stock("batch", "rice", "0 g")]]) {
    const consumed = { ...base, pantry };
    assert.deepEqual(merge(base, other, consumed).pantry, pantry);
    assert.deepEqual(merge(base, consumed, other).pantry, pantry);
    blocked(base, undo, consumed);
  }
});

test("a duplicate cannot discard a stock ID referenced by a dinner or reuse an unrelated stock or receipt ID", () => {
  const base = empty(), draft = recordPurchase(base, "local", stock("mine")), saved = recordPurchase(base, "remote", stock("theirs"));
  blocked(base, { ...draft, meals: { [week]: cooked(week, "mine") } }, saved);
  blocked(base, draft, { ...base, pantry: [stock("mine", "other")] });
  blocked(base, draft, recordPurchase(base, "remote", stock("mine", "beans"), beansKey));
  blocked(base, draft, recordPurchase(base, "local", stock("different", "beans"), beansKey));
});

test("a shopping cycle and reviewed purchase are resolved together", () => {
  const base = { ...empty(), shoppingChecked: { [riceKey]: true }, shoppingCycles: { [riceKey]: "cycle" } };
  const draft = recordPurchase(base, "added", stock("mine"), riceKey, "cycle");
  blocked(base, draft, { ...base, shoppingChecked: { [riceKey]: false } });
  blocked(base, draft, { ...base, shoppingCycles: { [riceKey]: "different" } });
  const saved = { ...base, shoppingChecked: { ...base.shoppingChecked, [beansKey]: true } };
  assert.deepEqual(merge(base, draft, saved).shoppingPurchases, draft.shoppingPurchases);
});

test("two completions consuming the same batch conflict even when the final quantities agree", () => {
  const next = "2026-11-17";
  const base = { ...empty(), meals: { [week]: dinner(week), [next]: dinner(next) }, pantry: [stock("a")] };
  const remaining = [stock("a", "rice", "50 g")];
  const draft = { ...base, pantry: remaining, meals: { ...base.meals, [week]: cooked(week, "a") } };
  const saved = { ...base, pantry: remaining, meals: { ...base.meals, [next]: cooked(next, "a") } };
  blocked(base, draft, saved);
  blocked(base, draft, { ...base, pantry: remaining });
  assert.deepEqual(merge(base, draft, { ...base, favoriteRecipeIds: ["favorite"] }).pantry, remaining);
});

test("invalid aggregate limits are caught before returning a candidate state", () => {
  const base = empty();
  const draft = { ...base, pantry: Array.from({ length: 500 }, (_, index) => stock(String(index))) };
  blocked(base, draft, { ...base, pantry: [stock("another")] });
});

test("equivalent field order and old kitchens preserve the saved shape without a write", () => {
  const base = empty();
  const draft = { ...base, pantry: [{ measure: "100 g", name: "rice", id: "stock" }] };
  const saved = { ...base, pantry: [stock("stock")] };
  assert.strictEqual(merge(base, draft, saved), saved);
  assert.strictEqual(merge(base, { ...base, shoppingPurchases: [], favoriteRecipeIds: [] }, base), base);
});

test("equal reductions cannot collapse independent subtract-usage edits on ordinary or purchased stock", () => {
  for (const base of [{ ...empty(), pantry: [stock("batch", "rice", "0.5 kg")] }, recordPurchase(empty(), "purchase", stock("batch", "rice", "0.5 kg"))]) {
    const less = { ...base, pantry: [stock("batch", "rice", "400 g")] };
    blocked(base, less, structuredClone(less));
  }
  const base = { ...empty(), pantry: [stock("a")], meals: { [week]: dinner(week) } };
  const finished = { ...base, pantry: [stock("a", "rice", "50 g")], meals: { [week]: cooked(week, "a") } };
  const saved = { ...structuredClone(finished), favoriteRecipeIds: ["rice"] };
  assert.strictEqual(merge(base, finished, saved), saved);
  blocked(base, { ...finished, pantry: [stock("a", "rice", "25 g")] }, { ...saved, pantry: [stock("a", "rice", "25 g")] });
});

test("a one-sided unlock or Undo can accompany an independent edit, preserving the dinner identity", () => {
  const locked = { ...empty(), meals: { [week]: { ...dinner(week), locked: true } } };
  const unlocked = { ...locked, meals: { [week]: dinner(week) } };
  const favorite = { ...locked, favoriteRecipeIds: ["favorite"] };
  assert.deepEqual(merge(locked, unlocked, favorite).meals, unlocked.meals);
  blocked(locked, { ...unlocked, meals: { [week]: { ...dinner(week), recipeId: "replacement" } } }, favorite);
  const finished = { ...empty(), pantry: [stock("batch", "rice", "50 g")], meals: { [week]: cooked(week, "batch") } };
  const undone = { ...finished, pantry: [stock("batch")], meals: { [week]: dinner(week) } };
  const merged = merge(finished, undone, { ...finished, favoriteRecipeIds: ["favorite"] });
  assert.deepEqual(merged.meals, undone.meals);
  assert.deepEqual(merged.pantry, undone.pantry);
  blocked(finished, { ...undone, meals: { [week]: { ...dinner(week), recipeId: "replacement" } } }, finished);
});
