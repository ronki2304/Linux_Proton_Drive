# Story 3.0b: Targeted Debt Fixes

Status: done

> **Why this story exists:** After the Bun runtime migration (Story 3-0a), four technical debt
> items from the Epic 2 retrospective remain. Two of those items (watcher status reset on
> token_expired; onChangesDetected rejection handling) were discovered to already be implemented
> in the codebase — but without test coverage. This story: (1) formalises the `change_type` enum
> so Story 3.2 can write typed values to `change_queue`, (2) adds regression tests for the two
> already-fixed items, and (3) updates `architecture.md` which still contains stale Node.js /
> wrong-path references from before Story 2-10's discovery.
>
> **Scope:** Four narrow, surgical changes — no architectural work, no new features.
>
> **Dependency:** Story 3-0a must be `done` before this story starts.
> `bun test` must be the test runner when this story executes.

## Story

As the **project lead**,
I want **four targeted debt items from the Epic 2 retrospective resolved**,
so that **Epic 3 feature stories start from a clean, documented, fully-tested baseline**.

## Acceptance Criteria

### AC1 — `change_type` TypeScript union defined and enforced

**Given** `engine/src/state-db.ts` where `ChangeQueueEntry.change_type` is typed as `string`
**When** this story is complete
**Then** `export type ChangeType = "created" | "modified" | "deleted"` is exported from `state-db.ts`
**And** `ChangeQueueEntry.change_type` is changed from `string` to `ChangeType`
**And** NO new migration is added and `CURRENT_VERSION` stays at `2` — SQLite does not support
  adding CHECK constraints via `ALTER TABLE` (only `ADD COLUMN` / `RENAME` are supported);
  enforcement is at the TypeScript layer only, which is sufficient for this internal API
**And** `bun test engine/src/state-db.test.ts` passes — new tests verify:
- `enqueue()` accepts `"created"`, `"modified"`, `"deleted"` and rows appear in the DB
- TypeScript type-checks reject a call with an invalid literal (compile-time only — no runtime test needed)
**And** `bunx tsc --noEmit` still passes with zero errors after the change

> **Note:** Story 3.2 (persistent change queue) depends on this enum being defined here.
> Do NOT use an unconstrained string when writing to `change_queue` in any story from this
> point forward.

---

### AC2 — Watcher status reset on token_expired/logout verified with tests

**Given** `ui/src/protondrive/main.py` where `_on_token_expired` (line 299) and `logout` (line 323)
both already reset `self._watcher_status = "unknown"` — the fix is present but untested
**When** `meson test -C builddir` (or `python -m pytest ui/tests/`) is run
**Then** `test_main.py` includes tests that verify:
- After `_on_token_expired()` is called, `app._watcher_status` equals `"unknown"`
  (regardless of what value it held before — test both `"ready"` and `"initializing"` as prior states)
- After `logout()` is called, `app._watcher_status` equals `"unknown"`
**And** `_on_token_expired` calls `_cancel_validation_timeout()` which calls `GLib.source_remove` —
  `GLib` must be patched in `sys.modules` (follow the existing mock pattern in `test_main.py`)
  before constructing the Application instance, otherwise the test will crash on GLib initialization
**And** all existing tests continue to pass — no regressions

> **Discovery note:** When the Epic 2 retro was written (2026-04-12), this was listed as
> outstanding. Code inspection confirms both resets are already in place. This AC adds the
> missing test coverage, not the fix itself.

---

### AC3 — `onChangesDetected` rejection handling confirmed and documented

**Given** `engine/src/watcher.ts` lines 83–85 which already catch `onChangesDetected` rejections
and log them via `debugLog`:
```ts
this.onChangesDetected(pairId).catch((e) =>
  debugLog(`watcher: onChangesDetected failed for ${pairId}: ${(e as Error).message}`),
);
```
**When** this story is reviewed
**Then** the dev agent confirms this pattern is correct — rejections are no longer silently swallowed
**And** a test exists in `engine/src/watcher.test.ts` that verifies: when `onChangesDetected` rejects,
`debugLog` is called with a message containing the error text and the `pairId`
**And** the watcher does not crash or propagate the rejection when `onChangesDetected` throws

> **Discovery note:** The retro item said "swallowed via `void`" — current code already uses
> `.catch()` + `debugLog`. No source change needed; only test coverage is missing.

---

### AC4 — `architecture.md` updated to reflect actual post-3-0a state

**Given** `_bmad-output/planning-artifacts/architecture.md` which contains stale references:
1. Line 91: `Node.js: bundled via org.freedesktop.Sdk.Extension.node22` — now Bun
2. Lines 94–96: YAML snippet showing `sdk-extensions: [node22]` and `append-path: .../node22/bin`
3. Lines 392–394: `get_engine_path()` code snippet — wrong binary (`node`), wrong path
   (`/app/lib/protondrive/engine.js`) — actual path discovered in Story 2-10 was
   `/app/lib/protondrive-engine/dist/src/main.js`; post-3-0a this may be a compiled Bun binary
4. Lines 399–401: `tsconfig` flags showing `"module": "NodeNext"` — now `"ESNext"` / `"Bundler"`

**When** this story is complete
**Then** the engine runtime entry (line 91 area) reflects **Bun** as the engine runtime,
  referencing whatever Flatpak approach was chosen in AC0 of Story 3-0a
**And** the YAML snippet (lines 94–96) is updated or replaced to show the actual post-3-0a
  Flatpak engine packaging (remove node22 references; show Bun approach)
**And** `get_engine_path()` code snippet (lines 392–394) reflects the actual post-3-0a
  implementation from `engine.py` — read the current live file, don't guess
**And** the tsconfig flags snippet (lines 399–401) shows:
  `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"types": ["bun-types"]`
**And** no other architecture.md content is changed — surgical updates only

> **Critical:** Read the **actual current state** of `engine.py` and the Flatpak manifest after
> 3-0a is done before writing the architecture.md update. Do not copy the snippets from the
> 3-0a story file — they show the intended state, not necessarily what was implemented.

---

### AC5 — Story stops at `review`

Per standing agreement: dev agent sets status to `review` and stops. Jeremy certifies `done`.
One commit per logical group. Branch: `feat/3-0b-targeted-debt-fixes`.

## Tasks / Subtasks

> **Order:** Do Tasks 1–3 (code/tests) first. Task 4 (architecture.md) last, after all tests
> pass — it requires reading the actual post-3-0a implementations.

- [x] **Task 1: `change_type` enum** (AC: #1)
  - [x] 1.1 Add `export type ChangeType = "created" | "modified" | "deleted"` above
        the `ChangeQueueEntry` interface in `state-db.ts`
  - [x] 1.2 Update `ChangeQueueEntry.change_type: string` → `ChangeQueueEntry.change_type: ChangeType`
  - [x] 1.3 Do NOT add a migration or bump `CURRENT_VERSION` — enforcement is TypeScript-only
        (SQLite ALTER TABLE does not support CHECK constraints)
  - [x] 1.4 In `state-db.test.ts` — add tests: enqueue with each valid ChangeType value succeeds;
        dequeue returns the correct `change_type`
  - [x] 1.5 Run `bun test engine/src/state-db.test.ts` — all tests pass
  - [x] 1.6 Run `bunx tsc --noEmit` — zero errors

- [x] **Task 2: Watcher status reset — test coverage** (AC: #2)
  - [x] 2.1 Read existing `ui/tests/test_main.py` — identify the GLib/EngineClient/CredentialManager
        mock setup pattern used in other tests; replicate it exactly
  - [x] 2.2 In `ui/tests/test_main.py` — add a test that:
        - patches `GLib` in `sys.modules` (required — `_cancel_validation_timeout` calls
          `GLib.source_remove`; without this the test crashes on GLib initialization)
        - creates an `Application` instance with mocked engine + credentials
        - sets `app._watcher_status = "ready"`
        - calls `app._on_token_expired({"payload": {"code": "SESSION_EXPIRED"}})`
        - asserts `app._watcher_status == "unknown"`
  - [x] 2.3 Add a second test: set `_watcher_status = "initializing"`, call `app.logout()`,
        assert `app._watcher_status == "unknown"` (logout also calls `_engine.send_shutdown()` —
        mock `_engine`)
  - [x] 2.4 Run `python -m pytest ui/tests/test_main.py -v` — all pass

- [x] **Task 3: `onChangesDetected` rejection — test coverage** (AC: #3)
  - [x] 3.1 Confirm `engine/src/watcher.ts` lines 83–85 use `.catch((e) => debugLog(...))` —
        no source change required if the pattern is already present
  - [x] 3.2 In `engine/src/watcher.test.ts` — add a test:
        - construct `FileWatcher` with an `onChangesDetected` that rejects with `new Error("boom")`
        - trigger `scheduleSync` (call the internal callback, or advance timers)
        - assert `debugLog` was called with a message containing `"boom"` and the pair ID
        - assert no unhandled rejection propagated (the test itself must not throw)
  - [x] 3.3 Run `bun test engine/src/watcher.test.ts` — passes

- [x] **Task 4: `architecture.md` surgical update** (AC: #4)
  - [x] 4.1 Read current `engine.py` `get_engine_path()` — copy the actual implementation
  - [x] 4.2 Read current Flatpak manifest `protondrive-engine` module section — note the approach
  - [x] 4.3 Run `grep -n "node22\|Node\.js" architecture.md` — find ALL occurrences
        (known locations: lines ~91–96, ~392–394; there is also at least one more around line 656)
  - [x] 4.4 Update engine runtime paragraph: replace Node.js/node22 with Bun
  - [x] 4.5 Update YAML snippet: replace node22 sdk-extension with the actual Bun packaging used
  - [x] 4.6 Update `get_engine_path()` code snippet: replace with actual post-3-0a implementation
  - [x] 4.7 Update tsconfig snippet: `NodeNext` → `ESNext`/`Bundler`, add `bun-types`
  - [x] 4.8 Verify no other lines were accidentally changed (`git diff architecture.md`)

## Dev Notes

### Dependency: Story 3-0a must be done

This story **must not start** until Story 3-0a is merged and `bun test` is the test runner.
Both the engine test commands (`bun test`) and the TypeScript check (`bunx tsc --noEmit`)
depend on the Bun migration being complete.

### change_type enum: where it's used

Currently `change_type` is an unconstrained `string` in both TypeScript and SQLite. After this
story, all callers that write to `change_queue` must pass a `ChangeType` value. Do a codebase
grep to find any existing `enqueue()` calls and update them:
```bash
grep -rn "enqueue\|change_queue\|change_type" engine/src/
```
If `enqueue()` is not yet called from any production code (it was defined in Story 2-1 but
Story 3.2 is where it gets used), no call-site updates are needed — the type change alone is
sufficient.

### `change_type` enforcement is TypeScript-only — no SQL migration

SQLite's `ALTER TABLE` only supports `ADD COLUMN`, `RENAME TABLE`, and `RENAME COLUMN`.
Adding a CHECK constraint via `ALTER TABLE` is not valid SQL in SQLite and throws a syntax error
at runtime. The TypeScript union `ChangeType = "created" | "modified" | "deleted"` on
`ChangeQueueEntry.change_type` is the only enforcement needed — this is an internal API with
no external writers. No migration, no CURRENT_VERSION bump.

### test_main.py mock pattern

Follow the existing mock pattern in `ui/tests/test_main.py` for constructing an `Application`
instance. Look at how `test_token_expired` (if it exists) or similar auth tests mock the
EngineClient and CredentialManager. Key: `_watcher_status` is a plain Python attribute —
no mock needed to set or read it.

### watcher.test.ts — testing `scheduleSync`

After Story 3-0a, `watcher.test.ts` will use `bun:test`. When adding the new rejection test,
use **`mock(() => {})`** for mock creation — not `mock.fn()` (which is node:test syntax and
does not exist in bun:test). Follow whatever pattern the rest of the file uses post-migration.

`scheduleSync` is a private method. In `bun:test`, you can call private methods via
`(watcher as any)._scheduleSync(pairId)` or trigger it by having the `watchFn` mock emit a
change event. Check the existing watcher tests for the pattern already in use — follow it.

The `debounceMs` constructor parameter defaults to 1000ms. Pass `0` in tests to avoid
needing fake timers:
```ts
const watcher = new FileWatcher(pairs, onChangesDetected, emitEvent, mockWatchFn, 0);
```
With `debounceMs: 0`, the setTimeout fires immediately — add a short `await` to let the
microtask queue flush before asserting:
```ts
await new Promise(resolve => setTimeout(resolve, 0));
```

### architecture.md — read before writing

The architecture.md `get_engine_path()` snippet (around line 392) shows:
```python
return ('/usr/lib/sdk/node22/bin/node', '/app/lib/protondrive/engine.js')
```
This was already wrong before Story 3-0a (Story 2-10 found the actual path was
`/app/lib/protondrive-engine/dist/src/main.js`). After 3-0a, the path changes again
(Bun binary or compiled binary). **Read the actual `engine.py` file first** — do not
copy any snippet from a story file.

### Files touched by this story

- `engine/src/state-db.ts` — ChangeType export, ChangeQueueEntry type update, migration v3
- `engine/src/state-db.test.ts` — new tests for enqueue + ChangeType values
- `engine/src/watcher.test.ts` — new test for onChangesDetected rejection logging
- `ui/tests/test_main.py` — new tests for _watcher_status reset on token_expired + logout
- `_bmad-output/planning-artifacts/architecture.md` — engine runtime, Flatpak, tsconfig sections

Do NOT touch:
- `ui/src/protondrive/main.py` — fix already present (lines 299, 323)
- `engine/src/watcher.ts` — fix already present (lines 83–85)
- Any CI files
- `project-context.md` — already updated in Story 3-0a (AC8)

### References

- Deferred work: `_bmad-output/implementation-artifacts/deferred-work.md`
  - § "Deferred from: code review of 2-1" — change_type constraint
  - § "Deferred from: code review of 2-6" — watcher_status reset + onChangesDetected
- Epic 2 retro: `_bmad-output/implementation-artifacts/epic-2-retro-2026-04-12.md` § "Story 3-0"
- Current state-db.ts: `engine/src/state-db.ts` — ChangeQueueEntry at line 26–32
- Current watcher.ts: `engine/src/watcher.ts` lines 77–88 — scheduleSync + catch
- Current main.py: `ui/src/protondrive/main.py` lines 288–323 — _on_token_expired + logout
- Architecture doc: `_bmad-output/planning-artifacts/architecture.md` lines 88–98, 388–401

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

_none — no blocking issues_

### Completion Notes List

- **Task 1 (AC1):** Added `export type ChangeType = "created" | "modified" | "deleted"` to `state-db.ts`; updated `ChangeQueueEntry.change_type: string → ChangeType`; no migration (TypeScript-only enforcement); updated all existing test `change_type` values ("upload"→"created", "delete"→"deleted") to valid ChangeType literals; added 4 new tests in `StateDb — ChangeType enum` describe block; 27/27 tests pass; `bunx tsc --noEmit` zero errors.
- **Task 2 (AC2):** Created `ui/tests/test_main.py`; GLib already mocked globally by `conftest.py`; used `object.__new__(Application)` pattern to bypass GTK init; `_token_validation_timer_id = None` prevents `GLib.source_remove` call; 4 tests covering `_on_token_expired` (from "ready" and "initializing") and `logout` (from "ready" and "initializing") — all pass.
- **Task 3 (AC3):** Confirmed `watcher.ts` lines 83-85 already use `.catch((e) => debugLog(...))` — no source change; added rejection test to `watcher.test.ts` using `PROTONDRIVE_DEBUG=1` + temp `XDG_CACHE_HOME` to verify log file contains "boom" and pairId; `debounceMs: 0` + `await setTimeout(0)` to flush; 7/7 tests pass.
- **Task 4 (AC4):** Read actual `get_engine_path()` from `engine.py` and `protondrive-engine` module from Flatpak manifest; updated 4 locations in `architecture.md`: (1) line ~91 engine runtime paragraph Node.js/node22 → Bun `bun build --compile`; (2) YAML snippet → actual Flatpak module; (3) `get_engine_path()` snippet → actual post-3-0a implementation; (4) tsconfig snippet `NodeNext` → `ESNext`/`Bundler`/`bun-types`; also updated line ~656 architectural decisions checklist. `git diff` confirms surgical changes only.
- **Pre-existing failures:** 29 UI test failures in `test_auth_completion.py`, `test_auth_window.py`, `test_credential_store.py`, `test_main_routing.py` — confirmed pre-existing (same failures with stashed changes); not regressions from this story.

### File List

- `engine/src/state-db.ts`
- `engine/src/state-db.test.ts`
- `engine/src/watcher.test.ts`
- `ui/tests/test_main.py` (new)
- `_bmad-output/planning-artifacts/architecture.md`
- `_bmad-output/implementation-artifacts/3-0b-targeted-debt-fixes.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

### Change Log

- 2026-04-14: Implemented AC1 (ChangeType enum), AC2 (watcher status reset tests), AC3 (onChangesDetected rejection test), AC4 (architecture.md surgical update). Story set to review.

### Review Findings

- [x] [Review][Decision] D1 — Wrong branch + uncommitted: resolved — committing all changes (3-0a code + 3-0b) together on `feat/3-0a-bun-runtime-migration` per Jeremy's direction (option c).
- [x] [Review][Decision] D2 — Out-of-scope 3-0a files in working tree: resolved — included in combined commit per Jeremy's direction (option c).
- [x] [Review][Decision] D3 — AC3 verification method: resolved — refactored to `spyOn(fs, "appendFileSync").mockImplementation(() => {})` with direct call-argument assertions; XDG_CACHE_HOME manipulation removed.
- [x] [Review][Patch] P1 — `fw.stop()` not in try/finally: fixed — test body wrapped in try/finally. [`engine/src/watcher.test.ts`]
- [x] [Review][Defer] W1 — Migration runner lacks null guard on PRAGMA user_version result [`engine/src/state-db.ts:128`] — deferred, pre-existing; SQLite guarantees PRAGMA user_version always returns a row
- [x] [Review][Defer] W2 — onChangesDetected reject handler casts any rejection to Error — non-Error throws log "undefined" instead of actual value [`engine/src/watcher.ts:84`] — deferred, pre-existing; watcher.ts is out of scope per story
- [x] [Review][Defer] W3 — `object.__new__(Application)` bypasses `__init__`, brittle if new attributes added [`ui/tests/test_main.py:23`] — deferred, established project pattern (conftest.py design)
