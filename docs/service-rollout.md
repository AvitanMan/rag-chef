# Service rollout and rollback

Treat the application gateway, private Catalog Worker and private Chef Worker as
one release. They have separate runtime responsibilities but share D1. This
runbook describes operator actions; the repository changes do not provision,
publish or migrate a production installation.

## Record and verify a candidate

Record the source commit, all three Worker artifact/version identifiers, intended
D1 database and migration state, queue name, and previous known-good release.
Set the same immutable `SERVICE_RELEASE` label on all three Workers. Keep secrets
in the deployment secret store; the release record should reference their
configuration rather than copy secret values.

Hosted readiness requires an explicit release label. Standalone development
defaults to `development` when the label is omitted.

The checked-in `service-contracts.json` requires protocol 1, controls 1 and schema
9 (`0009_catalog_job_recipe_receipts`). The source and build checks validate the three
configurations, shared database/queue bindings, private service routes and
cancellation flags. They never deploy code or inspect production data.

```bash
pnpm install --frozen-lockfile
pnpm services:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm services:check:build
```

Run the isolated browser gates for the candidate: `pnpm test:e2e`,
`pnpm test:hosted`, `pnpm test:hosted-dev`, `pnpm test:setup`,
`pnpm test:dev` and `pnpm test:smoke`. These use disposable databases and synthetic
fixtures. They do not establish real OAuth callbacks, provider quality or the
correctness of production configuration.

Check the intended deployment settings before opening traffic:

- `DB` points to the same intended database on all three Workers. A hosted
  installation uses a separate database from personal standalone use.
- Gateway `CATALOG` and `CHEF` bindings point to the matching private releases;
  Chef has its own matching `CATALOG` binding. Catalog and the gateway publish
  to the same `CATALOG_TASKS` queue; only Catalog consumes it and runs recovery.
- Catalog and Chef expose no public routes, Workers.dev URLs or preview URLs.
  All three retain `nodejs_compat` and `enable_request_signal` exactly once.
- Hosted mode, approved source IDs, platform administrators, admission policy
  and `SERVICE_RELEASE` agree. Keep `OLLAMA_EMBED_MODEL` identical on all three.
  Generation/verifier credentials belong on Chef; Catalog needs embedding
  settings only. Hosted requests still cannot use operator model credentials.
- Provider limits are positive integers from 1 to 100. Defaults are two Ollama
  operations and four OpenAI operations across Chef and Catalog. Hosted request
  windows default to 60 per minute and 1,000 per day; blank standalone windows
  are disabled. Zero is invalid. See [.env.example](../.env.example).

## Deploy without a mixed active release

1. Use a staging installation or pause public traffic and new catalog submissions.
   Quiesce queue delivery and scheduled recovery during the release switch, and
   let current operations finish. A model callback is bounded to five minutes;
   a whole Chef request may last twenty minutes and a catalog attempt twelve
   minutes. An expired job lease alone does not prove its old provider request
   has stopped. Preserve queued D1 jobs and their identities.
2. Back up the intended D1 database, including kitchens, command receipts, catalog
   jobs, recipe-write receipts, source permissions and admission tables. Apply the additive migrations
   once through `0009_catalog_job_recipe_receipts.sql` to that database. Do not copy local
   personal state into hosted storage or reset the migration journal.
   Migration 0009 marks previously attempted, unfinished recipe-writing jobs as
   `CATALOG_REVIEW_REQUIRED`: older attempts cannot prove which recipe writes
   already committed. Their payloads and progress remain available for review
   and explicit resubmission with a new request ID. Never-started jobs and jobs
   that only build embeddings can continue normally.
3. Deploy the matching private Catalog Worker, then the matching private Chef
   Worker, then the gateway. Use the candidate's generated configurations and
   deployment secret settings. Keep external traffic closed during this switch.
4. As a catalog operator, call `GET /api/admin/services` through the gateway.
   Standalone access uses the existing loopback/admin-token policy; hosted access
   requires a signed-in platform administrator. Require HTTP 200 and `ok: true`
   with all three services on the intended release. Never put an admin token in
   a URL or paste it into release logs.
5. Run a controlled smoke check: kitchen command save/replay and snapshot
   conflict behavior, catalog reads and an approved background job, Chef context
   staleness, and hosted deterministic answers with no provider calls. Verify
   real OAuth callbacks on the intended HTTPS origin when enabling hosted mode.
6. Resume queue delivery/recovery and public traffic. Watch request/job IDs,
   stage durations, admission rejection rates and queued/failed jobs. Confirm
   work progresses without repeated paid requests or duplicate kitchen edits.

Readiness makes no model calls. It checks required schema columns and bindings
and compares the three Workers' protocol, controls, release label, hosted/source
scope and admission limits. It has a short bounded deadline. A 503 is a failed
deployment gate, even when the landing page renders. It does not verify model
reachability, queue delivery, real OAuth or that an operator labeled artifacts
correctly; retain the recorded version identifiers and smoke checks.

Private compatibility headers reject unsupported results. They cannot make old
Worker code enforce new limits, and an old Worker may do work before the caller
rejects its response. Therefore the private-first deployment order, paused traffic
and readiness gate are required; binding a new gateway to an old private Worker
is not a supported rollback strategy.

## Roll back the application release

1. Pause traffic, catalog submissions, queue consumption and scheduled recovery.
   Record the failing release and request/job IDs without copying kitchen or
   prompt contents. Wait for in-flight operations to stop or reach their bounded
   deadlines before switching implementations.
2. Restore the previous known-good **matched set** of Catalog, Chef and gateway
   artifacts and their matching settings. Restore private services first and
   gateway last while traffic remains paused. Do not combine a newer gateway
   with older private controls.
3. Keep the additive schema, command receipts, recipe-write receipts, jobs and existing data. A code
   rollback is not a database restore. Removing receipt or job records can make
   old retries execute again; restoring only one table can disconnect pantry
   state from its retry receipts. Database disaster recovery requires a coherent
   backup and a separate reconciliation plan.
4. Run the previous release's readiness and smoke gates before reopening traffic.
   A release older than controls version 1 cannot guarantee the new provider or
   household limits. Treat such a downgrade as an explicit operator decision
   under paused traffic, not a compatibility-checked rollback.
   A release older than schema 9 does not honor recipe-write receipts: do not
   resume partially completed Catalog jobs on it, because a replay can overwrite
   a newer recipe review. Keep those jobs paused until a compatible release runs.
5. Resume jobs using their existing D1 identities. Do not rewrite idempotency keys
   or automatically replay interactive Chef answers. A lost answer may already
   have incurred provider cost.

Do not clear live permit rows to force capacity. The provider lease is six
minutes and expires after its at-most-five-minute admitted operation; a release
failure can conservatively reserve capacity until expiry. `429 service_busy`
and `429 usage_limit_exceeded` include `Retry-After`; invalid policy or unavailable
admission storage fails closed. Background jobs use the busy delay within their
bounded retry policy, while interactive generation has no automatic retry.

Permits bound the application's active requests. Cancelling HTTP does not prove
that a remote provider has stopped inference or that it will waive the cost.
