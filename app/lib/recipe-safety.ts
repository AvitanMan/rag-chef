import type { RecipeIngredient } from "./recipe-types";

// Preserve the Chef's conservative ingredient-text exclusions. These are not
// allergy certification and cannot detect cross-contact or missing source data.
const ALLERGY_GROUPS: Array<{ labels: string[]; terms: string[] }> = [
  { labels: ["dairy", "milk", "lactose"], terms: ["milk", "cream", "butter", "cheese", "whey", "casein", "yogurt", "yoghurt", "ghee", "lactose", "mozzarella", "parmesan", "parmigiano", "pecorino", "feta", "ricotta", "cheddar", "paneer", "buttermilk", "mascarpone", "brie", "gorgonzola"] },
  { labels: ["egg", "eggs"], terms: ["egg", "eggs", "mayonnaise", "meringue", "albumen"] },
  { labels: ["peanut", "peanuts"], terms: ["peanut", "peanuts", "groundnut", "groundnuts"] },
  { labels: ["tree nut", "tree nuts", "nut", "nuts"], terms: ["nut", "nuts", "almond", "almonds", "walnut", "walnuts", "cashew", "cashews", "pistachio", "pistachios", "pecan", "pecans", "hazelnut", "hazelnuts", "macadamia", "brazil nut", "pine nut", "marzipan"] },
  { labels: ["gluten"], terms: ["gluten", "wheat", "flour", "barley", "rye", "spelt", "semolina", "couscous", "breadcrumbs", "bread crumbs", "bread", "pasta", "farfalle", "ziti", "penne", "macaroni", "spaghetti", "fettuccine", "lasagne", "lasagna", "orzo", "soy sauce", "seitan", "bulgur", "udon"] },
  { labels: ["wheat"], terms: ["wheat", "flour", "semolina", "couscous", "breadcrumbs", "bread crumbs", "bread", "pasta", "farfalle", "ziti", "penne", "macaroni", "spaghetti", "fettuccine", "lasagne", "lasagna", "orzo", "seitan", "bulgur", "udon"] },
  { labels: ["soy", "soya"], terms: ["soy", "soya", "tofu", "tempeh", "edamame", "miso", "tamari", "soy sauce"] },
  { labels: ["sesame"], terms: ["sesame", "tahini"] },
  { labels: ["fish"], terms: ["fish", "salmon", "tuna", "cod", "anchovy", "anchovies", "sardine", "sardines", "trout", "haddock", "fish sauce", "worcestershire"] },
  { labels: ["shellfish", "crustacean", "mollusc"], terms: ["shellfish", "shrimp", "prawn", "prawns", "crab", "lobster", "clam", "clams", "mussel", "mussels", "oyster", "oysters", "scallop", "scallops", "crayfish", "squid", "octopus"] },
  { labels: ["mustard"], terms: ["mustard"] },
  { labels: ["celery"], terms: ["celery", "celeriac"] },
];

export function normalizeIngredientText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function containsIngredientTerm(haystack: string, term: string): boolean {
  const needle = normalizeIngredientText(term);
  return Boolean(needle) && ` ${haystack} `.includes(` ${needle} `);
}

export function matchedRecipeAllergies(recipe: { ingredients: RecipeIngredient[]; allergens?: string[] }, allergies: string[]): string[] {
  const text = normalizeIngredientText([...recipe.ingredients.map((item) => item.name), ...(recipe.allergens ?? [])].join(" | "));
  return allergies.filter((raw) => {
    const allergy = normalizeIngredientText(raw).replace(/\b(?:allergy|allergies|allergic|intolerance|intolerant|to)\b/g, " ").replace(/\s+/g, " ").trim();
    if (!allergy) return false;
    const group = ALLERGY_GROUPS.find(({ labels }) => labels.some((label) => allergy === label || containsIngredientTerm(allergy, label)));
    return (group?.terms ?? [allergy]).some((term) => containsIngredientTerm(text, term));
  });
}
