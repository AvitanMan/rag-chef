# RAG Chef operating guide

[Back to the project](../README.md) · [Evaluation](evaluation.md)

## Quick start

### Requirements

- Node.js **22.13 or newer** (Node 22 is selected in `.nvmrc`) and
  **pnpm 11.25.0**, pinned in `package.json`.
- **Ollama**, optional, for local AI and semantic search.
- **Python 3.10 or newer**, only for collecting recipes with Scrapling.

### Start the app

From the project directory:

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
```

Open [localhost:3000](http://localhost:3000).

The app opens on **Chef**. If tonight already has a saved dinner, its panel
shows portions, measured pantry coverage, missing ingredients, and **Cook dinner**.
Otherwise, choose an instant suggestion or ask Chef for ideas. **Choose for
tonight** saves the dinner and shows that panel without visiting Plan or a date
picker. Recipes uses the same selection action. **Dinner day and portions** is
shared across Chef and Recipes; choose another day before selecting when needed.
Source quantities are the default, and unknown yields use recipe batches.

**Change dinner** searches for a replacement while keeping the saved meal.
**Cancel change** returns to it; replacing an occupied day still needs confirmation.
Locked and cooked dinners stay protected. **Adjust amounts** changes your saved
dinner, while **Recipe details** provides original directions, sources, and
**Ask Chef about this recipe**. Recipe cards keep one primary selection action.

The dinner panel’s missing amounts reserve stock for other saved dinners in the
same week. Unknown amounts remain marked for review; missing ingredients do not
block cooking. **Weekly shopping** opens the existing shared weekly list, with
**Back to dinner** returning to the selected meal. Purchase review still asks what
you actually bought before adding pantry batches. Plan remains available for
weekly filling, copying, locking, and manual completion.

Recipe search, filters, and list position stay intact during the current session.
Return links preserve the originating plan or recipe browser, and browser Back
and Forward restore the section and dinner context. Reloading starts at today’s
dinner. Browsing and choosing dinner do not require an AI model.

Chef opens with up to three **Pantry picks**, or **Dinner ideas** when your pantry
is empty, using the loaded catalog without a model call. Saved exclusions and
dislikes still apply. Use **Find my dinner** for a specific request, or leave it
blank for the default pantry-dinner question. Weekly filling stays on **Plan**.
Natural questions such as “What can I cook with eggplant?” request dinner
choices; questions about a pinned recipe continue to use that source.
The **Dinner request** field gives examples for finding dinner and narrowing the
current ideas. Choose **Ask about this recipe** directly on a Chef card to switch
to that recipe’s questions; no drawer is needed. The question field then shows
the recipe name and examples about ingredients, numbered steps, or substitutions.
Use **New dinner search** to return to dinner ideas. Cooking-step help has its own
example and identifies whether it can use the current source step or the full recipe.
After a request, the answer and recipe choices come first. Source links and a
short original excerpt stay visible on cards. Expand **How Chef found this** for the actual retrieval method,
catalog and shortlist counts, requirement exclusions, and whether an AI answer
or a catalog fallback was used. **Recipe evidence** puts source excerpts and
original links beside the answer. Cited excerpts are copied from the source;
fallback excerpts are explicitly labeled as retrieved recipe text. Open an
evidence title to inspect the full recipe. No confidence percentage is implied.
Choosing a day keeps that target visible in Chef and Recipes. Every selection
uses **Choose for tonight** or **Choose for [day]**, then opens the saved dinner
panel. Opening recipe details is optional. A single source method starts cooking
directly; recipes with multiple methods show one inline choice first.

**Ask Chef about this recipe**, inside recipe details, pins a discussion to one approved source recipe.
Selecting a recipe clears dinner-search refinements; saved profile exclusions
still apply to the discussion.
Follow-up questions retain the latest three question/answer pairs while navigating
between Chef, recipe details, and cooking. Earlier questions are collapsed;
reloading starts a new discussion. **New dinner search** (or **Change dinner** from a saved dinner) clears the recipe,
portions, and refinements; the selected dinner day stays selected, including
after switching between Chef and Recipes. Use **Cancel selection** to clear it.
Chef uses one question field: after discovery, **Update dinner ideas** applies a refinement
and immediately searches again. New questions outside a pinned recipe become
the current search for later refinements and chip removal. Refinements are limited
to 200 characters; an oversized draft stays editable with an error, preserving
the current choices until corrected. Removable refinement chips also refresh results
when removed and cannot relax saved exclusions. A pinned recipe changes this
same field into a follow-up question. Return links lead back to the originating
plan day or recipe browser, keeping the current search and list position.

Chef uses saved, measured pantry stock for its request estimates, after reserving
stock for other saved dinners in the target week. A replacement preview releases
the dinner being replaced and applies the selected portions; cooking help uses
the saved dinner's actual amounts. Cards distinguish covered,
partial, missing, and review-needed requirements; unknown yields use recipe
batches. **Cook for** changes deterministic planning quantities, while Chef's
substitution advice remains separate and never rewrites a meal.

For a saved dinner, quantity-only questions show **Your dinner amounts** using
those same calculations. Serving changes scale original amounts; an explicit
saved override remains final. Labels distinguish scaled amounts from overrides,
while original ingredient evidence stays visible separately. These answers work
with the AI provider offline and make no generation or verification call.
Unclear measures or ingredient names ask for clarification. Questions about the
original source, cooking technique or substitutions keep their source-grounded
answering path. Factual answers do not add a recommendation shortlist.

Cooking has **Ask about this step** inside its existing scrolling area. Questions
use the pinned recipe and original step references, leaving timers and progress
running. Discovery refinement chips stay with their dinner search and are not
applied to cooking help; saved profile exclusions still apply. Older sessions are mapped back to source steps where unambiguous;
otherwise help uses the recipe context. Changed dinner portions, source versions,
or source permissions are rechecked before an answer. Saved directions remain
available when Chef cannot verify a version. Relevant source steps retain their
original IDs, and an omitted step cannot be cited as supplied evidence.
Step explanations focus on the active direction (or a numbered step you ask
about), with the verbatim evidence under **Source for this answer**. Meaning
questions about boiling or simmering also show a separately attributed Wikibooks
technique reference. Standalone meaning requests use those reviewed definitions
directly and need no model call. Those definitions do not supply missing recipe times,
quantities or doneness tests. A question about an unstated duration must say that
the recipe gives no exact time. Moving to another step hides the previous answer.
If local Ollama verification rejects a focused step answer, Chef makes one
correction attempt using the same evidence and verifies that replacement too.
Unsupported replacements remain withheld; this does not add paid-provider calls.

**Finish cooking** opens a final review inside the existing cooking workspace.
Pantry deductions are optional and off by default. **Back to directions** preserves
the step and timer; **Mark dinner cooked** removes the meal’s remaining shopping
needs and returns to its dinner panel, where **Undo cooked** remains available.
The session is retained until the completion is recoverable in browser storage
or saved to this Mac. If both fail, keep the review open and use **Retry save**.
Changed dinner snapshots cannot be completed from an old cooking session.
Reloading during the review resumes the last source step. Unplanned cooking can
finish without adding a meal or changing the pantry. Replacing another saved
cooking session still requires confirmation.

### Populate a fresh installation

Use **Load starter recipes** on Chef or Recipes to add three original MIT-licensed
recipes without a model, account, or external download. Retrying is safe and does
not add duplicate recipes. The action changes only the catalog.


Collected recipes are local database content, **not a checked-in seed dataset**.
A fresh checkout does not include the recipe collection built on this Mac.

With the app running, use another terminal to import the small, curated TheMealDB
prototype catalog and inspect its status:

```bash
curl -X POST http://localhost:3000/api/admin/catalog
curl http://localhost:3000/api/admin/catalog
```

The POST fetches and saves recipes, then attempts to compute embeddings. An AI
failure does not discard saved recipes. Use the reviewed Wikibooks importer below
to expand the catalog.

### Enable local AI

With Ollama installed, pull the default models and keep Ollama running:

```bash
ollama pull qwen3.5:9b
ollama pull nomic-embed-text
```

For optional configuration overrides, copy the example without overwriting an
existing local configuration:

```bash
cp -n .env.example .env.local
```

Edit the local file and restart the app. Model choices already saved in your
browser can be changed in **Settings**. For the optional OpenAI provider, configure
a server-side key and a model available to your account, then select it in Settings.
Keep keys out of browser code, `NEXT_PUBLIC_` variables, and version control.
The standalone `pnpm start` preview reads Wrangler configuration from `.dev.vars`;
copy `.env.example` there instead when configuring that mode. Both local files
are ignored. Maintenance scripts read exported shell variables rather than
automatically loading either file.

### Production-style local preview

```bash
pnpm build
pnpm start
```

This still runs locally; it does not deploy the app. Stop `pnpm start` before
running a direct `pnpm build`, which replaces its served files. Tests build
disposable copies and leave this preview and its database untouched.

## Planning and shopping rules

### Use food that is due soon

Chef’s **Use soon** section shows up to five nonzero pantry items with entered
use-by dates from today through three days ahead; **Review pantry** opens the
complete list. Select an ingredient to see three matching dinners, then use
**Show more dinners** for further matches. Normal dinner selection, replacement
confirmation, cooking, and optional pantry deductions still apply.

Suggestions respect saved allergies, diet, and equipment requirements and match
normalized ingredient identity; cooked and uncooked rice remain distinct.
Estimates reserve quantities for other saved dinners in the selected week before
calculating the new dinner. The dinner being replaced does not reserve stock.
Confirmed use of the selected pantry batch ranks first, followed by reviewed
mains, measured pantry coverage, and title. Unknown quantities or incompatible
units show **Check amount**, and fully reserved items are explained rather than
presented as available. Changing the dinner day or portions updates estimates.
A date after the item’s entered use-by date produces no suggestions for that item.

**Review this item** opens its pantry row for amount/date edits or reversible
removal. **Past entered date** items are excluded from availability and require
manual review; dates are never extended automatically. Date groups refresh when
the local day changes. No ratings, shelf-life predictions, or model calls are
needed for this flow. Cooking deductions remain optional and off by default.


Use the **Dark mode** toggle in the top bar or cooking header to switch themes.
The app follows your system preference until you choose a theme, then remembers
that choice in this browser. Theme preferences are separate from kitchen backups.

An empty week offers optional preferences and pantry shortcuts beside a short
next-step hint. One **Today’s dinner** card offers cooking, changing dinner, and
shopping actions. Mobile week entries are compact; **Fill options** contains
advanced filling preferences. **Today’s dinner** gives immediate access to tonight;
saving a dinner opens its Chef panel. Recipe selection defaults to today;
choose a historical or future date in the shared dinner context when needed.
Occupied dates require replacement confirmation.

In **Settings**, cooking preferences come first. Enter allergies and dislikes as editable chips: Enter,
comma, or leaving the field saves an ingredient. Select a chip to edit it, or
use its × button to remove it.

In **Pantry**, paste ingredients separated by new lines, commas, or semicolons.
Amounts are optional: `rice: 300 g`, `300 g rice`, and `rice 300 g` are supported.
Multiple ingredients and measured entries open an editable confirmation preview
whose actions remain visible while the ingredient rows scroll.
Existing stock stays intact; confirmed entries create separate stock rows.
Removing pantry rows or unlocked dinners (including **Clear unlocked**) offers
**Undo** in a recovery bar above the page content until dismissed or the page is
reloaded. New removals reveal the bar without placing it over page actions.
Earlier removals remain available in the bar. Undo preserves later edits and
never replaces a dinner subsequently added to the same date.

Quantity fields keep invalid drafts beside the field without blocking other
valid edits from saving. Correct the draft or press Escape to restore its saved
value. Free-text notes such as `to taste` remain valid, unquantified amounts.

Chef’s instant dinner picks favor eligible reviewed main dishes. If the Chef
API is unavailable, local picks remain available with **Retry Chef**; saved
exclusions and the failed request’s dietary and ingredient restrictions still apply.

Recipe search ignores case, accents, and punctuation. Every search word must
appear in the title or ingredient names. Exact names lead, then pantry coverage
and alphabetical ties. **Show more** reveals another 24 cards. Pantry matches
count ingredient names, not whether you have enough to cook the meal.

Fresh installations start with an empty pantry. Known zero stock and stock past
its optional entered **Use by** date do not count as available. The entered date
is inclusive. Unknown amounts remain uncertain and are never treated as enough.
Past-dated stock stays excluded for unfinished historical dinners. Cooking
deductions use the actual cooking date, including when a dinner is cooked early.
Automatic planning reserves measured stock for saved dinners, then fills upcoming
empty days in date order without spending the same stock twice. **Prefer reviewed
mains** is on by default: eligible reviewed mains lead, then unreviewed recipes
if mains run out; known sides, components and desserts stay out. Turn it off to
use the wider collection. Within that dinner group, stock due within three days
leads, then meals using remaining measured stock. Each fill makes a
fresh weighted random draw within the available group, favoring quantity
coverage and ingredient reuse without always choosing the same dinners. Each
suggestion explains its review status, pantry coverage and remaining shopping needs.
Past days remain manually editable; locked, cooked and saved dinners stay intact.

Use **Cook for** when the source provides an explicit serving count. Unknown
yields remain **Recipe batches**. **Adjust amounts** corrects a particular dinner
without rewriting the source. Entered ingredient overrides are final amounts,
applied after scaling. Locking and copying are under **More options**.

Shopping counts each planned dinner and combines compatible quantities. Unknown
pantry amounts never count as sufficient stock. Missing measures, ranges, and
conflicting units stay marked for review. Cups use 240 ml, tablespoons 15 ml,
and teaspoons 5 ml; volume is never assumed to equal mass.

Ingredient matching recognizes reviewed descriptions such as `any small pasta`,
`medium zucchini, grated`, and `cheese, grated` as their plain pantry ingredients.
Only specific produce sizes and cutting descriptions are normalized; alternatives,
preservation, heat treatment and different food products keep separate identities.
The attributed source text stays unchanged. Matching also keeps cooked and
uncooked stock separate. For example,
`cooked rice` matches `rice, cooked`, while `uncooked rice` and `dry rice` match
ordinary `rice`. This uncooked default applies to an explicit set of grain,
pasta and pulse staples; dried herbs, fruit, mushrooms and canned foods retain
their own identities. No cooked-to-dry weight or volume ratio is assumed.
Shopping flags a preparation mismatch for review instead of subtracting the
wrong stock. Enter leftovers as `cooked rice: 300 g`, for example.

Checked items move into **Bought** without changing pantry stock. Use **Add bought
items to pantry** to review actual purchased amounts, then **Confirm pantry
additions**. Each purchase adds separate batches, preserving existing quantities,
use-by dates, and cooked/uncooked identities. Unknown and note-only amounts remain
unquantified. Each bought check has a purchase-cycle ID saved with the kitchen
and its backups, so retrying the same purchase cannot add it twice. To record another purchase of
the same shortage, uncheck it in **Bought**, then check it again and review its
new pantry addition. Earlier purchase records stay intact. **Pantry additions** shows
purchase history and offers undo while its batches are unchanged; later edits,
removal, and consumption block that undo to preserve newer work. Shopping review
opens dinner amounts in a dialog and returns to the same list.

Completing a
dinner can deduct confirmed stock; **Undo cooked** restores that deduction.
Saved meals retain independent recipe snapshots, so catalog updates do not
silently rewrite existing dinners or historical quantities.

Cooking mode shows the same final amounts and overrides as the dinner details.
Ingredients start collapsed and expand into the main cooking panel. That panel
is the single scrolling area; the header and step controls stay visible, and
changing steps returns to the top. Background page scrolling is locked while
a dialog is open.
The compact timer bar remains visible while the main cooking panel scrolls.
**Set timer** opens minutes, seconds, presets (1, 5, 10, 15 minutes) and sound
settings. Running timers show Pause; paused timers show Resume and Reset.
**Change timer** opens setup, and choosing another duration requires confirming
**Replace timer** before an active timer is replaced. Custom timers accept 1 second to 24 hours and use a saved deadline, so time does
not depend on background interval ticks. Single explicit source-step durations
offer shortcuts; ranges and ambiguous durations require a custom timer. Sound is
optional and requires browser audio support. Timer completion never marks dinner
cooked. **Exit cooking** preserves progress; **Resume cooking** or **Discard
cooking session** appears after reopening. Starting another dinner asks before
replacing progress. Changed meal identities or quantities require reopening the
current dinner before completion and pantry deduction.

Dialogs support Escape to close, keep Tab focus inside, and return focus to the
opening control when it is still available. Exiting cooking preserves the timer.

## How Chef works

Chef searches the full approved database catalog, not the on-screen shortlist or
recipe text submitted by a client. Ingredient-text allergy exclusions run before
ranking and before recipes reach the model. Retrieval combines field-weighted BM25 keyword search and precomputed semantic
embeddings through Reciprocal Rank Fusion. Exact recipe names and existing
relevance gates take precedence; pantry stock cannot admit unrelated recipes.
A partial index keeps meaning-based search for current vectors while missing
recipes use keywords. Rice noodles remain a separate search phrase from rice;
search aliases never change ingredient identity or stock amounts.

For dinner discovery, the model receives each selected recipe's complete ingredients and directions
once, in an ordered evidence list (`I1…` for ingredients with quantities, `S1…`
for cooking steps), and returns a small, validated JSON response. Titles,
servings, reviewed metadata, pantry information and user preferences remain in
the input. The server supplies canonical recipe IDs,
citations, and pantry lists. Proposed substitutions appear separately from
source facts and unchanged original directions.

The fixed 25-step regression fixture uses **5,339 bytes instead of 7,627 bytes**
for its serialized JSON context, a **30.0% reduction** with all evidence,
reviewed metadata and preferences retained. This measures input size, not tokens
or response speed; local-model timing checks remain separate from deterministic
tests.

Source facts use request-local ingredient/step evidence IDs; the server copies
their original text rather than accepting model-written factual claims. Recipe
citations remain server-owned. Unsupported requests can return `no_match` without
calling a generation provider. Empty catalogs and unsatisfied constraints have
separate outcomes. Pantry coverage cannot turn an unrelated query into a match.
Canceling or superseding a request prevents its late response from appearing;
changing the pantry, profile or current date hides results from the old context
and cancels any pending request. Returning to the app refreshes the current date
so stock that has passed its entered use-by date is excluded from new requests.

Pinned questions combine keyword and semantic step rankings. Up to six core
steps are expanded to adjacent directions; the active cooking step and explicit
step numbers take priority. Short recipes use their complete source without a
query-embedding call. Missing or stale step vectors use wording and cooking cues.
The supplied evidence has a 16,000-character budget shared across recipes. Whole
source steps keep their original IDs and wording; omitted text remains explicitly
partial, with the complete recipe still accessible.

After generation, deterministic checks compare explicit time, temperature,
gas-mark, and common nutrition measurements in the factual answer with cited
excerpts and reviewed total-time metadata.
Recommendation reasons are checked against the supplied evidence for their own
recipe. A step duration cannot become total recipe time, and curator time
estimates must stay labeled. An unverified answer is withheld while the original
source remains available; `answerValidation.reason` records the failed check.
Requested advisory changes remain separate from factual source claims. These
numeric checks remain independent of the semantic verification pass.

Free-form recipe answers and requested adaptations receive one additional local
Ollama verification call for their displayed model answer, recommendation
reasons, and generated warnings. Generated warnings also receive the numeric
source checks; server-owned notices remain separate. Recipe discovery uses model-selected recipe IDs and exact source
excerpts, with app-owned introductions, match explanations and stock facts. Clarification and unsupported statuses use fixed
messages and server-owned match explanations, so those labels cannot bypass
checks and expose arbitrary model prose. Model-written discovery prose is discarded rather than presented as verified
recipe or pantry facts.

The verifier checks factual entailment against selected excerpts, original title
and yield, reviewed metadata, server-calculated readiness, effective requirement
checks, and resolved planning amounts. The selected recipe, cooking step and
quantity basis provide authoritative scope. The user question stays in generation
context; answer relevance is evaluated separately in journey checks. Every displayed model-generated
claim receives a verdict, and factual references must belong to the supplied
material and correct recipe. Generic nonfactual discovery prose may have no
support refs; factual questions still require positive source support. The
verifier cannot rewrite an answer or turn kitchen facts into original quotes.

Verification uses the selected Ollama generation model, or `OLLAMA_CHAT_MODEL`
when generation uses OpenAI. It always uses a loopback Ollama endpoint and never
adds a paid verification call. The check has a 30-second timeout for multi-recipe
answers and no automatic repair attempt. Rejected or unavailable checks withhold
the answer, retain source access and offer **Retry answer** or **Retry step
answer**. **Answer evidence checked** describes a model-assisted review, not a
guarantee of correctness. Canonical messages, discovery explanations and calculated dinner amounts skip
verification. Whole-recipe timing requires explicit recipe-level wording or a
reviewed total; an ambiguous “it takes” or component being “ready in” establishes
only a step duration. Missing totals receive a direct source-based refusal.
Requests cancel provider work when superseded; source permissions, recipe hashes,
reviewed details and kitchen revisions are rechecked before results return.

Requests such as **no pasta**, **without tomatoes**, **avoid eggs**, and **don't
use onions** filter ingredients before ranking or generation. Comma-separated
lists and `and`/`or` lists are supported. Excluded words are removed from the
positive retrieval query. These are request-specific rules; saved preferences
are unchanged. This parser handles explicit English clauses rather than general
conversational reasoning.
**Meatless** and **meat-free** are treated as vegetarian requests. **Dairy free**
and **dairy-free** use the dairy ingredient-family exclusion, with a visible
**Diet not verified: dairy free** notice. Named requests such as **Make Cheese
Pasta dairy-free** remain advisory adaptations and retain saved exclusions.

Explicit appliance exclusions, such as **dinner without an oven**, **no oven
dinner**, and **I don't have an oven**, filter reviewed equipment requirements
before ranking or generation. Recipes without a reviewed equipment list are
left out of these requests, with an explanation. Mixed requests such as **rice
without eggs or an oven** keep food and equipment exclusions separate. Appliance
exclusions remain hard requirements for named recipes too. Saved preferences,
source recipes and embeddings are unchanged.

Broad meal requests prefer reviewed main dinners, then recipes with unknown
roles, then reviewed sides/components/desserts. Specific searches keep their
relevance ranking and exact-title priority.

**Make Baked Ziti vegan** is an advisory adaptation of the named source;
**find a vegan dinner** filters source recipes instead. A named adaptation never
relaxes a saved diet or allergy exclusion. Original ingredients and directions
stay intact, with an explicit warning that the source has not become verified
for the adaptation target.

Exact title requests and explicit positive questions such as
`For Zucchini Pasta Bake, can I use olive oil instead of butter?`
stay focused on that dish. This is deliberately narrow, not a general intent
parser. Explicit substitution/change wording enables adaptations; ordinary
recommendations cannot generate unsolicited changes.

The public search endpoint and Chef share final shortlist selection. Exact named
recipes return one source record. Other targeted searches return at most three;
additional recommendations must cover all normalized query terms. Lexical
admission requires at least two-thirds query-term coverage as well as the
existing lexical score threshold, so sharing only **beef** cannot admit a dish
for **Beef Wellington**. Ordinary plurals and a small set of search aliases
normalize for retrieval only. Semantic admission retains its existing threshold.
Specific searches prioritize complete query coverage and relevance ahead of
pantry usefulness; broad browsing retains reviewed dinner roles and pantry
ordering. Fewer than three results is valid.

Shortlist cards show a server-supplied **Why this match** line, separate from
Chef's generated advice. It distinguishes named recipes, complete or partial
search-word matches, semantic matches, reviewed main dinners and pantry-name
matches. The same explanation remains available during provider fallback;
pantry-name matches do not establish quantities or dietary suitability. Search
responses expose these strings in `matchReasonsByRecipeId`, and Chef
recommendations include `matchReason`. Neither field is generated by a model.

- Missing embeddings or an unavailable Ollama service use lexical/pantry search.
- Failed, invalid, or incomplete generation produces explicitly labeled
  **Catalog suggestions**.
- Chef and the full Recipes tab report unavailable catalog storage explicitly.
  The older `/api/recipes` adapter can use a live-source fallback during setup;
  that does not populate the full catalog automatically.

Search uses `search_document:` and `search_query:` embedding prefixes with the
versioned `recipe-search-v2` profile. Old/stale vectors are not mixed with current
ones, and oversized embedding input is rejected rather than truncated. Responses
include retrieval, generation, and total timings.

With the app running, refresh missing/outdated vectors without fetching source
pages, rewriting recipes, or changing kitchen data:

```bash
pnpm recipes:embed
```

Current vectors are skipped. Retry the same command if some embeddings fail.

## Collect recipes (Python 3.10+)

The Scrapling collector is a manually run, text-only importer for **English
Wikibooks Cookbook**. It does not discover links, schedule crawling, collect
images, or automatically approve recipes.

### Setup

```bash
python3 -m venv .venv-recipes
.venv-recipes/bin/python -m pip install -r tools/recipes/requirements.txt
```

Use a newer Python executable if the system version is older than 3.10. Keep
the local app running and apply its database migrations before importing.

### Collect and review

Put **1–20 HTTPS Wikibooks Cookbook URLs** in `links.txt`, one per line, or use
the supplied example:

```bash
pnpm recipes:collect -- tools/recipes/links.example.txt
```

The terminal displays source links, ingredients, amounts, ordered directions,
servings, and warnings. Choose **a** to approve, **s** to skip, or **q** to quit.
Missing ingredients or ordered directions block approval. Unclear quantities
are preserved, not invented. Unsupported alternative-method pages and pages
carrying notices are left for manual review.

Requests are sequential, at least two seconds apart, respect robots rules and
longer server delays, and stop on access blocks. Redirects must remain within
the allowed source. No proxies, stealth, browser impersonation, or CAPTCHA solving
are used.

Approved recipes save through the local import endpoint and deduplicate by
canonical source URL. Edited drafts require renewed review. Failed embeddings
leave the recipe saved and usable through non-semantic search. Importing never
changes pantry or plan data.

### Resume and retry

Reports containing drafts, review decisions, and results live in ignored
`recipe-runs/`. Replace the report path below with the actual run file:

```bash
# Collect drafts without importing.
pnpm recipes:collect -- links.txt --collect-only

# Review drafts or retry approved imports without fetching pages again.
pnpm recipes:collect -- --resume recipe-runs/YOUR-RUN.json

# Retry embeddings for saved recipes in this report.
pnpm recipes:collect -- --retry-embeddings recipe-runs/YOUR-RUN.json
```

For another local app port, add `--app http://localhost:PORT`. Resume does not
retry failed page fetches: collect those URLs in a new run after resolving the
issue. New runs never overwrite existing reports. Keep reports private if they
contain personal notes.

## Data, backups, and offline use

The local Cloudflare D1 database under **`.wrangler/state/`** stores recipes,
ingredients, ordered steps, source policies, embeddings, pantry amounts, dated
meal snapshots, and shopping checks. Preserve this directory when moving the
installation. Stop local servers before copying it for a consistent full backup.

**Settings → Export backup** downloads kitchen data as JSON, not the complete
recipe catalog or embedding index. Cooking preferences (allergies, diet, equipment, dislikes, skill and budget) are
part of the kitchen and its backup. Model preferences remain browser-local.
Each tab has its own recoverable draft; conflicting saves require an explicit
choice rather than silently overwriting another tab's kitchen.

**Settings → Restore backup** accepts original exports, version 1 exports, and version 2 exports.
Version 2 includes cooking preferences. Older backups keep the current cooking
preferences and require review before restoration.
It validates the file and previews counts before replacement, preserves the
current kitchen as a recoverable draft, and uses the current revision when saving.
Replacement is blocked if the recovery copy cannot be written. Catalog data and
model preferences are not restored. **Unsaved kitchens found** lets you review
closed-tab drafts with dates, counts and differences; recovery copies a draft
without deleting another tab's work. Offline restores stay pending until saved.

### Reviewed recipe metadata

Apply migrations before using reviewed metadata. Reviews live in a separate,
versioned table bound to the source content hash. Stale reviews become unknown;
metadata changes do not rewrite source recipes, embeddings or saved dinners.

The current **v2 dinner review** covers the same 30 Wikibooks mains. Refresh the
matching sources with the current collector before applying it. The two explicit
link lists stay within the collector's 20-page limit; each recipe still requires
review in the terminal.

With the local app running and migrations applied:

```bash
pnpm recipes:collect -- tools/recipes/core-dinners.v2.part1.txt
pnpm recipes:collect -- tools/recipes/core-dinners.v2.part2.txt
pnpm recipes:curate -- validate tools/recipes/core-dinners.v2.json
pnpm recipes:curate -- preview tools/recipes/core-dinners.v2.json
pnpm recipes:curate -- import tools/recipes/core-dinners.v2.json
pnpm recipes:embed
pnpm recipes:curate -- report recipe-runs/quality-report.json
pnpm recipes:curate -- export recipe-runs/review-worksheet.json
```

Preview verifies source hashes and field provenance without writing. Repeated
imports are idempotent. Reports classify unresolved amounts and retain source
links; worksheets require explicit review before import. Use a new output path
for each report/worksheet. Add `--app http://localhost:PORT` for another local
preview; for `recipes:embed`, set `RECIPES_APP_URL=http://localhost:PORT` instead.
Embedding refresh updates source and step search vectors without fetching pages.
The checked-in core annotates existing catalog records. Source recipes
are collected separately; this review does not preload a fresh installation.
If preview reports a changed source hash, review the new source and its complete
metadata again. Do not force an older annotation onto changed content. Blocked
source pages stay untouched and must be reported as deferred.

All 30 reviews retain explicit source servings. The November 1, 2026 review
captured original source notes for 19 recipes without changing ingredients,
directions or servings. Twelve mains have complete source-backed totals; eight
other source time labels remain unknown because of omitted preparation or
inconsistent timing. Ten sources state no complete total. Twenty-nine mains
still have at least one amount requiring review. These include seasonings,
ranges and prepared ingredients; missing amounts are not invented.

In **Recipes**, enable **Reviewed dinners** to narrow results to reviewed mains.
Its matching count respects the selected collection, search, saved exclusions,
and time limit before pagination. It also works in **Favorites** and **Cook again**.
Main-dish classification does not establish quantified amounts or dietary safety.

**Maximum total minutes** includes only complete, source-backed totals, never
step durations or curator estimates. Required preparation outside the directions,
such as cooking rice or thawing an ingredient, keeps the complete total unknown.
Optional serving suggestions are outside the main dish's stated time. Unknown
times remain browsable when the time filter is cleared. Chef also honors an
explicit unknown-total review: preserving an incomplete original time label
does not make that label a complete total in answers or recommendations. See the
[30-dinner review](dinner-review.md) for outcomes and outstanding gaps.

The earlier source-time reviews for Quick Risotto, Tomato Pasta, and Chickpea Omelette are in
`tools/recipes/verified-times.v1.json`, with links to the reviewed source revisions.
The source statements are retained as **Original source notes**, separate from
cooking steps. Tomato Pasta’s 20–25 minute source range uses its upper bound for
filtering. Other unknown times stay unknown.

For an existing installation, run `pnpm db:migrate` before restarting the app to
add source-note storage. After collecting and reviewing the matching source
versions with the current collector, preview and apply the timing annotations:

```bash
pnpm recipes:curate -- preview tools/recipes/verified-times.v1.json
pnpm recipes:curate -- import tools/recipes/verified-times.v1.json
```

Apply that earlier timing manifest **before** `core-dinners.v2.json` when using
both, so the refreshed Chickpea Omelette review stays current. The v2 manifest
supersedes `core-dinners.v1.json`; the older file remains a historical review.

All curation manifests are tied to their captured source hashes. A source-note
change requires a fresh metadata review; older metadata cannot silently carry
forward to a new source version. The collector displays source notes during
approval and includes them in the review hash.

The production-style preview can cache the app shell after an online visit.
Cached kitchen data and unsaved edits can survive a temporary server outage and
sync when the server returns. The service worker does not cache recipe API
responses: offline support does **not** guarantee full-catalog browsing or AI
generation. Development mode needs its server to load the page. Production builds publish an
asset manifest so Chromium and WebKit can cache the complete app shell even when
Resource Timing entries are unavailable. `pnpm test:smoke` checks actual offline
reload, timer recovery, and shopping copy/print behavior in both engines. This is
automated WebKit coverage, not physical-device or Safari-app certification.

## Configuration

See [`.env.example`](../.env.example) for the complete template and defaults.

| Setting | Purpose |
| --- | --- |
| `OLLAMA_BASE_URL` | Local provider address; defaults to `http://127.0.0.1:11434` |
| `OLLAMA_CHAT_MODEL`, `OLLAMA_EMBED_MODEL` | Server model defaults; generation uses `qwen3.5:9b`, embeddings use `nomic-embed-text` |
| `OLLAMA_EMBED_TIMEOUT_MS` | Bulk embedding-refresh timeout |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | Optional server-side cloud-provider configuration |
| `CHEF_TOP_K`, `CHEF_PROVIDER_TIMEOUT_MS` | Context size (bounded to 1–8) and generation timeout |
| `CATALOG_ADMIN_TOKEN` | Catalog administrator token for non-loopback requests |

Recipe maintenance commands use `RECIPES_APP_URL` to target another running
app instead of port 3000. The collector uses its separate `--app` option.

## Development and testing

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm exec playwright install chromium webkit
pnpm test:e2e
pnpm test:setup
pnpm test:smoke
pnpm recipes:test
```

`pnpm test:source` runs source/SQL/hook tests without building. `pnpm test` runs
those checks followed by `pnpm test:integration`, which builds and renders a
disposable project. `pnpm test:e2e` builds another isolated copy, migrates a
separate D1 database, seeds synthetic recipes, and tests desktop/mobile flows on
an ephemeral loopback port. AI providers are mocked; personal data and `.env`
files are not copied. Browser artifacts live in ignored `output/playwright/`.
Collector tests need the Python environment above. Only a direct app build needs
the production preview stopped.

GitHub Actions runs type checking, lint, source tests, isolated build/browser
checks, and the Python collector tests on pushes and pull requests. It installs
Chromium and its Linux dependencies using the
[Playwright CI setup](https://playwright.dev/docs/ci-intro).
The workflow needs no app secrets, Cloudflare account, downloaded AI models, or
personal database. Local-Ollama evaluation commands below remain separate.

See [Evaluation and release evidence](evaluation.md) for real-model commands,
held-out quality gates, result definitions, fingerprints, and limitations.

### Project layout

```text
app/components/       Screens, recipe details, weekly plan, and shopping UI
app/lib/              Retrieval, provider schemas, storage, and quantities
app/api/              Chef, recipes, kitchen, and catalog administration
db/                   Drizzle schema and database access
drizzle/              Database migrations
tools/recipes/        Collection, embedding refresh, and evaluation tools
tests/                App regression tests
public/kitchen-sw.js  Offline app-shell caching
```

The stack is React and Next.js-compatible app code served through **Vinext/Vite**,
Cloudflare's local runtime and **D1**, with **Drizzle** migrations. Scrapling runs
in an isolated Python environment. No separate vector database is required.

### Main API routes

| Route | Purpose |
| --- | --- |
| `GET /api/recipes/catalog` | Full approved catalog |
| `GET /api/recipes` | Ranked search; setup-time live-source fallback |
| `POST /api/chef` | Grounded answer or labeled catalog suggestions |
| `GET /api/kitchen`, `PUT /api/kitchen` | Revision-checked kitchen persistence |
| `GET /api/admin/catalog` | Catalog and embedding status |
| `POST /api/admin/catalog/demo` | Add original starters without AI or downloads |
| `POST /api/admin/catalog` | Source sync; `{"embeddingsOnly":true}` refreshes only vectors |
| `POST /api/admin/recipes/import` | Import up to 20 reviewed Wikibooks recipes |
| `GET /api/admin/recipes/metadata` | Hash-bound source review worksheet and quality summary |
| `POST /api/admin/recipes/metadata` | Preview or atomically import reviewed metadata |

## Attribution and prototype limits

See [NOTICE](../NOTICE) for the recipe fixtures and their source-specific terms.
Original app code is licensed under the [MIT License](../LICENSE). Third-party
recipe content and dependencies retain their separate licenses and terms.

Wikibooks imports preserve contributor attribution, a source/history link,
**CC BY-SA 4.0** licensing, and a normalization notice. Retain those notices when
reusing imported text; see the
[Wikibooks reuse policy](https://en.wikibooks.org/wiki/Wikibooks:Copyrights).
TheMealDB is a separate prototype-approved adapter; do not assume its content
has the same license. Recipe-content licenses are not a license for app code.

Allergy exclusions are conservative ingredient-text matching, not certification.
They cannot establish cross-contact safety or detect missing source ingredients.
Dietary labels, total cooking times, and nutrition are not guaranteed metadata.
Chef suggestions are not automatically applied to pantry stock or saved meals.

Keep the app bound to loopback. Catalog administration rejects cross-origin
browser writes and requires a token for non-loopback requests, but that is
**not authentication for the whole kitchen**. Before public use, review
application-wide access control, storage/indexing/embedding rights, image
permissions, and commercial use. Source approvals here cover the local prototype,
not a public release.

## GitHub preparation

The repository includes source code, migrations, tests, reviewed metadata and a
frozen attributed evaluation corpus. It does not include your local kitchen,
database, browser storage, private configuration, imported recipe runs or backups.
The evaluation corpus is not loaded into the app on startup.

Keep `.env.local`, `.dev.vars`, `.wrangler/`, `recipe-runs/`, `work/`, local
databases, kitchen backup exports and test artifacts out of commits. `.env.example`
contains public defaults and empty secret fields only. Sharing the repository
does not deploy the app; it remains intended for loopback use.

Before uploading, inspect `git status` and the staged file list. To repeat the
secret scan with [Gitleaks](https://github.com/gitleaks/gitleaks) installed:

```bash
gitleaks git . --log-opts=--all --redact
gitleaks git . --staged --redact
```
