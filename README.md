# RAG Chef

A local-first cooking assistant that turns pantry ingredients into grounded recipe recommendations, weekly meal plans, shopping lists, and step-by-step cooking guidance.

## What the prototype includes

- Pantry-aware recipe retrieval with explicit source citations
- A persistent D1 catalog with normalized ingredients and ordered direction sections
- Versioned recipe search embeddings precomputed with Ollama
- Hard allergy filtering before recipes reach an AI provider
- Switchable Ollama and OpenAI generation
- Hybrid semantic, lexical, and pantry ranking with a deterministic fallback
- Weekly planning, consolidated shopping, metric conversion, timers, and wake-lock cooking mode
- Browser-local persistence for one profile; recipe data is stored separately in D1

The active external recipe adapter uses [TheMealDB](https://www.themealdb.com/api.php). A small set of original local fallback recipes keeps the core flow usable offline. Unapproved source adapters remain unavailable. Recipe Commons is represented as a future license-aware import adapter.

## Run locally

Requirements: Node.js 22.13 or newer and pnpm.

```bash
pnpm install
pnpm run dev
```

Open <http://localhost:3000>.

On the first run, import the curated, prototype-approved catalog and precompute
its recipe vectors:

```bash
curl -X POST http://localhost:3000/api/admin/catalog
curl http://localhost:3000/api/admin/catalog
```

The catalog endpoint is available without a token only on localhost. Set
`CATALOG_ADMIN_TOKEN` before exposing the app anywhere else and send it as a
Bearer token for catalog status or sync requests.

The default AI provider is Ollama using `qwen3.5:9b` for generation and `nomic-embed-text` for embeddings. Start Ollama and make sure those models are installed. The app still returns deterministic pantry matches if the model or embedding endpoint is unavailable.

To use OpenAI, copy `.env.example` to `.env.local`, set `OPENAI_API_KEY`, restart the dev server, and select OpenAI in Settings. Keep provider keys server-side.

## Verify

```bash
pnpm run lint
pnpm test
```

`pnpm test` creates a production build and checks the rendered application shell.

## Source boundaries

The source interface lives behind `/api/recipes`. Approved source records,
normalized recipes, and model-versioned vectors are stored in D1; live source
fetching remains a migration fallback when the catalog is empty or unavailable.
Do not enable an adapter for content whose terms or license do not allow
persistent storage, indexing, and embedding. The built-in approval is scoped to
this local prototype and must be reviewed before a public launch.
