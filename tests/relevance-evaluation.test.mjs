import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { calibrateThresholds, evaluateRecords, loadPureRanker } from "../tools/recipes/evaluate-relevance.mjs";
import { qualityCases } from "../tools/recipes/quality-cases.mjs";

const row = (title, lexicalScore, semanticScore = null, extra = {}) => ({ recipe: { id: title, title }, lexicalScore, semanticScore, exactTitle: false, eligibility: { allergyMatches: [] }, ...extra });
const record = (id, expectedOutcome, ranked, extra = {}) => ({ item: { id, query: id, split: "calibration", expectedOutcome, expectedTitles: expectedOutcome === "matches" ? [id] : [], ...extra }, ranked, broad: false });

test("quality labels remain balanced and explicit allergy context is retained", async () => {
  assert.equal(qualityCases.length, 80);
  const { recipes } = JSON.parse(await readFile(new URL("../tools/recipes/fixtures/relevance-catalog.json", import.meta.url), "utf8"));
  assert.equal(recipes.length, 166);
  const titles = new Set(recipes.map((recipe) => recipe.title));
  for (const split of ["calibration", "heldout"]) {
    assert.equal(qualityCases.filter((item) => item.split === split && item.expectedOutcome === "matches").length, 20);
    assert.equal(qualityCases.filter((item) => item.split === split && item.expectedOutcome === "no_match").length, 20);
  }
  for (const item of qualityCases) for (const title of item.expectedTitles) assert.ok(titles.has(title), title);
  assert.deepEqual(qualityCases.find((item) => item.query === "pancakes without eggs").constraints, { allergies: ["egg"] });
});

test("threshold selection cannot use held-out labels or their scores", () => {
  const calibration = [record("dinner", "matches", [row("dinner", 0.8, 0.9)]), record("nonsense", "no_match", [row("wrong", 0.2, 0.4)])];
  const lexical = calibration.map((item) => ({ ...item, ranked: item.ranked.map((value) => ({ ...value, semanticScore: null })) }));
  const selected = calibrateThresholds(calibration, lexical);
  const poison = record("poison", "no_match", [row("poison", 1, 1)], { split: "heldout" });
  assert.deepEqual(calibrateThresholds([...calibration, poison], [...lexical, poison]).thresholds, selected.thresholds);
  assert.equal(selected.selectionSplit, "calibration");
  assert.equal(selected.calibration.gatesPassed, true);
  assert.equal(selected.forcedLexicalCalibration.gatesPassed, true);
});

test("precision reports unlabeled returned recipes and excludes broad cases", () => {
  const supported = record("dinner", "matches", [row("other", 1), row("dinner", 0.9), row("also other", 0.8)]);
  const broad = { item: { id: "broad", query: "", expectedOutcome: "matches", expectedTitles: [] }, broad: true, ranked: [row("anything", 0)] };
  const scored = evaluateRecords([supported, broad], { lexical: 0.5, semantic: 0.9 });
  assert.equal(scored.retention, 1);
  assert.equal(scored.expectedTitleCases, 1);
  assert.equal(scored.expectedHitAt3, 1);
  assert.equal(scored.labeledPrecisionAt3, 1 / 3);
  assert.ok(Math.abs(scored.labeledPrecisionPenalty - 2 / 3) < 1e-12);
});

test("an exact-title case must return the requested recipe first even when it appears in the top three", () => {
  const item = record("dinner", "matches", [row("other", 1), row("dinner", 0.9)], { exactTitleId: "dinner" });
  const scored = evaluateRecords([item], { lexical: 0.5, semantic: 0.9 });
  assert.equal(scored.expectedHitAt3, 1);
  assert.equal(scored.results[0].exactTitleTopOnePass, false);
  assert.equal(scored.gatesPassed, false);
});

test("missing embeddings force lexical scores and pantry boosts cannot approve gibberish", async () => {
  const pure = await loadPureRanker();
  after(pure.dispose);
  const recipe = { id: "rice", title: "Rice Dinner", image: null, category: "Dinner", cuisine: "Test", ingredients: [{ name: "rice", measure: "1 cup" }], instructions: ["Cook rice."], tags: [], source: { name: "Test", url: "https://example.com" }, sourceUrl: "https://example.com" };
  const ranked = pure.search.rankCatalogRecipes([recipe], { query: "zzzxxyy quantum spaceship", pantry: ["rice"] }, new Map([["rice", [1, 0]]]), null);
  assert.equal(ranked[0].semanticScore, null);
  assert.equal(ranked[0].pantryScore, 1);
  assert.equal(pure.search.queryRelevanceDecision(ranked[0], "zzzxxyy quantum spaceship", { lexical: 0.1, semantic: 0.78 }), false);
  assert.equal(pure.search.queryRelevanceDecision(ranked[0], "", { lexical: 0.1, semantic: 0.78 }), true);
  assert.equal(pure.search.recipeQueryIntent("What can I cook with my pantry?").broad, true);
  await assert.rejects(() => pure.search.searchRecipeCatalog({ query: "rice" }, "nomic-embed-text"), /Database access is disabled/);
});
