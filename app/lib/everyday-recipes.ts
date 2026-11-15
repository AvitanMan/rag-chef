import type { Recipe } from "./recipe-types";

const temperatureSource = "https://www.foodsafety.gov/food-safety-charts/safe-minimum-internal-temperatures";
const originalContentNote = "Original RAG Chef recipe. Not kitchen-tested; total time has not been measured.";
const notes = (description: string, temperatureGuidance = false) => [
  `About this dish: ${description}`,
  originalContentNote,
  ...(temperatureGuidance ? [`Cooking temperature guidance: ${temperatureSource}`] : []),
];

/** Original everyday dinners; source attribution is supplied by the starter catalog. */
export function createEverydayRecipes(common: Pick<Recipe, "source" | "sourceUrl">): Recipe[] {
  const base = { ...common, image: null, category: "Everyday dinner", cuisine: "Home cooking", servings: 2, tags: ["everyday"] };
  return [
    {
      ...base, id: "everyday-garlic-tomato-pasta", title: "Garlic Tomato Pasta",
      sourceNotes: notes("Pasta tossed in a rich garlic and tomato sauce, finished with Parmesan."),
      ingredients: [
        { name: "pasta", measure: "200 g" }, { name: "canned chopped tomatoes", measure: "400 g" },
        { name: "garlic", measure: "3 cloves" }, { name: "olive oil", measure: "1 tbsp" },
        { name: "Parmesan cheese", measure: "30 g" }, { name: "salt", measure: "0.5 tsp" },
        { name: "black pepper", measure: "0.25 tsp" }, { name: "water", measure: "2 l" },
      ],
      instructions: [
        "Peel and finely chop the garlic. Finely grate the Parmesan.",
        "Bring the water to a boil in a saucepan on the stovetop. Add the pasta and cook according to its package directions until just tender. Reserve 100 ml of the cooking water, then drain the pasta.",
        "While the pasta cooks, warm the olive oil in a large frying pan over medium-low heat. Add the garlic and stir until fragrant, without letting it brown.",
        "Add the tomatoes, salt and black pepper. Simmer uncovered over medium-low heat, stirring occasionally, until the sauce thickens and no longer looks watery.",
        "Add the drained pasta to the sauce. Toss over low heat, adding the reserved cooking water a tablespoon at a time only if needed to coat the pasta. Remove from the heat, stir in half the Parmesan, and divide between two bowls. Scatter the remaining Parmesan over the top.",
      ],
    },
    {
      ...base, id: "everyday-creamy-mushroom-pasta", title: "Creamy Garlic Mushroom Pasta",
      sourceNotes: notes("Golden mushrooms and garlic in a creamy Parmesan sauce that clings to the pasta."),
      ingredients: [
        { name: "pasta", measure: "200 g" }, { name: "mushrooms", measure: "250 g" },
        { name: "garlic", measure: "2 cloves" }, { name: "butter", measure: "20 g" },
        { name: "heavy cream", measure: "100 ml" }, { name: "Parmesan cheese", measure: "30 g" },
        { name: "salt", measure: "0.25 tsp" }, { name: "black pepper", measure: "0.25 tsp" },
        { name: "water", measure: "2 l" },
      ],
      instructions: [
        "Wipe the mushrooms clean and slice them. Peel and finely chop the garlic. Finely grate the Parmesan.",
        "Bring the water to a boil in a saucepan on the stovetop. Cook the pasta according to its package directions until just tender. Reserve 150 ml of the cooking water, then drain the pasta.",
        "While the pasta cooks, melt the butter in a wide frying pan over medium-high heat. Add the mushrooms and spread them across the pan. Cook, stirring occasionally, until their liquid has evaporated and the edges are golden.",
        "Reduce the heat to medium-low. Stir in the garlic, salt and black pepper and cook until the garlic is fragrant. Add the cream and bring to a gentle simmer.",
        "Add the drained pasta and toss to coat. Remove from the heat and stir in the Parmesan. Add the reserved pasta water a tablespoon at a time as needed for a smooth sauce. Divide between two bowls and serve.",
      ],
    },
    {
      ...base, id: "everyday-chicken-potato-tray-bake", title: "Paprika Chicken & Potato Tray Bake",
      sourceNotes: notes("Paprika-coated chicken, golden potato wedges and sweet roasted onion on one tray.", true),
      ingredients: [
        { name: "chicken breast", measure: "350 g" }, { name: "potatoes", measure: "500 g" },
        { name: "onion", measure: "1" }, { name: "olive oil", measure: "2 tbsp" },
        { name: "paprika", measure: "1 tsp" }, { name: "salt", measure: "0.5 tsp" },
        { name: "black pepper", measure: "0.25 tsp" },
      ],
      instructions: [
        "Heat the oven to 200°C (390°F). Scrub the potatoes and cut them into wedges no thicker than 2 cm. Peel the onion and cut it into thick wedges.",
        "Put the potatoes and onion on a large rimmed baking tray. Toss with 1 tablespoon of the olive oil, half the paprika, half the salt and half the black pepper. Spread in one layer and roast for 20 minutes.",
        "Use boneless, skinless chicken breast. Cut it into pieces about 3 cm across on a separate board. Coat with the remaining olive oil, paprika, salt and pepper. Wash hands and clean utensils and surfaces that touched the raw chicken.",
        "Turn the potatoes and onion, then add the chicken in the spaces between them. Return the tray to the oven. Roast until the potatoes are tender with golden edges and the thickest chicken pieces reach 74°C (165°F), checked with a food thermometer. Begin checking after 15 minutes; keep cooking until both are done.",
        "Use clean serving utensils to divide the chicken, potatoes and onion between two plates, spooning the tray juices over the top.",
      ],
    },
    {
      ...base, id: "everyday-chicken-pepper-rice", title: "Chicken & Pepper Rice Bowls",
      sourceNotes: notes("Paprika chicken and softened peppers in a tomato sauce, spooned over fluffy rice.", true),
      ingredients: [
        { name: "rice", measure: "150 g" }, { name: "chicken breast", measure: "300 g" },
        { name: "bell pepper", measure: "1" }, { name: "onion", measure: "1" },
        { name: "canned chopped tomatoes", measure: "200 g" }, { name: "olive oil", measure: "1 tbsp" },
        { name: "paprika", measure: "1 tsp" }, { name: "salt", measure: "0.5 tsp" },
        { name: "black pepper", measure: "0.25 tsp" }, { name: "water", measure: "1 l" },
      ],
      instructions: [
        "Bring the water to a boil in a saucepan on the stovetop. Use ordinary white rice. Add the uncooked rice and boil uncovered, stirring occasionally, until tender; start checking after 10 minutes and continue until cooked. Drain through a fine sieve, return to the saucepan off the heat, and cover to keep warm while finishing the chicken.",
        "Peel and slice the onion. Remove the pepper's stalk and seeds, then cut the pepper into strips. Cut boneless, skinless chicken breast into 2 cm pieces using a separate board. Wash hands and clean utensils and surfaces that touched the raw chicken.",
        "Warm the olive oil in a large frying pan over medium heat. Add the onion and pepper and cook, stirring, until softened. Stir in the chicken and paprika and cook, turning the pieces, until lightly browned on the outside; it will finish cooking in the sauce.",
        "Add the tomatoes, salt and black pepper. Bring to a gentle simmer, cover, and cook until the thickest chicken pieces reach 74°C (165°F), checked with a food thermometer. Stir occasionally. If the sauce is very loose when the chicken is done, uncover and simmer until it coats the chicken and peppers.",
        "Fluff the rice with a fork and divide between two bowls. Spoon the chicken, peppers and sauce over the rice and serve hot.",
      ],
    },
    {
      ...base, id: "everyday-egg-fried-rice", title: "Egg & Pea Fried Rice",
      sourceNotes: notes("Rice tossed with soft scrambled egg, sweet peas, carrot and soy sauce. Starts with uncooked rice.", true),
      ingredients: [
        { name: "rice", measure: "150 g" }, { name: "eggs", measure: "3" },
        { name: "frozen peas", measure: "100 g" }, { name: "carrot", measure: "1" },
        { name: "onion", measure: "1" }, { name: "vegetable oil", measure: "2 tbsp" },
        { name: "soy sauce", measure: "1 tbsp" }, { name: "water", measure: "1 l" },
      ],
      instructions: [
        "Bring the water to a boil in a saucepan on the stovetop. Use ordinary white rice. Add the uncooked rice and boil uncovered, stirring occasionally, until just tender; start checking after 10 minutes and continue until cooked. Drain thoroughly through a fine sieve and spread on a large clean plate so steam can escape while you immediately prepare the other ingredients.",
        "Peel and finely dice the onion and carrot. Beat the eggs in a bowl.",
        "Warm 1 tablespoon of the vegetable oil in a large non-stick frying pan over medium heat. Add the eggs and stir gently to form curds. Cook until set with no runny egg, then transfer to a clean plate.",
        "Add the remaining oil to the pan. Cook the onion and carrot over medium heat, stirring, until softened. Add the frozen peas and cook until hot throughout.",
        "Turn the heat to medium-high. Add the drained rice and soy sauce. Toss and stir, breaking up clumps, until the rice is hot throughout. Return the cooked egg to the pan and stir until the mixture reaches 71°C (160°F), checked with a food thermometer. Divide between two bowls and serve immediately.",
      ],
    },
    {
      ...base, id: "everyday-potato-onion-frittata", title: "Golden Potato & Onion Frittata",
      sourceNotes: notes("A thick stovetop omelette with tender potatoes, sweet onion and a golden base.", true),
      ingredients: [
        { name: "eggs", measure: "4" }, { name: "potatoes", measure: "350 g" },
        { name: "onion", measure: "1" }, { name: "olive oil", measure: "2 tbsp" },
        { name: "salt", measure: "0.5 tsp" }, { name: "black pepper", measure: "0.25 tsp" },
        { name: "water", measure: "60 ml" },
      ],
      instructions: [
        "Scrub the potatoes and cut them into slices about 3 mm thick. Peel and thinly slice the onion.",
        "Heat the olive oil in a 20 cm non-stick frying pan with a lid over medium-low heat. Add the potatoes and onion and turn them through the oil. Add the water, cover, and cook gently, stirring occasionally, until the potatoes are tender when pierced with a fork.",
        "Remove the lid and let any remaining water evaporate, turning the vegetables gently. Spread the potatoes and onion evenly across the pan and reduce the heat to low.",
        "Beat the eggs with the salt and black pepper. Pour evenly over the vegetables. Cover and cook gently until the egg is set all the way through and the center reaches 71°C (160°F), checked with a food thermometer. Keep the heat low so the base does not burn while the center sets.",
        "Remove from the heat. Loosen the edges with a spatula, cut into wedges in the pan, and divide between two plates.",
      ],
    },
    {
      ...base, id: "everyday-tuna-tomato-pasta", title: "Tuna & Tomato Pasta",
      sourceNotes: notes("Flaked tuna folded into a garlicky tomato sauce for a filling cupboard pasta dinner."),
      ingredients: [
        { name: "pasta", measure: "200 g" }, { name: "canned tuna, drained", measure: "150 g" },
        { name: "canned chopped tomatoes", measure: "400 g" }, { name: "garlic", measure: "2 cloves" },
        { name: "olive oil", measure: "1 tbsp" }, { name: "salt", measure: "0.25 tsp" },
        { name: "black pepper", measure: "0.25 tsp" }, { name: "water", measure: "2 l" },
      ],
      instructions: [
        "Peel and finely chop the garlic. Drain enough canned tuna to give 150 g and break it into large flakes.",
        "Bring the water to a boil in a saucepan on the stovetop. Cook the pasta according to its package directions until just tender. Reserve 100 ml of the cooking water, then drain the pasta.",
        "While the pasta cooks, warm the olive oil in a large frying pan over medium-low heat. Stir in the garlic and cook until fragrant without browning it. Add the tomatoes, salt and black pepper. Simmer, stirring occasionally, until the sauce thickens.",
        "Fold the tuna into the sauce and heat through. Add the drained pasta and toss gently, adding the reserved pasta water a tablespoon at a time only if needed to loosen the sauce. Divide between two bowls and serve.",
      ],
    },
    {
      ...base, id: "everyday-tomato-eggs-toast", title: "Tomato Skillet Eggs with Toast",
      sourceNotes: notes("Eggs nestled in a paprika tomato sauce, with crisp toast for scooping up the sauce.", true),
      ingredients: [
        { name: "eggs", measure: "4" }, { name: "canned chopped tomatoes", measure: "400 g" },
        { name: "onion", measure: "1" }, { name: "garlic", measure: "2 cloves" },
        { name: "olive oil", measure: "1 tbsp" }, { name: "paprika", measure: "1 tsp" },
        { name: "salt", measure: "0.25 tsp" }, { name: "black pepper", measure: "0.25 tsp" },
        { name: "bread", measure: "4 slices" },
      ],
      instructions: [
        "Peel and finely chop the onion and garlic. Warm the olive oil in a frying pan with a lid over medium heat. Cook the onion, stirring, until softened. Add the garlic and paprika and stir until fragrant.",
        "Add the tomatoes, salt and black pepper. Simmer uncovered, stirring occasionally, until the sauce thickens enough to hold a shallow well made with a spoon.",
        "Make four shallow wells in the sauce. Crack one egg into a small bowl, then slide it into a well; repeat with the remaining eggs. Reduce the heat to low, cover, and cook gently until both the egg whites and yolks are firm. Keep the sauce at a gentle simmer so it does not scorch.",
        "While the eggs cook, toast the bread in a dry frying pan over medium heat, turning until crisp on both sides.",
        "Divide the eggs and tomato sauce between two plates and serve with the toast.",
      ],
    },
  ];
}
