// Original synthetic records with fixed facts shared by both journey tracks.
export const journeyRecipes = [
  { id: "journey-pasta-bake", title: "Zucchini Pasta Bake", servings: 4, tags: ["vegetarian"],
    ingredients: [{ name: "any small pasta", measure: "400 g" }, { name: "cheese, grated", measure: "250 g" }, { name: "eggs", measure: "2" }, { name: "milk", measure: "200 ml" }, { name: "butter", measure: "50 g" }, { name: "medium zucchini, grated", measure: "3" }, { name: "Vegetable stock base", measure: "" }, { name: "Salt", measure: "" }, { name: "Pepper", measure: "" }],
    instructions: ["Prepare the pasta according to its packaging, then drain it.", "Whisk the eggs with milk, salt, and pepper.", "Fold the grated cheese into the egg mixture.", "Melt the butter and mix it in.", "Dissolve the stock base in a little hot water and stir it in.", "Combine the zucchini, pasta, and mixture.", "Transfer everything to a greased baking dish.", "Bake at 200°C (400°F) for about 30 minutes, until firm throughout."] },
  { id: "journey-lentil-soup", title: "Red Lentil Soup", servings: 4, tags: ["vegan", "vegetarian"],
    ingredients: [{ name: "red lentils", measure: "250 g" }, { name: "onion", measure: "1" }, { name: "carrots", measure: "2" }, { name: "garlic", measure: "2 cloves" }, { name: "olive oil", measure: "1 tbsp" }, { name: "vegetable stock", measure: "1 L" }],
    instructions: ["Rinse and inspect the lentils.", "Soften the chopped onion and carrots in oil, then add garlic.", "Add lentils and stock. Simmer for 20–30 minutes until the lentils are soft.", "Serve the soup hot."] },
];
export function journeyMetadata(recipe, contentHash) {
  const vegan = recipe.id === "journey-lentil-soup";
  return { revision: 1, sourceContentHash: contentHash, coreDinner: true, dinnerRole: "main", diets: { vegetarian: "fits", vegan: vegan ? "fits" : "conflicts", gluten_free: "unknown", low_carb: "unknown" }, totalMinutes: null, equipment: vegan ? ["Stovetop"] : ["Stovetop", "Oven"],
    provenance: Object.fromEntries(["coreDinner", "dinnerRole", "diets.vegan", "diets.vegetarian", "diets.gluten_free", "diets.low_carb", "totalMinutes", "equipment", "servings", "ingredients"].map(field => [field, { basis: "curator_assessment", evidence: `Original synthetic evaluation record: ${field}; unknown fields remain unknown.` }])), reviewedBy: "journey-evaluation", reviewedAt: "2026-10-26T00:00:00.000Z" };
}
