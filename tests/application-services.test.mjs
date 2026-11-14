import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

// No Worker bindings or storage overrides: these factories must use only their supplied ports.
const sources = await createSourceLoader({ name: "application-services", externals: {
  "cloudflare:workers": "throw new Error('A service with injected ports must not load Cloudflare');",
} });
after(() => sources.dispose());
const { createKitchenService, KitchenConflictError } = await sources.import("app/lib/kitchen-service.ts");
const { createCatalogService } = await sources.import("app/lib/catalog-service.ts");
const { createChefService, ChefServiceError } = await sources.import("app/lib/chef-service.ts");
const { createChefModelTransport } = await sources.import("app/lib/chef-provider.ts");
const { parseChefRequest } = await sources.import("app/lib/chef-schema.ts");
const { EMPTY_KITCHEN, DEFAULT_COOKING_PROFILE } = await sources.import("app/lib/kitchen-types.ts");
const context = { mode: "hosted", userId: "owner", householdId: "family", role: "owner", timezone: "UTC", assistantEnabled: false };
const makeDocument = (revision = 3) => ({ revision, state: structuredClone(EMPTY_KITCHEN), updatedAt: "2026-11-12T12:00:00.000Z" });
const recipe = (id, ingredients) => ({ id, title: id === "plain" ? "Plain Rice" : "Peanut Rice", image: null, category: "Dinner", cuisine: "Test", tags: [], servings: 2,
  ingredients: ingredients.map(name => ({ name, measure: "200 g" })), instructions: ["Cook the rice until tender."], source: { name: "Synthetic", url: `https://example.test/${id}` }, sourceUrl: `https://example.test/${id}` });
const records = [recipe("plain", ["rice"]), recipe("peanut", ["rice", "peanut"])].map(recipe => ({ recipe, contentHash: "a".repeat(64), version: 1 }));
function catalogPorts() {
  const calls = [];
  return { calls, repository: {
    list: async (...args) => { calls.push(["list", ...args]); return records; },
    embeddings: async () => { calls.push(["embeddings"]); return []; },
    sourcePolicy: async () => ({ approval_status: "approved", allow_display: 1, allow_cache: 1, allow_index_text: 1, allow_derive: 1 }),
  } };
}
function commandPort(repository) {
  const receipts = new Map();
  return {
    async find(commandId) { const receipt = receipts.get(commandId); return receipt ? { ...receipt, replayed: true } : null; },
    async commit(change, context) {
      const document = change.applied ? await repository.save(change.current.revision, change.state, context) : change.current;
      const result = { commandId: change.commandId, applied: change.applied, document, replayed: false };
      receipts.set(change.commandId, result); return result;
    },
  };
}

test("Kitchen service propagates context and persists one validated command snapshot", async () => {
  let current = makeDocument(); const calls = [];
  const repository = {
    read: async scope => { assert.strictEqual(scope, context); return current; },
    save: async (revision, state, scope) => { assert.strictEqual(scope, context); calls.push({ revision, state }); current = { ...current, revision: revision + 1, state }; return current; },
  };
  const kitchen = createKitchenService(repository, commandPort(repository));
  const command = { type: "AddPantryBatches", commandId: "stock-1", expectedRevision: 3, batches: [{ id: "rice", name: "rice", measure: "1 kg" }] };
  const result = await kitchen.execute(command, context);
  assert.equal(result.applied, true); assert.equal(result.commandId, "stock-1"); assert.equal(result.document.revision, 4);
  assert.equal(calls.length, 1); assert.equal(calls[0].revision, 3);
  assert.deepEqual(current.state.pantry, command.batches);
  const replay = await kitchen.execute(command, context);
  assert.deepEqual(replay, { ...result, replayed: true });
  assert.equal(calls.length, 1, "an exact retry never repeats the mutation");
});

test("Kitchen service records a semantic no-op and leaves a racing compare-and-swap to the command repository", async () => {
  const initial = makeDocument(), winner = { ...makeDocument(4), state: { ...initial.state, pantry: [{ id: "winner", name: "beans", measure: "1 kg" }] } };
  let saves = 0;
  const repository = { read: async () => initial, save: async () => { saves++; throw new KitchenConflictError(winner); } };
  const kitchen = createKitchenService(repository, commandPort(repository));
  const rejected = await kitchen.execute({ type: "RemovePantryBatch", commandId: "already-removed", expectedRevision: 3, snapshot: { id: "absent", name: "rice", measure: "1 kg" } }, context);
  assert.equal(rejected.applied, false); assert.strictEqual(rejected.document, initial); assert.equal(saves, 0);
  assert.equal((await kitchen.execute({ type: "RemovePantryBatch", commandId: "already-removed", expectedRevision: 3, snapshot: { id: "absent", name: "rice", measure: "1 kg" } }, context)).replayed, true);
  await assert.rejects(kitchen.execute({ type: "AddPantryBatches", commandId: "loser", expectedRevision: 3, batches: [{ id: "loser", name: "rice", measure: "1 kg" }] }, context), error => error instanceof KitchenConflictError && error.current === winner);
  assert.equal(saves, 1); assert.deepEqual(initial.state.pantry, []); assert.equal(winner.state.pantry.length, 1);
});

test("Kitchen service rejects a member's profile command before calling persistence", async () => {
  const current = makeDocument(); current.state.cookingProfile = { ...DEFAULT_COOKING_PROFILE, allergies: ["peanut"] };
  let saves = 0;
  const repository = { read: async () => { assert.fail("Owner-only commands stop before state access"); }, save: async () => { saves++; assert.fail("Member profile edits must not be persisted"); } };
  const kitchen = createKitchenService(repository, commandPort(repository));
  await assert.rejects(kitchen.execute({ type: "SetCookingProfile", commandId: "remove-allergy", expectedRevision: 3, profile: DEFAULT_COOKING_PROFILE }, { ...context, role: "member" }), error => error.code === "OWNER_REQUIRED");
  assert.equal(saves, 0);
  assert.deepEqual(current.state.cookingProfile.allergies, ["peanut"]);
});

test("Kitchen service rejects malformed intent before reading state or retry receipts", async () => {
  const forbidden = async () => { assert.fail("Malformed commands must stop before a repository call"); };
  const kitchen = createKitchenService({ read: forbidden, save: forbidden }, { find: forbidden, commit: forbidden });
  await assert.rejects(kitchen.execute({ type: "AddPantryBatches", commandId: "invalid", expectedRevision: 3, batches: [{ id: "bad", name: "rice", measure: "-1 g" }] }, context), error => error.name === "KitchenCommandValidationError");
});

test("Catalog service runs actual constrained lexical ranking entirely through injected ports", async () => {
  const { calls, repository } = catalogPorts();
  const catalog = createCatalogService(repository, { semanticSearchEnabled: () => false, embedTexts: async () => { throw new Error("Embeddings are disabled"); } });
  const result = await catalog.search({ query: "rice", allergies: ["peanut"] }, "test-model");
  assert.deepEqual(result.recipes.map(recipe => recipe.id), ["plain"]);
  assert.equal(result.allergyExcludedCount, 1);
  assert.deepEqual(calls, [["list", 1000]]);
  assert.equal(result.method, "lexical_pantry");
});

test("Chef service uses the scoped saved profile without mutating input or invoking a model", async () => {
  const { repository } = catalogPorts();
  const catalog = createCatalogService(repository, { semanticSearchEnabled: () => false });
  const current = makeDocument(); current.state.cookingProfile = { ...DEFAULT_COOKING_PROFILE, allergies: ["peanut"] };
  let reads = 0;
  const forbidden = async () => { throw new Error("Hosted phase one cannot use a model"); };
  const chef = createChefService({ kitchen: { read: async scope => { assert.strictEqual(scope, context); reads++; return current; } }, catalog,
    models: { generate: forbidden, embed: forbidden, verify: forbidden, checkVerifier: forbidden } });
  const input = parseChefRequest({ query: "Suggest rice for dinner", provider: "openai", profile: { allergies: [] }, pantry: ["peanut"] });
  const before = structuredClone(input);
  const answer = await chef.answer(input, { household: context });
  assert.deepEqual(answer.recipes.map(recipe => recipe.id), ["plain"]);
  assert.notEqual(answer.generation, "ai"); assert.ok(reads > 0);
  assert.deepEqual(input, before);
});

test("Chef service rejects an outdated kitchen before searching or touching provider ports", async () => {
  const forbidden = async () => { assert.fail("Stale context must stop before retrieval or model access"); };
  const chef = createChefService({ kitchen: { read: async () => makeDocument(4) },
    catalog: { search: forbidden, list: forbidden, embeddings: forbidden, sourcePolicy: forbidden },
    models: { generate: forbidden, embed: forbidden, verify: forbidden, checkVerifier: forbidden } });
  await assert.rejects(chef.answer(parseChefRequest({ query: "Suggest dinner", context: { kitchenRevision: 3 } }), { household: context }),
    error => error instanceof ChefServiceError && error.status === 409 && error.code === "kitchen_changed");
});

test("ambiguous follow-ups recheck recipe permissions and kitchen revisions before returning choices", async () => {
  for (const change of ["recipe", "kitchen"]) {
    const current = makeDocument(); const { repository } = catalogPorts();
    const catalog = createCatalogService(repository, { semanticSearchEnabled: () => false });
    const search = catalog.search;
    catalog.search = async (...args) => {
      const result = await search(...args);
      if (change === "recipe") repository.list = async () => [];
      else current.revision++;
      return result;
    };
    const forbidden = async () => assert.fail("An ambiguous follow-up must not call model providers");
    const chef = createChefService({ kitchen: { read: async () => current }, catalog,
      models: { generate: forbidden, embed: forbidden, verify: forbidden, checkVerifier: forbidden } });
    await assert.rejects(chef.answer(parseChefRequest({ query: "Can I make it?", history: [{ role: "user", content: "Suggest rice for dinner" }] }), { household: context }),
      error => error instanceof ChefServiceError && error.code === "context_changed", change);
  }
});

test("model transport's deadline covers a stalled body after response headers", async () => {
  let aborted = false;
  const transport = createChefModelTransport({ timeoutMs: 20, fetchImpl: async (_url, init) => new Response(new ReadableStream({
    start(controller) { init.signal.addEventListener("abort", () => { aborted = true; controller.error(new DOMException("Aborted", "AbortError")); }, { once: true }); },
  }), { status: 200, headers: { "content-type": "application/json" } }) });
  await assert.rejects(transport.generate({ provider: "ollama", model: "test", systemPrompt: "Test", userPrompt: "Test", schema: {} }), error => error.code === "provider_unavailable");
  assert.equal(aborted, true);
});

test("model transport keeps malformed successful provider JSON distinct from an outage", async () => {
  const transport = createChefModelTransport({ fetchImpl: async () => new Response("broken json", { status: 200 }) });
  await assert.rejects(transport.generate({ provider: "ollama", model: "test", systemPrompt: "Test", userPrompt: "Test", schema: {} }),
    error => error.code === "invalid_provider_response" && error.status === 502);
});
