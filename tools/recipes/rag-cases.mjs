// Original synthetic source records. Labels are fixed separately from ranking.
const development = [
  ["Whisk the egg whites until stiff peaks form.", "How should the whites look?", "Whisk the egg whites until stiff peaks form.", "Leave the egg whites loose and unwhisked."],
  ["Add olive oil in a slow steady stream while whisking to form an emulsion.", "How is the oil incorporated?", "Add the olive oil gradually while whisking.", "Pour all the oil in at once without whisking."],
  ["Rest the dough covered for 20 minutes before rolling it.", "When do I roll the dough?", "Rest the covered dough for 20 minutes before rolling.", "Roll the dough immediately without resting it."],
  ["Preheat to 180°C. Bake for 25–30 minutes until golden.", "How hot should the oven be?", "Preheat the oven to 180°C.", "Preheat the oven to 250°C."],
  ["Drain the pasta and reserve a cup of its cooking water before adding sauce.", "Which liquid should I keep?", "Reserve some pasta cooking water before adding the sauce.", "Discard all pasta cooking water before adding sauce."],
  ["Fold cooled melted chocolate gently into the whipped cream.", "How should chocolate and cream be combined?", "Gently fold cooled chocolate into the whipped cream.", "Stir hot chocolate forcefully into the cream."],
  ["Simmer uncovered until the sauce reduces to half its original volume.", "When should I stop reducing the sauce?", "Simmer uncovered until the sauce is half its original volume.", "Keep the sauce volume unchanged while simmering covered."],
  ["Rinse the rice with cold water until the water runs clear.", "How can I tell when rinsing is finished?", "Rinse until the water runs clear.", "Stop rinsing while the water is still cloudy."],
  ["Cool the beans completely before covering and refrigerating them.", "When should the beans be covered?", "Cover the beans after they cool completely.", "Cover the beans while they are still hot."],
  ["Turn off the heat before stirring in yogurt. Do not boil after adding yogurt.", "Should the heat stay on when yogurt goes in?", "Turn off the heat before adding yogurt and do not boil afterward.", "Boil the mixture after adding yogurt."],
];
const heldout = [
  ["Sauté the onions until translucent without letting them brown.", "What appearance should the onions have?", "Cook the onions until translucent without browning them.", "Brown the onions deeply."],
  ["Beat in the eggs one at a time, mixing after each addition.", "Do the eggs go in together?", "Add eggs one at a time and mix after each addition.", "Add all the eggs together without mixing between additions."],
  ["Grease the pan before pouring in the batter.", "What happens before the batter is poured?", "Grease the pan before adding batter.", "Pour the batter into an ungreased pan."],
  ["Toast the spices in a dry pan before adding water.", "Should water go in before the spices are toasted?", "Toast the spices dry before adding water.", "Add water first and then toast the spices."],
  ["Add the berries directly from frozen; do not thaw them first.", "Should the berries be defrosted?", "Use the berries frozen without thawing them.", "Thaw the berries completely before adding them."],
  ["Let the cake cool completely before spreading the frosting.", "Can I frost the cake while it is warm?", "Wait until the cake is completely cool before frosting.", "Frost the cake while it is still warm."],
  ["Switch off the oven and leave the meringues inside to cool.", "Where do the meringues cool down?", "Cool the meringues inside the switched-off oven.", "Remove the meringues immediately to cool outside the oven."],
  ["Split the vanilla pod lengthwise and scrape out the seeds.", "How do I get the vanilla seeds out?", "Split the pod lengthwise and scrape out its seeds.", "Use the vanilla pod whole without opening it."],
  ["Remove the saucepan from heat before stirring in lemon juice.", "When does the lemon juice go in?", "Add lemon juice after removing the pan from heat.", "Add lemon juice while the pan stays on the heat."],
  ["Stir in the fresh herbs just before serving.", "At which stage are fresh herbs added?", "Add fresh herbs just before serving.", "Add the fresh herbs at the beginning of cooking."],
];
export const ragRecipes = [development, heldout].map((rows, split) => ({
  id: `rag-method-${split}`, title: split ? "Heldout Source Method" : "Development Source Method", image: null, category: "Test", cuisine: "Test", tags: [], servings: 2,
  ingredients: [{ name: "rice", measure: "200 g" }, { name: "olive oil", measure: "1 tbsp" }, { name: "egg whites", measure: "2" }],
  source: { name: "Original synthetic RAG evaluation", url: "https://example.invalid/rag-fixtures" }, sourceUrl: `https://example.invalid/rag-fixtures/${split}`,
  instructions: Array.from({ length: 40 }, (_, index) => index % 4 === 3 ? rows[(index - 3) / 4][0] : `Source direction ${index + 1}: arrange the preparation items on the counter.`),
}));
export const ragCases = [development, heldout].flatMap((rows, split) => rows.flatMap((row, index) => [true, false].map((supported) => ({
  id: `${split ? "heldout" : "development"}-${supported ? "supported" : "unsupported"}-${index + 1}`,
  split: split ? "heldout" : "development", recipeId: ragRecipes[split].id, query: row[1], expectedEvidenceId: `S${index * 4 + 4}`,
  claim: row[supported ? 2 : 3], supported,
}))));
