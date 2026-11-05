import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
const dir = await mkdtemp(join(tmpdir(), "chef-plan-intent-"));
after(() => rm(dir, { recursive: true, force: true }));
for (const file of await readdir(new URL('../app/lib/', import.meta.url))) {
  if (!file.endsWith('.ts')) continue;
  const source = await readFile(new URL(`../app/lib/${file}`, import.meta.url), "utf8");
  await writeFile(join(dir, file.replace(/\.ts$/, '.mjs')), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"'));
}
const { defaultPlanIntent, resolveChefPlanIntent, requestChefPlanIntent, positiveRecipeQuery } = await import(pathToFileURL(join(dir, "chef-plan-intent.mjs")));
const base = () => defaultPlanIntent("2026-11-02", "2026-11-03");
const resolve = (query, intent = base(), generated) => resolveChefPlanIntent(query, intent, generated);
const modelInterpretation = () => ({ count: null, servings: null, batches: null, dates: [], excludedIngredients: [], diets: [], excludedEquipment: [], maxTotalMinutes: null, priority: null, allowRepeats: null, evidence: Object.fromEntries(["count", "servings", "batches", "excludedIngredients", "diets", "excludedEquipment", "maxTotalMinutes", "priority", "allowRepeats"].map(field => [field, ""])) });
test("explicit count, servings and priority override incorrect model slots", () => {
  const { intent } = resolve("Plan three dinners for four people using food that expires soon.", base(), { count: 1, servings: 2, priority: "variety" });
  assert.equal(intent.count, 3); assert.equal(intent.servings, 4); assert.equal(intent.priority, "use_soon");
  assert.equal(resolve("Plan two dinners with fewer groceries", base(), { priority: "use_soon" }).intent.priority, "fewer_groceries");
});
test("negated exclusions preserve independent allergy requests without inventing negatives", () => {
  const { intent } = resolve("Plan two dinners. Do not exclude mushrooms; avoid peanuts.", base(), { excludedIngredients: ["mushrooms", "peanuts"] });
  assert.deepEqual(intent.excludedIngredients, ["peanuts"]);
  assert.deepEqual(resolve("No repeats. Avoid eggs.").intent.excludedIngredients, ["eggs"]);
});
test("draft revisions resolve exact days and preserve other dates and requirements", () => {
  const previous = { ...base(), dates: ["2026-11-03", "2026-11-05", "2026-11-06"], count: 3, servings: 4, excludedIngredients: ["peanuts"] };
  const { intent } = resolve("Keep Tuesday, replace Thursday, and make Friday vegetarian.", previous);
  assert.deepEqual(intent.keepDates, ["2026-11-03"]); assert.deepEqual(intent.replaceDates, ["2026-11-05"]);
  assert.equal(intent.perDate["2026-11-06"].diet, "vegetarian"); assert.deepEqual(intent.diets, []);
  assert.deepEqual(intent.excludedIngredients, ["peanuts"]); assert.equal(intent.servings, 4);
  assert.deepEqual(intent.dates, previous.dates);
});
test("per-date portions and batch changes do not change the whole week", () => {
  const previous = { ...base(), dates: ["2026-11-03", "2026-11-04"], servings: 4 };
  const { intent } = resolve("Make Wednesday for two people.", previous);
  assert.equal(intent.servings, 4); assert.equal(intent.perDate["2026-11-04"].servings, 2);
  assert.equal(resolve("Make tomorrow for two people.", previous).intent.perDate["2026-11-04"].servings, 2);
  assert.equal(resolve("Plan two dinners using 0.5 recipe batches.").intent.batches, 0.5);
});
test("ambiguous references and dates outside one future week require clarification", () => {
  for (const query of ["Replace it", "Plan Monday", "Plan 2026-11-10", "Plan next week", "Plan eight dinners", "Plan two weeks"]) assert.ok(resolve(query).clarification, query);
  assert.deepEqual(resolve("Plan tomorrow").intent.dates, ["2026-11-04"]);
  assert.deepEqual(resolve("Plan the weekend").intent.dates, ["2026-11-07", "2026-11-08"]);
});
test("time and equipment requests preserve source-only constraints in typed intent", () => {
  const { intent } = resolve("Plan two vegetarian dinners under 30 minutes without an oven.");
  assert.equal(intent.maxTotalMinutes, 30); assert.deepEqual(intent.diets, ["vegetarian"]); assert.deepEqual(intent.excludedEquipment, ["oven"]);
});
test("model output is bounded and cannot introduce hidden command fields", () => {
  for (const value of [{ actions: ["save"] }, { servings: "two" }, { dates: [2] }, []]) assert.throws(() => resolve("Plan two dinners", base(), value));
});
test("Ollama interpretation uses one local bounded call and has a manual fallback error", async () => {
  const original = globalThis.fetch, previousUrl = process.env.OLLAMA_BASE_URL;
  let calls = 0;
  try {
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
    globalThis.fetch = async (url, options) => { calls++; assert.match(url, /^http:\/\/127\.0\.0\.1:11434\/api\/chat$/); const body = JSON.parse(options.body); assert.equal(body.stream, false); assert.equal(body.think, false); assert.equal(options.redirect, "manual"); assert.ok(body.format.properties.count); assert.ok(options.signal); return Response.json({ message: { content: JSON.stringify({ ...modelInterpretation(), count: 2 }) } }); };
    assert.equal((await requestChefPlanIntent({ query: "Plan two dinners", week: base().week, today: base().today })).intent.count, 2); assert.equal(calls, 1);
    process.env.OLLAMA_BASE_URL = "https://example.com";
    await assert.rejects(requestChefPlanIntent({ query: "Plan two dinners", week: base().week, today: base().today }), /local Ollama/); assert.equal(calls, 1);
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434"; globalThis.fetch = async () => { throw new Error("offline"); };
    await assert.rejects(requestChefPlanIntent({ query: "Plan two dinners", week: base().week, today: base().today }), /manual planning controls/);
  } finally { globalThis.fetch = original; if (previousUrl === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = previousUrl; }
});

test("the Ollama boundary rejects incomplete or schema-invalid output without accepting defaults", async () => {
  const original = globalThis.fetch, previousUrl = process.env.OLLAMA_BASE_URL;
  try {
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
    for (const value of [{}, { ...modelInterpretation(), priority: "price" }, { ...modelInterpretation(), priority: ["variety"] }, { ...modelInterpretation(), evidence: { count: "two dinners" } }, { ...modelInterpretation(), count: 2.5 }, { ...modelInterpretation(), servings: 101 }, { ...modelInterpretation(), dates: Array(8).fill("2026-11-03") }, { ...modelInterpretation(), diets: ["paleo"] }, { ...modelInterpretation(), allowRepeats: "yes" }, { ...modelInterpretation(), constructor: "unknown field" }]) {
      globalThis.fetch = async () => Response.json({ message: { content: JSON.stringify(value) } });
      await assert.rejects(requestChefPlanIntent({ query: "Plan two dinners", week: base().week, today: base().today }), error => error.code === "invalid_interpretation" && /planning controls/.test(error.message));
    }
    assert.equal(resolve("Plan two dinners", base(), {}).intent.count, 2);
  } finally { globalThis.fetch = original; if (previousUrl === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = previousUrl; }
});

test("ungrounded model dates, quantities and exclusions never override defaults or followups", () => {
  const generated = { dates: ["2026-11-07"], servings: 8, count: 6, excludedIngredients: ["tomatoes"], priority: "variety" };
  const first = resolve("Plan dinners with tomatoes", base(), generated).intent;
  assert.deepEqual(first.dates, []); assert.equal(first.servings, null); assert.equal(first.count, 3); assert.deepEqual(first.excludedIngredients, []); assert.equal(first.priority, "use_soon");
  const previous = { ...base(), count: 3, dates: ["2026-11-03", "2026-11-05", "2026-11-06"], servings: 4 };
  const next = resolve("Use fewer groceries", previous, generated).intent;
  assert.deepEqual(next.dates, previous.dates); assert.equal(next.servings, 4);
  const scoped = resolve("Make Tuesday vegetarian and Friday for two people", previous).intent;
  assert.equal(scoped.perDate["2026-11-03"].servings, undefined); assert.equal(scoped.perDate["2026-11-06"].servings, 2);
  const reduced = resolve("Plan two dinners", previous).intent;
  assert.equal(reduced.count, 2); assert.deepEqual(reduced.dates, ["2026-11-03", "2026-11-05"]);
});
test("cited semantic paraphrases inform the draft while explicit values retain priority", () => {
  const query = "A couple of evening meals for a household of five. Plant based please; do not buy much.";
  const interpreted = resolve(query, base(), { count: 2, servings: 5, diets: ["vegan"], priority: "fewer_groceries", evidence: { count: "A couple of evening meals", servings: "a household of five", diets: "Plant based", priority: "do not buy much" } }).intent;
  assert.equal(interpreted.count, 2); assert.equal(interpreted.servings, 5); assert.deepEqual(interpreted.diets, ["vegan"]); assert.equal(interpreted.priority, "fewer_groceries");
  const original = resolve(query, base()).intent; assert.equal(original.servings, null); assert.deepEqual(original.diets, []);
  const invented = resolve("Plan three dinners for four people", base(), { count: 6, servings: 8, diets: ["vegan"], evidence: { count: "six meals", servings: "eight people", diets: "plant based" } }).intent;
  assert.equal(invented.count, 3); assert.equal(invented.servings, 4); assert.deepEqual(invented.diets, []);
});
test("cited exclusions respect negations and never turn positive ingredients into exclusions", () => {
  assert.deepEqual(resolve("Use tomatoes", base(), { excludedIngredients: ["tomatoes"], evidence: { excludedIngredients: "Use tomatoes" } }).intent.excludedIngredients, []);
  assert.deepEqual(resolve("Do not exclude mushrooms; avoid peanuts", base(), { excludedIngredients: ["mushrooms", "peanuts"], evidence: { excludedIngredients: "Do not exclude mushrooms; avoid peanuts" } }).intent.excludedIngredients, ["peanuts"]);
  assert.deepEqual(resolve("We are out of butter", base(), { excludedIngredients: ["butter"], evidence: { excludedIngredients: "out of butter" } }).intent.excludedIngredients, ["butter"]);
  assert.deepEqual(resolve("The oven is broken", base(), { excludedEquipment: ["oven"], evidence: { excludedEquipment: "oven is broken" } }).intent.excludedEquipment, ["oven"]);
});

test("an exact but irrelevant quote cannot authorize a semantic diet or priority", () => {
  const result = resolve("Plan four dinners", base(), { diets: ["vegan"], priority: "variety", evidence: { diets: "four dinners", priority: "four dinners" } }).intent;
  assert.deepEqual(result.diets, []); assert.equal(result.priority, "use_soon");
});

test("positive cuisine requests become retrieval queries alongside supported exclusions", async () => {
  const response = await requestChefPlanIntent({ query: "Plan Mexican dinners without peanuts", week: base().week, today: base().today, infer: async () => modelInterpretation() });
  assert.equal(response.intent.recipeQuery, "mexican"); assert.deepEqual(response.intent.excludedIngredients, ["peanuts"]);
});

test("planning counts and priorities never become recipe topics, while actual ingredients remain", () => {
  const controls = ["with variety", "with varied meals", "with something different each night", "and mix it up", "with a novel mix", "using perishable food", "using food that expires soon", "using up food", "using food going off soon", "with less food waste", "with less waste", "with fewer groceries", "with fewer additional groceries", "with less grocery shopping", "with minimal shopping", "with ingredients to buy minimized"];
  for (const count of ["two", "a couple of", "a pair of"]) for (const control of controls) {
    assert.equal(positiveRecipeQuery(`Plan ${count} dinners ${control}.`), undefined, `${count} / ${control}`);
  }
  assert.equal(positiveRecipeQuery("Plan a pair of Mexican dinners with variety."), "mexican");
  assert.equal(positiveRecipeQuery("Plan two dinners using brown rice with fewer groceries."), "brown rice");
  assert.equal(positiveRecipeQuery("Plan two dinners using up brown rice with less waste."), "brown rice");
  assert.equal(positiveRecipeQuery("Plan two dinners using pancake mix with less waste."), "pancake mix");
  assert.equal(positiveRecipeQuery("Plan a couple of Martian dinners with variety."), "martian");
});

test("diet adjectives between the count and dinner noun retain the explicit meal count", () => {
  for (const adjective of ['gluten-free', 'gluten free', 'dairy-free', 'low-carb', 'low carb']) {
    const { intent } = resolve(`Plan two ${adjective} dinners.`, base(), { count: 3 });
    assert.equal(intent.count, 2, adjective);
  }
});

test("meal counts and durations after for do not invent servings", () => {
  for (const query of ["Plan for two dinners", "Plan for two vegetarian dinners", "Plan dinners for 30 minutes"]) {
    assert.equal(resolve(query).intent.servings, null, query);
  }
  assert.equal(resolve("Plan for two dinners for four people").intent.servings, 4);
  assert.equal(resolve("Plan two dinners for four").intent.servings, 4);
});

test("scoped edits retain independent exclusions, equipment and time requirements", () => {
  const previous = { ...base(), dates: ["2026-11-03", "2026-11-06"], servings: 4 };
  for (const query of ["Make Friday vegetarian and avoid peanuts", "Make Friday vegetarian without peanuts"]) {
    const { intent } = resolve(query, previous);
    assert.equal(intent.perDate["2026-11-06"].diet, "vegetarian");
    assert.deepEqual(intent.excludedIngredients, ["peanuts"], query);
    assert.deepEqual(intent.diets, []);
  }
  const { intent } = resolve("Make Friday vegetarian without an oven and under 30 minutes", previous);
  assert.deepEqual(intent.excludedEquipment, ["oven"]);
  assert.equal(intent.maxTotalMinutes, 30);
});

test("negated planning commands do not authorize edits or cropped model evidence", () => {
  const previous = { ...base(), dates: ["2026-11-03", "2026-11-06"], servings: 4 };
  const { intent } = resolve("Do not make Friday vegan for two people; keep Tuesday", previous, { diets: ["vegan"], servings: 2, evidence: { diets: "vegan", servings: "two people" } });
  assert.equal(intent.perDate["2026-11-06"], undefined);
  assert.equal(intent.servings, 4);
  assert.deepEqual(intent.diets, []);
  assert.deepEqual(intent.keepDates, ["2026-11-03"]);
  assert.equal(resolve("Do not prioritize food waste and minimize shopping").intent.priority, "fewer_groceries");
  assert.deepEqual(resolve("Never preserve Friday; replace Tuesday", previous).intent.keepDates, []);
});

test("decimal batch quantities survive per-date sentence splitting", () => {
  const previous = { ...base(), dates: ["2026-11-03", "2026-11-06"], servings: 4 };
  const { intent } = resolve("Make Friday 0.5 batches", previous);
  assert.equal(intent.perDate["2026-11-06"].batches, 0.5);
  assert.equal(intent.servings, 4);
});

test("repeated references to one date keep subsequent edits scoped to that date", () => {
  const previous = { ...base(), dates: ["2026-11-03", "2026-11-06"], servings: 4 };
  const { intent } = resolve("Replace Friday and make Friday vegetarian and set Friday for two people", previous);
  assert.deepEqual(intent.replaceDates, ["2026-11-06"]);
  assert.equal(intent.perDate["2026-11-06"].diet, "vegetarian");
  assert.equal(intent.perDate["2026-11-06"].servings, 2);
  assert.deepEqual(intent.diets, []);
  assert.equal(intent.servings, 4);
});

test("explicit global diet replacements revise draft preferences and preserve unrelated requirements", () => {
  const previous = { ...base(), diets: ["vegan", "gluten_free"], excludedIngredients: ["peanuts"] };
  for (const query of ["Vegetarian instead of vegan", "Plan vegetarian dinners rather than vegan", "Switch from vegan to vegetarian", "Change from vegan to vegetarian"]) {
    const { intent } = resolve(query, previous);
    assert.deepEqual(intent.diets, ["gluten_free", "vegetarian"], query);
    assert.deepEqual(intent.excludedIngredients, ["peanuts"]);
  }
  assert.deepEqual(previous.diets, ["vegan", "gluten_free"]);
  assert.deepEqual(resolve("Don't switch from vegan to vegetarian", previous).intent.diets, previous.diets);
});

test("unsupported combined daily diets require clarification instead of dropping a requirement", () => {
  const previous = { ...base(), dates: ["2026-11-03", "2026-11-06"] };
  for (const query of ["Make Friday vegetarian and gluten-free", "Make Friday vegetarian and make Friday gluten-free", "Make Friday vegetarian instead of vegan"]) {
    const result = resolve(query, previous);
    assert.match(result.clarification, /one dietary requirement/);
    assert.equal(result.intent, undefined);
  }
  assert.deepEqual(resolve("Plan vegetarian and gluten-free dinners").intent.diets, ["vegetarian", "gluten_free"]);
});

test("negated day-specific diets require clarification instead of applying a positive diet", () => {
  const previous = { ...base(), dates: ["2026-11-03", "2026-11-06"] };
  for (const query of ["Make Friday not vegetarian", "Friday does not need to be vegan", "Friday doesn't have to be vegan", "Make Friday non-vegetarian"]) {
    const result = resolve(query, previous, { diets: ["vegan"], evidence: { diets: "vegan" } });
    assert.match(result.clarification, /Negated dietary requirements/);
    assert.equal(result.intent, undefined);
  }
  assert.equal(resolve("Make Friday vegetarian", previous).intent.perDate["2026-11-06"].diet, "vegetarian");
});
