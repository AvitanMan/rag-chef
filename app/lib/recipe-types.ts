export interface RecipeIngredient {
  name: string;
  measure: string;
}

export interface RecipeSourceAttribution {
  name: string;
  url: string;
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
}

export interface RecipeSearchOptions {
  pantry?: string[];
  query?: string;
  limit?: number;
}
