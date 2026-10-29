import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadPureRanker } from "../tools/recipes/evaluate-relevance.mjs";

const pure = await loadPureRanker();
after(pure.dispose);
const { recipeQueryIntent, constraintsForRecipeQuery, rankCatalogRecipes, queryRelevanceDecision } = pure.search;
const constraints = (value) => pure.constraints.normalizeConstraints(value);
const recipe = (id, title, names) => ({ id, title, ingredients: names.map((name) => ({ name, measure: "1" })), instructions: ["Use the source directions."], tags: [], image: null, category: "Dinner", cuisine: "Test", source: { name: "Test", url: "https://example.com/" }, sourceUrl: "https://example.com/" });
const recipes = [recipe("pasta", "Cheese Pasta", ["penne", "mozzarella"]), recipe("tomato", "Tomato Rice", ["rice", "chopped tomatoes"]), recipe("plain", "Garlic Rice", ["rice", "garlic"]), recipe("beans", "Bean Stew", ["beans", "onions"]), recipe("eggplant", "Eggplant Bowl", ["eggplant", "rice"]), recipe("egg", "Egg Rice", ["eggs", "rice"])];

test("natural dinner questions request recipes without treating source questions as discovery", () => {
  for (const query of ["What can I cook with what I have?", "What can I cook with eggplant?", "What should we make for dinner?", "Which recipes could I try with rice?", "What's for dinner?", "Can you find a dinner with rice?"]) {
    assert.equal(pure.search.queryRequestsRecipes(query), true, query);
  }
  for (const query of ["Why rinse the rice?", "How long does this recipe take?", "What can I cook this in?", "What can I use instead of milk?", "What should the lentils feel like?", "What is the next source direction?"]) {
    assert.equal(pure.search.queryRequestsRecipes(query), false, query);
  }
  assert.equal(recipeQueryIntent("What should we cook with eggplant?").topic, "eggplant");
  for (const query of ["What should we make for dinner?", "What's for dinner?", "What should we eat tomorrow?"]) assert.equal(recipeQueryIntent(query).broad, true, query);
});

test("common dietary wording becomes constraints rather than positive search words", () => {
  for (const query of ["Meatless dinner", "MEAT-FREE dinner", "a meat free meal"]) {
    const intent = recipeQueryIntent(query);
    assert.equal(intent.broad, true, query);
    assert.deepEqual(intent.diets, ["vegetarian"], query);
  }
  for (const query of ["dairy free rice", "dairy-free rice"]) {
    const intent = recipeQueryIntent(query);
    assert.equal(intent.topic, "rice");
    assert.deepEqual(intent.excludedIngredients, ["dairy"]);
    assert.equal(pure.search.recipeRetrievalQuery(query), "rice");
  }
  assert.deepEqual(recipeQueryIntent("not meatless dinner").diets, []);
  assert.ok(!recipeQueryIntent("not dairy free").excludedIngredients.includes("dairy"));
});

test("equipment exclusions are separate from food exclusions and leave the positive dish intact", () => {
  for (const query of ["Rice without an oven", "Rice with no oven", "Rice, don't use the oven", "Rice, I don't have an oven", "Rice without using the oven"]) {
    const intent = recipeQueryIntent(query);
    assert.equal(intent.topic, "rice", query);
    assert.deepEqual(intent.excludedIngredients, [], query);
    assert.deepEqual(intent.excludedEquipment, ["oven"], query);
    assert.equal(pure.search.recipeRetrievalQuery(query), "rice", query);
  }
  assert.equal(recipeQueryIntent("No oven dinner").broad, true);
  const mixed = recipeQueryIntent("Rice without eggs, an oven or a hob");
  assert.deepEqual(mixed.excludedIngredients, ["eggs"]);
  assert.deepEqual(mixed.excludedEquipment, ["oven", "stovetop"]);
  assert.equal(recipeQueryIntent("oven roasted rice").excludedEquipment, undefined);
});

test("request constraints tighten saved requirements without changing them", () => {
  const saved = constraints({ diet: "Vegan", allergies: ["peanut"], equipment: ["Oven", "Stovetop"], excludedEquipment: ["blender"] });
  const before = structuredClone(saved);
  const parsed = constraintsForRecipeQuery("Meatless rice without an oven or dairy", saved);
  assert.deepEqual(parsed.diets, ["vegan", "vegetarian"]);
  assert.deepEqual(parsed.excludedIngredients, ["dairy"]);
  assert.deepEqual(parsed.excludedEquipment, ["blender", "oven"]);
  assert.deepEqual(parsed.allergies, ["peanut"]);
  assert.deepEqual(parsed.equipment, ["oven", "stovetop"]);
  assert.deepEqual(saved, before);
  assert.deepEqual(constraintsForRecipeQuery("Meatless rice without an oven or dairy", parsed), parsed);
});

test("dietary aliases and equipment exclusions apply before either lexical or semantic ranking", () => {
  const sources = [...recipes, recipe("chicken", "Chicken Rice", ["rice", "chicken stock"]), recipe("bake", "Rice Bake", ["rice", "coconut milk"])];
  const metadata = Object.fromEntries(sources.filter((row) => row.id !== "eggplant").map((row) => [row.id, { diets: {}, equipment: [row.id === "bake" ? "Oven" : "Stovetop"] }]));
  for (const semantic of [false, true]) {
    const vectors = semantic ? new Map(sources.map((row) => [row.id, [1, 0]])) : new Map();
    const search = (query) => rankCatalogRecipes(sources, { query }, vectors, semantic ? [1, 0] : null, metadata);
    assert.ok(search("meatless dinner").every((row) => row.recipe.id !== "chicken"));
    const dairyFree = search("dairy free dinner");
    assert.ok(dairyFree.every((row) => row.recipe.id !== "pasta"));
    assert.ok(dairyFree.some((row) => row.recipe.id === "bake"), "Plant milk is not treated as dairy");
    const noOven = search("dinner without an oven");
    assert.ok(noOven.length > 0);
    assert.ok(noOven.every((row) => !["bake", "eggplant"].includes(row.recipe.id)), "Known conflicts and unreviewed equipment are excluded");
  }
});

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
  const dairyFree = recipeQueryIntent("Make Cheese Pasta dairy-free", true);
  assert.deepEqual(dairyFree.excludedIngredients, []);
  assert.deepEqual(dairyFree.adaptationDiets, ["dairy_free"]);
  assert.equal(rankCatalogRecipes(recipes, { query: "Make Cheese Pasta dairy-free" })[0]?.recipe.id, "pasta");
  assert.ok(rankCatalogRecipes(recipes, { query: "Make Cheese Pasta dairy-free", constraints: constraints({ allergies: ["milk"] }) }).every((row) => row.recipe.id !== "pasta"));
  assert.deepEqual(recipeQueryIntent("Make Cheese Pasta meatless", true).adaptationDiets, ["vegetarian"]);
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

test("counted broad requests retrieve dinners without treating counts as a dish", () => {
  for (const count of ["three", "3", "9"]) {
    const query = `Suggest ${count} different vegetarian dinners for tonight.`;
    const intent = recipeQueryIntent(query);
    assert.equal(intent.broad, true); assert.equal(intent.requestedCount, 3);
    assert.deepEqual(intent.diets, ["vegetarian"]);
    assert.equal(pure.search.recipeRetrievalQuery(query), "");
    assert.ok(rankCatalogRecipes(recipes, { query }).length >= 3);
  }
  assert.equal(recipeQueryIntent("Three Bean Soup").topic, "three bean soup");
  assert.equal(recipeQueryIntent("Three Bean Soup").requestedCount, undefined);
});
test("scheduling and recipe choices do not authorize food adaptations", () => {
  for (const query of ["Recommend Cheese Pasta for tonight instead.", "Change my dinner to Bean Stew", "Replace tonight's meal with Garlic Rice", "Suggest a different recipe instead", "Replace this recipe with Bean Stew"]) assert.equal(recipeQueryIntent(query, true).mode, "recommendation", query);
  for (const query of ["Use milk instead of cream", "Swap cheese for tofu", "Replace the butter with oil", "Change this recipe to vegan", "Change this meal to vegan", "Change the cooking method", "Double the recipe", "Make Cheese Pasta dairy-free"]) assert.equal(recipeQueryIntent(query, true).mode, "adaptation", query);
});

test("ingredient replacement questions need no preselected replacement", () => {
  for (const query of ["How can I replace the milk?", "Can I replace the cheese?", "What could replace butter?", "Replace the milk", "What is a replacement for milk?"]) assert.equal(recipeQueryIntent(query, true).mode, "adaptation", query);
  for (const query of ["Can I replace this recipe?", "Replace my dinner", "Replace this recipe with Bean Stew", "Recommend Cheese Pasta for tonight instead.", "Suggest a replacement recipe", "Find a replacement for this dinner"]) assert.equal(recipeQueryIntent(query, true).mode, "recommendation", query);
});
