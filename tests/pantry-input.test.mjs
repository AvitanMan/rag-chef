import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const directory = await mkdtemp(join(tmpdir(), "jff-pantry-input-"));
after(() => rm(directory, { recursive: true, force: true }));
for (const name of ["pantry-input", "quantities", "kitchen-types", "kitchen-validation"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(directory, `${name}.mjs`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"'));
}
const { parsePantryInput, pantryInputProblem } = await import(pathToFileURL(join(directory, "pantry-input.mjs")));

test("pasted lists preserve every ingredient and split explicit or unambiguous amounts", () => {
  assert.deepEqual(parsePantryInput("rice: 300 g\n2 eggs; milk 500 ml, garlic\n\n"), [
    { name: "rice", measure: "300 g" }, { name: "egg", measure: "2" },
    { name: "milk", measure: "500 ml" }, { name: "garlic", measure: "" },
  ]);
  assert.deepEqual(parsePantryInput("salt: to taste\nbeans\t2 cans"), [{ name: "salt", measure: "to taste" }, { name: "beans", measure: "2 cans" }]);
});

test("ambiguous amounts stay intact for the preview instead of inventing stock", () => {
  assert.deepEqual(parsePantryInput("1–2 cups rice\n2 large onions\nsalt to taste"), [
    { name: "1–2 cups rice", measure: "" }, { name: "2 large onions", measure: "" }, { name: "salt to taste", measure: "" },
  ]);
});

test("comma preparation suffixes stay attached to pantry names", () => {
  assert.deepEqual(parsePantryInput("rice, cooked: 300 g; pasta, uncooked 200 g\nchickpeas, dried, milk 500 ml, cooked rice"), [
    { name: "rice, cooked", measure: "300 g" }, { name: "pasta, uncooked", measure: "200 g" },
    { name: "chickpeas, dried", measure: "" }, { name: "milk", measure: "500 ml" }, { name: "cooked rice", measure: "" },
  ]);
  assert.match(pantryInputProblem(parsePantryInput("rice, raw rice"), []), /more than once/);
  assert.equal(pantryInputProblem(parsePantryInput("rice, cooked rice"), []), "");
});

test("preview validates quantities with the same bounds as kitchen persistence", () => {
  for (const amount of ["-2 g", "1/0 cup", "Infinity", "1000000001 g", "x".repeat(161)]) {
    assert.ok(pantryInputProblem([{ name: "rice", measure: amount }], []), amount);
  }
  assert.ok(pantryInputProblem([{ name: "", measure: "" }], []));
  assert.equal(pantryInputProblem([{ name: "rice", measure: "to taste" }], []), "");
});

test("preview catches aliases and row limits without overwriting existing stock", () => {
  assert.match(pantryInputProblem(parsePantryInput("tomato, tomatoes"), []), /more than once/);
  const pantry = [{ id: "existing", name: "rice", measure: "100 g" }];
  assert.equal(pantryInputProblem(parsePantryInput("rice: 200 g"), pantry), "");
  assert.equal(pantry[0].measure, "100 g");
  assert.match(pantryInputProblem(parsePantryInput("rice"), Array(500).fill(pantry[0])), /500/);
});
