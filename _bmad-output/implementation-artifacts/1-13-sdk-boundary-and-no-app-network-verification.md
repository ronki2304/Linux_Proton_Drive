# Story 1.13: SDK Boundary & No-App-Network Verification

Status: done

## Story

As a security-conscious user,
I want to be certain the app makes no network connections of its own,
so that I can trust all network I/O goes through the ProtonDrive SDK.

## Acceptance Criteria

1. **Given** the complete UI codebase (`ui/src/`), **when** inspecting for HTTP client code, **then** no imports of `http.client`, `urllib`, `requests`, or any network library exist outside of `auth.py` (localhost-only server).

2. **Given** the complete engine codebase (`engine/src/`), **when** inspecting for HTTP/fetch imports, **then** no imports of `http`, `https`, `fetch`, `node-fetch`, `axios`, or any network library exist outside of `sdk.ts` (NFR10).

3. **Given** `engine/src/sdk.ts`, **when** inspecting its imports, **then** it is the only file that imports `@protontech/drive-sdk` **and** a boundary comment at the top of the file enforces this rule.

4. **Given** any engine file other than `errors.ts`, **when** inspecting its imports, **then** it does not import from `@protontech/drive-sdk` directly -- only from `sdk.ts`.

5. **Given** `engine/src/sdk.ts`, **when** inspecting its internal imports, **then** it imports only from `errors.ts` (one-way dependency rule) -- never from `sync-engine.ts`, `ipc.ts`, `state-db.ts`, `conflict.ts`, `watcher.ts`, or `main.ts`.

6. **Given** `engine/src/ipc.ts`, **when** inspecting its imports, **then** it does not import from `sdk.ts` (cross-module isolation).

7. **Given** `engine/src/errors.ts`, **when** inspecting its imports, **then** it has zero internal imports from any other engine file.

8. **Given** a CI pipeline run, **when** boundary checks execute, **then** all grep-based checks pass with zero violations.

## Tasks / Subtasks

- [x] Task 1: Verify `sdk.ts` boundary comment exists (AC: #3)
  - [x] 1.1–1.2 Created `sdk.ts` with boundary comment + DriveClient stub

- [x] Task 2: Audit engine for SDK import leaks (AC: #3, #4)
  - [x] 2.1–2.3 Zero violations found

- [x] Task 3: Audit engine for network library imports outside `sdk.ts` (AC: #2)
  - [x] 3.1–3.2 Zero violations found

- [x] Task 4: Audit UI for network library imports outside `auth.py` (AC: #1)
  - [x] 4.1–4.3 Zero violations found; auth.py confirmed localhost-only

- [x] Task 5: Verify one-way dependency rule in engine (AC: #5, #6, #7)
  - [x] 5.1–5.4 Zero violations found

- [x] Task 6: Create CI boundary-check script (AC: #8)
  - [x] 6.1–6.4 `scripts/check-boundaries.sh` — 9 checks, all passing

- [x] Task 7: Create code review checklist (AC: all)
  - [x] 7.1 Rules documented as header comment in boundary-check script

## Dev Notes

### SDK Boundary Architecture

`engine/src/sdk.ts` is the sole file that imports `@protontech/drive-sdk` and `openpgp`. It wraps the SDK into a `DriveClient` class that all other engine files consume. This isolation:

- Insulates the codebase from SDK version churn (pre-release `^0.14.3`, treat every bump as breaking)
- Encapsulates openpgp `Uint8Array<ArrayBufferLike>` to SDK `Uint8Array<ArrayBuffer>` cast boundary
- Enables unit tests to mock at `DriveClient` boundary without touching SDK internals

The boundary comment at the top of `sdk.ts` is the enforcement signal for both human reviewers and AI agents.

### NFR10: No Network I/O Outside SDK

The privacy architecture guarantees: no telemetry, no analytics, no network I/O outside SDK. This is a user-facing trust promise documented in the PRD. The only permitted network-adjacent code:

| File | Permitted Network Code | Scope |
|---|---|---|
| `engine/src/sdk.ts` | `@protontech/drive-sdk` (all Proton API calls) | Full network via SDK |
| `ui/src/auth.py` | `http.server` on `127.0.0.1` only | Localhost OAuth callback, ephemeral, single-request |

Everything else: zero network imports.

### One-Way Dependency Rule

The engine dependency DAG is strictly acyclic:

```
errors.ts          (leaf -- zero imports from engine)
    ^
    |
sdk.ts             (imports: errors.ts ONLY from engine)
    ^
    |
state-db.ts        (imports: errors.ts)
    ^
    |
sync-engine.ts     (imports: sdk.ts, state-db.ts, errors.ts, conflict.ts, watcher.ts)
    ^
    |
ipc.ts             (imports: errors.ts ONLY -- never sdk.ts)
    ^
    |
main.ts            (orchestrator -- imports all)
```

Violations create circular dependencies that break compilation or produce runtime import order bugs.

### Grep Patterns for Boundary Checks

**SDK leak detection (engine, excluding sdk.ts):**
```bash
grep -rn "@protontech/drive-sdk" engine/src/ --include="*.ts" | grep -v "sdk.ts"
grep -rn "from ['\"]openpgp['\"]" engine/src/ --include="*.ts" | grep -v "sdk.ts"
```

**Network leak detection (engine, excluding sdk.ts):**
```bash
grep -rn "import.*['\"]node:http[s]\?['\"]" engine/src/ --include="*.ts" | grep -v "sdk.ts"
grep -rn "import.*['\"]node-fetch['\"]" engine/src/ --include="*.ts" | grep -v "sdk.ts"
grep -rn "import.*['\"]axios['\"]" engine/src/ --include="*.ts" | grep -v "sdk.ts"
```

**Network leak detection (UI, excluding auth.py):**
```bash
grep -rn "import http\.client\|import urllib\|import requests\|import aiohttp\|import httpx" ui/src/ --include="*.py" | grep -v "auth.py"
```

**One-way dependency checks:**
```bash
# sdk.ts must not import from these modules
grep -n "from ['\"]\.\/sync-engine\|from ['\"]\.\/ipc\|from ['\"]\.\/state-db\|from ['\"]\.\/conflict\|from ['\"]\.\/watcher\|from ['\"]\.\/main" engine/src/sdk.ts

# ipc.ts must not import from sdk.ts
grep -n "from ['\"]\.\/sdk" engine/src/ipc.ts

# errors.ts must have zero internal imports
grep -n "from ['\"]\.\/" engine/src/errors.ts
```

### This Is a Verification Story

This story produces no new application features. Its deliverables are:

1. Verified boundary compliance across all existing code
2. Boundary comment in `sdk.ts` (if not already present)
3. A CI script that catches future violations automatically
4. Fixes for any violations discovered during audit

If the codebase already passes all checks, the primary deliverable is the CI enforcement script.

### Test Commands

No new application tests. The boundary-check script itself is the test:

```bash
bash scripts/check-boundaries.sh  # exit 0 = pass, exit 1 = violation found
```

CI integration verifies it runs in the pipeline alongside existing test suites:
- UI tests: `meson test -C builddir`
- Engine unit: `node --import tsx --test engine/src/**/*.test.ts`
- Boundary: `bash scripts/check-boundaries.sh`

### References

- [Source: _bmad-output/planning-artifacts/epics.md, lines 679-703]
- [Source: _bmad-output/planning-artifacts/architecture.md, SDK boundary sections, lines 403, 487, 520, 534, 609, 634]
- [Source: _bmad-output/project-context.md, Architectural Boundaries section, lines 276-282]
- [Source: _bmad-output/project-context.md, SDK Footguns section, lines 289-294]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
N/A

### Completion Notes List
- sdk.ts created as stub with boundary comment — real SDK integration deferred to Epic 2
- DriveClient class exposes validateSession() interface for future SDK wiring
- All 9 boundary checks pass in check-boundaries.sh
- 5 engine-side boundary tests verify rules via file content analysis
- No violations found in any audit (clean codebase)
- CI script exits non-zero on any violation with clear error messages

### File List
- `engine/src/sdk.ts` (created — SDK boundary stub with DriveClient)
- `engine/src/sdk.test.ts` (created — 5 boundary enforcement tests)
- `scripts/check-boundaries.sh` (created — 9 CI checks)
