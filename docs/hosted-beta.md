# Hosted family beta

The hosted application uses the same Workers/D1 application as standalone RAG Chef. It adds Google sign-in, one shared household per account, personal AI connections, and reviewed assistant actions. Hosted mode is opt-in; it must pass the release gates below before inviting families.

## Configure a deployment

Use a separate Cloudflare D1 database for the hosted application. Do not copy `.wrangler/state`, `.env.local`, kitchen backups, or the local recipe corpus into a deployment. The original starter recipes can be published by a platform administrator; any additional source requires a rights review for hosted distribution and its existing attribution/permission records.

Configure the real Worker name and D1 binding in `wrangler.jsonc` in your deployment checkout, replacing the placeholder database ID. The Vite configuration already enables `nodejs_compat`. Keep the binding named `DB` and the migration directory `drizzle`.

Set these non-secret Worker variables:

| Variable | Value |
| --- | --- |
| `RAG_CHEF_HOSTED` | `1` |
| `BETTER_AUTH_URL` | Exact HTTPS origin, without a trailing slash |
| `GOOGLE_CLIENT_ID` | Your Google OAuth web client ID |
| `HOUSEHOLD_OWNER_EMAILS` | Comma-separated verified emails admitted to create initial households |
| `PLATFORM_ADMIN_EMAILS` | Separate comma-separated catalog administrator emails |
| `HOSTED_RECIPE_SOURCE_IDS` | Optional comma-separated exact source IDs approved by the operator after hosted distribution rights review; empty enables only `rag-chef-starters` |
| `AI_CREDENTIALS_KEY_VERSION` | `v1` initially |

Set `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_SECRET`, and `AI_CREDENTIALS_ENCRYPTION_KEY_V1` through Cloudflare Worker secrets. The auth secret must have at least 32 characters; the credential key must be a base64-encoded, random 32-byte value. Generate independent values outside source control. Never use the synthetic secrets in the test harness for a deployment.

The hosted source gate applies to recipe text, metadata, embeddings, and catalog status in addition to each source's existing approval and permission flags. It uses exact lowercase source IDs, with no wildcards; removing an ID immediately hides that source from catalog reads and future assistant validation. `rag-chef-starters` contains the original MIT starter recipes and is the only default. To import reviewed Wikibooks recipes, first complete a hosted rights review and explicitly add `wikibooks`; source attribution and review hashes remain mandatory. TheMealDB's built-in approval is for a local prototype and cannot be promoted by the hosted sync endpoint. Hosted source sync and server embedding refresh are disabled; approved hosted imports use lexical retrieval without model calls.

Register the Google OAuth redirect URI as `https://YOUR_ORIGIN/api/auth/callback/google`. The application accepts only Google sign-in and verified emails. It does not require an email delivery service: owners copy invitation links for the named recipient. Invitations expire after seven days, can be cancelled, and can only be accepted by their verified email. Each account belongs to at most one household.

After configuring the target database and secrets, apply migrations to that hosted database, build, and deploy the generated Worker:

```bash
pnpm install --frozen-lockfile
pnpm exec wrangler d1 migrations apply DB --remote --config wrangler.jsonc
pnpm build
pnpm exec wrangler deploy --config dist/server/wrangler.json
```

These commands change the configured remote deployment. The repository's normal `pnpm db:migrate` and test commands use local or disposable databases instead. For a local hosted-mode check, use the isolated commands below; no real Google credentials are needed for those tests.

Upgrades must include `0008_catalog_apply_guard.sql` before using assistant or
planner Apply, in both standalone and hosted mode. Its catalog revision counter
changes in the same transaction as recipe text, quantities, metadata, or source
permissions. Apply captures the counter before validating its approved records
and checks it inside the kitchen save. A concurrent catalog change returns a
409 conflict and requires a new review. An installation missing the migration
gets a setup error; ordinary manual kitchen saves remain available. The counter
is catalog-wide, so an unrelated catalog edit can also require a fresh review.

## Household behavior

An admitted owner creates a kitchen and selects its timezone. Owners manage invitations, members, shared cooking requirements, and household deletion. Members edit pantry, dinners, and shopping. Shared requirements apply to every member's requests. The assistant beta is disabled for new households until the owner explicitly enables it in Settings after deployment validation.

Kitchen saves use a revision compare-and-swap and recheck live membership and session identity inside the write. Browser requests also assert the account and household from which they originated, so an old tab cannot write into a newer sign-in. The app polls revisions while visible and refreshes on focus. Independent edits can be merged; conflicting rows require a visible choice. Newly locked/cooked dinners remain protected during conflict recovery.

Browser backups, settings, cooking progress, navigation snapshots, and recovery drafts are scoped by account and household. Logout/removal clears that account's local and session storage and disables old storage writers. Hosted mode unregisters the standalone offline shell; authenticated HTML and API responses are not offline caches. The current tab keeps drafts and conversations only until it closes or signs out.

Kitchen backup import is explicit and reviewed. Owners can restore pantry/planning data; existing household feedback and assistant receipts remain authoritative. Credentials and recipe catalogs are not part of kitchen backups.

## Personal AI connections

### Browser Ollama

Use current desktop Chrome or Edge on the computer running Ollama. In Settings, connect to `http://127.0.0.1:11434`, choose an installed model, and run the structured-output test. Configure `OLLAMA_ORIGINS` with the exact hosted HTTPS origin and restart Ollama; allow local-network access when the browser requests it. Keep Ollama on loopback. No companion service, public port, or browser extension is required.

Local connection settings are saved for this account and browser only. Phones can use manual controls or their own OpenAI connection. Browser permissions, mixed-content behavior, CORS rejection, unavailable models, and cold starts must be checked against the real HTTPS origin; localhost test results do not establish production browser compatibility.

The server prepares bounded inference tasks and validates returned JSON against the original request and canonical sources. Each task is tied to its member, household, connection, revision, evidence/schema hashes, and five-minute expiry. Cancellation invalidates the workflow. A browser can fabricate output, so local evidence checks are labeled **Checked on this device**, never server-attested. They cannot authorize kitchen writes or create source facts.

### Browser LM Studio

On the computer running LM Studio, start its server in the **Developer** tab and
enable **CORS** in server settings. Keep it bound to loopback. In RAG Chef Settings,
select **LM Studio**, connect to `http://127.0.0.1:1234`, choose a model, then run
**Test and save local model**. Allow local-network access if the browser asks.

This browser connection supports an unauthenticated loopback LM Studio server.
If you require a token, use standalone mode with the server-side `LMSTUDIO_API_KEY`.
See [LM Studio server settings](https://lmstudio.ai/docs/developer/core/server/settings).
The connection is stored separately from Ollama for this account and browser.
Generation and verification run through that browser; the hosted server never
connects to your computer's loopback endpoint. Browser/HTTPS compatibility still
needs checking on the deployed origin, as with Ollama.

### OpenAI

Each member supplies their own key. It is encrypted using AES-GCM with account/provider/version binding; APIs return only configuration status and the last four characters. The application sends requests only to the fixed OpenAI Responses endpoint. Generation and the separate model-assisted evidence check use that same member's key. There is no hosted fallback to `OPENAI_API_KEY` or another member's credentials.

Testing and using the connection incurs usage on the member's OpenAI account. Replacement and deletion are available in Settings. For encryption rotation, add a new `AI_CREDENTIALS_ENCRYPTION_KEY_VN` secret and change `AI_CREDENTIALS_KEY_VERSION`; retain old keys until all records have been replaced/deleted or migrated. Losing an old encryption key requires the affected users to enter their API keys again.

Hosted retrieval uses keyword/BM25 and deterministic constraints without embedding calls or automatic paid indexing. Standalone semantic search remains available. Model output is never the authority for portions, stock allocation, shopping arithmetic, source identity, or household permissions.

## Assistant contracts

- `POST /api/assistant`: request or edited intent, selected week, household date, kitchen revision, and optional prior tab draft. Returns clarification, a `KitchenActionDraft`, or a local model task.
- `POST /api/ai/tasks/:id/result`: bounded structured model output plus the task token. Returns the next phase or the final reviewed draft/answer. Replays return the stored result; conflicting replay is rejected.
- `DELETE /api/ai/tasks/:id`: cancels the workflow using its token.
- `POST /api/assistant/apply`: independently revalidates the draft against current kitchen, membership, sources and quantities, then atomically saves with an action receipt. A repeated submission does not apply it again.
- `/api/chef`, `/api/chef/plan`, and `/api/chef/plan/apply` retain their existing manual and standalone interfaces. Hosted inference adds `ai: {provider: "openai" | "browser_ollama", model}`.

Combined requests calculate pantry changes first, then dinner changes and the complete week's shopping. Add, set remaining, subtract used, remove stock, and entered use-by dates are separate operations. Ambiguous batches and incompatible quantities require review. Cuisine/ingredient/dish planning stays within the approved catalog. Taste feedback is explicit, attributed, reversible, and ranks after mandatory constraints and planning priorities.

Temporary task records contain the bounded request and intermediate outputs for resumable inference. They are not shared conversations or kitchen writes. Expired records are deleted on subsequent AI-task traffic; household/account deletion removes associated records. No keys, queries, pantry values, or generated answers belong in telemetry.

## Verification and release gates

```bash
pnpm test:source
pnpm typecheck
pnpm lint
pnpm test:integration
pnpm test:e2e
pnpm test:hosted
pnpm test:hosted-dev
pnpm test:smoke
```

The hosted harness creates synthetic signed sessions and disposable D1 data. It does not bypass application authorization or use real keys. The model transport is mocked where deterministic browser coverage is required. Tests cover isolated households, invites, member removal, personal keys, task replay/cancellation, exact preview/Apply, repeated saves, stale revisions, and account-switch storage cleanup.

Before enabling a deployed beta, complete a real Google sign-in round trip, real HTTPS browser-to-Ollama permission/CORS checks, and an explicitly selected user's live OpenAI connection test. These cannot be established by synthetic credentials. Run fresh development and held-out pantry/planning evaluations (at least 90% per split, zero saved-constraint violations), retain grounding regressions, and report model-specific warm p95 and cold starts separately. Keep manual controls available if any AI connection fails.

Deployment secrets, a production URL, and live provider access are operator configuration, not bundled application data. Test results and remaining release gates are recorded separately from this setup guide.

See the [implementation validation report](shared-kitchen-validation.md) for the
completed checks, model evaluation limits, and remaining deployment tests.
