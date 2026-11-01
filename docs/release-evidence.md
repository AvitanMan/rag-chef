# v0.2.0 release evidence

Evaluated locally on November 1, 2026, using `qwen3.5:9b` and
`nomic-embed-text`. The application is commit
`e1b10f47d3cdd4573993c55b73f9bb07c12b1fff`;
the grading implementation is commit
`d92e8058ea75ba838e946517138813485ac983e5`.
Later presentation and CI configuration changes do not alter these application files.

## Application checks

| Check | Result |
| --- | --- |
| Source, SQL, hook, and route tests | 308 passed |
| Desktop/mobile Chromium regression suite | 270 passed, zero skipped or flaky |
| Focused missing-nutrition browser regression after the final source change | 2 passed |
| Fresh-installation dinner flow | Desktop and mobile passed |
| Actual service-worker offline reload/timer recovery and shopping copy/print | Chromium and WebKit: 4 passed |
| Python recipe collector | 19 passed |
| Type checking, lint, isolated build/render | Passed |
| Fresh dependency install, migrations, source/build and setup/offline checks | Passed with a separate package store and no copied dependency tree |
| Publication tree and Git history secret scans | No findings; private configuration and local state excluded |

The offline checks found and fixed a WebKit startup gap: shell caching now uses a
build-generated asset list rather than relying on Resource Timing entries.
Engine automation does not certify physical Safari devices or OS alarm behavior.

## Real-model findings

| Evaluation | Result and scope |
| --- | --- |
| Held-out retrieval/claim checks | Recall 10/10; supported acceptance 10/10; false acceptance 0/10 |
| Complete retrieval/claim check set | 40/40 cases; development, held-out, and aggregate gates passed |
| Grounding contracts | 8/8 passed |
| Useful source answers/corrections | 4/5; one wrong-step-premise guard explicitly withheld |
| Correct missing-information responses | 3/3 |
| Full API journeys | 9/9 journeys; 24/24 turns |
| Kitchen writes during Chef turns | 24/24 unchanged |
| Journey generated-response latency | median 6.08 s; p95 8.63 s on this Mac |

The grounding guard permits withholding when the model draft cannot be verified.
It counts as a passed safety contract and remains excluded from useful answers.
These fixed synthetic cases do not establish general cooking accuracy, nutrition
correctness, or allergy safety. [Methodology](evaluation.md) describes the labels,
held-out gates, denominators, and limitations.

## Reproducibility

RAG source fingerprint: `0f4b507eb021bb5b77b511026c8b5fa10e7f3f5d2ca08748a57232b6cff5a10f`.
RAG evaluator fingerprint: `f9162ea67bf79d3e5498bd3dbb3c634cc653c99ed8857a625adbde8a00187080`.

Chat model digest: `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`.
Grounding application fingerprint: `ba64bfba1b49f2a0a248116fed0459b8548b53b5e7e4eb636920f08cd0979dd0`.
Grounding evaluator fingerprint: `29e112208dd5a363bea35bb012684639da8dfe011fb9e67f540a87925e99c6c7`.
Journey application fingerprint: `87d1700febda02957499ad218562cbcfd8528023140791887ec7632d4538a011`.
Journey evaluator fingerprint: `b63e00247bec82706ec8c8e3b427c4ab19acca66ba04fea058951f721615ec42`.

The evaluators hash different documented file sets, so their application hashes
need not equal one another. Each was recomputed against the final files before
publication. Full synthetic reports are attached to the
[v0.2.0 release](https://github.com/AvitanMan/rag-chef/releases/tag/v0.2.0).
Personal recipes, kitchen snapshots, configuration and keys are excluded.
