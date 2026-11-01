import type { Recipe } from "./recipe-types";
import type { ApprovedRecipeSourceInput } from "./recipe-store";

const sourceUrl = "https://github.com/AvitanMan/rag-chef/blob/main/app/lib/demo-recipes.ts";
const licenseUrl = "https://github.com/AvitanMan/rag-chef/blob/main/LICENSE";

/** Original starter content, separate from the synthetic evaluation fixtures. */
export const DEMO_SOURCE: ApprovedRecipeSourceInput = {
  id: "rag-chef-starters", name: "RAG Chef starter recipes", url: sourceUrl,
  licenseId: "MIT", licenseUrl, attributionText: "Original RAG Chef starter recipes. Shared under the repository's MIT license.",
  permissionBasis: "Original content distributed with this application under MIT.",
  approvalStatus: "approved", approvedBy: "RAG Chef maintainers",
  allowDisplay: true, allowCache: true, allowIndexText: true, allowEmbed: true,
  allowDerive: true, allowCommercial: true, allowImages: false,
};

const common = {
  image: null, category: "Starter dinner", cuisine: "Home cooking", servings: 2,
  source: { name: DEMO_SOURCE.name, url: sourceUrl, licenseId: "MIT", licenseUrl, attributionText: DEMO_SOURCE.attributionText! },
  sourceUrl, tags: ["starter"],
  sourceNotes: ["Original starter recipe included with RAG Chef. Total time has not been measured."],
};

export const DEMO_RECIPES: Recipe[] = [
  { ...common, id: "tomato-chickpea-pan", title: "Tomato Chickpea Pan",
    ingredients: [{ name: "canned chickpeas, drained", measure: "400 g" }, { name: "canned chopped tomatoes", measure: "400 g" }, { name: "onion", measure: "1" }, { name: "olive oil", measure: "1 tbsp" }, { name: "ground cumin", measure: "1 tsp" }, { name: "bread", measure: "4 slices" }],
    instructions: ["Peel and finely chop the onion. Drain and rinse the canned chickpeas.", "Warm the olive oil in a frying pan on the stovetop over medium heat. Add the onion and cook, stirring, until softened.", "Stir in the cumin, chickpeas and tomatoes. Bring to a gentle simmer, then reduce the heat and stir occasionally until the sauce has thickened and the chickpeas are hot throughout.", "Divide between two bowls and serve with the bread."],
  },
  { ...common, id: "lemon-white-bean-toast", title: "Lemon White Bean Toast",
    ingredients: [{ name: "canned white beans, drained", measure: "400 g" }, { name: "lemon juice", measure: "2 tbsp" }, { name: "olive oil", measure: "1 tbsp" }, { name: "bread", measure: "4 slices" }, { name: "tomato", measure: "2" }],
    instructions: ["Drain and rinse the canned white beans. Slice the tomatoes.", "In a bowl, mash the beans with the lemon juice and olive oil, leaving some beans whole.", "Toast the bread in a dry frying pan on the stovetop over medium heat, turning until both sides are crisp.", "Spread the bean mixture on the toast and top with the sliced tomatoes. Divide between two plates and serve."],
  },
  { ...common, id: "spinach-tomato-pasta", title: "Spinach Tomato Pasta",
    ingredients: [{ name: "pasta", measure: "200 g" }, { name: "canned chopped tomatoes", measure: "400 g" }, { name: "spinach", measure: "100 g" }, { name: "olive oil", measure: "1 tbsp" }, { name: "garlic", measure: "2 cloves" }, { name: "water", measure: "2 l" }],
    instructions: ["Peel and finely chop the garlic. Wash the spinach.", "Bring the water to a boil in a saucepan on the stovetop. Add the pasta and cook according to its package directions. Before draining, reserve a small cup of the cooking water.", "While the pasta cooks, warm the olive oil in a frying pan over medium-low heat. Stir in the garlic and cook until fragrant, without browning it.", "Add the tomatoes and simmer until the sauce thickens. Stir in the spinach until wilted.", "Add the drained pasta and toss with the sauce. If needed, add a little reserved cooking water to loosen it. Divide between two bowls and serve."],
  },
];
