# RAG Chef

![RAG Chef — Cook with what you have](public/og.png)

A local-first cooking app for turning pantry ingredients into dinner ideas,
weekly plans, and shopping lists. Optional AI recommendations use an approved
recipe catalog, with source instructions and attribution preserved.

Built for personal use on one Mac. This is a prototype, not a public multi-user
service or an allergy-safety certification tool.

## Features

- **Plan:** dated dinners, serving adjustments, copied or locked meals, and
  pantry-first suggestions that fill empty days without replacing saved dinners.
- **Recipes:** browse the full catalog, search names and ingredients, inspect
  original directions, and add a recipe to the plan.
- **Shopping:** combine planned ingredients, subtract known pantry amounts,
  review unclear quantities, and check off purchases.
- **Pantry:** track ingredients with known amounts or leave quantities unknown.
- **Ask Chef:** source-grounded recommendations and requested substitutions
  using local Ollama or the optional OpenAI provider.
- **Cook:** step-by-step guidance, timers, optional wake lock, pantry deductions,
  and undo for completed dinners.

Reviewed **Core dinners**, source-backed time filters, and visible quantity gaps
distinguish reviewed meals from recipes that still need checking. Saved diets
hide known conflicts; unknown suitability stays visible with a **Diet not
verified** label. Allergy, diet and equipment rules are shared across browsing,
Chef and planning. Dislikes affect ranking rather than excluding meals.

Recipes, pantry amounts, plans, and shopping checks persist locally. Browsing,
planning, and shopping do not require an AI model.

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

The app opens on **Chef**. Choose a dinner day (today by default), ask for ideas,
then choose a dinner, review shopping, and cook. **Plan** remains directly accessible.
You can also choose **Add to plan** from Recipes. Open **Chef** directly from
navigation, or **Ask Chef** from Recipes. Your recipe search stays intact during
the current session.
Chef opens with up to three **Pantry picks**, or **Dinner ideas** when your pantry
is empty, using the loaded catalog without a model call. Saved exclusions and
dislikes still apply. Use **Find my dinner** for a specific request, or leave it
blank for the default pantry-dinner question. Weekly filling stays on **Plan**.
After a request, **How Chef found this** shows the actual retrieval method,
catalog and shortlist counts, requirement exclusions, and whether an AI answer
or a catalog fallback was used. **Recipe evidence** puts source excerpts and
original links beside the answer. Cited excerpts are copied from the source;
fallback excerpts are explicitly labeled as retrieved recipe text. Open an
evidence title to inspect the full recipe. No confidence percentage is implied.
When choosing a day, Chef keeps that date visible and its recipe cards offer
**Add to [day]** directly. Opening recipe details is optional. Without a selected
day, Chef uses the visible date, defaulting to today. Adding from the Recipes
browser without a selected day still opens the day picker. Replacing a dinner
still needs confirmation.

**Ask about this recipe** pins a discussion to one approved source recipe.
Follow-up questions retain the latest three question/answer pairs while navigating
between Chef, recipe details, and cooking. Earlier questions are collapsed;
reloading starts a new discussion. **New dinner search** clears the recipe,
selected day, portions, and refinements. Explicit refinements appear as removable
filters and cannot relax saved exclusions.

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
running. Older sessions are mapped back to source steps where unambiguous;
otherwise help uses the recipe context. Changed dinner portions, source versions,
or source permissions are rechecked before an answer. Saved directions remain
available when Chef cannot verify a version. Relevant source steps retain their
original IDs, and an omitted step cannot be cited as supplied evidence.

### Populate a fresh installation

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

Use the **Dark mode** toggle in the top bar or cooking header to switch themes.
The app follows your system preference until you choose a theme, then remembers
that choice in this browser. Theme preferences are separate from kitchen backups.

An empty week has a compact, expandable checklist for preferences, pantry,
dinner, and shopping. **Today’s dinner** gives immediate access to tonight;
saving a dinner reveals its card. The day picker defaults to an upcoming empty
date. Historical or occupied dates require an explicit selection.

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

Checked items move into **Bought** without changing pantry stock. Completing a
dinner can deduct confirmed stock; **Undo cooked** restores that deduction.
Saved meals retain independent recipe snapshots, so catalog updates do not
silently rewrite existing dinners or historical quantities.

Cooking mode shows the same final amounts and overrides as the dinner details.
Ingredients start collapsed and expand into the main cooking panel. That panel
is the single scrolling area; the header and step controls stay visible, and
changing steps returns to the top. Background page scrolling is locked while
a dialog is open.
Custom timers have minutes and seconds controls, plus 1, 5, 10, and 15 minute
presets. They accept 1 second to 24 hours and use a saved deadline, so time does
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
Ollama verification call for their displayed model answer and recommendation
reasons. Recipe discovery uses model-selected recipe IDs and exact source
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
recipe catalog or embedding index. Profile and model preferences are browser-local.
Each tab has its own recoverable draft; conflicting saves require an explicit
choice rather than silently overwriting another tab's kitchen.

**Settings → Restore backup** accepts original exports and version 1 exports.
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

With the local app running, inspect and load the attributed 30-dinner review:

```bash
pnpm recipes:curate -- validate tools/recipes/core-dinners.v1.json
pnpm recipes:curate -- preview tools/recipes/core-dinners.v1.json
pnpm recipes:curate -- import tools/recipes/core-dinners.v1.json
pnpm recipes:curate -- report recipe-runs/quality-report.json
pnpm recipes:curate -- export recipe-runs/review-worksheet.json
```

Preview verifies source hashes and field provenance without writing. Repeated
imports are idempotent. Reports classify unresolved amounts and retain source
links; worksheets require explicit review before import. Use a new output path
for each report/worksheet. Add `--app http://localhost:PORT` for another local
preview. The checked-in core annotates existing catalog records; it is not a seed
dataset. Import the matching source recipes first on a fresh installation.

All 30 reviews retain explicit source servings. Total cooking time and low-carb
suitability remain unknown where the captured source cannot establish them.
**Maximum total minutes** includes only complete, source-backed totals, never
step durations or curator estimates. Consequently the initial core has no time
filter matches until source-backed totals are reviewed. All other recipes remain
available with explicit unknowns.

The production-style preview can cache the app shell after an online visit.
Cached kitchen data and unsaved edits can survive a temporary server outage and
sync when the server returns. The service worker does not cache recipe API
responses: offline support does **not** guarantee full-catalog browsing or AI
generation. Development mode needs its server to load the page.

## Configuration

See [`.env.example`](.env.example) for the complete template and defaults.

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
pnpm exec playwright install chromium
pnpm test:e2e
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

To check five fixed source-answering cases against a real local model, without
starting the app or loading personal recipes:

```bash
pnpm recipes:grounding-eval
pnpm recipes:rag-eval
# Optional installed local model:
pnpm recipes:grounding-eval --model qwen3.5:9b
```

This builds a disposable app with nine synthetic recipes and uses only local
Ollama. It checks step timing, a temperature paraphrase, doneness, missing
nutrition, and the difference between step duration and total recipe time.
Source facts must match the original supplied evidence. The report records the
model digest, selected evidence IDs, timings, and unchanged kitchen/catalog
snapshots in ignored `output/playwright/chef-*/grounding-results.json`. A withheld
answer fails answer-quality scoring even though the unsupported prose was hidden.
This small regression suite is separate from the provider-mocked CI checks.

`recipes:rag-eval` adds 40 fixed synthetic source-question and claim cases,
with disjoint development and held-out recipe splits. It compares evidence
recall@6 with the retained lexical selector, and false-claim acceptance with the
numeric-only guard. Reports include model digests, selected source IDs, labels
and source hashes, context size, and median/p95 verification time. Its gates are
90% evidence recall, 90% supported-answer acceptance, and at most 5% unsupported
claim acceptance. This evaluates a small labeled set, not general culinary truth.
It uses only local models and synthetic records, without accessing the app's
personal database. Reports and vector caches are ignored local artifacts.


### RAG user journeys

Run **8 fixed journeys with 21 Chef turns** through a built disposable app:

```bash
# Repeatable original test recipes; local Ollama must be running.
pnpm recipes:journey-eval
# The same expectations against a read-only snapshot of the local catalog.
pnpm recipes:journey-eval --catalog local
# Investigate one journey; subset reports are labeled explicitly.
pnpm recipes:journey-eval --catalog local --journey stock-reservations
# Optional installed local model and generated-response p95 budget.
pnpm recipes:journey-eval --model qwen3.5:9b --latency-budget-ms 60000
```

The journeys cover ordinary pantry names, cooked versus uncooked stock, unknown
and partial quantities, saved allergies and diet changes, unavailable equipment,
recipe follow-ups, an ambiguous choice, switching recipes, final portions and
amount overrides, cooking-step help, missing nutrition and total time, mistaken
temperatures, stale kitchen/dinner context, expiry dates and reserved stock.
Each journey carries actual answers, selected recipe IDs and saved dinner hashes
forward. Explicit setup actions write only the disposable kitchen. Every Chef
turn is checked for unintended kitchen changes.

The fixed expectations check recommendation identity and usefulness, source
scope, exact quoted evidence and source links, expected answer details, unknown
facts, stock coverage, final amounts and conflict responses. The pipeline's own
model-assisted verifier is recorded as one signal; it is not an independent
semantic judge. Saved dinner ingredient amounts use a separate calculated-answer
contract (report version 2): exact final amounts, source ingredient IDs, servings
and override labels must match, with zero generation or verification calls.
Their latency is reported separately from model-assisted factual answers.
Original source quantities remain separate from the saved dinner amounts.
These checks do not measure every possible factual error.
Failed, withheld, timed-out and blocked turns never count as passes. A failed
multiple-choice precondition blocks its dependent ambiguous follow-up rather
than manufacturing a conversation to make it pass.

Reports appear in ignored `output/playwright/journeys-*/journey-report.md` and
`journey-results.json`. They include prompts, answers, failed checks, latency by
request group, model digests, catalog/code/evaluation/label fingerprints and the
selected source evidence. The full canonical responses and catalog oracle are
saved alongside the report for diagnosis. Setup and embedding refresh time are excluded from
response latency; first-turn cold response time is included. Keep the host awake
while comparing performance. Large event-loop gaps make timing unreliable and
fail the latency gate instead of silently passing it. Timeout failures also
fail the run even when other answers are fast.

The local-catalog track requires Python 3 and the **Zucchini Pasta Bake** and
**Red Lentil Soup** records with the fixed facts used by the journey labels.
Drift in those required source facts stops evaluation for review; expected facts are never regenerated
from model output. SQLite is backed up read-only, including committed WAL data.
The copied kitchen is replaced with the fixed test scenarios before Chef is
called, `.env` and provider keys are excluded, and only local Ollama is used.
No new source is imported. `local-snapshot-check.json` compares the original
local database before and after; a concurrent change marks the run for review.
A nonzero exit can indicate an application quality finding, an execution
failure, or a failed latency gate; inspect the per-turn report for the reason.


Step embeddings use the existing database table with kind `recipe-step-v1`;
no schema migration is needed. After upgrading an existing installation, run
`pnpm recipes:embed` against the local app once. It refreshes missing or stale
recipe and step vectors, preserves source records and kitchen data, and skips
current vectors on subsequent runs. Catalog status reports current and pending
step counts. Permission changes and recipe hashes are checked again when vectors
are written and loaded. Until refresh completes, lexical retrieval stays usable.

With the app running and the relevant recipes imported:

```bash
pnpm recipes:eval
pnpm recipes:chef-eval
pnpm recipes:relevance-eval
```

`recipes:eval` runs 20 fixed retrieval checks, targeting at least 16 expected
top-three matches with no forbidden allergy results. `recipes:chef-eval` checks
three local Ollama answers, latency, recipe references, requested changes, and
unchanged kitchen/catalog data. It requires the **Zucchini Pasta Bake** catalog
entry and never selects a paid cloud provider. These small regression checks
do not certify culinary correctness or allergy safety.

`recipes:relevance-eval` uses the attributed frozen 166-recipe evaluation corpus
and local Ollama embeddings, without database access or paid generation. Normal
verification evaluates the deployed, frozen thresholds on 40 calibration queries,
40 held-out queries and the original 20 retrieval cases, including forced lexical
fallback. Exact named recipes must rank first. Query embeddings use the same
parsed positive query as production. Add `--calibrate --report NEW_PATH` to
evaluate a threshold candidate selected only from calibration cases; this never
rewrites deployed thresholds. Candidate threshold searches run only when
`--calibrate` is supplied. Normal verification uses the same final shortlist
selector as production and records matched/missing query terms per result.
The committed report records corpus/source hashes, model version, outcomes and
strict labeled precision. Held-out retention/abstention gates are 95%; the report
also discloses imperfect precision. The current shortlist policy abstains on the
previous Beef Wellington false positive. Add `--baseline REPORT_PATH` to record
a comparison against a report with matching corpus, labels and embedding model.
Comparisons account for the previous Chef's exact-title filtering: candidate
context precision on the existing held-out labels improves from 71.3% to 91.7%
with semantic retrieval, and from 67.6% to 92.6% with forced lexical fallback.
These non-exhaustive labels measure candidate relevance, not generated-answer
accuracy or culinary suitability. This corpus is a test fixture, not an
application seed.

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
| `POST /api/admin/catalog` | Source sync; `{"embeddingsOnly":true}` refreshes only vectors |
| `POST /api/admin/recipes/import` | Import up to 20 reviewed Wikibooks recipes |
| `GET /api/admin/recipes/metadata` | Hash-bound source review worksheet and quality summary |
| `POST /api/admin/recipes/metadata` | Preview or atomically import reviewed metadata |

## Attribution and prototype limits

See [NOTICE](NOTICE) for the recipe fixtures and their source-specific terms.
Original app code is licensed under the [MIT License](LICENSE). Third-party
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
