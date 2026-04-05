# Story 7.3: E2E CI Workflow

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a developer,
I want a GitHub Actions workflow that runs e2e and integration tests on-demand and on release tags,
so that every release is validated beyond unit tests before assets are published.

## Acceptance Criteria

1. **Given** `.github/workflows/e2e.yml` exists, **When** triggered manually (`workflow_dispatch`) or on push of a `v*` tag, **Then** it compiles the binary, runs `bun test src/__e2e__/`, and reports results.
2. **Given** `PROTON_TEST_USER` and `PROTON_TEST_PASS` are configured as GitHub Actions secrets, **When** `e2e.yml` runs on a `v*` tag, **Then** it also runs `bun test src/__integration__/` and blocks the workflow on failure.
3. **Given** the existing `ci.yml`, **When** a PR is opened, **Then** `ci.yml` continues to run only `bun test` (unit tests) — no change to PR gate behavior.
4. **Given** `e2e.yml`, **When** `bun test src/__e2e__/` or `bun test src/__integration__/` fails, **Then** the workflow exits non-zero and the failure is visible in the Actions tab.

## Tasks / Subtasks

- [x] Write workflow structure tests (AC: 1, 2, 3, 4)
  - [x] Create `src/__e2e__/workflow.test.ts` — parse and assert on `.github/workflows/e2e.yml` and `.github/workflows/ci.yml`
  - [x] Assert `e2e.yml` has `workflow_dispatch` trigger
  - [x] Assert `e2e.yml` has `push.tags` trigger matching `v*`
  - [x] Assert `e2e.yml` has step that runs `bun test src/__e2e__/`
  - [x] Assert `e2e.yml` integration test step passes `PROTON_TEST_USER` and `PROTON_TEST_PASS` env vars from secrets
  - [x] Assert `e2e.yml` integration test step only runs on tag-push event
  - [x] Assert `ci.yml` does NOT contain `src/__integration__/` (PR gate unchanged)
- [x] Create `.github/workflows/e2e.yml` (AC: 1, 2, 4)
  - [x] Triggers: `workflow_dispatch` and `push.tags: ['v*']`
  - [x] Runner: `ubuntu-latest`
  - [x] Pin `actions/checkout` to commit SHA (same as ci.yml)
  - [x] Pin `oven-sh/setup-bun` to commit SHA with `bun-version: "1.3.11"` (same as ci.yml)
  - [x] Steps: install deps, build binary (`bun build --compile --target=bun-linux-x64 src/cli.ts --outfile dist/protondrive`)
  - [x] Step: `bun test src/__e2e__/` — always runs
  - [x] Step: `bun test src/__integration__/` with `PROTON_TEST_USER`/`PROTON_TEST_PASS` from secrets — runs only on `push` event (tag push)

## Dev Notes

### Critical Implementation Facts

**Same commit SHAs as ci.yml and release.yml** — always pin to commit SHAs, never mutable version tags (lesson from Epic 6 review):
- `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5` # v4
- `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6` # v2
- `softprops/action-gh-release@153bb8e04406b158c6c84fc1615b65b24149a1fe` # v2 (not needed here)

**Binary build target:** `bun build --compile --target=bun-linux-x64 src/cli.ts --outfile dist/protondrive`

**E2e test run command:** `bun test src/__e2e__/`
- Binary must be pre-built before this step — build step must precede this step

**Integration test conditional:**
- Integration tests should run only on `push` event (tag pushes), not `workflow_dispatch`
- Use `if: github.event_name == 'push'` condition on the integration test step
- Pass secrets via step `env:` block: `PROTON_TEST_USER: ${{ secrets.PROTON_TEST_USER }}` and `PROTON_TEST_PASS: ${{ secrets.PROTON_TEST_PASS }}`
- The `test.skipIf(SKIP)` pattern in integration tests handles absence of credentials — tests self-skip if env vars not set
- Any test that runs and FAILS will exit non-zero → workflow blocks on failure (AC4)

**ci.yml must NOT be modified** — AC3 requires it unchanged. Only `e2e.yml` is new.

### Test Strategy

Since `e2e.yml` is a YAML configuration file (not executable TypeScript), tests validate its structure by:
1. Reading the file with `Bun.file()` + text parsing via `js-yaml` (already in dependencies for config parsing)
2. Asserting trigger configuration, step presence, environment variable wiring
3. Asserting ci.yml unchanged (no integration test commands)

Test file location: `src/__e2e__/workflow.test.ts`
- Uses `js-yaml` (already a project dependency via `import { load } from "js-yaml"`)
- Does NOT spawn a binary — pure file/YAML assertion, valid in the `__e2e__` directory

### Forbidden Patterns

- Do NOT modify `ci.yml` — AC3 is violated if it changes
- Do NOT add `workflow_call` or matrix builds — out of scope
- Do NOT add a build-and-release step to `e2e.yml` — it is a test-only workflow
- Do NOT import from `src/` modules in workflow test — keep black-box separation

### References

- Supply-chain security: pin GitHub Actions to commit SHAs [Source: epic-6-retro-2026-04-05.md#Key Lessons]
- Binary build command [Source: architecture.md, release.yml:42]
- Integration test skip pattern [Source: src/__integration__/*.integration.test.ts]
- `js-yaml` available as project dep [Source: package.json — installed for config parsing]
- Pinned action SHAs [Source: .github/workflows/ci.yml, .github/workflows/release.yml]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- 2026-04-05: Story 7.3 implemented. Created `.github/workflows/e2e.yml` with `workflow_dispatch` and `push v*` triggers. Binary build step precedes e2e test step. Integration test step conditional on `github.event_name == 'push'` with `PROTON_TEST_USER`/`PROTON_TEST_PASS` from secrets. Both actions pinned to commit SHAs (same as ci.yml/release.yml). Created `src/__e2e__/workflow.test.ts` with 10 tests validating workflow structure via js-yaml parsing. All 10 new tests pass. 213 total pass; pre-existing `cli.test.ts` bun-PATH failure unchanged.

### Review Findings

- [x] [Review][Patch] No test asserts `uses:` fields are SHA-pinned (not mutable version tags) [`src/__e2e__/workflow.test.ts`]
- [x] [Review][Defer] No test asserts `bun-version: "1.3.11"` is set in e2e.yml — deferred, high churn on every Bun upgrade; needs source-of-truth refactor [`src/__e2e__/workflow.test.ts`]
- [x] [Review][Patch] No test asserts build target `--target=bun-linux-x64` in build step [`src/__e2e__/workflow.test.ts`]
- [x] [Review][Defer] `CI_WORKFLOW` read unconditionally without `existsSync` guard — throws ENOENT instead of clean assertion failure if ci.yml absent [`src/__e2e__/workflow.test.ts:112`] — deferred, low risk (ci.yml is committed)
- [x] [Review][Defer] `loadWorkflow` called redundantly inside every test — no `beforeAll` cache [`src/__e2e__/workflow.test.ts`] — deferred, cosmetic
- [x] [Review][Defer] No Dependabot or equivalent configured to refresh pinned action SHAs — project-wide infra gap [`e2e.yml:16,20`] — deferred, pre-existing
- [x] [Review][Defer] `toContain("push")` condition check is slightly loose — would pass for `push_event` [`src/__e2e__/workflow.test.ts:114`] — deferred, no realistic risk
- [x] [Review][Defer] No cross-workflow Bun version consistency check between ci.yml, release.yml, e2e.yml [`src/__e2e__/workflow.test.ts`] — deferred, nice-to-have

### File List

- `.github/workflows/e2e.yml` (new)
- `src/__e2e__/workflow.test.ts` (new — 12 tests; 2 added in review: SHA-pinning + build-target)

