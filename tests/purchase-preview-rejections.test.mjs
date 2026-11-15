import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Children, isValidElement } from "react";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const sources = await createSourceLoader({ name: "purchase-preview-rejections", externals: { react: `
let slots = [], cursor = 0;
export const runtime = { reset() { slots = []; }, render(fn) { cursor = 0; return fn(); } };
export function useState(initial) {
  const index = cursor++;
  slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
  return [slots[index].value, update => { slots[index].value = typeof update === "function" ? update(slots[index].value) : update; }];
}
` }, overrides: { "app/components/Modal.tsx": "export function Modal({ children }) { return children; }" } });
after(() => sources.dispose());
const { runtime } = await sources.import("react");
const { PurchasePreview } = await sources.import("app/components/PurchasePreview.tsx");
const { createPlannedMeal } = await sources.import("app/lib/kitchen-state.ts");
const { applyBoughtItems, shoppingForWeek } = await sources.import("app/lib/shopping-purchases.ts");
const today = "2026-10-22", week = "2026-10-19", at = "2026-10-22T12:00:00.000Z";
const recipe = { id: "purchase-preview-fixture", title: "Test dinner", image: null, category: "Dinner", cuisine: "", tags: [],
  source: { name: "Test", url: "https://example.test" }, sourceUrl: "https://example.test/purchases", instructions: ["Cook the ingredients."],
  ingredients: [{ name: "rice", measure: "200 g" }, { name: "milk", measure: "200 ml" }, { name: "tomato", measure: "2" }] };

function elements(node) {
  return Children.toArray(node).flatMap(child => isValidElement(child) ? [child, ...elements(child.props.children)] : []);
}

test("purchase rejection keeps edited fields, skipped rows and batch IDs available for a successful retry", () => {
  runtime.reset();
  const initial = { schemaVersion: 2, pantry: [], meals: { [today]: createPlannedMeal(today, recipe) }, shoppingChecked: {}, migratedLegacy: true };
  const items = shoppingForWeek(initial, week, today);
  const state = { ...initial, shoppingChecked: Object.fromEntries(items.map(item => [item.key, true])),
    shoppingCycles: Object.fromEntries(items.map(item => [item.key, `cycle-${item.name}`])) };
  const before = structuredClone(state), submissions = [];
  let accepted = false, applied;
  const props = { items, state, week, today, close() {}, confirm(drafts) {
    submissions.push(structuredClone(drafts));
    if (accepted) applied = applyBoughtItems(state, week, today, drafts, "accepted-purchase", at);
    return accepted;
  } };
  let nodes;
  const render = () => { nodes = elements(runtime.render(() => PurchasePreview(props))); };
  const input = label => nodes.find(node => node.type === "input" && node.props["aria-label"] === label);
  const button = label => nodes.find(node => node.type === "button" && node.props["aria-label"] === label);
  function submit() {
    const dates = new Map(nodes.filter(node => node.type === "input" && node.props.type === "date")
      .map(node => [node.props.name, { value: node.props.value, validity: { valid: true } }]));
    nodes.find(node => node.type === "form").props.onSubmit({ preventDefault() {}, currentTarget: {
      reportValidity: () => true, elements: { namedItem: name => dates.get(name) },
    } });
    render();
  }
  render();
  input("Amount bought rice").props.onChange({ target: { value: "375 g" } }); render();
  input("Use by rice").props.onInput({ currentTarget: { value: "2026-10-25", validity: { valid: true } } }); render();
  nodes.find(node => node.props.label === "Location for rice").props.onChange("freezer"); render();
  button("Skip purchased tomato").props.onClick(); render();
  submit();
  assert.ok(nodes.some(node => node.props.role === "alert" && /Purchase additions were not applied/.test(node.props.children)));
  assert.equal(input("Amount bought rice").props.value, "375 g");
  assert.equal(input("Use by rice").props.value, "2026-10-25");
  assert.equal(nodes.find(node => node.props.label === "Location for rice").props.value, "freezer");
  assert.equal(input("Amount bought tomato"), undefined);
  assert.deepEqual(state, before);
  assert.equal(applied, undefined);
  input("Amount bought rice").props.onChange({ target: { value: "400 g" } }); render();
  assert.ok(!nodes.some(node => node.props.role === "alert"));
  submit();
  assert.ok(nodes.some(node => node.props.role === "alert"));
  accepted = true;
  submit();
  assert.ok(!nodes.some(node => node.props.role === "alert"));
  assert.deepEqual(submissions.map(rows => rows.map(row => [row.pantryId, row.cycleId])), Array(3).fill(submissions[0].map(row => [row.pantryId, row.cycleId])));
  assert.equal(applied.shoppingPurchases.length, 1);
  assert.equal(applied.shoppingPurchases[0].items.length, 2);
  assert.equal(new Set(applied.pantry.map(stock => stock.id)).size, 2);
  assert.deepEqual(applied.pantry.find(stock => stock.name === "rice"), { id: submissions[0].find(row => row.name === "rice").pantryId,
    name: "rice", measure: "400 g", useBy: "2026-10-25", location: "freezer" });
  assert.deepEqual(applied.shoppingChecked, before.shoppingChecked);
  assert.deepEqual(applied.shoppingCycles, before.shoppingCycles);
  assert.equal(applied.pantry.some(stock => stock.name === "tomato"), false);
});
