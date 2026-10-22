// Fixed before evaluating the new index. Expected titles come from the 102-recipe
// prototype catalog; pantry/allergy cases exercise the same public search route.
export const cases = [
  { query: "Cheese Omelette", expected: ["Cheese Omelette"] },
  { query: "Baked Ziti", expected: ["Baked Ziti"] },
  { query: "Calzone", expected: ["Calzone"] },
  { query: "Red Lentil Soup", expected: ["Red Lentil Soup"] },
  { query: "Cauliflower Cheese", expected: ["Cauliflower Cheese"] },
  { query: "Chickpea Stew", expected: ["Chickpea Stew"] },
  { query: "Buckwheat Crepes", expected: ["Buckwheat Crêpes"] },
  { query: "BABA GANOUSH", expected: ["Baba Ganoush"] },
  { query: "Pad See Ew", expected: ["Pad See Ew"] },
  { query: "Boxty Irish Potato Cakes", expected: ["Boxty (Irish Potato Cakes)"] },
  { query: "tomato pasta", pantry: ["tomatoes", "garlic"], expected: ["Tomato Pasta", "Eggplant Pasta"] },
  { query: "mushroom pasta", pantry: ["mushrooms", "pasta"], expected: ["Creamy Mushroom Pasta"] },
  { query: "egg rice", pantry: ["rice", "egg"], expected: ["Chicken Fried Rice", "Loco Moco (Rice with Egg and Hamburger)"] },
  { query: "chickpea curry", pantry: ["chickpeas"], expected: ["Cholley (Chickpea Curry)"] },
  { query: "blueberry breakfast", expected: ["Blueberry Pancakes", "Blueberry Muffin"] },
  { query: "a cozy lentil soup", expected: ["Red Lentil Soup"] },
  { query: "a creamy pasta with mushrooms", expected: ["Creamy Mushroom Pasta"] },
  { query: "an egg breakfast with cheese", expected: ["Cheese Omelette", "Breakfast Burrito", "Basic Scrambled Eggs", "Scrambled Eggs with Herbs"] },
  { query: "pancakes", allergies: ["egg"], expected: ["Pancakes (Vegan)"], forbidden: ["Blueberry Pancakes", "Light Fluffy Pancakes"] },
  { query: "tomato gravy", allergies: ["tree nuts"], expected: ["Basic Indian Tomato Gravy"], forbidden: ["Cashew Gravy"] },
];
