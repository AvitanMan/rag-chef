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

export interface RecipeSearchOptions {
  allergies?: string[];
  pantry?: string[];
  query?: string;
  limit?: number;
}
