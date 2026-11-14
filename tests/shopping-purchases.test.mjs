import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createSourceLoader } from "../tools/testing/load-source.mjs";
const sources = await createSourceLoader({ name: "shopping-purchases" });
after(() => sources.dispose());
const { applyKitchenCommand } = await sources.import("app/lib/kitchen-commands.ts");
const { shoppingForWeek, unappliedBoughtItems, purchaseDraftProblems, purchasePreviewProblem, applyBoughtItems, purchaseUndoProblem, undoPurchase, setShoppingItemBought, beginShoppingPurchaseCycle } = await sources.import("app/lib/shopping-purchases.ts");
const { DEFAULT_COOKING_PROFILE } = await sources.import("app/lib/kitchen-types.ts");
const { completeMeal, undoMeal } = await sources.import("app/lib/quantities.ts");
const { createPlannedMeal } = await sources.import("app/lib/kitchen-state.ts");
const { validateKitchenState } = await sources.import("app/lib/kitchen-validation.ts");
const { serializeKitchenBackup, parseKitchenBackup } = await sources.import("app/lib/kitchen-backup.ts");
const { PurchasePreview } = await sources.import("app/components/PurchasePreview.tsx");
const { DurableShoppingView } = await sources.import("app/components/WeeklyKitchenViews.tsx");
const week = "2026-10-26", today = "2026-10-27", at = "2026-10-27T12:00:00.000Z";
const recipe = { id: "test:rice", title: "Rice", image: null, category: "", cuisine: "", tags: [], ingredients: [{ name: "rice", measure: "200 g" }], instructions: ["Cook the rice."], source: { name: "Test", url: "https://example.com/rice" }, sourceUrl: "https://example.com/rice" };
function kitchen(ingredients = recipe.ingredients) {
  const meal = createPlannedMeal(today, { ...recipe, ingredients });
  return { schemaVersion: 2, pantry: [{ id: "raw", name: "rice", measure: "100 g" }, { id: "cooked", name: "cooked rice", measure: "400 g" }], meals: { [today]: meal }, shoppingChecked: {}, migratedLegacy: true };
}
function preview(state) {
  const items = shoppingForWeek(state, week, today);
  const checked = { ...state, shoppingChecked: Object.fromEntries(items.map((item) => [item.key, true])) };
  const drafts = items.map((item, index) => ({ key: item.key, name: item.name, measure: item.measure, pantryId: `purchase-stock-${index}` }));
  return { checked, drafts };
}

test("shopping checks alone do not alter stock; reviewed purchases add separate raw batches once", () => {
  const original = kitchen(), { checked, drafts } = preview(original);
  assert.deepEqual(checked.pantry, original.pantry);
  assert.equal(unappliedBoughtItems(checked, shoppingForWeek(checked, week, today)).length, 1);
  const added = applyBoughtItems(checked, week, today, drafts, "purchase", at);
  assert.deepEqual(added.pantry.slice(0, 2), original.pantry);
  assert.deepEqual(added.pantry[2], { id: "purchase-stock-0", name: "rice", measure: "100 g" });
  assert.deepEqual(shoppingForWeek(added, week, today), []);
  assert.equal(applyBoughtItems(added, week, today, drafts, "purchase", at), added);
  assert.equal(applyBoughtItems(added, week, today, drafts, "different-id", at), added);
  validateKitchenState(added);
});

test("replaying a checked key after stock is consumed cannot add the purchase again", () => {
  const { checked, drafts } = preview(kitchen());
  const added = applyBoughtItems(checked, week, today, drafts, "purchase", at);
  const used = { ...added, pantry: added.pantry.map((stock) => stock.id === "purchase-stock-0" ? { ...stock, measure: "0 g" } : stock) };
  assert.equal(shoppingForWeek(used, week, today)[0].key, drafts[0].key);
  assert.deepEqual(unappliedBoughtItems(used, shoppingForWeek(used, week, today)), []);
  assert.equal(applyBoughtItems(used, week, today, drafts, "replay", at), used);
  const restored = parseKitchenBackup(serializeKitchenBackup(used, at)).state;
  assert.equal(applyBoughtItems(restored, week, today, drafts, "replay", at), restored);
});

test("preview rejects stale totals, unchecks, duplicate rows, invalid quantities and pantry limits", () => {
  const { checked, drafts } = preview(kitchen());
  for (const state of [
    { ...checked, shoppingChecked: {} },
    { ...checked, pantry: checked.pantry.map((stock) => stock.id === "raw" ? { ...stock, measure: "150 g" } : stock) },
    { ...checked, meals: {} },
    { ...checked, pantry: Array.from({ length: 500 }, (_, i) => ({ id: `stock-${i}`, name: "salt", measure: "1 g" })) },
  ]) assert.equal(applyBoughtItems(state, week, today, drafts, "purchase", at), state);
  assert.notEqual(purchasePreviewProblem(checked, week, today, [...drafts, ...drafts]), "");
  for (const measure of ["-5 g", "1/0 cup", "0 g", "Infinity"]) assert.notEqual(purchasePreviewProblem(checked, week, today, [{ ...drafts[0], measure }]), "");
});

test("unknown amounts and incompatible units remain reviewable separate stock", () => {
  for (const measure of ["", "1 cup", "one bag"]) {
    const { checked, drafts } = preview(kitchen());
    const added = applyBoughtItems(checked, week, today, [{ ...drafts[0], measure }], "purchase", at);
    validateKitchenState(added);
    assert.equal(added.pantry[2].measure, measure);
    assert.equal(shoppingForWeek(added, week, today)[0].measure, "100 g");
    assert.equal(shoppingForWeek(added, week, today)[0].needsReview, true);
  }
});

test("undo removes only unchanged purchased rows and allows a corrected purchase", () => {
  const { checked, drafts } = preview(kitchen());
  const added = applyBoughtItems(checked, week, today, drafts, "purchase", at);
  const unrelatedEdit = { ...added, pantry: added.pantry.map((stock) => stock.id === "cooked" ? { ...stock, measure: "350 g" } : stock) };
  const undone = undoPurchase(unrelatedEdit, "purchase");
  assert.equal(undone.pantry.length, 2);
  assert.equal(undone.pantry[1].measure, "350 g");
  assert.deepEqual(undone.shoppingPurchases, []);
  assert.equal(undoPurchase(undone, "purchase"), undone);
  assert.notEqual(applyBoughtItems(undone, week, today, drafts, "corrected", at), undone);
  for (const field of [{ measure: "50 g" }, { name: "cooked rice" }, { useBy: "2026-10-30" }]) {
    const edited = { ...added, pantry: added.pantry.map((stock) => stock.id === "purchase-stock-0" ? { ...stock, ...field } : stock) };
    assert.notEqual(purchaseUndoProblem(edited, edited.shoppingPurchases[0]), "");
    assert.equal(undoPurchase(edited, "purchase"), edited);
  }
  const removed = { ...added, pantry: added.pantry.slice(0, 2) };
  assert.equal(undoPurchase(removed, "purchase"), removed);
});

test("purchase history is optional in old backups and validates duplicate identities and malformed entries", () => {
  validateKitchenState(kitchen());
  assert.equal(parseKitchenBackup(serializeKitchenBackup(kitchen(), at)).state.shoppingPurchases, undefined);
  const { checked, drafts } = preview(kitchen());
  const added = applyBoughtItems(checked, week, today, drafts, "purchase", at);
  for (const patch of [
    { at: "2026-02-30T12:00:00.000Z" }, { week: "invalid" }, { items: [] },
    { items: [added.shoppingPurchases[0].items[0], added.shoppingPurchases[0].items[0]] },
  ]) assert.throws(() => validateKitchenState({ ...added, shoppingPurchases: [{ ...added.shoppingPurchases[0], ...patch }] }));
  assert.throws(() => validateKitchenState({ ...added, shoppingPurchases: [added.shoppingPurchases[0], added.shoppingPurchases[0]] }));
});

test("a fresh shopping cycle allows the same shortage again after the earlier dinner is cooked", () => {
  const monday = week, tuesday = today;
  let state = { ...kitchen(), pantry: [], meals: { [monday]: createPlannedMeal(monday, recipe) } };
  const first = shoppingForWeek(state, week, monday)[0];
  state = setShoppingItemBought(state, first.key, true, "cycle-one");
  const firstDraft = { key: first.key, cycleId: "cycle-one", name: first.name, measure: first.measure, pantryId: "first-purchase" };
  state = applyBoughtItems(state, week, monday, [firstDraft], "receipt-one", "2026-10-26T12:00:00.000Z");
  state = completeMeal(state, monday, true, "2026-10-26T12:30:00.000Z");
  state = { ...state, meals: { ...state.meals, [tuesday]: createPlannedMeal(tuesday, recipe) } };
  const second = shoppingForWeek(state, week, tuesday)[0];
  assert.equal(second.key, first.key);
  assert.equal(state.pantry[0].measure, "0 g");
  assert.equal(applyBoughtItems(state, week, tuesday, [firstDraft], "replayed-receipt", at), state);
  state = setShoppingItemBought(state, second.key, false, "ignored");
  state = setShoppingItemBought(state, second.key, true, "cycle-two");
  assert.equal(setShoppingItemBought(state, second.key, true, "duplicate-event"), state);
  assert.equal(unappliedBoughtItems(state, [second]).length, 1);
  assert.equal(applyBoughtItems(state, week, tuesday, [firstDraft], "stale-preview", at), state);
  const secondDraft = { ...firstDraft, cycleId: "cycle-two", pantryId: "second-purchase" };
  const added = applyBoughtItems(state, week, tuesday, [secondDraft], "receipt-two", at);
  assert.deepEqual(added.pantry.map(p => p.measure), ["0 g", "200 g"]);
  assert.equal(added.shoppingPurchases.length, 2);
  assert.deepEqual(added.shoppingPurchases.map(p => p.items[0].key), [first.key, first.key]);
  validateKitchenState(added);
  const restored = parseKitchenBackup(serializeKitchenBackup(added, at)).state;
  assert.equal(applyBoughtItems(restored, week, tuesday, [secondDraft], "replayed-second", at), restored);
  const undone = undoPurchase(restored, "receipt-two");
  assert.deepEqual(undone.pantry.map(p => p.measure), ["0 g"]);
  assert.equal(undone.shoppingPurchases[0].id, "receipt-one");
});

test("an unchecked and rechecked item invalidates an open purchase preview", () => {
  const { checked, drafts } = preview(kitchen());
  const first = { ...checked, shoppingCycles: { [drafts[0].key]: "old-cycle" } };
  const staleDraft = { ...drafts[0], cycleId: "old-cycle" };
  assert.equal(purchasePreviewProblem(first, week, today, [staleDraft]), "");
  const unchecked = setShoppingItemBought(first, staleDraft.key, false, "ignored");
  const rechecked = setShoppingItemBought(unchecked, staleDraft.key, true, "new-cycle");
  assert.notEqual(purchasePreviewProblem(rechecked, week, today, [staleDraft]), "");
  assert.equal(purchasePreviewProblem(rechecked, week, today, [{ ...staleDraft, cycleId: "new-cycle" }]), "");
});

test("legacy receipts and cycle-aware receipts round-trip without weakening cycle uniqueness", () => {
  const { checked, drafts } = preview(kitchen());
  const legacy = applyBoughtItems(checked, week, today, drafts, "legacy", at);
  const used = { ...legacy, pantry: legacy.pantry.map(p => p.id === drafts[0].pantryId ? { ...p, measure: "0 g" } : p) };
  const rechecked = setShoppingItemBought(setShoppingItemBought(used, drafts[0].key, false, "ignored"), drafts[0].key, true, "new-cycle");
  const added = applyBoughtItems(rechecked, week, today, [{ ...drafts[0], cycleId: "new-cycle", pantryId: "new-batch" }], "new-receipt", at);
  assert.equal(added.shoppingPurchases.length, 2);
  validateKitchenState(added);
  assert.deepEqual(parseKitchenBackup(serializeKitchenBackup(added, at)).state, { ...added, cookingProfile: DEFAULT_COOKING_PROFILE });
  assert.throws(() => validateKitchenState({ ...added, shoppingCycles: { key: "" } }));
  assert.throws(() => validateKitchenState({ ...added, shoppingCycles: { key: 12 } }));
  const duplicate = { ...added.shoppingPurchases[1], id: "duplicate", items: [{ ...added.shoppingPurchases[1].items[0], pantry: { id: "another-stock", name: "rice", measure: "100 g" } }] };
  assert.throws(() => validateKitchenState({ ...added, shoppingPurchases: [...added.shoppingPurchases, duplicate] }));
});

test("purchase dates are optional, validated calendar dates and retained separately in stock and receipts", () => {
  const original = kitchen();
  original.pantry[0].useBy = "2026-10-30";
  const { checked, drafts } = preview(original);
  for (const useBy of [undefined, "", "2026-10-28", "2026-10-26", "2028-02-29", "0001-01-01", "9999-12-31"]) {
    const draft = { ...drafts[0], useBy };
    assert.deepEqual(purchaseDraftProblems(draft), { measure: "", useBy: "" });
    const added = applyBoughtItems(checked, week, today, [draft], "dated-purchase", at);
    assert.notEqual(added, checked);
    assert.deepEqual(added.pantry.slice(0, 2), original.pantry);
    const snapshot = added.shoppingPurchases[0].items[0].pantry;
    assert.deepEqual(added.pantry[2], snapshot);
    if (useBy) assert.equal(snapshot.useBy, useBy);
    else assert.equal(Object.hasOwn(snapshot, "useBy"), false);
    validateKitchenState(added);
    assert.deepEqual(parseKitchenBackup(serializeKitchenBackup(added, at)).state.shoppingPurchases, added.shoppingPurchases);
    const edited = { ...added, pantry: added.pantry.map(stock => stock.id === draft.pantryId ? { ...stock, useBy: "2026-11-01" } : stock) };
    assert.equal(edited.shoppingPurchases[0].items[0].pantry.useBy, useBy || undefined);
    assert.equal(undoPurchase(edited, "dated-purchase"), edited);
  }
});

test("invalid purchase dates and amounts expose field errors and block the whole purchase", () => {
  const { checked, drafts } = preview(kitchen([...recipe.ingredients, { name: "salt", measure: "1 g" }]));
  for (const useBy of ["2026-02-29", "2026-02-30", "2026-04-31", "2026-13-01", "2026-00-01", "2026-10-00", "2026-10-32", "0000-01-01", "10000-01-01", "2026-1-01", "2026-10-27T00:00:00Z", "tomorrow", " ", " 2026-10-28", "2026-10-28 ", null, 20261028]) {
    const draft = { ...drafts[1], useBy };
    const problems = purchaseDraftProblems(draft);
    assert.equal(problems.measure, "");
    assert.match(problems.useBy, /valid use-by date/);
    assert.equal(purchasePreviewProblem(checked, week, today, [drafts[0], draft]), problems.useBy);
    assert.equal(applyBoughtItems(checked, week, today, [drafts[0], draft], "invalid-date", at), checked);
  }
  for (const measure of ["0 g", "-1 g", "1/0 cup", "Infinity", "1000000001 g"]) {
    const problems = purchaseDraftProblems({ measure, useBy: "2026-02-30" });
    assert.notEqual(problems.measure, "");
    assert.notEqual(problems.useBy, "");
  }
});

test("purchase preview renders optional date fields and accessible inline amount errors", () => {
  const original = kitchen();
  original.pantry[0].useBy = "2026-10-30";
  const { checked } = preview(original);
  const items = shoppingForWeek(checked, week, today).map(item => ({ ...item, measure: "0 g" }));
  const html = renderToStaticMarkup(createElement(PurchasePreview, { items, state: checked, week, today, close() {}, confirm() {} }));
  assert.match(html, /type="date"[^>]*aria-label="Use by rice"[^>]*value=""/);
  assert.doesNotMatch(html, /value="2026-10-30"/);
  const errorId = html.match(/aria-label="Amount bought rice"[^>]*aria-invalid="true"[^>]*aria-describedby="([^"]+)"/)?.[1];
  assert.ok(errorId);
  assert.ok(html.includes(`id="${errorId}" role="alert">Enter a positive purchased amount`));
  assert.match(html, /<form[^>]*class="panel kitchen-modal pantry-import-modal"/);
  assert.doesNotMatch(html, /novalidate/i);
  assert.match(html, /<button type="button"[^>]*>Skip item/);
  assert.match(html, /<button type="button"[^>]*>Cancel/);
  assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Confirm pantry additions/);
  assert.match(html, /Each batch keeps its own entered date/);
});

test("purchase submission validates actual date controls even when React still has an empty draft", () => {
  const { checked } = preview(kitchen());
  const confirmed = [];
  let tree;
  function CapturePreview() {
    tree = PurchasePreview({ items: shoppingForWeek(checked, week, today), state: checked, week, today, close() {}, confirm: drafts => confirmed.push(drafts) });
    return null;
  }
  renderToStaticMarkup(createElement(CapturePreview));
  const nodes = elements(tree);
  const form = nodes.find(node => node.type === "form");
  const date = nodes.find(node => node.type === "input" && node.props.type === "date");
  const confirmButton = nodes.find(node => node.type === "button" && node.props.type === "submit");
  assert.equal(date.props.value, "");
  assert.equal(typeof date.props.onInput, "function");
  assert.equal(typeof date.props.onInvalid, "function");
  assert.equal(confirmButton.props.onClick, undefined);
  const input = { value: "", validity: { valid: false, badInput: true } };
  let validityChecks = 0;
  const control = {
    reportValidity() { validityChecks++; return input.validity.valid; },
    elements: { namedItem(name) { assert.equal(name, date.props.name); return input; } },
  };
  function submit() {
    let prevented = false;
    form.props.onSubmit({ currentTarget: control, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  submit();
  assert.equal(validityChecks, 1);
  assert.equal(confirmed.length, 0);

  input.value = "2026-10-30";
  input.validity = { valid: true, badInput: false };
  submit();
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0][0].useBy, "2026-10-30");
  const added = applyBoughtItems(checked, week, today, confirmed[0], "dated-purchase", at);
  assert.equal(added.shoppingPurchases[0].items[0].pantry.useBy, "2026-10-30");

  input.value = "";
  input.validity = { valid: false, badInput: true };
  submit();
  assert.equal(confirmed.length, 1);
  input.validity = { valid: true, badInput: false };
  submit();
  assert.equal(confirmed.length, 2);
  assert.equal(confirmed[1][0].useBy, "");
  const cleared = applyBoughtItems(checked, week, today, confirmed[1], "undated-purchase", at);
  assert.equal(Object.hasOwn(cleared.shoppingPurchases[0].items[0].pantry, "useBy"), false);

  input.value = "2026-02-30";
  submit();
  assert.equal(confirmed.length, 2);
  assert.equal(validityChecks, 5);
  control.reportValidity = () => true;
  input.value = "";
  input.validity = { valid: false, badInput: true };
  submit();
  assert.equal(confirmed.length, 2);
  control.elements.namedItem = () => null;
  submit();
  assert.equal(confirmed.length, 2);
});

test("purchase undo accepts parsed equivalent quantities but never different amounts or dimensions", () => {
  for (const [measure, equivalent] of [["1 kg", "1000 g"], ["1/2 kilogram", "500 grams"], ["500 mg", "0.5 g"], ["1 l", "1000 ml"], ["1 cup", "240 ml"], ["2 pieces", "2"]]) {
    const { checked, drafts } = preview(kitchen());
    const added = applyBoughtItems(checked, week, today, [{ ...drafts[0], measure, useBy: "2026-10-30" }], "purchase", at);
    const normalized = { ...added, pantry: added.pantry.map(stock => stock.id === drafts[0].pantryId ? { ...stock, measure: equivalent } : stock) };
    assert.equal(purchaseUndoProblem(normalized, added.shoppingPurchases[0]), "");
    assert.deepEqual(undoPurchase(normalized, "purchase").pantry, checked.pantry);
    assert.equal(added.shoppingPurchases[0].items[0].pantry.measure, measure);
  }
  const { checked, drafts } = preview(kitchen());
  const added = applyBoughtItems(checked, week, today, [{ ...drafts[0], measure: "1 kg", useBy: "2026-10-30" }], "purchase", at);
  for (const patch of [
    { measure: "999.999999 g" }, { measure: "1000.000001 g" }, { measure: "1000 ml" }, { measure: "1000" },
    { measure: "1000 g drained" }, { measure: "1/0 kg" }, { measure: "" },
    { name: "Rice" }, { name: "rice " }, { name: "cooked rice" }, { useBy: "2026-10-31" }, { useBy: undefined },
    { id: "replacement-batch", measure: "1000 g" },
  ]) {
    const edited = { ...added, pantry: added.pantry.map(stock => stock.id === drafts[0].pantryId ? { ...stock, ...patch } : stock) };
    assert.notEqual(purchaseUndoProblem(edited, added.shoppingPurchases[0]), "");
    assert.equal(undoPurchase(edited, "purchase"), edited);
  }
});

test("unknown purchase notes must match exactly, not just share an unparseable amount", () => {
  const { checked, drafts } = preview(kitchen());
  for (const [measure, edits] of [["", [" ", "unknown"]], ["one bag", ["one bag ", "One bag", "two bags", "1 bag"]], ["1 bag", ["1 packet", "1", "1 bag drained"]], ["1 can", ["1 jar", "1"]]]) {
    const added = applyBoughtItems(checked, week, today, [{ ...drafts[0], measure }], "purchase", at);
    assert.notEqual(undoPurchase(added, "purchase"), added);
    for (const changed of edits) {
      const edited = { ...added, pantry: added.pantry.map(stock => stock.id === drafts[0].pantryId ? { ...stock, measure: changed } : stock) };
      assert.equal(undoPurchase(edited, "purchase"), edited);
    }
  }
});

test("purchase, cook, undo cook, undo purchase compose without losing entered dates or unrelated stock", () => {
  const { checked, drafts } = preview(kitchen());
  const added = applyBoughtItems(checked, week, today, [{ ...drafts[0], measure: "1 kg", useBy: "2026-10-30" }], "purchase", at);
  const cooked = completeMeal(added, today, true, at);
  assert.equal(cooked.pantry[2].measure, "800 g");
  assert.equal(cooked.meals[today].completion.deductions[0].useBy, "2026-10-30");
  assert.equal(undoPurchase(cooked, "purchase"), cooked);
  const uncooked = undoMeal(cooked, today);
  assert.equal(uncooked.pantry[2].measure, "1000 g");
  assert.equal(uncooked.pantry[2].useBy, "2026-10-30");
  assert.deepEqual(uncooked.shoppingPurchases, added.shoppingPurchases);
  const restored = parseKitchenBackup(serializeKitchenBackup(uncooked, at)).state;
  const undone = undoPurchase(restored, "purchase");
  assert.deepEqual(undone.pantry, checked.pantry);
  assert.deepEqual(undone.meals, checked.meals);
  assert.deepEqual(undone.shoppingPurchases, []);
  assert.notEqual(purchaseUndoProblem(undone, added.shoppingPurchases[0]), "");
  assert.equal(undoPurchase(undone, "purchase"), undone);
  validateKitchenState(undone);
});

test("undo cooking does not make later edited or removed purchase batches safe to undo", () => {
  const { checked, drafts } = preview(kitchen());
  const added = applyBoughtItems(checked, week, today, [{ ...drafts[0], measure: "1 kg", useBy: "2026-10-30" }], "purchase", at);
  const cooked = completeMeal(added, today, true, at);
  for (const pantry of [
    ...[{ measure: "700 g" }, { name: "cooked rice" }, { useBy: "2026-11-01" }].map(patch => cooked.pantry.map(stock => stock.id === drafts[0].pantryId ? { ...stock, ...patch } : stock)),
    cooked.pantry.filter(stock => stock.id !== drafts[0].pantryId),
  ]) {
    const uncooked = undoMeal({ ...cooked, pantry }, today);
    assert.notEqual(purchaseUndoProblem(uncooked, added.shoppingPurchases[0]), "");
    assert.equal(undoPurchase(uncooked, "purchase"), uncooked);
    validateKitchenState(uncooked);
  }
});

test("undo validates the retained receipt and rejects a whole multi-batch purchase if any batch changed", () => {
  const { checked, drafts } = preview(kitchen([...recipe.ingredients, { name: "salt", measure: "1 g" }]));
  const added = applyBoughtItems(checked, week, today, drafts, "purchase", at);
  const edited = { ...added, pantry: added.pantry.map(stock => stock.id === drafts[1].pantryId ? { ...stock, measure: "2 g" } : stock) };
  const stale = { ...added.shoppingPurchases[0], items: added.shoppingPurchases[0].items.map(item => ({ ...item, pantry: edited.pantry.find(stock => stock.id === item.pantry.id) })) };
  assert.notEqual(purchaseUndoProblem(edited, stale), "");
  assert.equal(undoPurchase(edited, "purchase"), edited);
});

function repeatablePurchase(cycleId) {
  const { checked, drafts } = preview(kitchen([...recipe.ingredients, { name: "salt", measure: "1 g" }]));
  checked.shoppingCycles = { [drafts[1].key]: "pending-salt", ...(cycleId ? { [drafts[0].key]: cycleId } : {}) };
  drafts[0] = { ...drafts[0], cycleId, measure: "one bag", useBy: "2026-10-29" };
  drafts[1] = { ...drafts[1], cycleId: "pending-salt" };
  const state = applyBoughtItems(checked, week, today, [drafts[0]], "first-receipt", at);
  return { state, drafts, previous: { purchaseId: "first-receipt", key: drafts[0].key, cycleId, pantryId: drafts[0].pantryId } };
}

test("explicit repeat purchases select an applied batch/cycle and leave all pending purchases intact", () => {
  for (const cycleId of [undefined, "first-cycle"]) {
    const { state, drafts, previous } = repeatablePurchase(cycleId);
    const next = beginShoppingPurchaseCycle(state, previous, "next-cycle", true);
    assert.notEqual(next, state);
    assert.equal(next.pantry, state.pantry);
    assert.equal(next.shoppingPurchases, state.shoppingPurchases);
    assert.equal(next.shoppingChecked[previous.key], true);
    assert.deepEqual(next.shoppingCycles, { ...state.shoppingCycles, [previous.key]: "next-cycle" });
    assert.equal(unappliedBoughtItems(next, shoppingForWeek(next, week, today)).length, 2);
    assert.equal(beginShoppingPurchaseCycle(next, previous, "next-cycle", true), next);
    assert.equal(beginShoppingPurchaseCycle(next, previous, "duplicate-click", false), next);
    assert.equal(applyBoughtItems(next, week, today, [drafts[0]], "stale-preview", at), next);
    assert.equal(applyBoughtItems(next, week, today, [{ ...drafts[0], cycleId: "next-cycle" }], "reused-batch", at), next);
    const newDraft = { ...drafts[0], cycleId: "next-cycle", pantryId: "next-batch", useBy: "2026-11-01" };
    const added = applyBoughtItems(next, week, today, [newDraft, drafts[1]], "next-receipt", at);
    assert.notEqual(added, next);
    assert.deepEqual(added.pantry.slice(0, state.pantry.length), state.pantry);
    assert.equal(added.pantry.find(stock => stock.id === "next-batch").useBy, "2026-11-01");
    assert.equal(added.shoppingPurchases[0].items[0].pantry.useBy, "2026-10-29");
    assert.equal(added.shoppingPurchases[1].items[1].cycleId, "pending-salt");
    assert.equal(beginShoppingPurchaseCycle(added, previous, "late-stale-click", true), added);
    assert.equal(applyBoughtItems(added, week, today, [newDraft], "duplicate-receipt", at), added);
    validateKitchenState(added);
    const restored = parseKitchenBackup(serializeKitchenBackup(added, at)).state;
    assert.equal(beginShoppingPurchaseCycle(restored, previous, "stale-after-reload", true), restored);
    const latest = { ...previous, purchaseId: "next-receipt", cycleId: "next-cycle", pantryId: "next-batch" };
    if (cycleId) assert.equal(beginShoppingPurchaseCycle(restored, latest, cycleId, true), restored);
    assert.notEqual(beginShoppingPurchaseCycle(restored, latest, "third-cycle", true), restored);
  }
});

test("repeat purchase guards reject wrong receipts, cycles, batches, unchecked items and current pending items", () => {
  const { state, previous, drafts } = repeatablePurchase("first-cycle");
  for (const selection of [
    { ...previous, purchaseId: "missing" }, { ...previous, key: "missing" }, { ...previous, cycleId: "stale" },
    { ...previous, cycleId: undefined }, { ...previous, pantryId: "another-batch" },
    { ...previous, key: drafts[1].key, cycleId: drafts[1].cycleId, pantryId: drafts[1].pantryId },
  ]) assert.equal(beginShoppingPurchaseCycle(state, selection, "new-cycle", true), state);
  for (const id of ["", " ", "first-cycle", "x".repeat(201)]) assert.equal(beginShoppingPurchaseCycle(state, previous, id, true), state);
  const unchecked = setShoppingItemBought(state, previous.key, false, "ignored");
  assert.equal(beginShoppingPurchaseCycle(unchecked, previous, "new-cycle", true), unchecked);
  const undone = undoPurchase(state, "first-receipt");
  assert.notEqual(undone, state);
  assert.equal(beginShoppingPurchaseCycle(undone, previous, "new-cycle", true), undone);
});

test("need to buy again returns the applied item to shopping and supports the existing checkbox", () => {
  const { state, previous, drafts } = repeatablePurchase("first-cycle");
  const needed = beginShoppingPurchaseCycle(state, previous, "need-again", false);
  assert.equal(needed.shoppingChecked[previous.key], false);
  assert.equal(needed.pantry, state.pantry);
  assert.equal(needed.shoppingPurchases, state.shoppingPurchases);
  assert.deepEqual(unappliedBoughtItems(needed, shoppingForWeek(needed, week, today)).map(item => item.key), [drafts[1].key]);
  assert.equal(beginShoppingPurchaseCycle(needed, previous, "repeated", false), needed);
  const bought = setShoppingItemBought(needed, previous.key, true, "bought-again");
  assert.equal(bought.shoppingCycles[previous.key], "bought-again");
  assert.equal(setShoppingItemBought(bought, previous.key, true, "duplicate-check"), bought);
  assert.equal(beginShoppingPurchaseCycle(bought, previous, "stale-record-click", true), bought);
  const draft = { ...drafts[0], cycleId: "bought-again", pantryId: "new-batch" };
  const added = applyBoughtItems(bought, week, today, [draft], "next-receipt", at);
  assert.equal(added.shoppingPurchases.length, 2);
  validateKitchenState(added);
});

function shoppingProps(state, command = () => {}) {
  return { items: shoppingForWeek(state, week, today), checked: state.shoppingChecked, cycles: state.shoppingCycles, purchases: state.shoppingPurchases,
    command, hasPlan: true, goPlan() {}, reviewMeal() {}, week,
    purchaseAction: createElement("button", null, "Add bought items to pantry"), purchaseHistory: createElement("p", null, "Existing purchase history") };
}

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object") return [];
  return [node, ...elements(node.props?.children)];
}

test("shopping renders explicit repeat controls only for the selected applied cycle and keeps existing slots", () => {
  const { state, previous } = repeatablePurchase("first-cycle");
  const render = props => renderToStaticMarkup(createElement(DurableShoppingView, props));
  const html = render(shoppingProps(state));
  assert.match(html, /aria-label="Need to buy again rice"/);
  assert.match(html, /aria-label="Record another purchase rice"/);
  assert.doesNotMatch(html, /aria-label="Record another purchase salt"/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /Add bought items to pantry/);
  assert.match(html, /Existing purchase history/);
  const pending = beginShoppingPurchaseCycle(state, previous, "new-cycle", true);
  assert.doesNotMatch(render(shoppingProps(pending)), /aria-label="Record another purchase rice"/);
  const legacyProps = shoppingProps(state);
  delete legacyProps.cycles; delete legacyProps.purchases;
  assert.doesNotThrow(() => render(legacyProps));
  assert.doesNotMatch(render(legacyProps), /aria-label="Record another purchase/);
});

test("repeat buttons remain idempotent across repeated clicks, stale renders and later applied receipts", () => {
  for (const cycleId of [undefined, "first-cycle"]) {
    for (const action of ["Need to buy again", "Record another purchase"]) {
      const initial = repeatablePurchase(cycleId);
      let current = initial.state;
      let sequence = 0;
      const update = intent => { current = applyKitchenCommand(current, { ...intent, commandId: `button-${sequence++}`, expectedRevision: 0 }, { revision: 0 }); };
      const staleTree = DurableShoppingView(shoppingProps(current, update));
      const controls = elements(staleTree).filter(node => node.type === "button");
      const button = controls.find(node => node.props["aria-label"] === `${action} rice`);
      assert.ok(button);
      button.props.onClick();
      const pending = current;
      assert.notEqual(pending, initial.state);
      assert.equal(pending.shoppingChecked[initial.previous.key], action === "Record another purchase");
      assert.equal(pending.shoppingCycles[initial.drafts[1].key], "pending-salt");
      button.props.onClick();
      assert.equal(current, pending);
      for (const other of controls.filter(node => /^(Need to buy again|Record another purchase) rice$/.test(node.props["aria-label"]))) other.props.onClick();
      assert.equal(current, pending);
      if (action === "Need to buy again") {
        const checkbox = elements(DurableShoppingView(shoppingProps(current, update))).find(node => node.type === "input" && node.props["aria-label"].startsWith("Bought rice "));
        checkbox.props.onChange({ target: { checked: true } });
        const checked = current;
        checkbox.props.onChange({ target: { checked: true } });
        assert.equal(current, checked);
      }
      const draft = { ...initial.drafts[0], cycleId: current.shoppingCycles[initial.previous.key], pantryId: "next-batch" };
      current = applyBoughtItems(current, week, today, [draft], "next-receipt", at);
      assert.equal(current.shoppingPurchases.length, 2);
      const applied = current;
      button.props.onClick();
      assert.equal(current, applied);
      validateKitchenState(current);
    }
  }
});
