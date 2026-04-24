# Story 8-0: Pre-Epic Debt Cleanup

Status: done

## Story

As a developer,
I want the five deferred debt items scheduled for 8-0 resolved,
so that the codebase is clean and CI is protected before entering Epic 8 sync and activity feed work.

## Background

Five items were identified at the Epic 7 retrospective (2026-04-24) for 8-0:

| Priority | Ref | Type | Description |
|----------|-----|------|-------------|
| **Critical** | [8-0 T1] | CI guard | `ci.yml` `bun test` discovers `__integration__/` — blocks 8-1 the moment the first integration test file is added |
| Medium | [8-0 T2] | Refactor | `atomicWriteConfig()` helper — 3 duplicate tmp/write/rename patterns in `config.ts` |
| Low | [8-0 T3] | Doc | Post-patch rebuild step missing from `project-context.md` |
| Low | [8-0 T4] | Doc | Log retrieval section missing from `CONTRIBUTING.md` (Flatpak sandbox logs + journalctl) |
| Low | [8-0 T5] | Doc | Architecture doc has stale paths — metainfo + desktop listed under `flatpak/`, actually live in `ui/data/` |

All changes are surgical. No new features, no architecture changes.

**Task 1 is a critical CI blocker** — it must be in place before any integration test file lands in 8-1. Tasks 2–5 are independent and low-risk.

---

## Acceptance Criteria

### AC1 — CI does not run integration tests

**Given** the `ci.yml` engine test step
**When** integration test files are added under `engine/src/__integration__/` in a future story
**Then** `bun test` in CI does not discover or run them
**And** all existing unit tests (`engine/src/*.test.ts`) continue to run and pass

**Given** a developer runs `bun test` locally from `engine/` with no arguments
**When** `__integration__/` contains test files
**Then** integration tests are NOT run by default (same exclusion as CI)
**And** `bun test src/__integration__/` still runs integration tests explicitly

### AC2 — `atomicWriteConfig()` helper extracted

**Given** `engine/src/config.ts`
**When** the story is complete
**Then** the three functions `writeConfigYaml`, `removeFromConfigYaml`, `updatePairPathInConfigYaml` each call a shared internal `atomicWriteConfig(configPath, data)` helper
**And** no `.tmp` / `writeFileSync` / `renameSync` pattern is duplicated inline

**Given** the `config.ts` unit tests
**When** `bun test engine/src/config.test.ts` runs
**Then** zero failures, zero regressions

### AC3 — Post-patch rebuild step documented

**Given** `_bmad-output/project-context.md`
**When** the story is complete
**Then** the Build & Run section (or Testing Rules section) contains an explicit note:
  after patching any `.blp`, `.gschema.xml`, `.gresource.xml`, or `protondrive.gresource.xml` file, run `meson compile -C builddir` before running the app or tests — skipping it produces stale UI artifacts

### AC4 — Flatpak log retrieval documented in CONTRIBUTING.md

**Given** `CONTRIBUTING.md`
**When** the story is complete
**Then** a new "Retrieving Logs" (or "Flatpak Logs") section exists that documents:
  - Engine debug log path in Flatpak: `~/.var/app/io.github.ronki2304.ProtonDriveLinuxClient/cache/protondrive/engine.log`
  - How to enable debug mode: `flatpak override --user --env=PROTONDRIVE_DEBUG=1 io.github.ronki2304.ProtonDriveLinuxClient`
  - Native dev log path: `$XDG_CACHE_HOME/protondrive/engine.log` (default `~/.cache/protondrive/engine.log`)
  - System/GNOME log command: `journalctl --user -f _FLATPAK_APP_ID=io.github.ronki2304.ProtonDriveLinuxClient`

### AC5 — Architecture doc path corrected

**Given** `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md`
**When** the story is complete
**Then** the `flatpak/` directory tree no longer shows `.metainfo.xml` or `.desktop` files
**And** a `ui/data/` entry (or annotation) shows those files live there instead
**And** the Requirements → Structure mapping table has an entry for "AppStream metainfo + desktop entry" → `ui/data/`

### AC6 — All tests pass

**When** the updated test command (`bun test 'src/*.test.ts'`) runs from `engine/`
**Then** all existing engine unit tests pass, zero failures
**And** the count matches whatever `bun test` reported before the change (verify before and after — 125 was the count as of 2026-04-24; confirm it hasn't drifted)

**When** `.venv/bin/pytest ui/tests/` runs
**Then** all UI tests pass, zero regressions

---

## Tasks / Subtasks

- [x] **Task 1 — CI integration test scope guard** (AC1) — CRITICAL
  - [x] 1.1 In `.github/workflows/ci.yml`, change the engine test step from `bun test` to `bun test --path-ignore-patterns '__integration__'` — `bun test 'src/*.test.ts'` does not work (bun treats it as a name filter, not a path glob); `--path-ignore-patterns` is the correct bun API for path exclusion
  - [x] 1.2 Verified: `bun test --path-ignore-patterns '__integration__'` runs 350 tests across 10 files, same as bare `bun test` (no integration tests exist yet; guard is in place for when they land in 8-1)
  - [x] 1.3 In `CONTRIBUTING.md` "Running Tests" table:
    - Updated "Engine unit" row to `cd engine && bun test --path-ignore-patterns '__integration__'` matching CI
    - Fixed "UI (local)" row from `ui/.venv/bin/pytest ui/tests/` to `.venv/bin/pytest ui/tests/` (venv at project root)

- [x] **Task 2 — `atomicWriteConfig()` helper** (AC2)
  - [x] 2.1 Added private `atomicWriteConfig(configPath: string, data: ConfigFile): void` in `engine/src/config.ts`
  - [x] 2.2 Replaced inline pattern in `writeConfigYaml` with `atomicWriteConfig(configPath, existing)`
  - [x] 2.3 Replaced inline pattern in `removeFromConfigYaml` with `atomicWriteConfig(configPath, existing)`
  - [x] 2.4 Replaced inline pattern in `updatePairPathInConfigYaml` with `atomicWriteConfig(configPath, existing)`
  - [x] 2.5 `bun test src/config.test.ts` — 6 pass, 0 fail

- [x] **Task 3 — Post-patch rebuild step in project-context.md** (AC3)
  - [x] 3.1 Added post-patch rebuild bullet to Testing Rules → "Python UI Tests (pytest via Meson compile)" section in `_bmad-output/project-context.md`

- [x] **Task 4 — Log retrieval section in CONTRIBUTING.md** (AC4)
  - [x] 4.1 Added "Retrieving Logs" section to `CONTRIBUTING.md` after the Integration Tests section — Flatpak log path, `flatpak override` debug enable, native dev path, `journalctl` command

- [x] **Task 5 — Architecture doc path correction** (AC5)
  - [x] 5.1 Removed `.metainfo.xml` and `.desktop` from `flatpak/` tree; `flatpak/` now shows only the manifest — `__integration__/` placeholder files untouched
  - [x] 5.2 Added `metainfo.xml`, `.desktop`, `protondrive.gresource.xml`, `style.css` to `ui/data/` tree (verified against actual `ls ui/data/` output)
  - [x] 5.3 Added "AppStream metainfo + desktop entry → `ui/data/`" row to Requirements → Structure mapping table

- [x] **Task 6 — Final validation** (AC6)
  - [x] 6.1 `bun test --path-ignore-patterns '__integration__'` from `engine/` — 350 pass, 10 files, 0 fail
  - [x] 6.2 No .blp/.gschema.xml/.gresource.xml files modified — meson compile not required for this story
  - [x] 6.3 `.venv/bin/pytest ui/tests/` — 672 passed, 0 regressions
  - [x] 6.4 Story status set to `review`

---

## Developer Context

### Scope: 5 targeted items, no feature work

This is a pure debt-reduction story. Every change is either:
- A one-line CI command change (Task 1)
- A private helper extraction with no logic change (Task 2)
- A documentation addition (Tasks 3, 4, 5)

Do NOT add new features, refactor unrelated code, or touch anything outside the listed files.

### Task 1 detail: Why `bun test 'src/*.test.ts'` is the right fix

All 10 existing unit test files live directly in `engine/src/` (no subdirectories):
```
engine/src/config.test.ts
engine/src/conflict.test.ts
engine/src/debug-log.test.ts
engine/src/ipc.test.ts
engine/src/main.test.ts
engine/src/network-monitor.test.ts
engine/src/sdk.test.ts
engine/src/state-db.test.ts
engine/src/sync-engine.test.ts
engine/src/watcher.test.ts
```

Integration tests will live in `engine/src/__integration__/*.test.ts`. The glob `'src/*.test.ts'` matches only the top-level `src/` — not subdirectory files — so `__integration__/` is excluded without any negative pattern.

**If future stories add unit tests in non-integration subdirectories**, the glob will need to be expanded (e.g., add `'src/subdir/*.test.ts'`). Leave a short comment in `ci.yml` explaining this:
```yaml
# Explicit glob excludes src/__integration__/ — expand if unit tests move to subdirs
run: bun test 'src/*.test.ts'
```

The `CONTRIBUTING.md` change (1.3) keeps local dev command consistent with CI — important so developers don't accidentally run integration tests with the default `bun test` invocation.

### Task 2 detail: `atomicWriteConfig()` — exact change

**Current pattern (repeated verbatim 3 times in `config.ts`):**
```ts
const tmpPath = configPath + ".tmp";
writeFileSync(tmpPath, yaml.dump(existing), "utf8");
renameSync(tmpPath, configPath);
```

**New private helper (add above `writeConfigYaml`):**
```ts
function atomicWriteConfig(configPath: string, data: ConfigFile): void {
  const tmpPath = configPath + ".tmp";
  writeFileSync(tmpPath, yaml.dump(data), "utf8");
  renameSync(tmpPath, configPath);
}
```

**Each write function then calls:**
```ts
atomicWriteConfig(configPath, existing);
```

The `mkdirSync(dirname(configPath), { recursive: true })` call in each function stays — it's not part of the atomic write pattern.

The helper is private (no `export`). The refactor is purely mechanical — same logic, just extracted — so no behavior changes.

**Test coverage note:** `config.test.ts` covers `writeConfigYaml` thoroughly (including the atomic-write pattern at line 58) but has zero dedicated tests for `removeFromConfigYaml` or `updatePairPathInConfigYaml`. This pre-exists this story. The extraction is safe because it is a direct textual substitution with no logic change. Do NOT add new tests for this story — that's out of scope. Simply confirm `bun test engine/src/config.test.ts` passes (it will — existing tests still exercise `writeConfigYaml` end-to-end, and the two uncovered functions are unchanged in behavior).

### Task 3 detail: exact location in project-context.md

The Testing Rules section already has:
> "Two-step local workflow: `meson compile -C builddir` (fast, compiles assets only) → `.venv/bin/pytest ui/tests/`... Raw `python -m pytest` without the compile step breaks tests touching `@Gtk.Template` or `Gio.Settings` — always compile first."

Add one sentence to that block making the "when you've patched a resource file" trigger explicit — something like:

> "After patching any `.blp`, `.gschema.xml`, `.gresource.xml`, or `protondrive.gresource.xml` file, run `meson compile -C builddir` before running the app or tests — skipping the compile step produces stale resource artifacts that will disagree with code changes."

### Task 4 detail: CONTRIBUTING.md log section

Add after the Integration Tests section (after line 84). Example structure:

```markdown
## Retrieving Logs

### Flatpak (production install)

Enable debug logging:
```bash
flatpak override --user --env=PROTONDRIVE_DEBUG=1 io.github.ronki2304.ProtonDriveLinuxClient
```

Engine log path:
```
~/.var/app/io.github.ronki2304.ProtonDriveLinuxClient/cache/protondrive/engine.log
```

Stream GNOME/systemd app logs:
```bash
journalctl --user -f _FLATPAK_APP_ID=io.github.ronki2304.ProtonDriveLinuxClient
```

### Native dev

Engine log (when `PROTONDRIVE_DEBUG=1`):
```
~/.cache/protondrive/engine.log   # default XDG_CACHE_HOME
```
```

Feel free to adjust wording to match the existing section style.

### Task 5 detail: architecture doc — exact stale section

**File:** `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md`

**Current (wrong — lines ~82–85):**
```
└── flatpak/
    ├── io.github.ronki2304.ProtonDriveLinuxClient.yml          ← Flatpak manifest
    ├── io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml ← AppStream
    └── io.github.ronki2304.ProtonDriveLinuxClient.desktop
```

**Correct (metainfo and desktop live in `ui/data/`, not `flatpak/`):**
```
├── ui/
│   └── data/
│       ├── io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml  ← AppStream
│       ├── io.github.ronki2304.ProtonDriveLinuxClient.desktop
│       ├── io.github.ronki2304.ProtonDriveLinuxClient.gschema.xml
│       └── icons/
│           └── ...
│
└── flatpak/
    └── io.github.ronki2304.ProtonDriveLinuxClient.yml               ← Flatpak manifest
```

Also add to the Requirements → Structure mapping table (around line 106):
```
| AppStream metainfo + desktop entry | `ui/data/` |
```

You can verify the actual `ui/data/` contents with `ls ui/data/` before writing — the directory contains: `icons/`, `ui/` (subdirectory for `.blp` files), `.desktop`, `.metainfo.xml`, `.gschema.xml`, `protondrive.gresource.xml`, `protondrive.in`, `style.css`.

### Run commands

```bash
# Engine tests with new scope-guarded command
cd engine && bun test 'src/*.test.ts'

# UI compile (needed before pytest when .blp/.xml files change)
distrobox-enter -n LinuxProtonDrive -- bash -c "/usr/bin/meson compile -C builddir 2>&1"

# UI tests — full suite regression
.venv/bin/pytest ui/tests/
```

Use `.venv/bin/pytest` — NOT system `python3 -m pytest` (no pytest installed system-wide).

### Files touched

- `.github/workflows/ci.yml` — Task 1: change `bun test` → `bun test 'src/*.test.ts'`
- `CONTRIBUTING.md` — Task 1.3: update Running Tests table; Task 4: add Retrieving Logs section
- `engine/src/config.ts` — Task 2: extract `atomicWriteConfig()` helper
- `_bmad-output/project-context.md` — Task 3: add post-patch rebuild sentence
- `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` — Task 5: correct `flatpak/` tree, add `ui/data/` entry, update mapping table

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Completion Notes List

- Task 1: CI guard implemented with `bun test --path-ignore-patterns '__integration__'` — `bun test 'src/*.test.ts'` does not work in bun (treats the arg as a name filter, not a path glob); `--path-ignore-patterns` is the correct bun API. Verified: 350 pass / 10 files, same as bare `bun test`, confirming no tests dropped. CONTRIBUTING.md Running Tests table updated accordingly; `ui/.venv` → `.venv` venv path fixed.
- Task 2: `atomicWriteConfig()` extracted in `config.ts` — purely mechanical substitution, no logic change. All 6 config tests pass.
- Task 3: Post-patch rebuild bullet added to Python UI Tests section of project-context.md.
- Task 4: "Retrieving Logs" section added to CONTRIBUTING.md after Integration Tests section with Flatpak log path, debug override command, native dev path, journalctl command.
- Task 5: Architecture doc corrected — `flatpak/` now shows only the manifest; `ui/data/` tree updated with metainfo.xml, .desktop, gresource.xml, style.css (verified against `ls ui/data/`); Requirements mapping table updated.
- Final: 350 engine tests pass, 672 UI tests pass, zero regressions.

### File List

- `.github/workflows/ci.yml`
- `CONTRIBUTING.md`
- `engine/src/config.ts`
- `_bmad-output/project-context.md`
- `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md`
- `_bmad-output/implementation-artifacts/8-0-pre-epic-debt-cleanup.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

### Review Findings

- [x] [Review][Patch] CONTRIBUTING.md "UI (CI)" row path mismatch — doc shows `.venv/bin/pytest` but `ci.yml` line 48 creates `ui/.venv` and line 57 calls `ui/.venv/bin/pytest`; the change over-corrected: local dev row may be correct at `.venv/` but CI row must match what CI actually runs [CONTRIBUTING.md:~36]
- [x] [Review][Patch] `engine/package.json` "test" script not updated — still `"test": "bun test"` (bare); violates AC1 "integration tests are NOT run by default" when 8-1 lands; `bun run test` and editor integrations use this script [engine/package.json]
- [x] [Review][Defer] `atomicWriteConfig` no cleanup on `writeFileSync` failure — stale `.tmp` left on disk on disk-full/permission error; `renameSync` also throws `EXDEV` if `XDG_CONFIG_HOME` resolves to a different filesystem [engine/src/config.ts:52-56] — deferred, pre-existing (identical inline pattern predates this story)
- [x] [Review][Defer] `atomicWriteConfig` no fsync before rename — power-loss after rename can leave destination with zero bytes; weaker durability than "atomic write" implies [engine/src/config.ts:52-56] — deferred, pre-existing
