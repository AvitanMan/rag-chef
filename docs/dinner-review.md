# Reviewed dinner refresh — November 1, 2026

For the 12 additional mains reviewed on November 4, 2026, see the
[additional-dinner review](additional-dinners.md).

The existing 30 Wikibooks mains were revisited with the current collector. All 30 pages were accessible. Original ingredients, directions and source servings matched the local records; 19 recipes gained original source notes. Metadata was reviewed in full and rebound to the captured content hashes. Source text remains attributed to Wikibooks contributors under CC BY-SA 4.0.

This refresh adds no recipes. In the existing 166-recipe kitchen, verified total-time coverage increases from **3 to 14 recipes**, including **12 of the 30 reviewed mains**. The other two timed recipes are Quick Risotto and Tomato Pasta. These are source statements, not measured cooking trials.

## Complete source totals

The displayed total covers the main dish as described, not optional sides suggested when serving. Explicit source ranges use their upper bound. Individual step durations are never summed into a total.

| Reviewed main | Total minutes |
| --- | ---: |
| [Baked Ziti](https://en.wikibooks.org/wiki/Cookbook:Baked_Ziti) | 60 |
| [Bean Soup (Vegetarian)](https://en.wikibooks.org/wiki/Cookbook:Bean_Soup_%28Vegetarian%29) | 60 |
| [Beef Stew II](https://en.wikibooks.org/wiki/Cookbook:Beef_Stew_II) | 90 |
| [Chanterelle Goulash](https://en.wikibooks.org/wiki/Cookbook:Chanterelle_Goulash) | 25 |
| [Chickpea Omelette](https://en.wikibooks.org/wiki/Cookbook:Chickpea_Omelette) | 5 |
| [Creamy Mushroom Pasta](https://en.wikibooks.org/wiki/Cookbook:Creamy_Mushroom_Pasta) | 20 |
| [Easy Onion Chicken](https://en.wikibooks.org/wiki/Cookbook:Easy_Onion_Chicken) | 60 |
| [Hamburger Skillet Dinner](https://en.wikibooks.org/wiki/Cookbook:Hamburger_Skillet_Dinner) | 40 |
| [Mapo Tofu](https://en.wikibooks.org/wiki/Cookbook:Mapo_Tofu) | 30 |
| [Paneer Butter Masala](https://en.wikibooks.org/wiki/Cookbook:Paneer_Butter_Masala) | 25 |
| [Taco Soup](https://en.wikibooks.org/wiki/Cookbook:Taco_Soup) | 30 |
| [Zucchini Pasta Bake](https://en.wikibooks.org/wiki/Cookbook:Zucchini_Pasta_Bake) | 60 |

## Time labels excluded from filtering

These source labels are preserved under Original source notes. They do not establish a complete total including required preparation. The metadata therefore retains an unknown total.

Chef honors these explicit unknown-total reviews when answering questions and checking recommendation claims. An original label remains available for inspection without becoming a complete start-to-finish total.

| Reviewed main | Reason |
| --- | --- |
| [Basic Lasagna](https://en.wikibooks.org/wiki/Cookbook:Basic_Lasagna) | The ingredients require cooked lasagne noodles and a separate tomato sauce, but preparing these is outside the captured directions and has no included duration. |
| [Black-Eyed Peas and Kale](https://en.wikibooks.org/wiki/Cookbook:Black-Eyed_Peas_and_Kale) | The ingredients require thawed frozen kale, but thawing is outside the captured directions and has no included duration. |
| [Chicken Fried Rice](https://en.wikibooks.org/wiki/Cookbook:Chicken_Fried_Rice) | The ingredients require cooked rice and a fried egg, but preparing them is outside the captured directions and has no included duration. |
| [Eggplant Pasta](https://en.wikibooks.org/wiki/Cookbook:Eggplant_Pasta) | The method requires at least 30 minutes resting plus 30 minutes simmering and additional preparation; the one-hour label does not establish a complete total. Pasta is also required cooked without an included preparation duration. |
| [Garbanzo Bean Stew](https://en.wikibooks.org/wiki/Cookbook:Garbanzo_Bean_Stew) | The ingredients require hot cooked rice, but cooking the rice is outside the captured directions and has no included duration; the source time is also approximate. |
| [Garlic Parmesan Pasta](https://en.wikibooks.org/wiki/Cookbook:Garlic_Parmesan_Pasta) | The ingredients require cooked pasta and cooked broccoli, but their cooking is outside the captured directions and has no included duration. |
| [Jambalaya I](https://en.wikibooks.org/wiki/Cookbook:Jambalaya_I) | The ingredients require cooked turkey or chicken, but cooking the meat is outside the captured directions and has no included duration. |
| [Keralan Vegetable Stew](https://en.wikibooks.org/wiki/Cookbook:Keralan_Vegetable_Stew) | The ingredients require already-boiled vegetables, but boiling them is outside the captured directions and has no included duration. |

## Sources without a complete total

[Asparagus Frittata](https://en.wikibooks.org/wiki/Cookbook:Asparagus_Frittata), [Bean Chili](https://en.wikibooks.org/wiki/Cookbook:Bean_Chili), [Basic Scrambled Eggs](https://en.wikibooks.org/wiki/Cookbook:Basic_Scrambled_Eggs), [Chili (Vegan)](https://en.wikibooks.org/wiki/Cookbook:Chili_%28Vegan%29), [Eggplant and Chickpea Skillet](https://en.wikibooks.org/wiki/Cookbook:Eggplant_and_Chickpea_Skillet), [Khichdi (South Asian Rice and Lentils)](https://en.wikibooks.org/wiki/Cookbook:Khichdi_%28South_Asian_Rice_and_Lentils%29), [Lentil Rice Loaf](https://en.wikibooks.org/wiki/Cookbook:Lentil_Rice_Loaf), [Denver Omelet](https://en.wikibooks.org/wiki/Cookbook:Denver_Omelet), [Indian Omelet](https://en.wikibooks.org/wiki/Cookbook:Indian_Omelet), [Red Lentil Soup](https://en.wikibooks.org/wiki/Cookbook:Red_Lentil_Soup).

## Quantities and suitability

All 30 recipes retain source servings. Twenty-nine still contain at least one amount that needs review; ranges, as-needed seasonings, ambiguous package sizes and prepared ingredients remain unresolved. No amount was filled in from an estimate. Original ingredient wording and directions are preserved.

Existing dietary and appliance evidence was rechecked against the unchanged ingredients and directions. Unknown suitability, including low-carb suitability, remains unknown. Reviewed main-dish classification is not a claim of nutritional completeness, allergy certification or tested cooking quality.

## Applying the review

Follow the [operating guide](guide.md#reviewed-recipe-metadata) to collect and review the two explicit link batches, then preview and import `core-dinners.v2.json`. The manifest records each source review outcome, original source notes, amount-review count and complete metadata. Source-hash mismatches require a new review.

The v2 review supersedes the original core review; it does not change the frozen evaluation corpus. Source refreshes update catalog entries and their embeddings. Saved dinners retain their captured recipes. Pantry, plans, favorites and shopping checks are not changed by collection or metadata import.

## Verification

- 393 source/SQL/hook/route tests, two isolated build/render checks and 19 Python collector tests passed; type checking and lint passed.
- All 286 desktop/mobile browser checks passed, including filter composition, counts, pagination, metadata, favorites, recent dinners, shopping and cooking. After the unknown-total Chef fix, the 122-check Chef subset passed again. Four offline Chromium/WebKit checks, two development checks and both fresh-installation checks also passed.
- The real local-model evaluations passed all 40 fixed synthetic retrieval/claim cases and eight isolated source-answering contracts. Separate current-catalog Chef checks correctly withheld an incomplete total and answered a supported total; both left the kitchen unchanged.
- The refreshed real catalog was previewed and imported in a disposable database first. Repeating the metadata import changed zero records. Manual browser checks covered choosing a refreshed dinner, editing portions, shopping and source-step navigation, including 320-pixel layouts without horizontal overflow.
- The local catalog received 19 source-note updates and 30 metadata reviews. The complete kitchen document and unrelated catalog entries matched their pre-application snapshots. Recipe and step embeddings were refreshed, with zero stale vectors remaining.

These checks verify application behavior and source-data handling. The fixed synthetic model cases do not establish general answer accuracy, and none of these checks constitutes a real cooking trial.
