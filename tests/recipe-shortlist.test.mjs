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
