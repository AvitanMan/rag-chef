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
rebuilding or running `pnpm test`, since both replace the build it is serving.

## Planning and shopping rules

Recipe search ignores case, accents, and punctuation. Every search word must
appear in the title or ingredient names. Exact names lead, then pantry coverage
and alphabetical ties. **Show more** reveals another 24 cards. Pantry matches
count ingredient names, not whether you have enough to cook the meal.

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

## How Chef works

Chef searches the full approved database catalog, not the on-screen shortlist or
recipe text submitted by a client. Ingredient-text allergy exclusions run before
ranking and before recipes reach the model. Retrieval combines precomputed
semantic embeddings, lexical relevance, and conservative pantry-name coverage.

The model receives complete directions for the selected records and returns a
small, validated JSON response. The server supplies canonical recipe IDs,
citations, and pantry lists. Proposed substitutions appear separately from
source facts and unchanged original directions.

Exact title requests and explicit positive questions such as
`For Zucchini Pasta Bake, can I use olive oil instead of butter?`
stay focused on that dish. This is deliberately narrow, not a general intent
parser. Explicit substitution/change wording enables adaptations; ordinary
recommendations cannot generate unsolicited changes.

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
pnpm recipes:test
```

`pnpm test` builds the app and tests storage, conflicts, imports, retrieval,
quantity arithmetic, recipe snapshots, cooking undo, AI boundaries, and rendered
UI. Collector tests need the Python environment above. Stop the production
preview before running a build or app tests.

With the app running and the relevant recipes imported:

```bash
pnpm recipes:eval
pnpm recipes:chef-eval
```

`recipes:eval` runs 20 fixed retrieval checks, targeting at least 16 expected
top-three matches with no forbidden allergy results. `recipes:chef-eval` checks
three local Ollama answers, latency, recipe references, requested changes, and
unchanged kitchen/catalog data. It requires the **Zucchini Pasta Bake** catalog
entry and never selects a paid cloud provider. These small regression checks
do not certify culinary correctness or allergy safety.

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
