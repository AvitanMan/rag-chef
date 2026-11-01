# Contributing

Use Node 22 and the pnpm version pinned in `package.json`. Follow the README's
fresh-install instructions, then work on a focused branch with a clear before
and after behavior.

## Check a change

Run `pnpm typecheck`, `pnpm lint`, and `pnpm test`. For browser behavior, install
Chromium and WebKit with `pnpm exec playwright install chromium webkit`, then run `pnpm test:e2e` and `pnpm test:smoke`.
Setup changes also need `pnpm test:setup`, which starts with an empty disposable
database. Collector changes need the Python environment described in the guide
and `pnpm recipes:test`.

Development-server and theme changes need `pnpm test:dev`. It checks the actual
development app with connected and unavailable HMR sockets, including browser
error handling and theme persistence. It uses its own database and port.

Add tests for behavior that could regress, including failure and recovery paths.
Keep small presentation changes easy to review with screenshots. The test runner
uses isolated project/database copies; do not point browser tests at a personal
kitchen on port 3000.

For RAG changes, use the relevant real-model evaluations in
[docs/evaluation.md](docs/evaluation.md). Report model and code fingerprints,
denominators, withholding, and failures. Do not tune against held-out labels or
present provider-mocked checks as evidence of model quality.

## Source and data rules

Preserve deterministic exclusions, source wording and attribution, explicit
quantity uncertainty, revision conflicts, and recovery. Changes suggested by a
model must remain separate from saved recipe and kitchen facts.

Use original synthetic data in tests and demonstrations. Add sources only after
reviewing the permissions for display, storage, indexing, embedding and reuse.
Keep source notices attached to imported text. Never include keys, local
databases, private recipe runs, or personal kitchen backups in a PR.

## Pull requests

Describe the user-visible problem, resulting behavior, verification performed,
and any remaining limitations. Keep unrelated work separate. Include screenshots
for UI changes and source provenance for new content. All required checks must
pass before merge.
