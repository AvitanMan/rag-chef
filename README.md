# RAG Chef

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

- Node.js **22.13 or newer** and **pnpm**.
- **Ollama**, optional, for local AI and semantic search.
- **Python 3.10 or newer**, only for collecting recipes with Scrapling.

### Start the app

From the project directory:

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

Open [localhost:3000](http://localhost:3000).

The app opens on **Plan**. Choose a day, select a recipe, then open **Shopping**.
You can also choose **Add to plan** from Recipes. **Ask Chef** opens from Recipes
and keeps your recipe search intact during the current session.

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

### Production-style local preview

```bash
pnpm build
pnpm start
```

This still runs locally; it does not deploy the app. Stop `pnpm start` before
running a direct `pnpm build`, which replaces its served files. Tests build
disposable copies and leave this preview and its database untouched.

## Planning and shopping rules

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
empty days in date order without spending the same stock twice. Stock due within
three days leads, followed by quantity coverage, ingredient reuse and stable ties.
Past days remain manually editable; locked, cooked and saved dinners stay intact.

Use **Cook for** when the source provides an explicit serving count. Unknown
yields remain **Recipe batches**. **Adjust amounts** corrects a particular dinner
without rewriting the source. Entered ingredient overrides are final amounts,
applied after scaling. Locking and copying are under **More options**.

Shopping counts each planned dinner and combines compatible quantities. Unknown
pantry amounts never count as sufficient stock. Missing measures, ranges, and
conflicting units stay marked for review. Cups use 240 ml, tablespoons 15 ml,
and teaspoons 5 ml; volume is never assumed to equal mass.

Checked items move into **Bought** without changing pantry stock. Completing a
dinner can deduct confirmed stock; **Undo cooked** restores that deduction.
Saved meals retain independent recipe snapshots, so catalog updates do not
silently rewrite existing dinners or historical quantities.

Cooking mode shows the same final amounts and overrides as the dinner details.
Custom timers accept 1 second to 24 hours and use a saved deadline, so time does
not depend on background interval ticks. Single explicit source-step durations
offer shortcuts; ranges and ambiguous durations require a custom timer. Sound is
optional and requires browser audio support. Timer completion never marks dinner
cooked. **Exit cooking** preserves progress; **Resume cooking** or **Discard
cooking session** appears after reopening. Starting another dinner asks before
replacing progress. Changed meal identities or quantities require reopening the
current dinner before completion and pantry deduction.

## How Chef works

Chef searches the full approved database catalog, not the on-screen shortlist or
recipe text submitted by a client. Ingredient-text allergy exclusions run before
ranking and before recipes reach the model. Retrieval combines precomputed
semantic embeddings, lexical relevance, and conservative pantry-name coverage.

The model receives each selected recipe's complete ingredients and directions
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

Requests such as **no pasta**, **without tomatoes**, **avoid eggs**, and **don't
use onions** filter ingredients before ranking or generation. Comma-separated
lists and `and`/`or` lists are supported. Excluded words are removed from the
positive retrieval query. These are request-specific rules; saved preferences
are unchanged. This parser handles explicit English clauses rather than general
conversational reasoning.
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
