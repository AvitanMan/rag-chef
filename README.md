# RAG Chef

[![Checks](https://github.com/AvitanMan/rag-chef/actions/workflows/ci.yml/badge.svg)](https://github.com/AvitanMan/rag-chef/actions/workflows/ci.yml)

**Turn what you have into tonight’s dinner—and a shopping list for what you need.**

RAG Chef is a local-first cooking app with a pantry, weekly plan, shopping list,
and step-by-step cooking workspace. Optional AI answers use an approved recipe
catalog, preserve source attribution, and withhold prose that cannot be verified.

Standalone mode runs one household on your computer. An opt-in **hosted family beta** adds Google sign-in, shared kitchens, personal OpenAI keys, and browser-connected Ollama. Browsing, planning, shopping, and calculated dinner amounts work without an AI model. See [hosted beta setup and release gates](docs/hosted-beta.md).

## Try it

Requires Node.js 22.13+ and pnpm 11.25.0. The repository pins both versions.

```bash
git clone https://github.com/AvitanMan/rag-chef.git
cd rag-chef
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
```

Open [localhost:3000](http://localhost:3000) and select **Load starter recipes**.
Three original MIT-licensed recipes let you try the complete flow without an
account, model, or recipe download. Your pantry starts empty; adding starters
changes only the catalog. The larger third-party evaluation corpus is never
loaded as application data.

After pulling updates, run `pnpm db:migrate` before restarting the app. Reviewed
assistant saves require the latest catalog consistency migration; ordinary
manual controls remain available if the database still needs that update.

1. Review allergies, diet, and equipment in **Settings**; add what you have to **Pantry**.
2. Choose a dinner. Review portions and missing ingredients in its dinner panel.
3. Open **Weekly shopping** to review, copy, or print the ingredients still needed.
4. Select **Cook dinner** for directions, independent timers, and source-linked help.
5. Mark the dinner cooked. Pantry deductions are optional, and completion can be undone.

## See the flow

These screenshots use the original starter recipes and an empty demonstration
kitchen, not personal data.

| Choose dinner | Review shopping | Cook step by step |
| --- | --- | --- |
| ![Dinner and missing ingredients](docs/images/dinner.png) | ![Weekly shopping list](docs/images/shopping.png) | ![Cooking directions and timers](docs/images/cooking.png) |

## What it does

- **Kitchen assistant:** reviewed pantry additions and corrections, cuisine-aware dinner plans, shopping previews, explicit taste feedback, and actual pantry usage after cooking. Every assistant change requires **Apply**.
- **Pantry to dinner:** ingredient search, measured stock coverage, due-soon food,
  favorites, and recently cooked meals.
- **Weekly planning:** dated dinners, portions and amount overrides, copied or
  locked meals, and suggestions that preserve existing plans. **Plan with Chef**
  turns requests into editable drafts with whole-week shopping previews; nothing
  is saved until **Apply plan**. Manual previews work without a model.
- **Shopping:** combine requirements, reserve stock across dinners, flag unclear
  amounts, and review purchases before adding them to the pantry.
- **Cooking:** original directions, multiple recoverable timers, optional screen
  wake lock, and source-specific questions about the current step.
- **Recovery:** local database persistence, browser drafts, conflict handling,
  undo, and kitchen backups including cooking preferences.

Known allergy, diet, equipment, and ingredient conflicts are filtered before
ranking. Unknown suitability and quantities stay visible for review. These
checks do not certify allergy safety or cross-contact conditions.

## Optional AI

For local generation and semantic search, install and run Ollama, then pull:

```bash
ollama pull qwen3.5:9b
ollama pull nomic-embed-text
```

Use **Settings → Test connection** to check generation, search, and answer
verification separately. Missing embeddings keep lexical/pantry search usable.
OpenAI generation is optional. Source-answer verification uses the same selected provider, so OpenAI does not require Ollama. Its separate verification request is also billed to your key. Hosted accounts configure their personal connection in Settings; the server never falls back to a platform key.

[Configuration and model setup](docs/guide.md#enable-local-ai) explains local
environment files, optional server-side keys, and production-style local preview.

## How it works

```mermaid
flowchart LR
  UI[Pantry / Plan / Recipes / Cook] --> Kitchen[Revision-checked kitchen state]
  Kitchen --> DB[(Local or household D1 database)]
  Sources[Approved recipe sources] --> Catalog[Recipes + source evidence]
  Catalog --> DB
  Query[Chef request] --> Filter[Deterministic constraints]
  DB --> Filter
  Filter --> Search[Lexical retrieval / standalone semantic search]
  Search --> Amounts[Calculated dinner amounts]
  Search --> Model[Optional generation]
  Model --> Verify[Source and selected-provider verification]
  Verify --> Answer[Verified answer or source fallback]
```

React/Next.js-compatible app code runs through **Vinext/Vite** and Cloudflare's
local runtime. **Drizzle** manages D1 migrations. **Ollama** supplies local models;
OpenAI is an optional generation provider. No separate vector database is needed.
Original recipe text, selected evidence, calculated amounts, and suggested
adaptations remain distinct; suggestions never silently rewrite saved meals.

## Evidence and checks

| Check | What it establishes |
| --- | --- |
| Source, SQL, hook, build, and browser tests | Application behavior and recovery contracts |
| Fresh-installation tests | Setup and dinner selection without AI or a preloaded catalog |
| 40 synthetic retrieval/claim cases | Independently gated development and held-out retrieval and verification quality |
| Eight source-answering checks | Answer usefulness, expected uncertainty, and safe withholding reported separately |
| Nine real-model journeys / 24 turns | Recipe follow-ups, constraints, quantities, source scope, and latency |

See the [v0.2.0 evidence summary](docs/release-evidence.md) and
[evaluation methodology](docs/evaluation.md) for exact denominators, model
fingerprints, thresholds, and limitations. Provider-mocked CI is not a measurement
of real-model answer quality. Historical retrieval metrics are not general
answer-accuracy claims.

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm exec playwright install chromium webkit
pnpm test:e2e
pnpm test:setup
pnpm test:smoke
pnpm test:dev
# After creating the collector's Python environment:
pnpm recipes:test
```

Tests use disposable databases and original synthetic recipes. Personal kitchen
state, configuration, and imported recipe runs are not copied into CI.

## Documentation and boundaries

- [Operating guide](docs/guide.md): kitchen flows, source import, configuration,
  backups, offline behavior, API routes, and troubleshooting.
- [Evaluation](docs/evaluation.md): real-model commands, grading, and release evidence.
- [Contributing](CONTRIBUTING.md): local verification and review expectations.
- [NOTICE](NOTICE): recipe-source attribution and content licenses.

The [MIT license](LICENSE) covers original application work and starter recipes.
Wikibooks content retains its attribution and CC BY-SA terms; TheMealDB content
has separate terms. Neither the recipe corpus nor your local database becomes
MIT-licensed merely by being used with this application.

Keep standalone mode bound to loopback. Public hosting requires the explicit hosted configuration, Google credentials, an approved recipe catalog, and the release checks in the [hosted beta guide](docs/hosted-beta.md). Publishing this repository does not deploy a kitchen.
Never commit `.env.local`, `.dev.vars`, `.wrangler/`, kitchen backups, or other
personal local state. See the guide for exact offline and backup limits.
