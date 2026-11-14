import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";
const sources = await createSourceLoader({ name: "kitchen-write-queue" });
after(() => sources.dispose());
const { parseKitchenWriteQueue, prepareKitchenWrite, appendKitchenCommand, appendKitchenSnapshot, MAX_PENDING_KITCHEN_WRITES } = await sources.import("app/lib/kitchen-write-queue.ts");
const { readRecoveryDrafts } = await sources.import("app/lib/kitchen-recovery.ts");
const { KITCHEN_CACHE_KEY } = await sources.import("app/lib/kitchen-state.ts");
const state = { schemaVersion: 2, pantry: [], meals: {}, shoppingChecked: {}, migratedLegacy: true };
const command = (commandId = "first") => ({ type: "SetFavorite", commandId, expectedRevision: 1, recipeId: "rice", favorite: true });
const pending = (id = "first") => ({ kind: "command", command: command(id), attempted: false });

test("persisted queues validate attempted ordering, revisions and unique command identities", () => {
  const valid = { version: 1, writes: [{ ...pending(), attempted: true }, { kind: "snapshot", state }, pending("last")] };
  assert.deepEqual(parseKitchenWriteQueue(valid), valid);
  for (const writes of [
    [pending(), { ...pending("last"), attempted: true }], [pending(), pending()],
    [{ kind: "snapshot", state, expectedRevision: null }], [{ kind: "snapshot", state, expectedRevision: -1 }],
    [pending(), { kind: "snapshot", state, expectedRevision: 1 }],
    [{ ...pending(), attempted: "yes" }], [{ ...pending(), command: { ...command(), extra: true } }],
  ]) assert.throws(() => parseKitchenWriteQueue({ version: 1, writes }));
});

test("only an unattempted head receives the latest revision and retries preserve the exact envelope", () => {
  const original = pending();
  const attempted = prepareKitchenWrite(original, 5);
  assert.equal(attempted.command.expectedRevision, 5); assert.equal(attempted.attempted, true);
  assert.equal(original.command.expectedRevision, 1); assert.equal(original.attempted, false);
  assert.strictEqual(prepareKitchenWrite(attempted, 99), attempted);
  const snapshot = prepareKitchenWrite({ kind: "snapshot", state }, 5);
  assert.strictEqual(prepareKitchenWrite(snapshot, 99), snapshot);
});

test("queue limits fail before adding an intent while an unattempted snapshot can still coalesce", () => {
  const full = Array.from({ length: MAX_PENDING_KITCHEN_WRITES }, (_, i) => pending(`intent-${i}`));
  assert.throws(() => appendKitchenCommand(full, command("overflow")));
  assert.throws(() => appendKitchenSnapshot(full, state));
  assert.equal(full.length, MAX_PENDING_KITCHEN_WRITES);
  const lastSnapshot = [...full.slice(0, -1), { kind: "snapshot", state }];
  const changed = { ...state, favoriteRecipeIds: ["rice"] };
  const result = appendKitchenSnapshot(lastSnapshot, changed);
  assert.equal(result.length, MAX_PENDING_KITCHEN_WRITES); assert.deepEqual(result.at(-1).state, changed);
  assert.deepEqual(lastSnapshot.at(-1).state, state);
});

test("an equal projected kitchen retains its unresolved command and inverse for recovery", () => {
  const id = `${KITCHEN_CACHE_KEY}:draft:unconfirmed`;
  const serialized = JSON.stringify({ revision: 1, dirty: true, state,
    writeQueue: { version: 1, writes: [{ ...pending(), attempted: true }, { ...pending("undo"), command: { ...command("undo"), favorite: false } }] } });
  const storage = { length: 1, key: () => id, getItem: () => serialized };
  const drafts = readRecoveryDrafts(storage, state);
  assert.equal(drafts.length, 1); assert.equal(drafts[0].cached.writeQueue.writes.length, 2);
  assert.equal(drafts[0].summary.differences.favoritesChanged, 0);
});
