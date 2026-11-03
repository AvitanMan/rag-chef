import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
const dir = await mkdtemp(join(tmpdir(), "jff-account-state-"));
after(() => rm(dir, { recursive: true, force: true }));
for (const name of ["private-storage", "kitchen-merge"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(dir, `${name}.mjs`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const { scopedStorage, accountStoragePrefix, clearAccountStorage, householdDate, browserScope } = await import(pathToFileURL(join(dir, "private-storage.mjs")));
const { mergeKitchenDraft } = await import(pathToFileURL(join(dir, "kitchen-merge.mjs")));
function memoryStorage() { const values = new Map(); return { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k), clear: () => values.clear() }; }
const kitchen = () => ({ schemaVersion: 2, pantry: [{ id: "rice", name: "rice", measure: "1 kg" }], meals: {}, shoppingChecked: {}, migratedLegacy: true });

test("account storage enumeration, recovery, and deletion cannot cross family or account boundaries", () => {
  const raw = memoryStorage(); raw.setItem("rag-chef-kitchen-v2", "standalone");
  const alice = scopedStorage(() => raw, accountStoragePrefix("a:b", "home"));
  const bob = scopedStorage(() => raw, accountStoragePrefix("a", "b:home"));
  alice.setItem("rag-chef-kitchen-v2:draft:1", "alice"); bob.setItem("rag-chef-kitchen-v2:draft:1", "bob");
  assert.equal(alice.length, 1); assert.equal(alice.key(0), "rag-chef-kitchen-v2:draft:1");
  assert.equal(bob.getItem(alice.key(0)), "bob");
  clearAccountStorage(raw, "a:b"); assert.equal(alice.length, 0); assert.equal(bob.length, 1);
  assert.equal(raw.getItem("rag-chef-kitchen-v2"), "standalone");
});
test("revoked storage facades reject delayed writes after logout", () => {
  const raw = memoryStorage(); let active = true;
  const old = scopedStorage(() => raw, accountStoragePrefix("alice", "home"), () => active);
  old.setItem("draft", "private"); old.clear(); active = false;
  old.setItem("draft", "late network response"); assert.equal(raw.length, 0); assert.equal(old.getItem("draft"), null);
});
test("household dates follow the selected timezone across UTC midnight and daylight savings", () => {
  assert.equal(householdDate("Asia/Jerusalem", new Date("2026-11-03T22:30:00Z")), "2026-11-04");
  assert.equal(householdDate("America/Los_Angeles", new Date("2026-11-04T02:30:00Z")), "2026-11-03");
  assert.equal(householdDate("America/New_York", new Date("2026-11-01T06:30:00Z")), "2026-11-01");
});
test("family merge preserves independent pantry changes and saved action receipts", () => {
  const base = kitchen(), mine = structuredClone(base), saved = structuredClone(base);
  mine.pantry[0].measure = "500 g"; saved.pantry.push({ id: "onion", name: "onion", measure: "2" });
  saved.recentActionReceipts = [{ id: "server-receipt" }]; mine.recentActionReceipts = [];
  const merged = mergeKitchenDraft(base, mine, saved);
  assert.deepEqual(merged.conflicts, []); assert.equal(merged.state.pantry[0].measure, "500 g");
  assert.equal(merged.state.pantry[1].name, "onion"); assert.deepEqual(merged.state.recentActionReceipts, saved.recentActionReceipts);
});
test("family merge requires an explicit choice for overlapping changes and never drops other edits", () => {
  const base = kitchen(), mine = structuredClone(base), saved = structuredClone(base);
  mine.pantry[0].measure = "500 g"; saved.pantry[0].measure = "200 g";
  mine.shoppingChecked.a = true; saved.shoppingChecked.b = true;
  assert.equal(mergeKitchenDraft(base, mine, saved).conflicts.length, 1);
  const merged = mergeKitchenDraft(base, mine, saved, true);
  assert.equal(merged.state.pantry[0].measure, "500 g"); assert.deepEqual(merged.state.shoppingChecked, { a: true, b: true });
  assert.equal(mergeKitchenDraft(base, mine, saved).state.pantry[0].measure, "200 g");
});

test("returning to the same account never reactivates earlier storage capabilities", () => {
  const raw = memoryStorage(), first = browserScope("alice:home");
  const old = scopedStorage(() => raw, "alice:", first.isActive);
  old.setItem("draft", "first"); first.revoke();
  const returning = browserScope("alice:home"); returning.activate();
  old.setItem("draft", "delayed earlier reply");
  assert.equal(raw.getItem("alice:draft"), "first"); assert.equal(first.isActive(), false);
});
