export interface RecipeIngredient {
  name: string;
  measure: string;
}

export interface RecipeSourceAttribution {
  name: string;
  url: string;
  licenseId?: string;
  licenseUrl?: string;
  attributionText?: string;
}

export interface Recipe {
  id: string;
  title: string;
  image: string | null;
  category: string;
  cuisine: string;
  source: RecipeSourceAttribution;
  sourceUrl: string;
  ingredients: RecipeIngredient[];
  instructions: string[];
  tags: string[];
  servings?: number;
}

export type Diet = "vegan" | "vegetarian" | "gluten_free" | "low_carb";
export type DietSuitability = "fits" | "conflicts" | "unknown";
export interface RecipeMetadata {
  revision: number;
  sourceContentHash: string;
  coreDinner: boolean;
  dinnerRole: "main" | "side" | "component" | "dessert" | "unknown";
  diets: Record<Diet, DietSuitability>;
  totalMinutes: number | null;
  equipment: string[] | null;
  provenance: Record<string, {
    basis: "source" | "curator_assessment" | "curator_estimate";
    evidence: string;
  }>;
  reviewedBy: string;
  reviewedAt: string;
}
export type RecipeMetadataMap = Record<string, RecipeMetadata>;

export interface RecipeConstraints {
  allergies: string[];
  excludedIngredients?: string[];
  diets: Diet[];
  dislikes: string[];
  equipment: string[];
  equipmentSpecified: boolean;
  maxTotalMinutes?: number;
}

export interface RecipeSearchOptions {
  allergies?: string[];
  pantry?: string[];
  query?: string;
  limit?: number;
  constraints?: RecipeConstraints;
}
