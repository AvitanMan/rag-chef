import { DEMO_RECIPES, DEMO_SOURCE } from "./demo-recipes";
import type { Recipe, RecipeMetadata } from "./recipe-types";

// New bundled recipes need an explicit appliance entry; never assume stovetop.
const ORIGINAL_EQUIPMENT: Record<string, readonly string[]> = {
  "tomato-chickpea-pan": ["stovetop"],
  "lemon-white-bean-toast": ["stovetop"],
  "spinach-tomato-pasta": ["stovetop"],
  "everyday-garlic-tomato-pasta": ["stovetop"],
  "everyday-creamy-mushroom-pasta": ["stovetop"],
  "everyday-chicken-potato-tray-bake": ["oven"],
  "everyday-chicken-pepper-rice": ["stovetop"],
  "everyday-egg-fried-rice": ["stovetop"],
  "everyday-potato-onion-frittata": ["stovetop"],
  "everyday-tuna-tomato-pasta": ["stovetop"],
  "everyday-tomato-eggs-toast": ["stovetop"],
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

/** Authored appliance/classification facts only, bound to the complete bundled content.
 * This does not grant a curated-dinner badge, certify diets, or estimate total time.
 * The catalog joins attribution from its source record, so normalize that known
 * storage representation as well as the catalog ID before comparing all fields.
 */
export function builtinOriginalMetadata(recipe: Recipe, contentHash: string): RecipeMetadata | undefined {
  if (!/^[a-f0-9]{64}$/.test(contentHash)) return undefined;
  const original = DEMO_RECIPES.find(item => recipe.id === `${DEMO_SOURCE.id}:${item.id}`);
  if (!original) return undefined;
  const expected: Recipe = { ...original, id: recipe.id, source: {
    name: DEMO_SOURCE.name, url: DEMO_SOURCE.url,
    licenseId: DEMO_SOURCE.licenseId, licenseUrl: DEMO_SOURCE.licenseUrl!,
    attributionText: DEMO_SOURCE.attributionText!,
  } };
  if (JSON.stringify(canonical(recipe)) !== JSON.stringify(canonical(expected))) return undefined;

  const equipment = ORIGINAL_EQUIPMENT[original.id];
  if (!equipment) return undefined;
  const assessment = (evidence: string) => ({ basis: "curator_assessment" as const, evidence });
  const unknownDiet = assessment("Dietary suitability has not been reviewed for this original recipe.");
  return {
    revision: 1, sourceContentHash: contentHash, coreDinner: false, dinnerRole: "main",
    diets: { vegan: "unknown", vegetarian: "unknown", gluten_free: "unknown", low_carb: "unknown" },
    totalMinutes: null, equipment: [...equipment],
    provenance: {
      coreDinner: assessment("Bundled original recipe; not approved as a reviewed core dinner."),
      dinnerRole: assessment("This original recipe was authored as a complete dinner for two."),
      "diets.vegan": unknownDiet, "diets.vegetarian": unknownDiet,
      "diets.gluten_free": unknownDiet, "diets.low_carb": unknownDiet,
      totalMinutes: assessment("Total cooking time has not been measured."),
      equipment: assessment(`The complete bundled original method requires ${equipment.join(" and ")} cooking. No other supported appliance is used.`),
      servings: assessment("The bundled original definition specifies two servings; the recipe has not been kitchen-tested."),
      ingredients: assessment("Amounts come from the bundled original definition and have not been kitchen-tested."),
    },
    reviewedBy: "Bundled original definitions (not a cooking trial)",
    reviewedAt: "2026-11-15T00:00:00.000Z",
  };
}
