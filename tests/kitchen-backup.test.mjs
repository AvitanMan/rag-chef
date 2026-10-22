import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const dir = await mkdtemp(join(tmpdir(), "jff-kitchen-backup-"));
after(() => rm(dir, { recursive: true, force: true }));
for (const name of ["kitchen-types", "kitchen-state", "quantities", "kitchen-stock", "kitchen-validation", "kitchen-backup", "kitchen-recovery"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"');
  await writeFile(join(dir, `${name}.mjs`), code);
}
const { parseKitchenBackup, serializeKitchenBackup } = await import(pathToFileURL(join(dir, "kitchen-backup.mjs")).href);
const { availablePantryNames, removePantryStock } = await import(pathToFileURL(join(dir, "kitchen-stock.mjs")).href);
const { migrateLegacyKitchen } = await import(pathToFileURL(join(dir, "kitchen-state.mjs")).href);
const kitchen = () => ({ schemaVersion: 2, pantry: [{ id: "rice", name: "rice", measure: "1 kg" }], meals: {}, shoppingChecked: {}, migratedLegacy: true });

test("versioned exports and original backup files round-trip without changing state", () => {
  const original = kitchen();
  const exportedAt = "2026-10-22T10:00:00.000Z";
  const text = serializeKitchenBackup(original, exportedAt);
  const restored = parseKitchenBackup(text);
  assert.equal(restored.backupVersion, 1);
  assert.deepEqual(restored.state, original);
  restored.state.pantry[0].measure = "0 g";
  assert.equal(original.pantry[0].measure, "1 kg");
  assert.deepEqual(parseKitchenBackup(JSON.stringify({ exportedAt, state: original })).state, original);
});

test("unsupported versions, invalid states, dates and oversized backups fail before restore", () => {
  const backup = { exportedAt: "2026-10-22T10:00:00.000Z", state: kitchen() };
  for (const value of [{ ...backup, backupVersion: 2 }, { ...backup, exportedAt: "tomorrow" }, { ...backup, state: { ...kitchen(), shoppingChecked: null } }, { ...backup, revision: 99 }]) {
    assert.throws(() => parseKitchenBackup(JSON.stringify(value)));
  }
  assert.throws(() => parseKitchenBackup(" ".repeat(2_000_001)), /storage limit/);
});

test("zero stock is absent, unknown amounts remain uncertain, and removal uses row identity", () => {
  const state = { ...kitchen(), pantry: [
    { id: "zero", name: "rice", measure: "0 g" },
    { id: "unknown", name: "rice", measure: "some" },
    { id: "restored", name: "rice", measure: "400 g" },
    { id: "beans", name: "beans", measure: "0 cans" },
  ] };
  assert.deepEqual(availablePantryNames(state.pantry), ["rice"]);
  const removed = removePantryStock(state, "unknown");
  assert.deepEqual(removed.pantry.map((item) => item.id), ["zero", "restored", "beans"]);
  assert.equal(state.pantry.length, 4);
});

test("new kitchens start empty while existing legacy pantry is preserved", () => {
  assert.deepEqual(migrateLegacyKitchen(null, []).pantry, []);
  assert.deepEqual(migrateLegacyKitchen({ pantry: ["rice", "tomatoes"] }, []).pantry.map((item) => item.name), ["rice", "tomatoes"]);
});
