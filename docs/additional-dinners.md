# Additional reviewed dinners

On November 4, 2026, twelve further mains were collected from English Wikibooks
Cookbook and reviewed against their captured source text. Their source links and
contributor attribution remain attached to the recipes; Wikibooks text is
available under CC BY-SA 4.0. Ingredient and direction wording is retained;
formatting is normalized.

The batch adds Beef Stir-Fry, Chicken Cacciatore, Chicken Tagine with Lemon and
Olives, Koshary, Matar Paneer, Moqueca de Peixe, Shakshuka I, Tofu Saltado,
Tofu and Couscous, Tofu in Spiced Coconut Sauce, Yetsom Shiro, and Zambian Fish
Stew. The [link list](../tools/recipes/extra-dinners.v1.txt) identifies each
original page. They are reviewed mains or light mains, not nutritionally
complete-meal certifications.

Only Matar Paneer (40 minutes) and Chicken Tagine (105 minutes) have a reviewed
complete source total. Six sources state an unambiguous serving count; the rest
use recipe batches. Nine recipes have at least one amount the app flags for
review. Other quantities or packaged products can also need checking.

The review keeps source limitations visible:

- Chicken Cacciatore needs a slow cooker. The source gives cooking ranges but
  no complete total including preparation.
- Koshary may require overnight soaking if dried pulses are used; the source
  does not specify whether the chickpeas are dry or prepared.
- Moqueca, Tofu in Spiced Coconut Sauce, and Yetsom Shiro mention a rice or
  bread accompaniment outside their source ingredient lists. The tofu sauce
  also calls for already-toasted almonds.
- Tofu Saltado uses prepared crispy chilli of unspecified composition, so its
  vegan and vegetarian suitability is unknown. Product labels, alternatives,
  allergens and cross-contact are not certified by this review.

## Reuse in another local catalog

Apply database migrations and start the local app. Then collect and personally
review the source recipes before previewing and importing the metadata:

```bash
pnpm recipes:collect -- tools/recipes/extra-dinners.v1.txt
pnpm recipes:curate -- validate tools/recipes/extra-dinners.v1.json
pnpm recipes:curate -- preview tools/recipes/extra-dinners.v1.json
pnpm recipes:curate -- import tools/recipes/extra-dinners.v1.json
pnpm recipes:embed
```

The reviewed metadata is tied to the captured source hashes. If a page changes,
review its current ingredients, directions and metadata again rather than
forcing the old review. The link list and metadata do not automatically load
recipe text into a fresh installation. See the
[collector guide](guide.md#collect-recipes-python-310) for setup and resume
instructions.

## Second batch

A second batch on November 4 adds 13 more Wikibooks recipes: ten reviewed mains
and three reviewed sides. It includes baked chicken breasts, baked halibut,
tilapia with white wine, bulgur burgers, creamy tomato and bean soup, and
Spanish potato omelette. The complete [source list](../tools/recipes/extra-dinners-2.v1.txt)
and [review metadata](../tools/recipes/extra-dinners-2.v1.json) are separate
from the first batch. Eggplant bharta, potato curry, and rice with black beans
are classified as sides rather than included in the reviewed-main filter.

Only the creamy tomato and bean soup has a reviewed complete source total
(45 minutes). Seven recipes have a single explicit serving count, and ten have
at least one amount the app flags for review. Baked chicken requires a probe
thermometer; the source for pecan spinach pasta lists optional feta without
specifying when to add it. Source wording and unresolved amounts are preserved.

With the local app running, collect and review the sources, then apply the
hash-bound metadata:

```bash
pnpm recipes:collect -- tools/recipes/extra-dinners-2.v1.txt
pnpm recipes:curate -- validate tools/recipes/extra-dinners-2.v1.json
pnpm recipes:curate -- preview tools/recipes/extra-dinners-2.v1.json
pnpm recipes:curate -- import tools/recipes/extra-dinners-2.v1.json
pnpm recipes:embed
```

The collector's source hashes must still match. Two candidates with upstream
Foodista attribution were deferred because the importer does not capture their
additional author and license details. Potato-Chickpea Curry was deferred
because its source says not to double the chickpeas when doubling the recipe,
which the app's automatic scaling cannot currently represent.

## Third batch

A third batch on November 4 adds 12 Wikibooks recipes: eleven reviewed mains
and one side. It includes baked eggplant, bean-sauce lasagne, chicken madras,
peanut chicken stir-fry, egg roast and Yemiser lentil salad. See the
[source list](../tools/recipes/extra-dinners-3.v1.txt) and
[review metadata](../tools/recipes/extra-dinners-3.v1.json) for the full batch.
The lentil salad is classified as a side or light meal, so it is not included
in the reviewed-main filter.

Five sources state a single numeric serving count, and eleven recipes have at
least one amount the app flags for review. None has a complete source total
that could be verified under the app's timing rules. The chicken madras method
calls for oil that its ingredient list does not include; the peanut chicken
and egg roast start with already-cooked ingredients. Monterey Jack chicken
requires a probe thermometer. Faten Wake lists groundnut oil and optional
crayfish; packaged gnocchi may contain egg, dairy or wheat.

With the local app running, collect and review the sources, then apply the
hash-bound metadata:

```bash
pnpm recipes:collect -- tools/recipes/extra-dinners-3.v1.txt
pnpm recipes:curate -- validate tools/recipes/extra-dinners-3.v1.json
pnpm recipes:curate -- preview tools/recipes/extra-dinners-3.v1.json
pnpm recipes:curate -- import tools/recipes/extra-dinners-3.v1.json
pnpm recipes:embed
```
