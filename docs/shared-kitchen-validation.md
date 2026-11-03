# Shared kitchen and assistant validation

Pre-commit review completed November 4, 2026. The automated review gates below
passed; final source and browser suites were rerun after the parser corrections. Hosted deployment and live external-provider
checks remain separate rollout gates.

Artifacts linked here are local, ignored test output; they are not part of a
fresh checkout. Tests used disposable application/D1 state and synthetic users.
Per-run model checks recorded unchanged original databases. The final whole-review
fingerprint did change: a separately running normal development app issued a
kitchen save while isolated browser tests used another port and disposable D1.
The originating browser action was not established. This report therefore makes
no whole-session unchanged-database claim; tests did not migrate the normal
database. [Local audit](../output/playwright/review-local-data-check.json).

## Review fixes

- Hosted search and technique references cannot bypass hosted source approval.
- Removing a member cancels their older pending invitations. Later OpenAI phases
  recheck membership and reject a deleted or replaced personal connection.
- Both assistant planning interfaces honor the household beta flag; ordinary
  manual planning remains available.
- Initial weeks use the household timezone, and date changes refresh promptly.
- Recovery merges use the recovered draft's original base, preserving newer
  independent family edits. This is covered in the real hook and both hosted
  browser modes on desktop/mobile.
- Conversational revisions reselect incompatible cuisine choices, preserve the
  order of pantry operations, distinguish operation-specific cancellation, and
  retain stable pending-batch choices across revisions.
- Apply checks the catalog revision inside the kitchen's atomic database write.
  Recipe, ingredient, instruction, metadata or source changes during validation
  reject the save with 409. Migration 0008 is required before using Apply.

- Count and priority phrases such as “a couple” and “with variety” no longer
  become recipe filters. An omitted model intent for an explicit dinner command
  uses the same validated planner, with guards for negation, cooking questions
  and taste feedback.

## Final automated checks

| Check | Result | Evidence |
| --- | --- | --- |
| Source tests | 563 passed, zero failures/skips | `pnpm test:source` |
| TypeScript and full ESLint | Passed | `pnpm typecheck`, `pnpm lint` |
| Isolated build and rendered shell | 2/2 passed | [Results](../output/playwright/integration-2026-11-03T23-36-37-691Z-e928b931/rendered-html.log) |
| Full desktop/mobile browser suite | 374 passed, 12 hosted-only skips, zero failures/flakes | [Results](../output/playwright/e2e-2026-11-03T23-36-32-883Z-4c9a277e/results.json) |
| Hosted built Worker, desktop/mobile | 12/12 passed | [Results](../output/playwright/hosted-2026-11-03T23-25-39-641Z-6f5b89be/results.json) |
| Hosted development server, desktop/mobile | 12/12 passed | [Results](../output/playwright/hosted-dev-2026-11-03T23-26-23-408Z-1fca2524/results.json) |
| Development server/HMR | 2/2 passed | [Results](../output/playwright/dev-2026-11-03T23-27-14-848Z-48233f5b/results.json) |
| Chromium offline and WebKit | 4/4 passed | [Results](../output/playwright/smoke-2026-11-03T23-27-32-986Z-e4795606/results.json) |
| Clean-install setup, desktop/mobile | 1/1 each | [Desktop](../output/playwright/clean-setup-2026-11-03T23-26-01-607Z-0bc61f89/results.json), [mobile](../output/playwright/clean-setup-2026-11-03T23-26-18-465Z-cd368ade/results.json) |
| Python recipe collectors | 19/19 passed | `pnpm recipes:test` |
| Real Ollama grounding | 8/8 passed, zero execution failures | [Results](../output/playwright/chef-2026-11-03T23-01-51-298Z-5494be06/grounding-results.json) |
| Clean frozen-lockfile install | Passed with a separate package store | `pnpm install --frozen-lockfile` |
| Publishable source scan and whitespace | No secrets found; passed | Gitleaks with redaction; `git diff --check` |

Hosted-only tests are skipped in the standalone runner and pass in both hosted
runners. Overlapping counts are not additive. The hosted harness uses real
Better Auth signed sessions and real database authorization, without a production
bypass. It covers scope changes, private storage cleanup, invitation expiry,
member removal, concurrent edits, task cancellation, duplicate Apply and stale
revisions. The catalog race checks exercise real SQLite commit boundaries. Isolated
desktop/mobile screenshots of Settings and the assistant were also inspected
for layout and control visibility.

The clean source export excluded local databases, environment files, credentials,
generated output and dependency caches. One scanner match was a synthetic signing
key used only for disposable test sessions; its exact line is annotated rather
than excluding the test file from scanning.

## Local-model assistant evaluation

The fixed evaluation contains **80 requests**: pantry and expanded planning each
have 20 development and 20 held-out cases. The model was `qwen3.5:9b` with digest
`6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`.

| Track | Development | Held out |
| --- | --- | --- |
| Pantry updates | 20/20 | 20/20 |
| Expanded planning | 20/20 | 19/20 |
| Combined | **40/40** | **39/40** |

Both held-out tracks exceeded the 90% threshold. The one held-out failure was an
unnecessary clarification for “Prepare one soup meal.” It remains counted as a
failure in that initial held-out result; the pre-commit regression below records
the subsequent deterministic fix. Development outputs informed parser/prompt changes; held-out outputs
were first inspected after development reached 20/20 in both tracks.

These evaluations call the canonical interpretation, planning, and draft/apply
validation code with real local structured inference. They exclude the HTTP,
authentication, Worker, and browser transport paths. The quality numbers do not
measure a deployed hosted assistant. The reports record zero kitchen writes,
unchanged input kitchens, and unchanged original catalog files. They are small
fixed synthetic evaluations, not general accuracy or allergy-safety estimates.

| Timing | Measured value |
| --- | --- |
| Development warm pipeline p95 | 7.341 seconds |
| Held-out warm pipeline p95 | 9.392 seconds |
| Separate cold request | 8.421 seconds |
| Model load within that cold request | 4.738 seconds |

The warm measurements are below 15 seconds **for this pipeline and machine**;
they do not establish the hosted end-to-end latency target. The cold probe used
a fresh, separate loopback Ollama daemon. Its process was stopped afterward;
the normal local daemon was unchanged.

The development report records `sourceUnchanged: false` because source files
changed during development. The held-out report records an unchanged source
snapshot. A later deterministic replay of the recorded model outputs retained
40/40 development and 39/40 held-out outcomes after independently discovered
unknown-topic, ingredient-qualifier, batch-target, editable-draft and conversational revision corrections.
That replay made zero model calls: it is regression
evidence, not a fresh independent model evaluation or a new latency result.
Further source changes require a matching fingerprint or new validation before
these artifacts can be called current.

Recorded artifacts:

- [Evaluation summary](../output/playwright/assistant-evaluation-summary.json)
- [Development model run](../output/playwright/assistant-development-final.json)
- [Held-out model run](../output/playwright/assistant-held-out.json)
- [Cold-start probe](../output/playwright/assistant-cold-start.json)
- [Development replay](../output/playwright/assistant-development-regression.json)
  and [held-out replay](../output/playwright/assistant-held-out-regression.json)

The fixed corpus digest is
`aaca58f14cb4e0cbe27ac3c9c3d4e830ef8e77989f5048f544a96a5b43b48264`;
the case digest is
`5d2581e3266e9311eaa839a2e863a15f69cf9591a24b69b419b478db0d0a64e5`.
The recorded replay source fingerprint is
`675357e5260cc1832cb6d5e985c3089717d97ce8acb241b25af29a6f88975586`.
Full per-case outputs and evaluated-module lists remain in the JSON reports.

## Fresh pre-commit model regression and final-code replay

Fresh `qwen3.5:9b` output passed all 80 fixed requests after the explicit-planning
fallback and main topic fixes. The development/held-out labels were already known:
this is regression evidence, not a new blind holdout. No model or prompt tuning
was performed during this run. The earlier [79/80 regression](../output/playwright/assistant-precommit-live.json)
remains retained as evidence of the unnecessary soup clarification before its fix.

| Track | Existing split | Fresh output | Final-code replay |
| --- | --- | --- | --- |
| pantry | development | 20/20 | 20/20 |
| pantry | held_out | 20/20 | 20/20 |
| expanded_planning | development | 20/20 | 20/20 |
| expanded_planning | held_out | 20/20 | 20/20 |

Warm pipeline p95 was **7.651 seconds** for the fresh run's
imported source snapshot. It excludes HTTP/authentication and browser transport,
and is not a cold-start measurement. The last priority-wording guard was edited
while that frozen imported snapshot was running, so its report correctly records
`sourceUnchanged: false`; the command exited nonzero for that workspace-drift
check, with all quality cases passing. This timing is not presented as a new
measurement of the last guard. Replaying every recorded output against the final source passed all
80 cases with zero model calls and an unchanged final source fingerprint:
`d5db75697c5613efe88dc5968d4b8ac0cad7ae3a0635a6dfa81e752bdd365e39`.

Both reports record unchanged kitchen inputs and original catalog files, with
zero kitchen writes. The final replay establishes deterministic regression
behavior; it does not supply another independent model or latency measurement.

[Fresh model report](../output/playwright/assistant-precommit-final.json) ·
[Final-code replay](../output/playwright/assistant-precommit-final-replay.json).

## Retained planning, cooking and retrieval regressions

The existing planning API corpus initially passed 38/40 cases. It exposed the
count/priority words incorrectly entering recipe filters. The corrected source
passes all 40 existing cases without changing the labels. These are regressions
on known cases, not a newly blinded evaluation.

| Check | Result | Evidence |
| --- | --- | --- |
| Legacy planning API | 40/40; all saved-constraint, quantity, shopping and no-write checks passed | [Results](../output/playwright/planning-2026-11-03T23-25-47-256Z-09f34462/planning-results.json) |
| Multi-turn Chef API journeys | 9/9 journeys, 24/24 answer turns, zero blocked turns or execution failures | [Results](../output/playwright/journeys-2026-11-03T23-29-43-522Z-0a1fde4f/journey-results.json) |
| Retrieval relevance | 80/80 in each semantic and forced-lexical mode; 20/20 legacy regressions; 7/7 guards | [Results](../output/playwright/final-model-regressions-2026-11-03T23-20-09Z-94aa6d78/relevance-results.json) |
| Factual-claim RAG | 40/40 covered; evidence recall and supported-claim acceptance 100%, unsupported-claim acceptance 0% in each split | [Results](../output/playwright/final-model-regressions-2026-11-03T23-20-09Z-94aa6d78/rag-results.json) |

Planning warm HTTP p95 was **7.049 seconds** over 35 samples, below the existing
15-second gate; its first model request was 6.825 seconds. Journey model-attempted
HTTP p95 was 10.032 seconds over 15 turns and includes its first turn. These are
local built-Worker API measurements, not hosted browser or external-provider
latency. All measured kitchen reads and catalog comparisons remained unchanged.

Relevance used 246 cached embeddings verified against the installed model digest;
it made no new embedding or chat calls. Source, labels and corpus fingerprints
match the checked checkout. Grounding, planning and journey reports identify
their exact evaluated snapshots. The last priority-phrase normalization followed
these API runs; it is covered by 48 parser combinations, complete draft/Apply
tests, the final 80-case replay, and the final full browser suite.

## Not exercised

- A real Google OAuth round trip with deployed callback URLs. Source tests
  validate OAuth initiation; browser tests use synthetic signed sessions.
- Browser-to-Ollama CORS and local-network permission behavior from an actual
  deployed HTTPS origin. Hosted browser inference transport uses controlled
  model output.
- A live OpenAI connection using a user's key. Tests use synthetic keys and do
  not send provider requests.
- A deployed shared-household beta, production D1 migration, or hosted
  end-to-end model latency.

These remain operator validation steps in the [hosted beta guide](hosted-beta.md).
New hosted households start with the assistant disabled until their owner
explicitly enables the beta. Manual kitchen controls remain available.
