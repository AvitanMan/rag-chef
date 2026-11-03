# Evaluation and release evidence

RAG Chef separates application behavior, retrieval relevance, source support,
and answer usefulness. A passing browser suite does not measure real-model
accuracy. A safely withheld answer does not count as a useful answer.

All model evaluations below use local Ollama. They do not select a paid cloud
provider. Install the configured chat model and `nomic-embed-text` before running
them. The default chat model is `qwen3.5:9b`; reports record its installed digest.

## What each check measures

| Check | Scope | Passing result means |
| --- | --- | --- |
| `pnpm test` | Source, SQL, hooks, and a disposable built app | Deterministic contracts and rendering pass |
| `pnpm test:e2e` | Desktop/mobile Chromium with synthetic recipes and a model stub | Browser journeys and failure/recovery behavior pass |
| `pnpm test:setup` | Empty disposable databases on desktop/mobile | Starter setup, retry, and dinner selection need no AI |
| `pnpm test:smoke` | Chromium and WebKit with actual service workers | Offline reload/timer recovery and shopping copy/print behavior |
| `pnpm recipes:test` | Python recipe collector | Parsing and import contracts pass |
| `pnpm recipes:grounding-eval` | Eight fixed real-model/source checks | All expected answer, uncertainty, and guard contracts pass; useful answers and withholding are reported separately |
| `pnpm recipes:rag-eval` | Forty synthetic retrieval/claim cases | Complete development and held-out splits independently meet retrieval and verification thresholds |
| `pnpm recipes:journey-eval` | Nine fixed API journeys, 24 Chef turns | Full journey expectations, latency budget, and unchanged-data checks pass |
| `pnpm recipes:relevance-eval` | Frozen 166-recipe corpus; 40 calibration and 40 held-out queries, plus 20 retrieval regressions | Deployed ranking and abstention behavior meet the fixed labels in both semantic and forced-lexical modes |

GitHub Actions runs the first three categories, type checking, and lint. It uses
no downloaded model or personal database. Run the real-model checks against the
release candidate separately and attach their reports to release evidence.

## Source answering and safe withholding

```bash
pnpm recipes:grounding-eval
# Optional installed local model:
pnpm recipes:grounding-eval --model qwen3.5:9b
```

The runner builds a disposable app, migrates an isolated database, and seeds
original synthetic recipes. Its eight checks comprise:

- Four answerable questions: step duration, oven temperature, doneness, and an
  attributed explanation of a cooking term.
- Three correct refusals or uncertainty responses: absent nutrition, an unknown
  whole-recipe duration, and an unstated duration for a particular step.
- One wrong-step-premise guard. A checked correction passes. Explicitly
  withholding the draft also passes this guard when the canonical step remains
  visible and the verifier rejected the draft.

Reports distinguish `checks`, `usefulAnswers`, `correctRefusals`, `guardChecks`,
`withheldAnswers`, and `executionFailures`. The useful-answer denominator is five:
the four answerable questions plus the guard question, which could receive a
useful correction. If that guard withholds, a run can pass all eight contracts
while providing only four of five useful answers. Report both numbers. Do not
describe that result as eight correct generated answers.

Expected uncertainty responses are counted as correct refusals even when the API
labels a factual statement of uncertainty `answered`. Unexpected withholding,
timeouts, missing results, malformed evidence, and other failed contracts fail
the suite. A guard's permitted withholding never raises the useful-answer count.

The result is saved under
`output/playwright/chef-*/grounding-results.json`. Report version 2 includes model
and corpus digests, exact evidence, per-call timings, complete case coverage, and
source/evaluator fingerprints. The source manifest covers app, database, worker,
build and migration files plus package/runtime configuration. Each manifest hashes
both paths and contents; README-only edits do not alter that source fingerprint.
The evaluator fingerprint includes the fixtures, grading code, and isolated
runner. These are small fixed checks, not a general culinary benchmark.

## Retrieval and factual-claim verification

```bash
pnpm recipes:rag-eval
# Save a named release-candidate result:
pnpm recipes:rag-eval --report output/playwright/release-rag-quality.json
```

There are 40 original synthetic cases: 20 development and 20 held-out, with ten
supported and ten unsupported claims in each split. Recipes are disjoint across
splits. The evaluator supplies fixed claims; it measures evidence selection and
claim verification, rather than end-to-end answer generation.

Every expected case must occur once, with its original split and support label.
Missing, duplicated, unexpected, relabeled, or incomplete results fail coverage.
Development, held-out, and aggregate results must each meet:

- Evidence recall@6 of at least 90% on supported cases.
- Supported-answer acceptance of at least 90%.
- Unsupported-claim acceptance of at most 5%.

With only ten unsupported claims per split, accepting even one false claim fails
that split: 1/10 is 10%. Strong development results cannot hide a held-out
regression. Percentages from these small samples should not be generalized to
all recipes or user questions.

The report compares with the retained lexical evidence selector and numeric-only
guard. It records model/embedding digests, source and label hashes, evaluator
fingerprints, selected evidence, context size, and median/p95 verification time.
The default output is `output/playwright/rag-quality.json`; vector caches remain
local in `work/`.

## Complete user journeys and latency

```bash
pnpm recipes:journey-eval
pnpm recipes:journey-eval --model qwen3.5:9b --latency-budget-ms 60000
# Optional read-only snapshot of the installed catalog:
pnpm recipes:journey-eval --catalog local
# Diagnosis only; a subset is not full-suite release evidence:
pnpm recipes:journey-eval --journey stock-reservations
```

Nine journeys carry real answers and recipe/dinner identities through 24 Chef
turns. Fixed expectations cover exclusions, stock preparation and quantities,
reservations, expiry, recipe follow-ups, portion changes, source facts, cooking
help, ambiguity, and stale context. Exact evidence and server-calculated amounts
are checked independently of generation. The application's model-assisted
verifier is one signal, not an independent semantic judge.

Journey report version 3 accepts up to three lentil recipes when their canonical
ingredients match the request, then explicitly selects a recipe before its
factual follow-up. Ambiguous follow-ups are tested separately. Exact citations
cover original ingredients (`I#`), directions (`S#`), and source notes (`N#`).

The report includes quality and latency gates, complete/subset status, model,
catalog, application and evaluator fingerprints, answers, and failed checks.
Failed, blocked, timed-out, or withheld turns never count as useful passes.
Calculated quantity answers must make zero generation or verification calls.

Latency excludes setup and embedding refresh and includes the first cold response.
Large event-loop gaps mark timing unreliable and fail the latency gate. Keep the
host awake and avoid running competing model evaluations while comparing speed.
The default generated-response p95 budget is 60 seconds; passing that budget is
not a claim that the experience feels instant.

Outputs are `output/playwright/journeys-*/journey-results.json` and
`journey-report.md`, with source/canonical-response records alongside them.
The optional local-catalog track snapshots SQLite read-only, substitutes a test
kitchen, and compares the original application tables and schemas before and
after. D1's internal read-bookmark counter is excluded from that comparison. It requires the
documented fixed Zucchini Pasta Bake and Red Lentil Soup facts; source drift stops
the evaluation instead of silently rewriting expected answers.

## Catalog relevance

```bash
pnpm recipes:relevance-eval
# Explicit experiment; does not rewrite production thresholds:
pnpm recipes:relevance-eval --calibrate --report output/playwright/candidate-relevance.json
```

Normal verification uses deployed thresholds and the production shortlist
selector. Calibration uses only its fixed calibration split. Held-out labels
never select thresholds. Both semantic and forced-lexical modes must meet 95%
retention and abstention gates, preserve exclusions, and rank exact title matches
first. The 20 older retrieval cases also remain regression checks.

Precision uses non-exhaustive acceptable-title labels and excludes broad queries;
an unlisted returned title incurs a penalty. This is **candidate-context
precision**, not generated-answer accuracy or dietary suitability. Preserve
corpus, label and model compatibility when comparing reports; `--baseline PATH`
checks those conditions and records non-regression results.

The attributed corpus is a test fixture, not an application seed. See
[NOTICE](../NOTICE) for source terms.

## Conversational dinner planning

```bash
pnpm recipes:planning-eval
pnpm recipes:planning-eval --model qwen3.5:9b
```

Planning and RAG regression evaluations accept `OLLAMA_BASE_URL` for a separate
loopback Ollama server. The default is `http://127.0.0.1:11434`.

This isolated track exercises `POST /api/chef/plan` against synthetic recipes and
kitchen state with the real local model. Forty fixed requests are divided into
20 development and 20 held-out cases. Both splits require at least 18 correct
outcomes, with zero saved-constraint violations, changes to protected dinners,
or writes during preview. An unnecessary clarification fails an answerable case.
The report independently recalculates the full-week shopping preview and checks
recipe identity and the interpreted request against fixed expectations.

The latency target is warm end-to-end p95 below 15 seconds. The first model request
is reported separately; setup and embedding refresh are excluded. Results include
model, corpus, source and evaluator fingerprints in
`output/playwright/planning-*/planning-results.json`. These small fixed cases are
not a general natural-language accuracy benchmark. Source and browser tests
separately cover Apply, cancellation, stale revisions and duplicate submissions.

### Planning implementation check — November 3, 2026

The first valid local-model run passed 20/20 development and 19/20 held-out
requests, with no safety or preview-write failures. The missed case lost the
count in “two gluten-free dinners”; the explicit count parser was corrected and
covered with a regression test. Subsequent runs are regression evidence: the
held-out labels had already been inspected, so they are not new independent
accuracy estimates.

The reviewed planning change passed all 40 fixed requests with `qwen3.5:9b`:
36 successful model requests, 5.889-second warm p95, and a 7.631-second first
request after unloading the model. No preview writes or saved-constraint
violations occurred; the disposable kitchen and catalog stayed unchanged.
The evaluator checks expected dates independently and requires a proposal when
eligible choices exist. A no-choice draft passes only when the catalog has no
eligible dinner and every omitted date has an explanation.

Validation of the scoped commit candidate: 468 source tests; type checking and
lint; isolated build/render checks; 179 desktop and 179 mobile browser checks
(including 30 planning checks); four WebKit/offline checks; two fresh-install
checks; and two development/HMR checks. The real-model retrieval/claim regression
also passed all 40 fixed cases, with zero unsupported claims accepted. Earlier
unrelated cooking/timer edits were excluded from this candidate.

The final planning report is saved locally under
`output/playwright/planning-2026-11-03T19-43-34-964Z/planning-results.json`;
its runtime and evaluator fingerprints match the staged source. The grounding
report is `output/playwright/planning-review-rag.json`. These model runs used a
separate loopback test daemon via `OLLAMA_BASE_URL`, with the installed model
files. The initial held-out result remains under
`output/playwright/planning-2026-11-03T19-07-18-549Z/planning-results.json`.

## Preparing release evidence

Run the deterministic checks first, then run each real-model suite sequentially
against the completed candidate. Preserve the full reports and publish a concise
summary with the exact revision, model digest, corpus, metric denominators,
failures/withholding, and latency. Compare source and evaluator fingerprints with
the candidate before calling a report current. Older reports without the required
fingerprints are historical observations.

Use the synthetic tracks for shareable evidence. Personal kitchen snapshots,
configuration, local-catalog copies, and provider keys remain private and ignored.
No result here certifies culinary correctness, nutrition, allergy safety, or
performance on a different machine.
