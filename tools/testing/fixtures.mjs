import { createHash } from "node:crypto";
import { journeyRecipes, journeyMetadata } from "./journey-fixtures.mjs";

// Original, synthetic test recipes. These are never imported into a user kitchen.
export const fixtureRecipes = [
  { id: "fixture-tomato-rice", title: "Tomato Rice", ingredients: [{ name: "rice", measure: "200 g" }, { name: "tomato", measure: "2" }], tags: ["vegan", "vegetarian"], servings: 2, instructions: ["Rinse the rice.", "Simmer the rice and tomatoes for 10 minutes."] },
  { id: "fixture-cheese-pasta", title: "Cheese Pasta", ingredients: [{ name: "pasta", measure: "200 g" }, { name: "cheese", measure: "100 g" }], tags: ["vegetarian"], servings: 2, instructions: ["Boil pasta for 8 minutes.", "Stir in the cheese."] },
  { id: "fixture-peanut-noodles", title: "Peanut Noodles", ingredients: [{ name: "noodles", measure: "200 g" }, { name: "groundnuts", measure: "50 g" }], tags: ["vegan", "vegetarian"], servings: 2, instructions: ["Cook the noodles.", "Stir in the groundnuts."] },
  { id: "fixture-fish-bowl", title: "Salmon Bowl", ingredients: [{ name: "salmon", measure: "200 g" }, { name: "rice", measure: "200 g" }], tags: [], servings: 2, instructions: ["Cook rice.", "Cook salmon until done."] },
  { id: "fixture-vegan-beans", title: "Garlic Beans", ingredients: [{ name: "beans", measure: "400 g" }, { name: "garlic", measure: "2 cloves" }], tags: ["vegan", "vegetarian"], servings: 2, instructions: ["Warm the beans.", "Add garlic and simmer for 5 minutes."] },
  { id: "fixture-unknown-soup", title: "Garden Soup", ingredients: [{ name: "vegetable stock", measure: "500 ml" }, { name: "carrot", measure: "200 g" }], tags: [], instructions: ["Simmer the carrots in stock until tender."] },
  { id: "fixture-eggplant", title: "Eggplant Stew", ingredients: [{ name: "eggplant", measure: "300 g" }, { name: "tomato", measure: "2" }], tags: ["vegan", "vegetarian"], servings: 2, instructions: ["Total time: 20 minutes. Dice the eggplant.", "Simmer with tomato for 15 minutes."] },
  { id: "fixture-beef-stew", title: "Beef Stew", ingredients: [{ name: "beef", measure: "200 g" }, { name: "onion", measure: "1" }], tags: [], servings: 2, instructions: ["Prepare the beef and onion.", "Simmer the stew until cooked."] },
];

const quote = (value) => value === null || value === undefined ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
export function fixtureSql({ grounding = false, journeys = false } = {}) {
  const statements = [
    `INSERT INTO recipe_sources (id,name,url,license_id,license_url,attribution_text,permission_basis,approval_status,approved_by,allow_display,allow_cache,allow_index_text,allow_embed,allow_derive,created_at,updated_at) VALUES ('test-fixtures','Original test fixtures','https://example.invalid/fixtures','CC0-1.0','https://creativecommons.org/publicdomain/zero/1.0/','Original synthetic recipes created for automated tests.','Original test content','approved','test-runner',1,1,1,1,1,1,1);`,
  ];
  const groundingRecipes = grounding ? [{ id: "fixture-oven-dinner", title: "Source Oven Dinner", ingredients: [{ name: "rice", measure: "200 g" }, { name: "vegetable stock", measure: "400 ml" }], tags: ["vegan"], servings: 2,
    instructions: Array.from({ length: 30 }, (_, index) => index === 19 ? "Preheat the oven to 180°C. Bake for 25–30 minutes until golden." : `Source direction ${index + 1}: continue preparing the ingredients.`) }] : [];
  for (const recipe of [...fixtureRecipes, ...groundingRecipes, ...(journeys ? journeyRecipes : [])]) {
    const contentHash = createHash("sha256").update(JSON.stringify(recipe)).digest("hex");
    const values = [recipe.id, "test-fixtures", recipe.id, `https://example.invalid/fixtures/${recipe.id}`, recipe.title, "Test", "Test", JSON.stringify(recipe.tags), `${recipe.title} ${recipe.ingredients.map((row) => row.name).join(" ")} ${recipe.instructions.join(" ")}`, contentHash, recipe.servings, 1, 1, 1];
    statements.push(`INSERT INTO recipes (id,source_id,source_record_id,source_url,title,category,cuisine,tags_json,search_text,normalized_content_sha256,servings,created_at,updated_at,last_seen_at) VALUES (${values.map(quote).join(",")});`);
    if (journeys && journeyRecipes.some(row => row.id === recipe.id)) {
      const metadata = journeyMetadata(recipe, contentHash);
      statements.push(`INSERT INTO recipe_metadata (recipe_id,revision,source_content_sha256,payload_json,reviewed_by,reviewed_at) VALUES (${[recipe.id, 1, contentHash, JSON.stringify(metadata), metadata.reviewedBy, metadata.reviewedAt].map(quote).join(",")});`);
    }
    recipe.ingredients.forEach((row, position) => statements.push(`INSERT INTO recipe_ingredients (recipe_id,position,original_name,normalized_name,original_measure) VALUES (${[recipe.id, position, row.name, row.name, row.measure].map(quote).join(",")});`));
    const section = `${recipe.id}-steps`;
    statements.push(`INSERT INTO recipe_instruction_sections (id,recipe_id,position) VALUES (${[section, recipe.id, 0].map(quote).join(",")});`);
    recipe.instructions.forEach((step, position) => statements.push(`INSERT INTO recipe_instruction_steps (recipe_id,section_id,position,text) VALUES (${[recipe.id, section, position, step].map(quote).join(",")});`));
  }
  return statements.join("\n");
}
