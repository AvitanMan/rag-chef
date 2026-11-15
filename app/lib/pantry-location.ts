import type { PantryLocation, PantryStock } from "./kitchen-types";

export type PantryLocationFilter = "all" | "unsorted" | PantryLocation;

export const PANTRY_LOCATIONS: { value: PantryLocation; label: string }[] = [
  { value: "fridge", label: "Fridge" },
  { value: "freezer", label: "Freezer" },
  { value: "cupboard", label: "Cupboard" },
  { value: "spice-rack", label: "Spice rack" },
];

/** View state only: old or unavailable location choices never assign storage to food. */
export function normalizePantryLocation(value: unknown, pantry: readonly Pick<PantryStock, "location">[]): PantryLocationFilter {
  if (value === "unsorted") return pantry.some(stock => stock.location === undefined) ? "unsorted" : "all";
  return value === "all" || PANTRY_LOCATIONS.some(location => location.value === value) ? value as PantryLocationFilter : "all";
}

export const SPICE_RACK_ITEMS: string[] = [
  "salt", "black pepper", "paprika", "ground cumin", "ground cinnamon",
  "turmeric", "chili flakes", "dried oregano", "dried thyme", "garlic powder",
];

const SUGGESTIONS: Record<string, PantryLocation> = {
  milk: "fridge", yogurt: "fridge", yoghurt: "fridge", butter: "fridge",
  cheese: "fridge", eggs: "fridge", egg: "fridge", tofu: "fridge",
  chicken: "fridge", "chicken breast": "fridge", "chicken breasts": "fridge", "chicken thighs": "fridge",
  mushroom: "fridge", mushrooms: "fridge", carrot: "fridge", carrots: "fridge", spinach: "fridge",
  "bell pepper": "fridge", "bell peppers": "fridge", cream: "fridge", "heavy cream": "fridge",
  "parmesan cheese": "fridge", "cooked rice": "fridge",
  "frozen peas": "freezer", "frozen spinach": "freezer", "frozen broccoli": "freezer",
  "frozen berries": "freezer", "ice cream": "freezer",
  rice: "cupboard", pasta: "cupboard", spaghetti: "cupboard", oats: "cupboard",
  flour: "cupboard", sugar: "cupboard", "olive oil": "cupboard", "vegetable oil": "cupboard",
  potato: "cupboard", potatoes: "cupboard", onion: "cupboard", onions: "cupboard", garlic: "cupboard", bread: "cupboard",
  "canned tuna": "cupboard", "canned chickpeas": "cupboard",
  "canned tomatoes": "cupboard", "canned beans": "cupboard", "dried lentils": "cupboard",
  ...Object.fromEntries(SPICE_RACK_ITEMS.map(name => [name, "spice-rack" as const])),
};

export function pantryLocationLabel(location?: PantryLocation): string {
  return PANTRY_LOCATIONS.find(item => item.value === location)?.label ?? "Unsorted";
}

export function withPantryLocation<T extends { location?: PantryLocation }>(value: T, location: PantryLocation | undefined): T {
  const next = { ...value };
  if (location) next.location = location;
  else delete next.location;
  return next;
}

/** A small exact-name suggestion map; callers review suggestions before saving. */
export function suggestPantryLocation(name: string): PantryLocation | undefined {
  const normalized = name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  return Object.hasOwn(SUGGESTIONS, normalized) ? SUGGESTIONS[normalized] : undefined;
}
