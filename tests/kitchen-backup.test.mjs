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
const { availablePantryNames } = await import(pathToFileURL(join(dir, "kitchen-stock.mjs")).href);
const { migrateLegacyKitchen } = await import(pathToFileURL(join(dir, "kitchen-state.mjs")).href);
const { compareKitchens } = await import(pathToFileURL(join(dir, "kitchen-recovery.mjs")).href);
const { DEFAULT_COOKING_PROFILE } = await import(pathToFileURL(join(dir, "kitchen-types.mjs")).href);
const { parseLegacyCookingProfile, validateCookingProfile } = await import(pathToFileURL(join(dir, "kitchen-validation.mjs")).href);
const kitchen = () => ({ schemaVersion: 2, pantry: [{ id: "rice", name: "rice", measure: "1 kg" }], meals: {}, shoppingChecked: {}, migratedLegacy: true });

test("favorites round-trip in backups and recovery reports changes without requiring them in older kitchens", () => {
  const original = kitchen();
  const saved = { ...original, favoriteRecipeIds: ["rice", "beans"] };
  assert.deepEqual(parseKitchenBackup(serializeKitchenBackup(saved)).state, { ...saved, cookingProfile: DEFAULT_COOKING_PROFILE });
  assert.equal(compareKitchens(original, saved).favoritesChanged, 2);
  assert.deepEqual(parseKitchenBackup(serializeKitchenBackup(original)).state, { ...original, cookingProfile: DEFAULT_COOKING_PROFILE });
  for (const favorites of [["rice", "rice"], [""], [42], null, Array.from({ length: 1001 }, (_, i) => String(i))]) {
    assert.throws(() => serializeKitchenBackup({ ...original, favoriteRecipeIds: favorites }));
  }
});

test("versioned exports and original backup files round-trip without changing state", () => {
  const original = kitchen();
  const exportedAt = "2026-10-22T10:00:00.000Z";
  const text = serializeKitchenBackup(original, exportedAt);
  const restored = parseKitchenBackup(text);
  assert.equal(restored.backupVersion, 2);
  assert.deepEqual(restored.state, { ...original, cookingProfile: DEFAULT_COOKING_PROFILE });
  restored.state.pantry[0].measure = "0 g";
  assert.equal(original.pantry[0].measure, "1 kg");
  assert.deepEqual(parseKitchenBackup(JSON.stringify({ exportedAt, state: original })).state, original);
});

test("unsupported versions, invalid states, dates and oversized backups fail before restore", () => {
  const backup = { exportedAt: "2026-10-22T10:00:00.000Z", state: kitchen() };
  for (const value of [{ ...backup, backupVersion: 3 }, { ...backup, backupVersion: 2 }, { ...backup, exportedAt: "tomorrow" }, { ...backup, state: { ...kitchen(), shoppingChecked: null } }, { ...backup, revision: 99 }]) {
    assert.throws(() => parseKitchenBackup(JSON.stringify(value)));
  }
  assert.throws(() => parseKitchenBackup(" ".repeat(2_000_001)), /storage limit/);
});

test("zero stock is absent and unknown amounts remain available by name", () => {
  const state = { ...kitchen(), pantry: [
    { id: "zero", name: "rice", measure: "0 g" },
    { id: "unknown", name: "rice", measure: "some" },
    { id: "restored", name: "rice", measure: "400 g" },
    { id: "beans", name: "beans", measure: "0 cans" },
  ] };
  assert.deepEqual(availablePantryNames(state.pantry), ["rice"]);
});

test("new kitchens start empty while existing legacy pantry is preserved", () => {
  assert.deepEqual(migrateLegacyKitchen(null, []).pantry, []);
  assert.deepEqual(migrateLegacyKitchen({ pantry: ["rice", "tomatoes"] }, []).pantry.map((item) => item.name), ["rice", "tomatoes"]);
});

test("cooking profiles round-trip in version 2 backups while old backups remain explicitly profile-free", () => {
  const cookingProfile = { ...DEFAULT_COOKING_PROFILE, allergies: ["milk", "peanut"], diet: "Vegan", equipment: ["Stovetop"] };
  const original = { ...kitchen(), cookingProfile };
  const restored = parseKitchenBackup(serializeKitchenBackup(original));
  assert.equal(restored.backupVersion, 2);
  assert.deepEqual(restored.state, original);
  assert.equal(compareKitchens(kitchen(), original).cookingProfileChanged, true);
  const older = parseKitchenBackup(JSON.stringify({ backupVersion: 1, exportedAt: "2026-10-22T10:00:00.000Z", state: kitchen() }));
  assert.equal(older.state.cookingProfile, undefined, "the restore UI must review current preferences instead of inventing preferences for an old backup");
  for (const bad of [null, { ...cookingProfile, version: 2 }, { ...cookingProfile, allergies: "milk" }, { ...cookingProfile, equipment: ["Oven", "Oven"] }, { ...cookingProfile, secret: "unexpected" }]) {
    assert.throws(() => validateCookingProfile(bad));
    assert.throws(() => serializeKitchenBackup({ ...kitchen(), cookingProfile: bad }));
  }
});

test("legacy profile parsing preserves explicit empty exclusions and rejects malformed values", () => {
  assert.deepEqual(parseLegacyCookingProfile({ allergies: [], equipment: [], diet: "Vegan" }), { ...DEFAULT_COOKING_PROFILE, allergies: [], equipment: [], diet: "Vegan" });
  for (const value of [null, {}, [], { allergies: null }, { allergies: "milk" }, { allergies: [42] }]) assert.equal(parseLegacyCookingProfile(value), null);
});
