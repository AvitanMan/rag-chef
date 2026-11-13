# Hosted households

Hosted mode adds Google sign-in, one household per account, shared pantry and
planning, owner-managed invitations, and account-scoped browser recovery. It is
opt-in. The default local application keeps its existing pantry, stocktake,
shopping, cooking, model configuration, and revision-conflict behavior.

This integration selectively reuses the auth and household work from
`codex/planning-assistant`. It does not include the planner/assistant actions,
personal AI connections, browser inference tasks, or LAN launchers from that
branch. Hosted Chef supports deterministic answers and source/catalog fallbacks;
hosted requests never use the operator's local models or server AI credentials.

## Configuration

Use a separate D1 database for a hosted installation. Keep the binding name `DB`.
Apply all migrations, including `0005_households_auth.sql`,
`0006_kitchen_command_receipts.sql`, `0007_catalog_jobs.sql` and
`0008_runtime_admission.sql` and `0009_catalog_job_recipe_receipts.sql`, to the intended database before enabling
hosted mode. The authentication migration adds authentication and
household tables without modifying existing `local-household` kitchen state.
Local data is not automatically assigned to a signed-in household.
The command migration adds durable retry receipts for both local and hosted
kitchens; it does not change existing pantry or stocktake data. The catalog job
migration adds background-work records without changing kitchen data. The runtime
admission migration adds provider leases and household Chef usage counters.

This migration follows this branch's `0000`–`0004` history. A database previously
migrated with the older planning-assistant beta's `0006`–`0008` history needs
separate migration reconciliation; use a fresh hosted database for this stage.

| Setting | Purpose |
| --- | --- |
| `RAG_CHEF_HOSTED=1` | Enable hosted access checks and the sign-in gate |
| `BETTER_AUTH_URL` | Exact public HTTPS origin, without a trailing slash; HTTP loopback is allowed for tests |
| `BETTER_AUTH_SECRET` | Independent secret of at least 32 characters |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth web-client configuration |
| `HOUSEHOLD_OWNER_EMAILS` | Comma-separated verified accounts allowed to create a household |
| `PLATFORM_ADMIN_EMAILS` | Separate comma-separated catalog operators |
| `HOSTED_RECIPE_SOURCE_IDS` | Optional exact source IDs approved for hosted distribution |
| `CHEF_HOSTED_REQUESTS_PER_MINUTE` / `CHEF_HOSTED_REQUESTS_PER_DAY` | Positive household Chef request limits; defaults 60 / 1,000 |
| `MODEL_OLLAMA_CONCURRENCY` / `MODEL_OPENAI_CONCURRENCY` | Shared provider pool limits; defaults 2 / 4, hosted model use remains disabled |
| `SERVICE_RELEASE` | Matching immutable non-secret release label on all three Workers |

Register `https://YOUR_ORIGIN/api/auth/callback/google` as the Google callback.
Configure secrets outside source control. The repository's Worker/D1 identifiers
are placeholders; this integration does not provision or deploy a hosted system.
Do not copy personal `.wrangler/state`, local environment files, or recipe runs
into a hosted installation. Test fixtures contain synthetic identities only.

Original `rag-chef-starters` recipes are the only default hosted source. Other
source IDs require explicit hosted approval in addition to the existing source
permissions. Catalog administration requires a signed-in platform administrator;
the standalone catalog token is not a hosted authentication mechanism. Hosted
source sync and server embedding requests remain disabled. Hosted search uses
text retrieval and pantry ranking.

Stage 4 adds a private Catalog Worker, configured in `wrangler.catalog.jsonc`.
Bind the application Worker's `CATALOG` service to it and `CATALOG_TASKS` to its
job queue. Stage 5 also binds `CHEF` to the private Chef Worker in
`wrangler.chef.jsonc`; that Worker has its own `CATALOG` binding. All three Workers
must use the same hosted `DB` and consistent
`RAG_CHEF_HOSTED`, `PLATFORM_ADMIN_EMAILS`, `HOSTED_RECIPE_SOURCE_IDS`, admission
limits and release label settings.
The Catalog and Chef Workers must not expose public Workers.dev or preview URLs.
The Catalog Worker's
queue consumer processes accepted work, and its recovery cron finds pending
jobs if delivery or an earlier worker failed. See
[service boundaries](service-boundaries.md#catalog-deployment-and-background-work)
for the job API and deployment contract.

Stage 6 counts admitted Chef answer requests per household in fixed UTC minute
and day windows, including deterministic answers and later processing failures.
The allowance is shared by household members, is not token billing, and does not
enable AI connections. Exhaustion returns 429 with `Retry-After`; invalid limit
configuration fails closed. Use the protected `/api/admin/services` readiness
check and the [rollout runbook](service-rollout.md) before routing traffic to a
release. Readiness checks no model providers and compares all three Workers'
schema, bindings, release label, policy and limits. Deploying a mixed older
release cannot guarantee these controls.

Chef rechecks the server-derived household/session context before processing and
before returning an answer. It reads current kitchen state through a read-only
application port, preserving stale dinner/step checks across the service call.
The shared D1 binding is still capable of database writes; the port enforces
application ownership rather than database-level isolation. Cookies and bearer
tokens stay at the gateway; Chef receives an internal session identifier.
Hosted Chef and readiness still report that AI connections are unavailable.
Generation keys belong only on the Chef Worker for standalone use, while Catalog
needs embedding settings only. This split does not enable shared hosted AI.

Starter setup and reviewed recipe imports now return an accepted job and a status
URL. The UI waits for completion. Enqueue, status access and every background
write retain platform-administrator checks; removing that access prevents later
writes. A previously approved source that an operator disables stays disabled,
even when an older queued import or setup job runs. Metadata review remains
synchronous. None of these jobs reads or changes a household kitchen.

## Access and recovery

An admitted owner creates a household and selects its timezone. Invitations are
copied links addressed to a verified email; the app does not send email. They
expire after seven days and can be cancelled. Removing a member also revokes
their outstanding invitation links. Household membership is limited to twenty
accounts. Members can edit pantry, dinners, and shopping; owners manage shared
cooking requirements, membership, and household deletion.

The server derives the household from the authenticated session. Kitchen writes
check the revision, live session, membership, role, and household settings in the
same SQL statement. Requests from an old account/household view are rejected.
Current whole-snapshot conflict/recovery choices remain in place, preserving
pantry deductions, shopping receipts, and stocktake safeguards.

Browser drafts, cooking progress, and preferences are scoped by account and
household. Sign-out or detected account/membership changes clear the previous
account's storage and revoke its old writers. Hosted pages and APIs are not
offline caches; the standalone service worker is disabled in hosted mode.

## Verification

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm test:hosted
pnpm test:hosted-dev
pnpm test:e2e --grep 'pantry|stocktake'
```

The hosted runners create disposable migrated databases and signed test sessions.
They cover authentication, separate households, membership removal, owner/member
permissions, invitations, browser account changes, and pantry workflows. Source
tests also cover atomic authorization races and preservation of local state.
These checks do not exercise real Google OAuth or establish production readiness.
Real OAuth callback/cookie behavior and deployment configuration must be verified
against the intended HTTPS origin before inviting users.
