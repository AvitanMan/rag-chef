// Read-only local generation check. Never selects a cloud provider or changes kitchen data.
const base = process.env.RECIPES_APP_URL || "http://localhost:3000";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) throw new Error("Use a local app for Chef evaluation.");
const cases = [
  { name: "named recipe", query: "Recommend Zucchini Pasta Bake. Keep its source directions unchanged.", expected: "Zucchini Pasta Bake" },
  { name: "requested substitution", query: "For Zucchini Pasta Bake, can I use olive oil instead of butter? Explain the tradeoff.", expected: "Zucchini Pasta Bake", adaptation: true },
  { name: "ingredient request with allergy", query: "Suggest a mushroom dinner.", allergies: ["peanut"] },
];
const get = async (path) => {
  const response = await fetch(new URL(path, base));
  if (!response.ok) throw new Error(`Snapshot failed: ${path} (${response.status})`);
  return response.text();
};
const kitchenBefore = await get("/api/kitchen");
const catalogBefore = await get("/api/recipes/catalog");
const results = [];
for (const item of cases) {
  const started = performance.now();
  const response = await fetch(new URL("/api/chef", base), {
    method: "POST", headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(150_000),
    body: JSON.stringify({ query: item.query, provider: "ollama", pantry: ["rice", "garlic", "tomatoes", "onion", "chicken", "parmesan", "pasta"], profile: { allergies: item.allergies ?? [], equipment: ["Oven", "Stovetop"] } }),
  });
  const data = await response.json();
  const titles = (data.recommendations ?? []).map((rec) => data.recipes?.find((recipe) => recipe.id === rec.recipeId)?.title);
  const adaptedTitles = (data.chefChanges ?? []).map((change) => data.recipes?.find((recipe) => recipe.id === change.recipeId)?.title);
  const knownIds = new Set((data.recipes ?? []).map((r) => r.id));
  const referencesValid = [...(data.recommendations ?? []), ...(data.sourceFacts ?? []), ...(data.chefChanges ?? []), ...(data.citations ?? [])].every((value) => knownIds.has(value.recipeId));
  const evidenceValid = (data.sourceFacts ?? []).every((fact) => {
    const recipe = data.recipes?.find((recipe) => recipe.id === fact.recipeId);
    const match = fact.evidenceId?.match(/^([IS])([1-9]\d{0,2})$/);
    if (!recipe || !match) return false;
    const index = Number(match[2]) - 1;
    const ingredient = recipe.ingredients[index];
    const original = match[1] === "I" ? ingredient && [ingredient.measure, ingredient.name].filter(Boolean).join(" ") : recipe.instructions[index];
    return fact.fact === original;
  });
  const changesMatchRequest = item.adaptation ? data.chefChanges?.length > 0 : data.chefChanges?.length === 0;
  const noInternalReferences = !/\bR[1-8]\b/.test(JSON.stringify([data.answer, data.warnings, ...(data.sourceFacts ?? []).map((x) => x.fact), ...(data.chefChanges ?? []).map((x) => [x.change, x.reason])]));
  const expectedRecipePresent = !item.expected || (item.adaptation ? adaptedTitles.includes(item.expected) : titles[0] === item.expected);
  const ok = response.ok && data.generation === "ai" && referencesValid && evidenceValid && expectedRecipePresent && changesMatchRequest && noInternalReferences;
  results.push({ name: item.name, query: item.query, ok, milliseconds: Math.round(performance.now() - started), generation: data.generation, titles, adaptedTitles, referencesValid, evidenceValid, expectedRecipePresent, changesMatchRequest, noInternalReferences, timings: data.timings, answer: data.answer, sourceFacts: data.sourceFacts, chefChanges: data.chefChanges, warnings: data.warnings });
  console.error(`${item.name}: ${results.at(-1).milliseconds} ms · ${data.generation} · ${ok ? "pass" : "FAIL"}`);
}
const unchanged = kitchenBefore === await get("/api/kitchen") && catalogBefore === await get("/api/recipes/catalog");
console.log(JSON.stringify({ passed: results.filter((r) => r.ok).length, total: cases.length, unchanged, results }, null, 2));
if (!unchanged || results.some((r) => !r.ok)) process.exitCode = 1;
