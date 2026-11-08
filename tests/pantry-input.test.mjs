import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const directory = await mkdtemp(join(tmpdir(), "jff-pantry-input-"));
after(() => rm(directory, { recursive: true, force: true }));
const require = createRequire(import.meta.url);
// Keep real React for markup checks; use controlled state scheduling for input/submit event tests.
await writeFile(join(directory, "preview-hooks.mjs"), `
let active;
export function createRenderer(component, props) {
  const slots = [];
  return { props, render(next = this.props) {
    this.props = next;
    const previous = active;
    active = { slots, cursor: 0 };
    try { return component(this.props); } finally { active = previous; }
  } };
}
export function useState(initial) {
  const index = active.cursor++;
  const slot = active.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
  return [slot.value, update => { slot.value = typeof update === "function" ? update(slot.value) : update; }];
}
`);
for (const [folder, name, extension] of [
  ...["pantry-input", "quantities", "kitchen-types", "kitchen-validation"].map((name) => ["lib", name, "ts"]),
  ["components", "PantryImportPreview", "tsx"], ["components", "Modal", "tsx"],
]) {
  const source = await readFile(new URL(`../app/${folder}/${name}.${extension}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/"(react(?:\/jsx-runtime)?)"/g, (_, module) => JSON.stringify(pathToFileURL(require.resolve(module)).href))
    .replace(/"\.{1,2}\/(?:lib\/)?([\w-]+)"/g, '"./$1.mjs"');
  await writeFile(join(directory, `${name}.mjs`), compiled);
  if (name === "PantryImportPreview") await writeFile(join(directory, "interactive-preview.mjs"), compiled.replace(JSON.stringify(pathToFileURL(require.resolve("react")).href), '"./preview-hooks.mjs"'));
}
const { parsePantryInput, pantryInputProblem, pantryInputNeedsReview, pantryInputStock } = await import(pathToFileURL(join(directory, "pantry-input.mjs")));
const { PantryImportPreview } = await import(pathToFileURL(join(directory, "PantryImportPreview.mjs")));
const { PantryImportPreview: InteractivePantryImportPreview } = await import(pathToFileURL(join(directory, "interactive-preview.mjs")));
const { createRenderer } = await import(pathToFileURL(join(directory, "preview-hooks.mjs")));
const { EMPTY_KITCHEN } = await import(pathToFileURL(join(directory, "kitchen-types.mjs")));
const { validateKitchenWrite } = await import(pathToFileURL(join(directory, "kitchen-validation.mjs")));
const noop = () => {};
const previewProps = (props = {}) => ({ rows: [], pantry: [], change: noop, close: noop, confirm: noop, disabled: false, ...props });
const preview = (props) => renderToStaticMarkup(createElement(PantryImportPreview, previewProps(props)));
const interactivePreview = (props) => createRenderer(InteractivePantryImportPreview, previewProps(props));
function elements(node) {
  return Children.toArray(node).flatMap((child) => isValidElement(child) ? [child, ...elements(child.props.children)] : []);
}

test("pasted lists preserve every ingredient and split explicit or unambiguous amounts", () => {
  assert.deepEqual(parsePantryInput("rice: 300 g\n2 eggs; milk 500 ml, garlic\n\n"), [
    { name: "rice", measure: "300 g" }, { name: "egg", measure: "2" },
    { name: "milk", measure: "500 ml" }, { name: "garlic", measure: "" },
  ]);
  assert.deepEqual(parsePantryInput("salt: to taste\nbeans\t2 cans"), [{ name: "salt", measure: "to taste" }, { name: "beans", measure: "2 cans" }]);
});

test("ambiguous single inputs stay intact and require review instead of inventing quantities", () => {
  for (const text of [
    "1–2 cups rice", "1-2 cups rice", "rice 1 - 2 cups", "rice 1 to 2 cups", "2 large onions", "salt to taste",
    "rice about 2 cups", "approximately 2 cups rice", "rice or pasta", "rice and beans", "a handful of basil",
    "some flour", "two onions", "1 (400 g) can tomatoes", "2 x 400 g tomatoes", "2 cups rice 100 g",
    "2 large onions 3", "rice 2 cups plus 1 tbsp", "500 g", "2 cups", "1,000 g rice", "0,5 l milk",
    "salt -2 g", "salt - 2 g", "rice − 2 cups", "rice ~ 2 cups", "rice >= 2 cups", "rice 1/0 cup",
    "tomatoes (chopped, drained)", "2 tbsp, divided", "2 onions, chopped",
  ]) {
    const rows = parsePantryInput(text);
    assert.equal(rows.length, 1, text);
    assert.equal(rows[0].name, text, text);
    assert.equal(rows[0].measure, "", text);
    assert.equal(rows[0].originalText, text, text);
    assert.ok(rows[0].reviewReasons?.length, text);
    assert.equal(pantryInputNeedsReview(rows, []), true, text);
  }
});

test("unambiguous fractional and count amounts still parse", () => {
  assert.deepEqual(parsePantryInput("½ cup milk; flour 1 1/2 cups; 1 pinch salt; 2 eggs"), [
    { name: "milk", measure: "120 ml" }, { name: "flour", measure: "1 1/2 cups" },
    { name: "salt", measure: "1 pinch" }, { name: "egg", measure: "2" },
  ]);
});

test("comma preparation suffixes stay attached to pantry names", () => {
  const rows = parsePantryInput("rice, cooked: 300 g; pasta, uncooked 200 g\nchickpeas, dried, milk 500 ml, cooked rice");
  assert.deepEqual(rows.map(({ name, measure }) => ({ name, measure })), [
    { name: "rice, cooked", measure: "300 g" }, { name: "pasta, uncooked", measure: "200 g" },
    { name: "chickpeas, dried", measure: "" }, { name: "milk", measure: "500 ml" }, { name: "cooked rice", measure: "" },
  ]);
  assert.equal(rows[0].originalText, "rice, cooked: 300 g");
  assert.deepEqual(parsePantryInput("rice, cooked ½ cup").map(({ name, measure }) => ({ name, measure })), [{ name: "rice, cooked", measure: "½ cup" }]);
  assert.deepEqual(parsePantryInput("rice, raw rice"), [{ name: "rice", measure: "" }, { name: "raw rice", measure: "" }]);
  assert.deepEqual(parsePantryInput("rice, cooked rice"), [{ name: "rice", measure: "" }, { name: "cooked rice", measure: "" }]);
});

test("chopped and compound preparation clauses are not silently turned into separate stocks", () => {
  for (const text of [
    "tomatoes, chopped", "onions, finely chopped", "beans, drained and rinsed", "carrots, peeled, diced",
    "flour, sifted", "chicken, prepared", "potatoes, cut into small pieces", "rice, cooked or raw", "salt, to taste",
    "beans, canned", "chicken, roasted", "rice, cooked about 200 g",
  ]) {
    const rows = parsePantryInput(text);
    assert.equal(rows.length, 1, text);
    assert.equal(rows[0].name, text, text);
    assert.equal(rows[0].measure, "", text);
    assert.equal(rows[0].originalText, text, text);
    assert.ok(rows[0].reviewReasons?.length, text);
    assert.equal(pantryInputNeedsReview(rows, []), true, text);
  }
  assert.deepEqual(parsePantryInput("tomatoes, chopped: 200 g, garlic; flour, sifted, sugar").map(({ name, measure }) => ({ name, measure })), [
    { name: "tomatoes, chopped", measure: "200 g" }, { name: "garlic", measure: "" },
    { name: "flour, sifted", measure: "" }, { name: "sugar", measure: "" },
  ]);
});

test("preview validates quantities with the same bounds as kitchen persistence", () => {
  for (const amount of ["-2 g", "1/0 cup", "Infinity", "1000000001 g", "x".repeat(161)]) {
    assert.ok(pantryInputProblem([{ name: "rice", measure: amount }], []), amount);
  }
  for (const name of ["", " ", "x".repeat(201), "rice\u0001"]) assert.match(pantryInputProblem([{ name, measure: "" }], []), /Ingredient 1 name/);
  assert.equal(pantryInputProblem([{ name: "rice", measure: "to taste" }], []), "");
  assert.equal(pantryInputProblem([{ name: "rice", measure: "0 g" }], []), "");
});

test("preview permits same-name and canonical duplicate batches without merging or overwriting stock", () => {
  const pantry = Object.freeze([Object.freeze({ id: "existing", name: "tomato", measure: "100 g", useBy: "2026-11-08" })]);
  const rows = Object.freeze([
    Object.freeze({ name: "tomato", measure: "200 g", useBy: "2026-11-09" }),
    Object.freeze({ name: "tomatoes", measure: "300 g", useBy: "2026-11-10" }),
    Object.freeze({ name: "tomato, chopped", measure: "" }),
  ]);
  assert.equal(pantryInputProblem(rows, pantry), "");
  assert.equal(pantryInputProblem(parsePantryInput("tomato, tomato, tomatoes"), pantry), "");
  assert.equal(pantryInputProblem(parsePantryInput("rice, raw rice, cooked rice"), []), "");
  const additions = rows.map((row, index) => pantryInputStock(row, `new-${index}`));
  assert.deepEqual(additions, rows.map((row, index) => ({ id: `new-${index}`, ...row })));
  assert.deepEqual(pantry, [{ id: "existing", name: "tomato", measure: "100 g", useBy: "2026-11-08" }]);
  validateKitchenWrite({ revision: 0, state: { ...EMPTY_KITCHEN, pantry: [...pantry, ...additions] } });
});

test("duplicate batches still count toward the pantry limit and empty imports are rejected", () => {
  const stock = { id: "existing", name: "rice", measure: "100 g" };
  assert.match(pantryInputProblem([], []), /at least one/);
  assert.equal(pantryInputProblem(parsePantryInput("rice, rice"), Array(498).fill(stock)), "");
  assert.match(pantryInputProblem(parsePantryInput("rice, rice"), Array(499).fill(stock)), /500/);
  assert.match(pantryInputProblem(parsePantryInput("rice"), Array(500).fill(stock)), /500/);
});

test("only a bare new name can bypass review, with canonical existing matches including empty batches", () => {
  for (const text of ["rice", "olive oil", "garlic", "cooked rice"]) assert.equal(pantryInputNeedsReview(parsePantryInput(text), []), false, text);
  for (const text of ["rice: 200 g", "2 eggs", "salt: to taste", "rice, milk", "rice:", "rice or pasta"]) {
    assert.equal(pantryInputNeedsReview(parsePantryInput(text), []), true, text);
  }
  for (const [name, existing] of [["tomatoes", "tomato"], ["SCALLIONS", "spring onion"], ["rice", "raw rice"], ["onion", "onions, chopped"]]) {
    assert.equal(pantryInputNeedsReview(parsePantryInput(name), [{ id: "existing", name: existing, measure: "" }]), true, name);
  }
  const pantry = [{ id: "raw", name: "rice", measure: "0 g", useBy: "2020-01-01" }];
  assert.equal(pantryInputNeedsReview(parsePantryInput("rice"), pantry), true);
  assert.equal(pantryInputNeedsReview(parsePantryInput("cooked rice"), pantry), false);
  assert.equal(pantryInputNeedsReview(parsePantryInput("rice vinegar"), pantry), false);
  assert.equal(pantryInputNeedsReview([{ name: "rice", measure: "", reviewReasons: ["Check this ingredient."] }], []), true);
  assert.equal(pantryInputNeedsReview([{ name: "rice", measure: "", useBy: "2026-11-08" }], []), true);
  assert.equal(pantryInputNeedsReview([], []), false);
});

test("preview accepts optional dates and validates calendar dates at the persistence boundary", () => {
  for (const useBy of [undefined, "", "   ", "0001-01-01", "2020-01-01", "2028-02-29", "2000-02-29", "9999-12-31", " 2026-11-08 "]) {
    const row = { name: "rice", measure: "", useBy };
    assert.equal(pantryInputProblem([row], []), "", String(useBy));
    validateKitchenWrite({ revision: 0, state: { ...EMPTY_KITCHEN, pantry: [pantryInputStock(row, "dated")] } });
  }
  for (const useBy of ["tomorrow", "2026-2-03", "2026-02-29", "1900-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-01-00", "0000-01-01", "10000-01-01", "2026-11-08T00:00:00Z"]) {
    const row = { name: "rice", measure: "", useBy };
    assert.match(pantryInputProblem([{ name: "salt", measure: "" }, row], []), /Ingredient 2 use-by date/, useBy);
    assert.throws(() => validateKitchenWrite({ revision: 0, state: { ...EMPTY_KITCHEN, pantry: [pantryInputStock(row, "invalid")] } }), useBy);
  }
});

test("stock projection trims fields and excludes all preview metadata without changing the draft", () => {
  const row = Object.freeze({ name: " Tomatoes, chopped ", measure: " 200 g ", useBy: " 2026-11-08 ", originalText: "tomatoes, chopped: 200 g", reviewReasons: ["Check preparation."], id: "untrusted", extra: true });
  assert.deepEqual(pantryInputStock(row, "new-batch"), { id: "new-batch", name: "tomatoes, chopped", measure: "200 g", useBy: "2026-11-08" });
  assert.equal(pantryInputProblem([row], []), "");
  assert.equal(row.name, " Tomatoes, chopped ");
  for (const useBy of [undefined, "", " "]) assert.deepEqual(pantryInputStock({ name: "Rice", measure: "", useBy }, "unknown-date"), { id: "unknown-date", name: "rice", measure: "" });
});

test("preview retains the accessible modal and labels, original text, reasons and optional date input", () => {
  const rows = parsePantryInput("2 large onions").map((row) => ({ ...row, useBy: "2026-11-08" }));
  const html = preview({ rows });
  assert.match(html, /<dialog[^>]*aria-modal="true"[^>]*aria-label="Review pantry ingredients"/);
  assert.match(html, /<label>Ingredient 1<input/);
  assert.match(html, /<label>Amount 1<input/);
  assert.match(html, /<label>Use by 1<input type="date"[^>]*value="2026-11-08"/);
  assert.match(html, /Original input: 2 large onions/);
  assert.ok(html.includes(rows[0].reviewReasons[0]));
  assert.match(html, /aria-describedby="pantry-preview-review-0"/);
  assert.match(html, />Confirm ingredients<\/button>/);
});

test("preview shows duplicate notices and every matching existing batch with explicit actions", () => {
  const pantry = [
    { id: "first", name: "rice", measure: "100 g", useBy: "2026-11-08" },
    { id: "second", name: "raw rice", measure: "" },
    { id: "cooked", name: "cooked rice", measure: "300 g", useBy: "2026-11-10" },
  ];
  const html = preview({ rows: parsePantryInput("rice: 200 g; raw rice: 400 g"), pantry, editExisting: noop });
  assert.match(html, /Each row will be added as a separate batch; amounts and dates will not be merged/);
  assert.match(html, /Existing batch 1: <strong>rice<\/strong> · 100 g · Use by 2026-11-08/);
  assert.match(html, /Existing batch 2: <strong>raw rice<\/strong> · Amount unknown · Use-by date unknown/);
  assert.doesNotMatch(html, /<strong>cooked rice<\/strong>/);
  assert.match(html, /aria-label="Correct existing rice batch 1 for ingredient 1"/);
  assert.match(html, />Confirm new batches<\/button>/);
  assert.doesNotMatch(html, /class="primary-button" disabled/);
  assert.match(preview({ rows: parsePantryInput("rice"), pantry }), />Confirm new batch<\/button>/);
  assert.doesNotMatch(preview({ rows: parsePantryInput("rice"), pantry }), />Correct existing batch<\/button>/);
});

test("preview actions only delegate to the parent and never mutate stock or auto-confirm", () => {
  const rows = Object.freeze([Object.freeze({ name: "tomato", measure: "200 g" })]);
  const pantry = Object.freeze([
    Object.freeze({ id: "first", name: "tomatoes", measure: "100 g", useBy: "2026-11-08" }),
    Object.freeze({ id: "second", name: "tomato", measure: "300 g", useBy: "2026-11-10" }),
  ]);
  const calls = [];
  const props = previewProps({ rows, pantry, editExisting: (id) => calls.push(["edit", id]), confirm: () => calls.push(["confirm"]), close: () => calls.push(["close"]), change: (next) => calls.push(["change", next]) });
  const tree = interactivePreview(props).render();
  renderToStaticMarkup(tree);
  assert.deepEqual(calls, []);
  const buttons = elements(tree).filter((element) => element.type === "button");
  const corrections = buttons.filter((button) => button.props.children === "Correct existing batch");
  assert.equal(corrections.length, 2);
  corrections[1].props.onClick();
  assert.deepEqual(calls, [["edit", "second"]]);
  const submit = buttons.find((button) => button.props.children === "Confirm new batch");
  assert.equal(submit.props.type, "submit");
  assert.equal(submit.props.onClick, undefined);
  for (const button of buttons.filter((button) => button !== submit)) assert.equal(button.props.type, "button");
  const form = elements(tree).find((element) => element.type === "form");
  assert.equal(form.props.noValidate, undefined);
  let checked = 0, prevented = 0;
  form.props.onSubmit({ preventDefault: () => { prevented++; }, currentTarget: { reportValidity: () => { checked++; return true; } } });
  assert.equal(checked, 1);
  assert.equal(prevented, 1);
  assert.deepEqual(calls, [["edit", "second"], ["confirm"]]);
  assert.equal(pantry[0].measure, "100 g");
  assert.equal(pantry[1].useBy, "2026-11-10");
  assert.deepEqual(rows, [{ name: "tomato", measure: "200 g" }]);
});

test("date edits and clearing only change the selected draft, and invalid dates disable confirmation", () => {
  const rows = [{ name: "rice", measure: "100 g" }, { name: "rice", measure: "200 g", useBy: "2026-11-08", originalText: "rice: 200 g" }];
  const original = structuredClone(rows);
  let changed;
  const fields = elements(interactivePreview({ rows, change: (next) => { changed = next; } }).render());
  const date = fields.filter((element) => element.type === "input" && element.props.type === "date")[1];
  date.props.onInput({ currentTarget: { value: "2026-11-09", validity: { valid: true, badInput: false } } });
  assert.deepEqual(changed, [rows[0], { ...rows[1], useBy: "2026-11-09" }]);
  date.props.onInput({ currentTarget: { value: "", validity: { valid: true, badInput: false } } });
  assert.equal(Object.hasOwn(pantryInputStock(changed[1], "cleared"), "useBy"), false);
  assert.deepEqual(rows, original);
  const invalid = [{ name: "rice", measure: "" }, { name: "beans", measure: "", useBy: "2026-02-30" }];
  const invalidFields = elements(interactivePreview({ rows: invalid }).render());
  assert.equal(invalidFields.find((element) => element.type === "button" && element.props.className === "primary-button").props.disabled, true);
  assert.equal(invalidFields.filter((element) => element.type === "input" && element.props.type === "date")[1].props["aria-invalid"], true);
  assert.match(preview({ rows: invalid }), /Ingredient 2 use-by date must be a valid calendar date/);
});

test("disabled previews prevent both new-batch confirmation and existing-batch correction", () => {
  let confirmed = false;
  const fields = elements(interactivePreview({ rows: parsePantryInput("rice"), pantry: [{ id: "existing", name: "rice", measure: "100 g" }], disabled: true, editExisting: noop, confirm: () => { confirmed = true; } }).render());
  for (const label of ["Confirm new batch", "Correct existing batch"]) {
    assert.equal(fields.find((element) => element.type === "button" && element.props.children === label).props.disabled, true);
  }
  fields.find((element) => element.type === "form").props.onSubmit({ preventDefault: noop, currentTarget: { reportValidity: () => true } });
  assert.equal(confirmed, false);
});

test("partial date input blocks both blank and previously valid drafts until completed or explicitly cleared", () => {
  for (const initial of [undefined, "2026-11-08"]) for (const repaired of ["", "2026-11-09"]) {
    const original = Object.freeze({ name: "rice", measure: "100 g", useBy: initial });
    const saved = [];
    const view = interactivePreview({ rows: [original],
      change: (rows) => { view.props = { ...view.props, rows }; },
      confirm: () => saved.push(view.props.rows.map((row, index) => pantryInputStock(row, `new-${index}`))),
    });
    const fields = () => elements(view.render());
    const date = () => fields().find((element) => element.type === "input" && element.props.type === "date");
    const native = { value: "", validity: { valid: false, badInput: true } };
    // Chrome can emit only input for a partial segment: value stays empty and change never fires.
    date().props.onInput({ currentTarget: native });
    assert.equal(date().props["aria-invalid"], true);
    assert.equal(date().props["aria-describedby"], "pantry-preview-date-error-0");
    const message = fields().find((element) => element.props.id === "pantry-preview-date-error-0");
    assert.equal(message.props.role, "alert");
    assert.match(message.props.children, /complete, valid use-by date, or clear/);
    let checked = 0;
    const submit = () => fields().find((element) => element.type === "form").props.onSubmit({ preventDefault: noop,
      currentTarget: { reportValidity: () => { checked++; return native.validity.valid; } },
    });
    submit();
    assert.equal(checked, 1);
    assert.deepEqual(saved, []);
    assert.equal(pantryInputProblem(view.props.rows, []), "", "draft-only validation cannot detect the partial date");
    native.value = repaired;
    native.validity = { valid: true, badInput: false };
    date().props.onInput({ currentTarget: native });
    assert.equal(date().props["aria-invalid"], false);
    assert.equal(fields().some((element) => element.props.id === "pantry-preview-date-error-0"), false);
    submit();
    assert.equal(checked, 2);
    assert.deepEqual(saved, [[{ id: "new-0", name: "rice", measure: "100 g", ...(repaired ? { useBy: repaired } : {}) }]]);
    assert.equal(original.useBy, initial);
  }
});

test("native invalid events show inline errors and submission checks live validity without prior input state", () => {
  let confirmed = false, changed = false;
  const view = interactivePreview({ rows: [{ name: "rice", measure: "" }], confirm: () => { confirmed = true; }, change: () => { changed = true; } });
  const fields = () => elements(view.render());
  const date = fields().find((element) => element.type === "input" && element.props.type === "date");
  assert.equal(date.props["aria-invalid"], false);
  fields().find((element) => element.type === "form").props.onSubmit({ preventDefault: noop, currentTarget: { reportValidity: () => {
    date.props.onInvalid({ currentTarget: { value: "", validity: { valid: false, badInput: true } } });
    return false;
  } } });
  assert.equal(confirmed, false);
  assert.equal(changed, false);
  assert.equal(fields().find((element) => element.type === "input" && element.props.type === "date").props["aria-invalid"], true);
  assert.match(fields().find((element) => element.props.id === "pantry-preview-date-error-0").props.children, /complete, valid/);
  // A DOM reset must not silently reinterpret a recorded partial date as an explicit clear.
  fields().find((element) => element.type === "form").props.onSubmit({ preventDefault: noop, currentTarget: { reportValidity: () => true } });
  assert.equal(confirmed, false);
});

test("removing preview rows keeps native date errors with the remaining rows and drops removed errors", () => {
  const view = interactivePreview({ rows: [{ name: "rice", measure: "" }, { name: "beans", measure: "" }], change: (rows) => { view.props = { ...view.props, rows }; } });
  const fields = () => elements(view.render());
  fields().filter((element) => element.type === "input" && element.props.type === "date")[1].props.onInput({ currentTarget: { value: "", validity: { valid: false, badInput: true } } });
  fields().find((element) => element.props["aria-label"] === "Remove preview ingredient 1").props.onClick();
  assert.equal(view.props.rows[0].name, "beans");
  assert.equal(fields().find((element) => element.type === "input" && element.props.type === "date").props["aria-invalid"], true);
  assert.ok(fields().some((element) => element.props.id === "pantry-preview-date-error-0"));
  fields().find((element) => element.props["aria-label"] === "Remove preview ingredient 1").props.onClick();
  assert.equal(fields().some((element) => String(element.props.id).startsWith("pantry-preview-date-error-")), false);
});

test("a native-valid form still cannot submit an invalid preview draft", () => {
  let confirmed = false;
  const tree = interactivePreview({ rows: [{ name: "rice", measure: "", useBy: "2026-02-30" }], confirm: () => { confirmed = true; } }).render();
  elements(tree).find((element) => element.type === "form").props.onSubmit({ preventDefault: noop, currentTarget: { reportValidity: () => true } });
  assert.equal(confirmed, false);
});
