# Sprint Change Proposal: E2E Test Suite

**Project:** ProtonDrive-LinuxClient
**Date:** 2026-04-05
**Author:** Bob (Scrum Master)
**Status:** Approved

---

## Section 1: Issue Summary

**Problem Statement:** The sprint plan was designed and executed with unit tests and component-level integration tests built into each story's acceptance criteria. Two test tiers were inadvertently omitted:

1. **CLI binary e2e tests** — tests that spawn the compiled `dist/protondrive` binary and exercise full command sequences, asserting on stdout, stderr, and exit codes. These catch regressions in the CLI layer that unit tests cannot.

2. **Live ProtonDrive e2e tests** — tests that run a complete user journey (auth → upload → sync → status) against a real Proton account. These are the only tests that can validate the SRP auth, SDK crypto path, and actual file data end-to-end.

**Discovery context:** Planning gap noticed after sprint execution. All 6 epics are `done` in `sprint-status.yaml`.

**Evidence:**
- Architecture defines `src/__integration__/auth.integration.test.ts` and `src/__integration__/sync.integration.test.ts` in the directory structure but no dedicated stories were created to implement them (beyond the auth integration test stub in Story 2.1 acceptance criteria)
- Story 6.1 (CI pipeline) only wires `bun test` — which runs co-located unit tests — with no binary-level or live e2e step
- PRD Technical Success: *"All v1 subcommands functional and tested"* — this bar is not fully met without e2e coverage

---

## Section 2: Impact Analysis

### Epic Impact

- Epics 1–6 are all `done`. No existing story is invalidated or needs rollback.
- A new **Epic 7: End-to-End Test Suite** is added. Epic 6 (packaging/distribution) is not the right home for test implementation stories.

### Story Impact

- **Story 6.1** (CI pipeline) is `done` but incomplete: it only runs `bun test`. A new Story 7.3 extends CI with a dedicated e2e workflow.
- No other completed stories are affected.

### PRD Impact

- No changes needed. Testing is already implied by Technical Success criteria (*"All v1 subcommands functional and tested"*).
- MVP scope is unaffected.

### Architecture Impact

- Added `src/__e2e__/` directory and `cli.e2e.test.ts` to directory structure
- Updated Development Workflow table with `bun test src/__e2e__/` entry
- Updated Test File Location pattern to document three-tier test model
- All changes are additive — no existing architectural decisions modified

### UX/UI Impact

N/A — v1 CLI only.

### Secondary Artifacts

- `epics.md` — added Epic 7 summary to Epic List, FR coverage map, and full story breakdown
- `architecture.md` — updated test tier documentation and directory structure
- `sprint-status.yaml` — added Epic 7 entries (all `backlog`)

---

## Section 3: Recommended Approach

**Selected: Option 1 — Direct Adjustment**

Add a new Epic 7 with 3 stories. No existing work disturbed. Effort: Low–Medium. Risk: Low.

**Rationale:**
- Purely additive change — all 6 completed epics remain valid
- Three small stories map cleanly to the two requested test tiers plus CI wiring
- Solo developer context: stories kept small and independently shippable
- Rollback not applicable; MVP scope reduction not warranted

---

## Section 4: Detailed Change Proposals

### 4.1 New Epic 7 in epics.md

Added to Epic List and detailed breakdown:

```
Epic 7: End-to-End Test Suite
The compiled binary and full user journeys are validated end-to-end — both via
process-spawning CLI tests (no live network) and live integration tests against
real ProtonDrive.
FRs covered: FR1–FR21 (validation layer)
NFRs addressed: NFR10, NFR11, NFR12, NFR14
```

### 4.2 Story 7.1 — CLI Binary Smoke & E2E Tests

Location: `src/__e2e__/cli.e2e.test.ts`

- Spawns compiled binary as child process
- Asserts stdout, stderr, exit codes for all subcommands
- Covers: `--help`, missing config (exit 2), missing credentials (exit 1), `status --json` format, bad upload path
- No live network required; binary must be pre-built

### 4.3 Story 7.2 — Live ProtonDrive Integration Tests

Location: `src/__integration__/` (populates files already referenced in architecture.md)

- `auth.integration.test.ts` — validates `srp.authenticate()` against live Proton auth endpoint
- `sync.integration.test.ts` — full upload → remote-verify → download cycle; conflict copy creation
- Excluded from default `bun test`; requires `PROTON_TEST_USER` / `PROTON_TEST_PASS` env vars
- `afterAll` cleanup removes all test data from the Proton account

### 4.4 Story 7.3 — E2E CI Workflow

New file: `.github/workflows/e2e.yml`

- Triggers: `workflow_dispatch` (manual) and `v*` tag push
- Steps: compile binary → `bun test src/__e2e__/` → (on `v*` tag) `bun test src/__integration__/`
- Existing `ci.yml` (PR gate, unit tests only) is unchanged
- GitHub Actions secrets: `PROTON_TEST_USER`, `PROTON_TEST_PASS`

### 4.5 Architecture doc updates

- Development Workflow table: added `bun test src/__e2e__/` row
- Test File Location pattern: replaced single bullet with three-tier documentation
- Directory structure: added `src/__e2e__/cli.e2e.test.ts`

### 4.6 sprint-status.yaml

```yaml
# Epic 7: End-to-End Test Suite
epic-7: backlog
7-1-cli-binary-smoke-e2e-tests: backlog
7-2-live-protondrive-integration-tests: backlog
7-3-e2e-ci-workflow: backlog
epic-7-retrospective: optional
```

---

## Section 5: Implementation Handoff

**Scope classification: Minor** — purely additive, no rework of completed stories.

**Handoff:** Development team (dev agent) — implement directly.

**Recommended sequencing:**
1. **Story 7.1** (CLI binary e2e) — unblocked immediately; no live credentials needed
2. **Story 7.3** (CI workflow) — unblocked once 7.1 has passing tests to run
3. **Story 7.2** (live integration) — requires a test Proton account configured as GitHub Actions secrets

**Success criteria:**
- `bun test src/__e2e__/` passes in CI after binary compile step
- `bun test src/__integration__/` passes in `e2e.yml` on `v*` tags with live credentials
- No existing unit test suite is disrupted
- All test data cleaned up from test Proton account after integration test run
