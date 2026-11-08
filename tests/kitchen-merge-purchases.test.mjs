import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const directory = await mkdtemp(join(tmpdir(), "jff-merge-purchases-"));
after(() => rm(directory, { recursive: true, force: true }));
for (const name of ["random-id", "shopping-purchases", "quantities", "kitchen-types", "kitchen-state", "kitchen-validation", "kitchen-merge"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(directory, `${name}.mjs`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"'));
}
const { shoppingForWeek, applyBoughtItems, setShoppingItemBought, undoPurchase } = await import(pathToFileURL(join(directory, "shopping-purchases.mjs")));
const { createPlannedMeal } = await import(pathToFileURL(join(directory, "kitchen-state.mjs")));
const { validateKitchenWrite } = await import(pathToFileURL(join(directory, "kitchen-validation.mjs")));
const { mergeKitchenDraft } = await import(pathToFileURL(join(directory, "kitchen-merge.mjs")));
const week = "2026-10-26", today = "2026-10-27", at = "2026-10-27T12:00:00.000Z";
const recipe = { id: "test:rice", title: "Rice", image: null, category: "", cuisine: "", tags: [], ingredients: ["rice", "onion", "carrot"].map(name => ({ name, measure: "200 g" })), instructions: ["Cook."], source: { name: "Test", url: "https://example.com/rice" }, sourceUrl: "https://example.com/rice" };
function kitchen(legacy = false) {
  let state = { schemaVersion: 2, pantry: [], meals: { [today]: createPlannedMeal(today, recipe) }, shoppingChecked: {}, migratedLegacy: true };
  for (const item of shoppingForWeek(state, week, today)) state = setShoppingItemBought(state, item.key, true, "cycle");
  if (legacy) delete state.shoppingCycles;
  return state;
}
function buy(state, names, id, receiptId = id) {
  const drafts = shoppingForWeek(state, week, today).filter(item => names.includes(item.name)).map(item => ({ key: item.key, cycleId: state.shoppingCycles?.[item.key], name: item.name, measure: item.measure, pantryId: `${id}-${item.name}` }));
  assert.equal(drafts.length, names.length);
  const result = applyBoughtItems(state, week, today, drafts, receiptId, at);
  assert.notEqual(result, state);
  validateKitchenWrite({ revision: 0, state: result });
  return result;
}
function merge(base, browser, saved, prefer) {
  const before = structuredClone([base, browser, saved]);
  const result = mergeKitchenDraft(base, browser, saved, prefer);
  assert.deepEqual([base, browser, saved], before, "inputs unchanged");
  validateKitchenWrite({ revision: 0, state: result.state });
  return result;
}
for (const prefer of [false, true]) {
  for (const legacy of [false, true]) {
    for (const sameReceipt of [false, true]) test(`overlapping purchase items: browser=${prefer}, legacy=${legacy}, shared receipt=${sameReceipt}`, () => {
      const base = kitchen(legacy);
      const browser = buy(base, ["rice", "onion"], "browser", sameReceipt ? "shared" : "browser");
      const saved = buy(base, ["rice", "carrot"], "saved", sameReceipt ? "shared" : "saved");
      browser.pantry = browser.pantry.map(stock => stock.name === "onion" ? { ...stock, measure: "150 g" } : stock);
      const { state, conflicts } = merge(base, browser, saved, prefer);
      assert.ok(conflicts.some(conflict => conflict.path.startsWith("Purchase cycle.")));
      assert.deepEqual(state.pantry.map(stock => stock.id).sort(), ["browser-onion", "saved-carrot", `${prefer ? "browser" : "saved"}-rice`].sort());
      assert.equal(state.pantry.find(stock => stock.name === "onion").measure, "150 g");
      assert.equal(state.shoppingPurchases.flatMap(receipt => receipt.items).length, 3);
    });
  }
  test(`winning consumed or edited stock is not restored: browser=${prefer}`, () => {
    for (const measure of [null, "0 g", "50 g"]) {
      const base = kitchen(), browser = buy(base, ["rice"], "browser"), saved = buy(base, ["rice"], "saved");
      const winner = prefer ? browser : saved;
      winner.pantry = measure === null ? [] : winner.pantry.map(stock => ({ ...stock, measure }));
      const { state } = merge(base, browser, saved, prefer);
      assert.deepEqual(state.pantry, winner.pantry);
      assert.equal(state.shoppingPurchases.length, 1);
    }
  });
  test(`base history consumption and undo: browser=${prefer}`, () => {
    const base = buy(kitchen(), ["rice"], "historical");
    const consumed = { ...base, pantry: [] };
    assert.deepEqual(merge(base, base, consumed, prefer).state.pantry, []);
    assert.deepEqual(merge(base, consumed, base, prefer).state.pantry, []);
    const undone = undoPurchase(base, "historical");
    assert.deepEqual(merge(base, base, undone, prefer).state.shoppingPurchases, []);
    const edited = { ...base, pantry: base.pantry.map(stock => ({ ...stock, measure: "50 g" })) };
    const result = merge(base, edited, undone, prefer);
    assert.ok(result.conflicts.length);
    assert.deepEqual(result.state.pantry, prefer ? edited.pantry : []);
    assert.equal(result.state.shoppingPurchases.length, prefer ? 1 : 0);
  });
  test(`independent cycles and legacy history survive: browser=${prefer}`, () => {
    const base = buy(kitchen(true), ["rice"], "legacy");
    const consumed = { ...base, pantry: [] };
    const key = base.shoppingPurchases[0].items[0].key;
    const next = cycle => setShoppingItemBought(setShoppingItemBought(consumed, key, false, "ignored"), key, true, cycle);
    const browser = buy(next("browser-cycle"), ["rice"], "browser");
    const saved = buy(next("saved-cycle"), ["rice"], "saved");
    const { state } = merge(base, browser, saved, prefer);
    assert.equal(state.shoppingPurchases.length, 3);
    assert.deepEqual(state.pantry.map(stock => stock.id).sort(), ["browser-rice", "saved-rice"]);
  });
}

test("shared receipt history retains independent item edits and additions", () => {
  const base = buy(kitchen(), ["rice", "onion"], "history");
  const browser = structuredClone(base), saved = buy(structuredClone(base), ["carrot"], "later");
  browser.pantry = browser.pantry.map(stock => stock.name === "rice" ? { ...stock, measure: "50 g" } : stock);
  saved.pantry = saved.pantry.map(stock => stock.name === "onion" ? { ...stock, measure: "75 g" } : stock);
  for (const prefer of [false, true]) {
    const { state, conflicts } = merge(base, browser, saved, prefer);
    assert.deepEqual(conflicts, []);
    assert.equal(state.shoppingPurchases.length, 2);
    assert.equal(state.pantry.find(stock => stock.name === "rice").measure, "50 g");
    assert.equal(state.pantry.find(stock => stock.name === "onion").measure, "75 g");
  }
});

test("undo-and-replace conflicts with consumed base stock as one purchase", () => {
  const base = buy(kitchen(), ["rice"], "history");
  const browser = buy(undoPurchase(base, "history"), ["rice"], "replacement");
  const saved = { ...base, pantry: [] };
  for (const prefer of [false, true]) {
    const { state, conflicts } = merge(base, browser, saved, prefer);
    assert.ok(conflicts.length);
    assert.deepEqual(state.pantry, prefer ? browser.pantry : []);
    assert.deepEqual(state.shoppingPurchases, prefer ? browser.shoppingPurchases : saved.shoppingPurchases);
  }
});

test("recovery without a base resolves semantic duplicates without restoring stock", () => {
  const browser = buy(kitchen(), ["rice", "onion"], "browser");
  const saved = buy(kitchen(), ["rice", "carrot"], "saved");
  saved.pantry = saved.pantry.filter(stock => stock.name !== "rice");
  for (const prefer of [false, true]) {
    const { state, conflicts } = merge(null, browser, saved, prefer);
    assert.ok(conflicts.length);
    assert.equal(state.pantry.filter(stock => stock.name === "rice").length, prefer ? 1 : 0);
    assert.ok(state.pantry.some(stock => stock.name === "onion"));
    assert.ok(state.pantry.some(stock => stock.name === "carrot"));
    assert.equal(state.shoppingPurchases.flatMap(receipt => receipt.items).length, 3);
  }
});

test("ambiguous reused stock identity fails closed", () => {
  const base = kitchen(), browser = buy(base, ["rice"], "browser"), saved = buy(base, ["carrot"], "saved");
  saved.shoppingPurchases[0].items[0].pantry.id = "browser-rice";
  saved.pantry[0].id = "browser-rice";
  assert.throws(() => mergeKitchenDraft(base, browser, saved), /shared by different purchases/);
  const detached = { ...browser, shoppingPurchases: [] };
  assert.throws(() => mergeKitchenDraft(base, browser, detached), /detached/);
});

test("saved locked/cooked dinners and server receipts remain protected", () => {
  for (const patch of [{ locked: true }, { status: "cooked" }]) {
    const base = kitchen(), browser = structuredClone(base), saved = structuredClone(base);
    browser.meals = {};
    Object.assign(saved.meals[today], patch);
    saved.recentActionReceipts = [];
    const result = mergeKitchenDraft(base, browser, saved, true);
    assert.deepEqual(result.state.meals[today], saved.meals[today]);
    assert.equal(result.state.recentActionReceipts, saved.recentActionReceipts);
  }
});
