import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Execute the actual application modules and their SQL. Only the Worker binding
// is replaced: a small D1 adapter forwards prepared statements to real SQLite.
const directory = await mkdtemp(join(tmpdir(), "jff-kitchen-persistence-"));
const database = new DatabaseSync(":memory:");
const migration = await readFile(new URL("../drizzle/0001_friendly_titania.sql", import.meta.url), "utf8");
database.exec(migration);

after(async () => {
  database.close();
  await rm(directory, { recursive: true, force: true });
});

await writeFile(join(directory, "test-cloudflare.mjs"), "export const env = { DB: undefined };\n");
for (const [name, sourcePath] of [
  ["kitchen-store", "../app/lib/kitchen-store.ts"],
  ["kitchen-validation", "../app/lib/kitchen-validation.ts"],
  ["kitchen-route", "../app/api/kitchen/route.ts"],
]) {
  const source = await readFile(new URL(sourcePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  await writeFile(join(directory, `${name}.mjs`), compiled
    .replaceAll('"cloudflare:workers"', '"./test-cloudflare.mjs"')
    .replaceAll('"@/app/lib/kitchen-store"', '"./kitchen-store.mjs"')
    .replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"'));
}

const { env } = await import(pathToFileURL(join(directory, "test-cloudflare.mjs")).href);
const store = await import(pathToFileURL(join(directory, "kitchen-store.mjs")).href);
const route = await import(pathToFileURL(join(directory, "kitchen-route.mjs")).href);
const queries = [];
const binding = {
  prepare(sql) {
    queries.push(sql);
    return {
      bind(...values) {
        return {
          async first() {
            // Let concurrent requests reach their write before either resolves.
            await Promise.resolve();
            return database.prepare(sql).get(...values) ?? null;
          },
        };
      },
    };
  },
};

beforeEach(() => {
  database.exec("DELETE FROM kitchen_state");
  queries.length = 0;
  env.DB = binding;
});

function starterRecipe(overrides = {}) {
  return {
    id: "local-rice-bowl",
    title: "Rice bowl",
    image: "",
    category: "Weeknight dinner",
    cuisine: "Home cooking",
    source: { name: "Local starter", url: "#source-note" },
    sourceUrl: "#source-note",
    ingredients: [{ name: "rice", measure: "400 g" }],
    instructions: ["Cook the rice until tender."],
    tags: ["pantry"],
    ...overrides,
  };
}

function plannedMeal(overrides = {}) {
  return {
    id: "meal-1",
    date: "2026-10-20",
    recipeId: "local-rice-bowl",
    recipe: starterRecipe(),
    title: "Rice bowl",
    baseServings: null,
    servings: null,
    batches: 1,
    locked: false,
    status: "planned",
    ingredientOverrides: {},
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    schemaVersion: 2,
    pantry: [{ id: "rice-stock", name: "rice", measure: "1 kg" }],
    meals: { "2026-10-20": plannedMeal() },
    shoppingChecked: {},
    migratedLegacy: false,
    ...overrides,
  };
}

function request(body, headers = {}) {
  return new Request("http://localhost/api/kitchen", {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function responseJson(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}

function valid(value) {
  assert.doesNotThrow(() => store.validateKitchenWrite({ revision: 0, state: value }));
}

function invalid(value) {
  assert.throws(() => store.validateKitchenWrite({ revision: 0, state: value }), store.KitchenValidationError);
}

test("GET starts at revision zero and does not create the migration-owned table", async () => {
  assert.deepEqual(await responseJson(await route.GET(), 200), {
    revision: 0, state: null, updatedAt: null,
  });
  assert.ok(queries.length > 0);
  assert.ok(queries.every((query) => !/^\s*(?:CREATE|ALTER|DROP)\b/i.test(query)));
});

test("local starter anchor attribution and empty images save and reload intact", async () => {
  const kitchen = state();
  const saved = await responseJson(await route.PUT(request({ revision: 0, state: kitchen })), 200);
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.state, kitchen);
  assert.equal(saved.updatedAt, new Date(saved.updatedAt).toISOString());
  assert.deepEqual(await responseJson(await route.GET(), 200), saved);
  valid(state({ meals: { "2026-10-20": plannedMeal({ recipe: starterRecipe({ image: null }) }) } }));
});

test("snapshot shapes stay strict and only the explicit local starter may use anchor URLs", () => {
  const badRecipes = [
    { id: "local-rice-bowl" },
    starterRecipe({ unknown: true }),
    starterRecipe({ source: { name: "Other source", url: "#source-note" } }),
    starterRecipe({ sourceUrl: "#another-anchor" }),
    starterRecipe({ image: "javascript:alert(1)" }),
    starterRecipe({ ingredients: [{ name: "rice", measure: "1 kg", unknown: true }] }),
    starterRecipe({ servings: Infinity }),
    starterRecipe({ id: "mismatched-id" }),
  ];
  for (const recipe of badRecipes) {
    invalid(state({ meals: { "2026-10-20": plannedMeal({ recipe }) } }));
  }
  valid(state({ meals: { "2026-10-20": plannedMeal({ recipe: null }) } }));
  valid(state({ meals: { "2026-10-20": plannedMeal({ recipe: starterRecipe({
    source: { name: "Recipe source", url: "https://example.com" },
    sourceUrl: "https://example.com/recipe",
    image: "https://example.com/recipe.jpg",
  }) }) } }));
});

test("calendar dates, date keys, and completion timestamps reject impossible values", async () => {
  for (const day of ["2026-02-30", "2026-02-29", "2026-13-01", "0000-01-01", "2026-1-02"]) {
    invalid(state({ meals: { [day]: plannedMeal({ date: day }) } }));
  }
  invalid(state({ meals: { "2026-10-21": plannedMeal() } }));
  invalid(state({ meals: { "2026-10-20": plannedMeal({
    status: "cooked",
    completion: { id: "completion-1", at: "2026-02-30T12:00:00.000Z", deductions: [] },
  }) } }));
  valid(state({ meals: { "2024-02-29": plannedMeal({ date: "2024-02-29" }) } }));
  const malformed = state({ meals: { "2026-02-30": plannedMeal({ date: "2026-02-30" }) } });
  const result = await responseJson(await route.PUT(request({ revision: 0, state: malformed })), 400);
  assert.equal(result.error.code, "INVALID_KITCHEN");
  assert.equal((await store.getKitchenDocument()).revision, 0);
});

test("nonfinite, negative, and impossible quantities fail while free text remains usable", () => {
  for (const measure of ["-2 cups", "−2 g", "1/0 cup", "1/-2 cups", "NaN g", "Infinity cups", "1e309 g"]) {
    invalid(state({ pantry: [{ id: "rice-stock", name: "rice", measure }] }));
  }
  for (const amount of [NaN, Infinity, -1, 0]) {
    invalid(state({ meals: { "2026-10-20": plannedMeal({ batches: amount }) } }));
  }
  for (const measure of ["1 1/2 cups", "1/0.5 cups", "½ cup", "to taste", ""]) {
    valid(state({ pantry: [{ id: "rice-stock", name: "rice", measure }] }));
  }
  for (const revision of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => store.validateKitchenWrite({ revision, state: state() }), store.KitchenValidationError);
  }
});

test("completion deduction names persist for undo and are bounded", async () => {
  const completion = {
    id: "completion-1", at: "2026-10-20T12:00:00.000Z",
    deductions: [{ pantryId: "rice-stock", name: "rice", before: "1 kg", after: "600 g" }],
  };
  const kitchen = state({ meals: { "2026-10-20": plannedMeal({ status: "cooked", completion }) } });
  await responseJson(await route.PUT(request({ revision: 0, state: kitchen })), 200);
  const reloaded = await responseJson(await route.GET(), 200);
  assert.deepEqual(reloaded.state.meals["2026-10-20"].completion, completion);
  for (const name of ["", "x".repeat(201), 42]) {
    const changed = structuredClone(kitchen);
    changed.meals["2026-10-20"].completion.deductions[0].name = name;
    invalid(changed);
  }
  delete kitchen.meals["2026-10-20"].completion.deductions[0].name;
  valid(kitchen);
});

test("state validation rejects unknown fields and duplicate identities, and retains dated history", () => {
  invalid(state({ unexpected: true }));
  invalid(state({ pantry: [
    { id: "duplicate", name: "rice", measure: "1 kg" },
    { id: "duplicate", name: "rice", measure: "2 kg" },
  ] }));
  invalid(state({ meals: {
    "2026-10-20": plannedMeal(),
    "2026-10-21": plannedMeal({ date: "2026-10-21" }),
  } }));
  const meals = {};
  for (let index = 0; index < 1_001; index++) {
    const day = new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10);
    meals[day] = plannedMeal({ id: `meal-${index}`, date: day, recipe: null });
  }
  valid(state({ meals }));
});

test("PUT bounds declared and actual UTF-8 bodies and rejects unsupported or malformed requests", async () => {
  await responseJson(await route.PUT(request("{}", { "content-type": "text/plain" })), 415);
  await responseJson(await route.PUT(request("not JSON")), 400);
  await responseJson(await route.PUT(request("{}")), 400);
  await responseJson(await route.PUT(request("{}", {
    "content-length": String(store.MAX_KITCHEN_BODY_BYTES + 1),
  })), 413);
  // No Content-Length: character count is under the limit but UTF-8 bytes exceed it.
  await responseJson(await route.PUT(request("é".repeat(store.MAX_KITCHEN_BODY_BYTES / 2 + 1))), 413);
  assert.equal((await store.getKitchenDocument()).revision, 0);
});

test("simultaneous initial saves have one winner and return the winning document in 409", async () => {
  const first = state();
  const second = state({ migratedLegacy: true });
  const responses = await Promise.all([
    route.PUT(request({ revision: 0, state: first })),
    route.PUT(request({ revision: 0, state: second })),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const winner = await responseJson(responses.find((response) => response.status === 200), 200);
  const conflict = await responseJson(responses.find((response) => response.status === 409), 409);
  assert.equal(winner.revision, 1);
  assert.equal(conflict.error.code, "REVISION_CONFLICT");
  assert.deepEqual(conflict.current, winner);
  assert.deepEqual(await responseJson(await route.GET(), 200), winner);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM kitchen_state").get().count, 1);
});

test("stale updates cannot overwrite a newer revision and return its current state", async () => {
  await responseJson(await route.PUT(request({ revision: 0, state: state() })), 200);
  const changed = state({ pantry: [{ id: "rice-stock", name: "rice", measure: "2 kg" }] });
  const saved = await responseJson(await route.PUT(request({ revision: 1, state: changed })), 200);
  assert.equal(saved.revision, 2);
  const stale = await responseJson(await route.PUT(request({ revision: 1, state: state() })), 409);
  assert.equal(stale.error.code, "REVISION_CONFLICT");
  assert.deepEqual(stale.current, saved);
  assert.deepEqual(await responseJson(await route.GET(), 200), saved);
});

test("concurrent updates of the same revision do not silently lose a write", async () => {
  await store.saveKitchenDocument(0, state());
  const changes = ["2 kg", "3 kg"].map((measure) => state({ pantry: [{ id: "rice-stock", name: "rice", measure }] }));
  const responses = await Promise.all(changes.map((value) => route.PUT(request({ revision: 1, state: value }))));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const winner = await responseJson(responses.find((response) => response.status === 200), 200);
  const conflict = await responseJson(responses.find((response) => response.status === 409), 409);
  assert.equal(winner.revision, 2);
  assert.deepEqual(conflict.current, winner);
  assert.deepEqual(await store.getKitchenDocument(), winner);
});

test("nonzero initial revisions conflict without inserting a row", async () => {
  const conflict = await responseJson(await route.PUT(request({ revision: 8, state: state() })), 409);
  assert.deepEqual(conflict.current, { revision: 0, state: null, updatedAt: null });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM kitchen_state").get().count, 0);
});

test("missing storage fails explicitly without exposing internal error details", async () => {
  env.DB = undefined;
  const getError = await responseJson(await route.GET(), 503);
  const putError = await responseJson(await route.PUT(request({ revision: 0, state: state() })), 503);
  assert.equal(getError.error.code, "KITCHEN_UNAVAILABLE");
  assert.deepEqual(putError, getError);
  assert.doesNotMatch(getError.error.message, /D1|binding|cloudflare|SQL/i);
});
