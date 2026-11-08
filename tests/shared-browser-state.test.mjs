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
const { scopedStorage, accountStoragePrefix, clearAccountStorage, householdDate, browserScope, mirroredStorage, migrateSecureLocalStorage, SECURE_LOCAL_PREFIX, readStorageForWrite, discardPendingStorageItem } = await import(pathToFileURL(join(dir, "private-storage.mjs")));
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

test("protected storage preserves failed writes in memory and reads changes from other tabs", () => {
  const raw = memoryStorage(), memory = new Map(), storage = mirroredStorage(() => raw, memory);
  storage.setItem("draft", "saved");
  raw.setItem("draft", "another tab");
  assert.equal(storage.getItem("draft"), "another tab");
  const write = raw.setItem;
  raw.setItem = () => { throw new Error("Quota exceeded"); };
  assert.throws(() => storage.setItem("draft", "pending changes"), /Quota/);
  assert.equal(storage.getItem("draft"), "pending changes");
  raw.setItem = write;
  storage.setItem("draft", "recovered");
  assert.equal(raw.getItem("draft"), "recovered");
  raw.setItem("draft", "later shared change");
  assert.equal(storage.getItem("draft"), "later shared change");
});

test("secure local migration moves private keys once and preserves appearance and other applications", () => {
  const raw = memoryStorage();
  raw.setItem("rag-chef-kitchen-v2", "kitchen");
  raw.setItem("rag-chef-kitchen-v2:draft:one", "unsaved");
  raw.setItem("rag-chef-cooking-v1", "timer");
  raw.setItem("rag-chef-theme", "dark");
  raw.setItem("another-app", "unrelated");
  raw.setItem("rag-chef-account:alice:home:private", "hosted");
  migrateSecureLocalStorage(raw);
  assert.equal(raw.getItem(`${SECURE_LOCAL_PREFIX}rag-chef-kitchen-v2:draft:one`), "unsaved");
  assert.equal(raw.getItem(`${SECURE_LOCAL_PREFIX}rag-chef-cooking-v1`), "timer");
  assert.equal(raw.getItem("rag-chef-kitchen-v2"), null);
  assert.equal(raw.getItem("rag-chef-theme"), "dark");
  assert.equal(raw.getItem("another-app"), "unrelated");
  assert.equal(raw.getItem("rag-chef-account:alice:home:private"), "hosted");
  raw.setItem("rag-chef-kitchen-v2", "later plain local kitchen");
  migrateSecureLocalStorage(raw);
  assert.equal(raw.getItem(`${SECURE_LOCAL_PREFIX}rag-chef-kitchen-v2`), "kitchen");
});

test("discarding a pending mirror adopts shared changes and deletions without resurrecting the draft", () => {
  for (const saved of ["newer saved progress", null]) {
    const raw = memoryStorage(), memory = new Map(), mirror = mirroredStorage(() => raw, memory);
    const scoped = scopedStorage(() => mirror, "private:");
    scoped.setItem("cooking", "old saved progress");
    const write = raw.setItem;
    raw.setItem = () => { throw new Error("Quota exceeded"); };
    assert.throws(() => scoped.setItem("cooking", "my unsaved progress"), /Quota/);
    raw.setItem = write;
    if (saved === null) raw.removeItem("private:cooking"); else raw.setItem("private:cooking", saved);
    assert.equal(readStorageForWrite(scoped, "cooking"), saved);
    assert.equal(scoped.getItem("cooking"), "my unsaved progress", "comparison alone retains the recovery draft");
    assert.equal(discardPendingStorageItem(scoped, "cooking"), saved);
    assert.equal(scoped.getItem("cooking"), saved);
    raw.getItem = () => { throw new Error("Storage denied"); };
    assert.equal(scoped.getItem("cooking"), saved, "later fallback never resurrects a discarded draft");
  }
});

test("revoking a browser scope aborts requests as well as storage access", () => {
  const scope = browserScope("local:one"), requestSignal = scope.signal;
  scope.revoke();
  assert.equal(requestSignal.aborted, true); assert.equal(scope.isActive(), false);
  scope.activate();
  assert.equal(scope.signal.aborted, false);
  assert.equal(requestSignal.aborted, true, "effect replay never revives an already aborted request");
});
