// Labels fixed before threshold calibration. Held-out queries are never used to
// select thresholds. The corpus retains recipe attribution in fixtures/.
const supported = {
  calibration: [
    ["Cheese Omelette", ["Cheese Omelette"]], ["Baked Ziti", ["Baked Ziti"]],
    ["Red Lentil Soup", ["Red Lentil Soup"]], ["Chickpea Stew", ["Chickpea Stew"]],
    ["Zucchini Pasta Bake", ["Zucchini Pasta Bake"]], ["Mapo Tofu", ["Mapo Tofu"]],
    ["Pad See Ew", ["Pad See Ew"]], ["Bean Chili", ["Bean Chili"]],
    ["a cozy lentil soup", ["Red Lentil Soup"]], ["a creamy pasta with mushrooms", ["Creamy Mushroom Pasta"]],
    ["chickpea curry", ["Cholley (Chickpea Curry)"]], ["tomato pasta", ["Tomato Pasta", "Eggplant Pasta"]],
    ["egg rice", ["Chicken Fried Rice", "Loco Moco (Rice with Egg and Hamburger)"]],
    ["blueberry breakfast", ["Blueberry Pancakes", "Blueberry Muffin"]],
    ["pancakes without eggs", ["Pancakes (Vegan)"]],
    ["beans with kale", ["Black-Eyed Peas and Kale"]],
    ["chicken and rice", ["Chicken Fried Rice", "Jambalaya I"]],
    ["For Zucchini Pasta Bake, halve the salt", ["Zucchini Pasta Bake"]],
    ["What can I cook with my pantry?", []], ["Recommend a vegetarian dinner", []],
  ],
  heldout: [
    ["Cauliflower Cheese", ["Cauliflower Cheese"]], ["Calzone", ["Calzone"]],
    ["Baba Ganoush", ["Baba Ganoush"]], ["Buckwheat Crepes", ["Buckwheat Crêpes"]],
    ["Tomato Chickpea Skillet", ["Eggplant and Chickpea Skillet", "Chickpea Stew"]],
    ["Garlic Parmesan Pasta", ["Garlic Parmesan Pasta"]], ["Easy Onion Chicken", ["Easy Onion Chicken"]],
    ["Yellow Split Pea Soup", ["Yellow Split Pea Soup"]],
    ["Make Bean Chili", ["Bean Chili"]], ["a warming soup made with lentils", ["Red Lentil Soup"]],
    ["pasta in a creamy mushroom sauce", ["Creamy Mushroom Pasta"]],
    ["an egg breakfast with cheese", ["Cheese Omelette", "Breakfast Burrito", "Basic Scrambled Eggs", "Scrambled Eggs with Herbs"]],
    ["chickpeas cooked in curry", ["Cholley (Chickpea Curry)"]],
    ["a blueberry muffin", ["Blueberry Muffin"]],
    ["tomato gravy", ["Basic Indian Tomato Gravy"]],
    ["rice with fried chicken", ["Chicken Fried Rice"]],
    ["a pasta bake with zucchini", ["Zucchini Pasta Bake"]],
    ["Scale Zucchini Pasta Bake for eight people", ["Zucchini Pasta Bake"]],
    ["Find me dinner ideas", []], ["Use my most perishable ingredients", []],
  ],
};
const unsupported = {
  calibration: [
    "zzzxxyy quantum spaceship", "How do I repair my bicycle", "Tomorrow's weather forecast",
    "Explain matrix multiplication", "Find my missing phone", "Write a Python sorting algorithm",
    "Mortgage interest calculations", "Flight tickets to Mars", "A watercolor painting tutorial",
    "Translate hello into French", "quux flibbertigibbet", "Laser printer cartridge replacement",
    "Lobster Thermidor", "Beef Wellington", "Miso Ramen", "Duck Confit", "Peking Duck",
    "Oysters Rockefeller", "Biryani Hyderabadi", "Sushi with sea urchin",
  ],
  heldout: [
    "asdfgh qwerty zxcvbn", "Who won the football match", "Fix a leaking bathroom tap",
    "Teach me recursion", "Schedule a dentist appointment", "Currency exchange forecast",
    "Install a graphics driver", "Plan a mountain bike route", "What is the capital of Sweden",
    "Generate a corporate logo", "xylophone nebula syntax", "Set up a laser telescope",
    "Bouillabaisse", "Cassoulet", "Crab Rangoon", "Takoyaki", "Khao Soi", "Cullen Skink",
    "Shakshuka", "Unagi Donburi",
  ],
};
export const qualityCases = ["calibration", "heldout"].flatMap((split) => [
  ...supported[split].map(([query, expectedTitles], index) => ({ id: `${split}-supported-${index + 1}`, split, query, expectedTitles, ...(query === "pancakes without eggs" ? { constraints: { allergies: ["egg"] } } : {}), expectedOutcome: "matches" })),
  ...unsupported[split].map((query, index) => ({ id: `${split}-unsupported-${index + 1}`, split, query, expectedTitles: [], expectedOutcome: "no_match" })),
]);
