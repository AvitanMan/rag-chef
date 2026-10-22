import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadPureRanker } from "../tools/recipes/evaluate-relevance.mjs";

const pure = await loadPureRanker();
after(pure.dispose);
const { recipeQueryIntent, constraintsForRecipeQuery, rankCatalogRecipes, queryRelevanceDecision } = pure.search;
const constraints = (value) => pure.constraints.normalizeConstraints(value);
const recipe = (id, title, names) => ({ id, title, ingredients: names.map((name) => ({ name, measure: "1" })), instructions: ["Use the source directions."], tags: [], image: null, category: "Dinner", cuisine: "Test", source: { name: "Test", url: "https://example.com/" }, sourceUrl: "https://example.com/" });
const recipes = [recipe("pasta", "Cheese Pasta", ["penne", "mozzarella"]), recipe("tomato", "Tomato Rice", ["rice", "chopped tomatoes"]), recipe("plain", "Garlic Rice", ["rice", "garlic"]), recipe("beans", "Bean Stew", ["beans", "onions"]), recipe("eggplant", "Eggplant Bowl", ["eggplant", "rice"]), recipe("egg", "Egg Rice", ["eggs", "rice"])];

test("explicit exclusion clauses become ingredient requirements rather than positive search terms", () => {
  for (const [query, excluded, topic] of [
    ["Recommend dinner but no pasta", ["pasta"], ""],
    ["Dinner without tomatoes", ["tomatoes"], ""],
    ["No pasta and no tomatoes", ["pasta", "tomatoes"], ""],
    ["Rice without tomatoes and without onions", ["tomatoes", "onions"], "rice"],
    ["Rice without tomatoes and onions, please", ["tomatoes", "onions"], "rice"],
    ["Avoid pasta; use rice", ["pasta"], "rice"],
    ["Rice, don't use eggs or dairy", ["eggs", "dairy"], "rice"],
    ["No red onions, mushrooms or eggs with rice", ["red onions", "mushrooms", "eggs"], "rice"],
  ]) {
    const intent = recipeQueryIntent(query);
    assert.deepEqual(intent.excludedIngredients, excluded, query);
    assert.equal(intent.topic, topic, query);
    assert.equal(intent.mode, "recommendation", query);
  }
  assert.deepEqual(recipeQueryIntent("Not only rice but also beans").excludedIngredients, []);
  assert.deepEqual(recipeQueryIntent("A no bake dessert").excludedIngredients, []);
  assert.deepEqual(recipeQueryIntent("For Cheese Pasta, without changing the source directions", true).excludedIngredients, []);
});

test("request ingredient families use bounded terms and keep unrelated ingredients eligible", () => {
  const examples = [
    ["tomatoes", "marinara sauce", "potatoes"],
    ["pasta", "spaghetti", "rice"], ["cheese", "ricotta", "milk"],
    ["dairy", "butter", "peanut butter beans"], ["nuts", "groundnuts", "nutmeg"],
    ["soy", "tofu", "potato"], ["shellfish", "prawns", "rice"],
  ];
  for (const [excluded, matching, unrelated] of examples) {
    const blocked = recipe("blocked", "Blocked", [matching]);
    assert.equal(pure.constraints.evaluateRecipeConstraints(blocked, undefined, constraints({ excludedIngredients: [excluded] })).eligible, false, `${excluded}: ${matching}`);
    const allowed = recipe("allowed", "Allowed", [unrelated]);
    assert.equal(pure.constraints.evaluateRecipeConstraints(allowed, undefined, constraints({ excludedIngredients: [excluded] })).eligible, true, `${excluded}: ${unrelated}`);
  }
});

test("negated ingredients and aliases are excluded even when semantic scores favor them", () => {
  const vectors = new Map(recipes.map((value) => [value.id, [1, 0]]));
  for (const [query, forbidden] of [["Dinner with no pasta", ["pasta"]], ["Dinner without tomatoes", ["tomato"]], ["Rice without eggs", ["egg"]], ["Dinner without cheese", ["pasta"]]]) {
    const ranked = rankCatalogRecipes(recipes, { query }, vectors, [1, 0]);
    assert.ok(ranked.length > 0, query);
    assert.ok(ranked.every((row) => !forbidden.includes(row.recipe.id)), query);
    assert.ok(ranked.every((row) => queryRelevanceDecision(row, query)), query);
  }
  assert.ok(rankCatalogRecipes(recipes, { query: "Rice without eggs" }).some((row) => row.recipe.id === "eggplant"));
  assert.ok(rankCatalogRecipes(recipes, { query: "Avoid Cheese Pasta" }).every((row) => row.recipe.id !== "pasta"), "An explicitly excluded complete dish name must not become a positive recommendation");
  const [first] = rankCatalogRecipes(recipes, { query: "Rice without tomatoes" });
  assert.equal(first.lexicalScore, 1, "Only the positive rice topic contributes to lexical relevance");
});

test("named adaptation targets stay advisory while saved exclusions remain mandatory", () => {
  const intent = recipeQueryIntent("Make Cheese Pasta vegan", true);
  assert.equal(intent.mode, "adaptation");
  assert.deepEqual(intent.diets, []);
  assert.deepEqual(intent.adaptationDiets, ["vegan"]);
  assert.deepEqual(constraintsForRecipeQuery("Make Cheese Pasta vegan", constraints(), true).diets, []);
  assert.equal(rankCatalogRecipes(recipes, { query: "Make Cheese Pasta vegan" })[0]?.recipe.id, "pasta");
  for (const profile of [{ diet: "Vegan" }, { allergies: ["dairy"] }, { excludedIngredients: ["pasta"] }]) {
    assert.ok(rankCatalogRecipes(recipes, { query: "Make Cheese Pasta vegan", constraints: constraints(profile) }).every((row) => row.recipe.id !== "pasta"));
  }
  assert.deepEqual(constraintsForRecipeQuery("Make a vegan dinner", constraints()).diets, ["vegan"]);
  assert.equal(recipeQueryIntent("Make a vegan dinner").mode, "recommendation");
  assert.deepEqual(constraintsForRecipeQuery("Find a gluten-free dinner", constraints({ diet: "Vegan" })).diets, ["vegan", "gluten_free"]);
  assert.deepEqual(recipeQueryIntent("For Cheese Pasta, leave out cheese", true).excludedIngredients, []);
  assert.equal(recipeQueryIntent("For Cheese Pasta, leave out cheese", true).mode, "adaptation");
});

test("broad dinners prefer reviewed mains while specific searches retain relevance and exact-title priority", () => {
  const main = recipe("main", "Garlic Rice", ["rice", "garlic"]);
  const dessert = recipe("dessert", "Almond Brownies", ["almonds", "sugar"]);
  const unknown = recipe("unknown", "A Garden Bowl", ["beans"]);
  const metadata = { main: { dinnerRole: "main", diets: {} }, dessert: { dinnerRole: "dessert", diets: {} } };
  const source = [dessert, unknown, main];
  const broad = rankCatalogRecipes(source, { query: "Dinner without tomatoes", pantry: ["almonds", "sugar"] }, new Map(), null, metadata);
  assert.deepEqual(broad.map((row) => row.recipe.id), ["main", "unknown", "dessert"]);
  const specific = rankCatalogRecipes(source, { query: "Almond Brownies" }, new Map(), null, metadata);
  assert.equal(specific[0].recipe.id, "dessert");
  const excluded = rankCatalogRecipes(source, { query: "Dinner without rice" }, new Map(), null, metadata);
  assert.ok(excluded.every((row) => row.recipe.id !== "main"), "A reviewed role cannot override a request exclusion");
});
