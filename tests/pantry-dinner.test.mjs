import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const loader = await createSourceLoader({ name: "pantry-dinner" });
after(() => loader.dispose());
const { availableTonightIngredients, findPantryDinners, tonightSuggestionPantry, pantryDinnerPicks } = await loader.import("app/lib/pantry-dinner.ts");
const { normalizeConstraints } = await loader.import("app/lib/recipe-constraints.ts");
const { DEMO_SOURCE } = await loader.import("app/lib/demo-recipes.ts");
const { EVERYDAY_RECIPES } = await loader.import("app/lib/everyday-collection.ts");
const TODAY = "2026-11-14";
const stock = (id, name, measure = "", useBy) => ({ id, name, measure, ...(useBy ? { useBy } : {}) });
const recipe = (id, names, title = id) => ({
  id, title, image: null, category: "Dinner", cuisine: "", source: { name: "Original test recipes", url: "https://example.test" },
  sourceUrl: "https://example.test/recipes", instructions: ["Follow the original directions."], tags: [],
  ingredients: names.map(name => ({ name, measure: "" })),
});
const metadata = (dinnerRole = "main", extra = {}) => ({
  revision: 1, sourceContentHash: "a".repeat(64), coreDinner: dinnerRole === "main", dinnerRole,
  diets: { vegan: "unknown", vegetarian: "unknown", gluten_free: "unknown", low_carb: "unknown" },
  totalMinutes: null, equipment: null, provenance: {}, reviewedBy: "Test", reviewedAt: "2026-11-14T00:00:00.000Z", ...extra,
});
const ids = result => result.matches.map(item => item.recipe.id);

test("available ingredients retain unknown amounts and undated batches, deduplicate aliases, and exclude empty or past stock", () => {
  const pantry = [stock("past", "Rice", "1 kg", "2026-11-13"), stock("unknown", "raw rice"),
    stock("duplicate", "uncooked rice", "some"), stock("today", "tomatoes", "2", TODAY),
    stock("tomato-empty", "tomato", "0"), stock("empty", "onion", "0 g"), stock("notes", "garlic", "a little")];
  assert.deepEqual(availableTonightIngredients(pantry, TODAY), [
    { key: "rice", name: "raw rice" }, { key: "tomato", name: "tomatoes" }, { key: "garlic", name: "garlic" },
  ]);
  assert.deepEqual(availableTonightIngredients([stock("old", "onion", "", "2026-11-13")], TODAY), []);
});

test("selected ingredients produce subset options and recipe-scoped overlap rather than requiring every pick", () => {
  const pantry = [stock("rice", "rice"), stock("tomato", "tomatoes")];
  const recipes = [recipe("both", ["rice", "tomato"]), recipe("rice-only", ["rice"]),
    recipe("tomato-only", ["tomatoes"]), recipe("neither", ["pasta"])];
  const result = findPantryDinners(recipes, ["rice", "tomato", "rice"], pantry, TODAY);
  assert.deepEqual(ids(result), ["both", "rice-only", "tomato-only"]);
  assert.deepEqual(result.picks, [{ key: "rice", name: "rice", available: true }, { key: "tomato", name: "tomatoes", available: true }]);
  assert.deepEqual(result.matches.map(match => match.usesPicks), [
    [{ key: "rice", name: "rice" }, { key: "tomato", name: "tomatoes" }],
    [{ key: "rice", name: "rice" }], [{ key: "tomato", name: "tomatoes" }],
  ]);
});

test("tonight discovery excludes freezer by default while keeping all eligible frozen ingredients selectable", () => {
  const pantry = [stock("unsorted", "onion"), { ...stock("shelf", "pasta"), location: "cupboard" },
    { ...stock("frozen", "raw rice", "some"), location: "freezer" },
    { ...stock("expired", "peas", "100 g", "2026-11-13"), location: "freezer" },
    { ...stock("finished", "broccoli", "0"), location: "freezer" }];
  const before = structuredClone(pantry);
  assert.deepEqual(tonightSuggestionPantry(pantry, TODAY).map(item => item.id), ["unsorted", "shelf"]);
  assert.deepEqual(tonightSuggestionPantry(pantry, TODAY, ["rice", "peas", "broccoli"]).map(item => item.id), ["unsorted", "shelf", "frozen"]);
  assert.deepEqual(availableTonightIngredients(pantry, TODAY).map(item => item.key), ["onion", "pasta", "rice"]);
  assert.deepEqual(pantry, before, "discovery cannot move entries or change physical stock");
});

test("unselected freezer support cannot improve dinner order, and selected freezer aliases stay usable with a reminder", () => {
  const pantry = [stock("rice", "rice"), stock("onion", "onion"),
    { ...stock("chicken", "chicken", "300 g"), location: "freezer" }];
  const recipes = [recipe("A-frozen", ["rice", "chicken"]), recipe("Z-ready", ["rice", "onion"])];
  const result = findPantryDinners(recipes, ["rice"], pantry, TODAY);
  assert.deepEqual(ids(result), ["Z-ready", "A-frozen"]);
  assert.deepEqual(ids(result), ids(findPantryDinners(recipes, ["rice"], pantry.slice(0, 2), TODAY)));
  assert.ok(result.matches.every(match => match.frozenPicks.length === 0));
  const selected = findPantryDinners(recipes, ["rice", "chicken"], pantry, TODAY);
  assert.deepEqual(ids(selected), ["A-frozen", "Z-ready"]);
  assert.deepEqual(selected.matches[0].frozenPicks, [{ key: "chicken", name: "chicken" }]);
  assert.deepEqual(selected.matches[1].frozenPicks, [], "the reminder belongs only to a recipe using the selected frozen food");
  const mixed = [stock("rice", "rice"), { ...stock("frozen-rice", "raw rice"), location: "freezer" }];
  assert.deepEqual(findPantryDinners(recipes, ["rice"], mixed, TODAY).matches[0].frozenPicks,
    [{ key: "rice", name: "raw rice" }], "selection is global by canonical identity across locations");
});

test("one unavailable pick stays visible and does not block recipes using other available selected food", () => {
  const recipes = [recipe("both", ["rice", "tomato"]), recipe("rice-only", ["rice"])];
  const pantry = [stock("rice", "rice"), stock("tomato", "tomato", "1", TODAY)];
  assert.deepEqual(ids(findPantryDinners(recipes, [], pantry, TODAY)), []);
  assert.deepEqual(ids(findPantryDinners(recipes, ["rice", "missing"], pantry, TODAY)), ["both", "rice-only"]);
  assert.deepEqual(ids(findPantryDinners(recipes, ["rice", "tomato"], pantry.slice(0, 1), TODAY)), ["rice-only", "both"]);
  const stale = findPantryDinners(recipes, ["rice", "tomato"], pantry, "2026-11-15");
  assert.deepEqual(ids(stale), ["rice-only", "both"]);
  assert.deepEqual(stale.picks, [{ key: "rice", name: "rice", available: true }, { key: "tomato", name: "tomato", available: false }]);
  assert.ok(stale.matches.every(match => match.usesPicks.every(pick => pick.key !== "tomato")));
  assert.deepEqual(ids(findPantryDinners(recipes, ["rice"], [stock("rice", "rice", "0")], TODAY)), []);
});

test("selected chips retain unavailable saved labels and canonical fallbacks without duplicate aliases", () => {
  const pantry = [stock("old", "Tomatoes", "2", "2026-11-13"), stock("empty", "raw rice", "0 g"),
    stock("onion", "Onions", "some")];
  const before = structuredClone(pantry);
  assert.deepEqual(pantryDinnerPicks(pantry, TODAY, ["tomato", "rice", "missing food", "onion", "onions", "raw rice"]), [
    { key: "tomato", name: "Tomatoes", available: false },
    { key: "rice", name: "raw rice", available: false },
    { key: "missing food", name: "missing food", available: false },
    { key: "onion", name: "Onions", available: true },
  ]);
  assert.deepEqual(pantry, before);
});

test("basic seasonings cannot start a dinner search or make an unrelated recipe match", () => {
  const pantry = ["rice", "salt", "black pepper", "olive oil", "water"].map(name => stock(name, name));
  const recipes = [recipe("rice", ["rice", "salt"]), recipe("unrelated", ["chicken", "salt", "olive oil"]),
    recipe("basics", ["salt", "water"])];
  const onlyBasics = findPantryDinners(recipes, ["salt", "black pepper", "olive oil", "water"], pantry, TODAY);
  assert.deepEqual(onlyBasics.matches, []);
  assert.equal(onlyBasics.picks.length, 4);
  const withFood = findPantryDinners(recipes, ["rice", "salt", "olive oil"], pantry, TODAY);
  assert.deepEqual(ids(withFood), ["rice"]);
  assert.deepEqual(withFood.matches[0].usesPicks, [{ key: "rice", name: "rice" }, { key: "salt", name: "salt" }]);
  assert.deepEqual(ids(findPantryDinners(recipes, ["missing", "salt"], pantry, TODAY)), []);
});

test("fewer missing foods precedes selected overlap, which precedes food coverage", () => {
  const pantry = ["rice", "pasta", "onion", "garlic"].map(name => stock(name, name));
  const recipes = [recipe("two-picks", ["rice", "pasta", "egg"], "Z two picks"),
    recipe("supported", ["rice", "onion", "garlic", "carrot"], "A support"),
    recipe("no-additions", ["rice"], "Z no additions")];
  assert.deepEqual(ids(findPantryDinners(recipes, ["rice", "pasta"], pantry, TODAY)),
    ["no-additions", "two-picks", "supported"]);
  assert.deepEqual(ids(findPantryDinners([...recipes].reverse(), ["pasta", "rice", "rice"], pantry, TODAY)),
    ["no-additions", "two-picks", "supported"]);
});

test("repeated selected aliases and source occurrences cannot inflate selected food overlap", () => {
  const pantry = [stock("rice", "raw rice"), stock("onion", "onions")];
  const recipes = [recipe("repeated", ["rice", "200 g rice", "uncooked rice"], "A repeated"),
    recipe("two-foods", ["rice", "onion"], "Z two foods")];
  const result = findPantryDinners(recipes, ["rice", "raw rice", "onion", "onions", "rice"], pantry, TODAY);
  assert.deepEqual(ids(result), ["two-foods", "repeated"]);
  assert.deepEqual(result.matches[1].usesPicks, [{ key: "rice", name: "raw rice" }]);
  assert.equal(result.picks.length, 2);
});

test("unselected eligible pantry food supports fit while unrelated food cannot create a selected match", () => {
  const pantry = ["rice", "onion", "garlic"].map(name => stock(name, name));
  const recipes = [recipe("supported", ["rice", "onion", "garlic"]), recipe("missing", ["rice", "mushroom"]),
    recipe("unrelated", ["onion", "garlic"])];
  const result = findPantryDinners(recipes, ["rice"], pantry, TODAY);
  assert.deepEqual(ids(result), ["supported", "missing"]);
  assert.ok(result.matches.every(match => match.usesPicks.length === 1 && match.usesPicks[0].key === "rice"));
});

test("an everyday chicken tray bake and mushroom pasta both survive a mixed set of picks", () => {
  const recipes = EVERYDAY_RECIPES.map(recipe => ({ ...recipe, id: `${DEMO_SOURCE.id}:${recipe.id}` }));
  const pantry = ["chicken breast", "potatoes", "pasta", "mushrooms"].map(name => stock(name, name));
  const result = findPantryDinners(recipes, ["chicken breast", "potato", "pasta", "mushroom"], pantry, TODAY);
  const tray = result.matches.find(match => match.recipe.id.endsWith(":everyday-chicken-potato-tray-bake"));
  const pasta = result.matches.find(match => match.recipe.id.endsWith(":everyday-creamy-mushroom-pasta"));
  assert.ok(tray);
  assert.ok(pasta);
  assert.deepEqual(tray.usesPicks.map(pick => pick.key), ["chicken breast", "potato"]);
  assert.deepEqual(pasta.usesPicks.map(pick => pick.key), ["pasta", "mushroom"]);
});

test("unknown pantry amounts match names without requiring enough stock or invented amounts", () => {
  const dinner = recipe("rice-dinner", ["rice", "tomato"]);
  dinner.ingredients[0].measure = "2 kg";
  const pantry = [stock("rice", "rice", "a little")];
  const before = structuredClone({ dinner, pantry });
  assert.deepEqual(ids(findPantryDinners([dinner], ["rice"], pantry, TODAY)), ["rice-dinner"]);
  assert.deepEqual({ dinner, pantry }, before);
});

test("matching uses measured source normalization and reviewed aliases while preserving source ingredients", () => {
  const pantry = [stock("onion", "onions"), stock("rice", "raw rice")];
  const dinner = recipe("rice-onion", ["2 onions", "200 g rice", "salt"]);
  const original = structuredClone(dinner);
  assert.deepEqual(ids(findPantryDinners([dinner], ["onion", "rice"], pantry, TODAY)), ["rice-onion"]);
  assert.deepEqual(dinner, original);
});

test("cooked and raw food, related products, and different onion varieties are not silent substitutes", () => {
  const pantry = [stock("rice", "raw rice"), stock("cooked", "cooked rice"), stock("onion", "onion")];
  const recipes = [recipe("raw", ["uncooked rice"]), recipe("cooked", ["cooked rice"]),
    recipe("noodles", ["rice noodles"]), recipe("vinegar", ["rice vinegar"]), recipe("red-onion", ["red onion"])];
  assert.deepEqual(ids(findPantryDinners(recipes, ["rice"], pantry, TODAY)), ["raw"]);
  assert.deepEqual(ids(findPantryDinners(recipes, ["cooked rice"], pantry, TODAY)), ["cooked"]);
  assert.deepEqual(ids(findPantryDinners(recipes, ["onion"], pantry, TODAY)), []);
});

test("saved allergy, diet, ingredient, and reviewed equipment constraints apply before ranking", () => {
  const pantry = [stock("rice", "rice")];
  const recipes = [recipe("allergy", ["rice", "peanut"]), recipe("diet", ["rice", "chicken"]),
    recipe("excluded", ["rice", "garlic"]), recipe("oven", ["rice"]), recipe("unknown", ["rice"]), recipe("safe-main", ["rice", "tomato"])];
  const reviews = { allergy: metadata(), diet: metadata(), excluded: metadata(), oven: metadata("main", { equipment: ["oven"] }),
    "safe-main": metadata("main", { equipment: ["stovetop"] }) };
  const constraints = normalizeConstraints({ allergies: ["peanut"], diet: "Vegetarian", excludedIngredients: ["garlic"], equipment: ["Stovetop"] });
  assert.deepEqual(ids(findPantryDinners(recipes, ["rice"], pantry, TODAY, reviews, constraints)), ["safe-main", "unknown"]);
});

test("reviewed mains rank ahead of unknown dishes and sides, then pantry food fit and stable title/id ties", () => {
  const pantry = [stock("rice", "rice"), stock("tomato", "tomato"), stock("garlic", "garlic")];
  const recipes = [recipe("main-missing", ["rice", "onion"], "A dinner"), recipe("side", ["rice"], "A side"),
    recipe("unknown", ["rice"], "A dish"), recipe("main-b", ["rice", "tomato"], "Dinner"),
    recipe("main-a", ["rice", "garlic"], "Dinner")];
  const reviews = { "main-missing": metadata(), "main-a": metadata(), "main-b": metadata(), side: metadata("side") };
  assert.deepEqual(ids(findPantryDinners(recipes, ["rice"], pantry, TODAY, reviews)), ["main-a", "main-b", "main-missing", "unknown", "side"]);
  assert.deepEqual(ids(findPantryDinners([...recipes].reverse(), ["rice"], pantry, TODAY, reviews)), ["main-a", "main-b", "main-missing", "unknown", "side"]);
});

test("pantry dinners prefer fewer missing food ingredients over seasoning matches", () => {
  const pantry = ["rice", "eggs", "soy sauce", "salt", "olive oil"].map(name => stock(name, name));
  const recipes = [recipe("chicken-rice", ["rice", "chicken", "cream", "soy sauce", "salt", "olive oil"]),
    recipe("egg-rice", ["rice", "egg", "soy sauce", "onion", "black pepper"])];
  const reviews = { "chicken-rice": metadata(), "egg-rice": metadata() };
  assert.deepEqual(ids(findPantryDinners(recipes, ["rice"], pantry, TODAY, reviews)), ["egg-rice", "chicken-rice"]);
});

test("saved dislikes lower a matching dinner without silently excluding it", () => {
  const pantry = [stock("rice", "rice"), stock("egg", "egg")];
  const recipes = [recipe("disliked", ["rice", "egg"]), recipe("preferred", ["rice", "tomato"])];
  const reviews = { disliked: metadata(), preferred: metadata() };
  assert.deepEqual(ids(findPantryDinners(recipes, ["rice"], pantry, TODAY, reviews,
    normalizeConstraints({ dislikes: ["egg"] }))), ["preferred", "disliked"]);
});

test("bundled everyday dinners get main priority while reviewed roles stay authoritative", () => {
  const original = EVERYDAY_RECIPES.find(recipe => recipe.id === "everyday-garlic-tomato-pasta");
  assert.ok(original);
  const everyday = { ...original, id: `${DEMO_SOURCE.id}:${original.id}` };
  const unknown = recipe("unknown", ["pasta"]);
  const pantry = [stock("pasta", "pasta")];
  assert.deepEqual(ids(findPantryDinners([unknown, everyday], ["pasta"], pantry, TODAY)), [everyday.id, "unknown"]);
  assert.deepEqual(ids(findPantryDinners([unknown, everyday], ["pasta"], pantry, TODAY,
    { [everyday.id]: metadata("side") })), ["unknown", everyday.id]);
  assert.deepEqual(ids(findPantryDinners([unknown, everyday], ["pasta"], pantry, TODAY,
    { [everyday.id]: metadata("unknown") })), ["unknown", everyday.id]);
});

test("selection and ranking are pure, retain recipe identity, and work without network access", () => {
  const pantry = [stock("rice", "rice")], recipes = [recipe("dinner", ["rice"])], selected = ["rice"];
  const before = structuredClone({ pantry, recipes, selected });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Pantry dinner discovery must not make network calls"); };
  try {
    const result = findPantryDinners(recipes, selected, pantry, TODAY);
    assert.equal(result.matches[0].recipe, recipes[0]);
    assert.deepEqual({ pantry, recipes, selected }, before);
  } finally { globalThis.fetch = originalFetch; }
});
