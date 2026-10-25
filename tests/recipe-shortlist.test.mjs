import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadPureRanker } from "../tools/recipes/evaluate-relevance.mjs";

const pure = await loadPureRanker();
after(pure.dispose);
const recipe = (id, title, names) => ({ id, title, ingredients: names.map((name) => ({ name, measure: "1" })), instructions: ["Follow the original source directions."], tags: [], image: null, category: "Dinner", cuisine: "Test", source: { name: "Test", url: "https://example.com/" }, sourceUrl: "https://example.com/" });
const recipes = [recipe("beef", "Beef Stew", ["beef", "onion"]), recipe("pasta", "Creamy Mushroom Pasta", ["pasta", "mushrooms", "cream"]), recipe("cheese", "Cheese Pasta", ["pasta", "cheese"]), recipe("soup", "Mushroom Soup", ["mushrooms", "water"])];
const ranked = (query, pantry = []) => pure.search.rankCatalogRecipes(recipes, { query, pantry });

test("a missing compound dish cannot match solely because one ingredient is shared", () => {
  const candidates = ranked("Beef Wellington", ["beef", "onion"]);
  assert.ok(candidates.some((row) => row.lexicalScore >= pure.search.catalogRelevanceThresholds.lexical));
  assert.equal(pure.search.queryRelevanceDecision(candidates.find((row) => row.recipe.id === "beef"), "Beef Wellington"), false);
  assert.deepEqual(pure.search.selectCatalogShortlist(candidates, "Beef Wellington"), []);
  assert.equal(pure.search.selectCatalogShortlist(ranked("beef dinner"), "beef dinner")[0].recipe.id, "beef");
});

test("exact-title searches return only the requested eligible source recipe", () => {
  const query = "Recommend Creamy Mushroom Pasta";
  const result = pure.search.selectCatalogShortlist(ranked(query, ["pasta", "cheese"]), query);
  assert.deepEqual(result.map((row) => row.recipe.id), ["pasta"]);
});

test("a related ingredient alone cannot fill secondary recommendation slots", () => {
  const query = "pasta with mushrooms";
  const candidates = ranked(query).map((row) => ({ ...row, semanticScore: row.recipe.id === "pasta" ? 0.95 : 0.9 }));
  const result = pure.search.selectCatalogShortlist(candidates, query);
  assert.deepEqual(result.map((row) => row.recipe.id), ["pasta"]);
  assert.deepEqual(pure.search.selectCatalogShortlist(ranked(query), query).map((row) => row.recipe.id), ["pasta"]);
});

test("pantry coverage cannot move a weaker semantic match ahead of the strongest match", () => {
  const query = "pasta with mushrooms";
  const candidates = ranked(query, ["pasta", "cheese"]).map((row) => ({ ...row, semanticScore: row.recipe.id === "pasta" ? 0.95 : 0.86 }));
  assert.equal(pure.search.selectCatalogShortlist(candidates, query)[0].recipe.id, "pasta");
});

test("broad dinner browsing keeps reviewed ordering while specific queries normalize ordinary plurals", () => {
  const broad = ranked("Dinner without beef");
  assert.deepEqual(pure.search.selectCatalogShortlist(broad, "Dinner without beef").map((row) => row.recipe.id), broad.map((row) => row.recipe.id));
  assert.equal(pure.search.selectCatalogShortlist(ranked("a creamy pasta with mushrooms"), "a creamy pasta with mushrooms")[0].recipe.id, "pasta");
});

test("match reasons distinguish named recipes, normalized search words and partial semantic matches", () => {
  const explain = pure.search.catalogMatchReason;
  assert.equal(explain(ranked("Creamy Mushroom Pasta")[0], "Creamy Mushroom Pasta"), "Matches the recipe you named.");
  const query = "pasta with mushrooms";
  const candidates = ranked(query);
  assert.equal(explain(candidates.find((row) => row.recipe.id === "pasta"), query), "Matches your search words: pasta, mushroom.");
  const partial = { ...candidates.find((row) => row.recipe.id === "cheese"), semanticScore: 0.9 };
  assert.equal(explain(partial, query), "Matches some search words: pasta.");
  const semantic = { ...ranked("coastal comfort")[0], semanticScore: 0.9 };
  assert.equal(pure.search.queryRelevanceDecision(semantic, "coastal comfort"), true);
  assert.equal(explain(semantic, "coastal comfort"), "Related to your request by meaning.");
});

test("broad match reasons use reviewed dinner roles or pantry names without implying quantity or diet suitability", () => {
  const explain = pure.search.catalogMatchReason;
  const empty = ranked("Suggest dinner")[0];
  assert.equal(explain(empty, "Suggest dinner"), "Suggested from your approved catalog.");
  assert.equal(explain(empty, "Suggest dinner", { dinnerRole: "main" }), "Reviewed as a main dinner.");
  assert.equal(explain(empty, "Suggest dinner", { dinnerRole: "unknown" }), "Suggested from your approved catalog.");
  assert.equal(explain(ranked("Dinner without beef", ["pasta"])[0], "Dinner without beef"), "Uses ingredient names from your pantry.");
});

test("explaining a shortlist does not change its ranking or include excluded search words", () => {
  const query = "pasta without mushrooms";
  const shortlist = pure.search.selectCatalogShortlist(ranked(query), query);
  const before = structuredClone(shortlist);
  assert.equal(shortlist.length, 1);
  assert.equal(pure.search.catalogMatchReason(shortlist[0], query), "Matches your search words: pasta.");
  assert.deepEqual(shortlist, before);
});

test("broad dinner choices use measured stock without making unrelated requests relevant", () => {
  const choices = [recipe("dry", "A Rice", ["rice"]), recipe("cooked", "Z Rice Leftovers", ["rice, cooked"])];
  choices.forEach((choice) => { choice.servings = 2; choice.ingredients[0].measure = "200 g"; });
  const stockContext = { pantry: [{ id: "leftovers", name: "cooked rice", measure: "200 g", useBy: "2026-10-26" }], meals: [], targetDate: "2026-10-25", today: "2026-10-25" };
  const candidates = pure.search.rankCatalogRecipes(choices, { query: "Dinner", pantry: ["rice"], stockContext });
  assert.equal(candidates[0].recipe.id, "cooked");
  assert.equal(candidates[0].readiness.coveredCount, 1);
  assert.equal(candidates[1].readiness.missingCount, 1);
  const unrelated = pure.search.rankCatalogRecipes(choices, { query: "quantum spaceship", stockContext });
  assert.deepEqual(pure.search.selectCatalogShortlist(unrelated, "quantum spaceship"), []);
});
