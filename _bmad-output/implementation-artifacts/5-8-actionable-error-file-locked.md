# Story 5.8: Actionable Error — File Locked

Status: done

## Story

As a user,
I want to know when a file can't sync because it's in use by another program,
so that I understand the sync will retry automatically.

## Acceptance Criteria

### AC1 — FILE_LOCKED error emitted on EBUSY/ETXTBSY during file operation

**Given** the sync engine encounters an EBUSY or ETXTBSY error when reading or writing a file
**When** the error is processed
**Then** an `error` push event is emitted with:
  - `code: "FILE_LOCKED"`
  - `message: "<filename> is in use — sync will retry when it's released"` (where `<filename>` is `basename(join(pair.local_path, item.relativePath))`)
  - `pair_id: <affected pair's pair_id>`

### AC2 — Non-EBUSY/ETXTBSY errors continue to emit existing codes

**Given** the sync engine encounters a filesystem error other than EBUSY or ETXTBSY
**When** the error is processed
**Then** the existing error code (`sync_file_error`, `DISK_FULL`, `PERMISSION_DENIED`, `queue_replay_failed`, etc.) is emitted unchanged
**And** no `FILE_LOCKED` event is emitted

### AC3 — Engine retries the file on the next sync cycle

**Given** a FILE_LOCKED error is emitted for a change queue entry
**When** processQueueEntry returns "failed"
**Then** the entry is NOT dequeued — it remains in `change_queue`
**And** the next drainQueue() call retries the entry automatically (no special retry logic required)

### AC4 — Error displayed inline on affected sync pair card

**Given** the UI receives a `FILE_LOCKED` error event with `pair_id`
**When** rendering the error
**Then** the affected `SyncPairRow` shows a **red dot** (error state)
**And** the `status_label` shows "Sync error"
**And** the accessible label is `"[pair name] — error"`
**And** the error is non-fatal — no app-level banner, no restart button

### AC5 — Footer bar shows sync error state

**Given** the UI receives a `FILE_LOCKED` error event with `pair_id`
**When** rendering the error
**Then** the `StatusFooterBar` shows `"Sync error in [pair name]"` with a **red dot**

---

## Developer Context

### Architecture overview — READ THIS FIRST

> ⚠️ **Prerequisites:** Story 5-6 must be complete (adds `isPermissionDenied` to sync-engine.ts — this story inserts `isFileLocked` immediately after it). Story 5-7 must be complete (watcher tests only; zero sync-engine.ts impact). Verify before proceeding or `bunx tsc --noEmit` will fail on the missing `isPermissionDenied` reference.

FILE_LOCKED is a pure engine-side classification layer — structurally identical to PERMISSION_DENIED (Story 5-6). The engine already emits `{type: "error", payload: {...}}` on file errors; this story adds an `isFileLocked()` check that intercepts EBUSY and ETXTBSY before the generic `sync_file_error`/`queue_replay_failed` emission.

**The UI requires ZERO changes.** The error routing pipeline built in Story 5-5 handles any `error` event with a `pair_id` automatically:

```
Engine:  EBUSY/ETXTBSY → isFileLocked() → emit FILE_LOCKED event → continue
                                ↓
UI:      error event → engine.py:319-323 → _on_engine_error() (main.py:507)
                                            → window.on_pair_error(pair_id, message)
                                              → SyncPairRow.set_state("error")  ← already done (5-5)
                                              → StatusFooterBar.set_error()     ← already done (5-5)
```

### Critical behavioral comparison across error types

| Behavior | DISK_FULL (5-5) | PERMISSION_DENIED (5-6) | FILE_LOCKED (this story) |
|---|---|---|---|
| After emitting event | `diskFull = true; break;` | `continue` | `continue` |
| Why | ENOSPC: all further writes fail | Per-file; others may sync | Per-file; others may sync |
| processQueueEntry return | `"disk_full"` | `"failed"` | `"failed"` |
| Entry stays in queue | Yes | Yes | Yes |
| Retry mechanism | User action needed | User action needed | Automatic on next cycle |

**Never set `diskFull = true` or `diskFullAbort = true` for FILE_LOCKED.**

### What this story delivers

1. **`engine/src/sync-engine.ts`** — `isFileLocked` helper + FILE_LOCKED classification at 6 error catch sites
2. **`engine/src/sync-engine.test.ts`** — describe block with 9 tests

That is the entire scope. No UI files change. No Blueprint, CSS, Python changes.

---

### Critical implementation details

#### 1. Engine: `isFileLocked` helper (sync-engine.ts)

Add after `isPermissionDenied` (added by Story 5-6), before `// ── Internal types ──`. The exact insertion point after 5-6's helper; use the surrounding pattern, not hard line numbers:

```ts
function isFileLocked(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EBUSY" || code === "ETXTBSY";
}
```

This mirrors the null-guard pattern from `isDiskFull` and `isPermissionDenied`. Two POSIX codes:
- `EBUSY` — resource busy (file locked by another process)
- `ETXTBSY` — text file busy (write to a file that is currently executing)

`basename` is already imported at line 3: `import { join, relative, dirname, basename } from "node:path";`

---

#### 2. Engine: 6 catch sites to modify (sync-engine.ts)

Insert the FILE_LOCKED check **after** the existing `isPermissionDenied` check (added by 5-6) and **before** the generic `emitEvent` call. Never reorder with respect to `isAuthExpired` (must remain first) or `isDiskFull` (must remain second).

**Precedence order in every catch block:**
1. `isAuthExpired(err)` → throw
2. `isDiskFull(err)` → emit DISK_FULL, diskFull = true; break
3. `isPermissionDenied(err)` → emit PERMISSION_DENIED, continue (added by 5-6)
4. `isFileLocked(err)` → emit FILE_LOCKED, continue  ← **ADD HERE**
5. Generic → emit sync_file_error / queue_replay_failed, continue

**Emit pattern (Sites 1–5, in `reconcilePair`):**
```ts
if (isFileLocked(err)) {
  this.emitEvent({
    type: "error",
    payload: {
      code: "FILE_LOCKED",
      message: `${basename(join(pair.local_path, item.relativePath))} is in use — sync will retry when it's released`,
      pair_id: pair.pair_id,
    },
  });
  continue;  // NOT: diskFull = true; break; — other files may still sync
}
```

**Site 1 — conflict copy `copyFile`/`rename` catch (~line 306 + 5-6 shifts)**

After the `isPermissionDenied` block (added by 5-6), before the generic `sync_file_error` emit. `item` is the `conflict` WorkItem.

**Site 2 — conflict_update download catch (~line 347 + shifts)**

`item` is the `conflict` WorkItem. Same pattern as Site 1. Insert after `isPermissionDenied`, before generic emit.

**Site 3 — collision rename catch (~line 371 + shifts)**

`item` is the `new_file_collision` WorkItem. `item.relativePath` gives the colliding local file. Same pattern.

**Site 4 — collision download catch (~line 411 + shifts)**

`item` is the `new_file_collision` WorkItem. Same pattern.

**Site 5 — main download loop catch (~line 497 + shifts)**

`item` is the download/conflict WorkItem. Same pattern.

**Site 6 — `processQueueEntry` outer catch (~line 871 + shifts)**

`entry.relative_path` gives the file path. Use `return "failed"` (not `return "disk_full"`):

```ts
} catch (err) {
  if (isAuthExpired(err)) throw err;
  if (isDiskFull(err)) {
    this.emitEvent({ type: "error", payload: { code: "DISK_FULL", ... } });
    return "disk_full";
  }
  if (isPermissionDenied(err)) {                                        // added by 5-6
    this.emitEvent({ type: "error", payload: { code: "PERMISSION_DENIED", ... } });
    return "failed";
  }
  if (isFileLocked(err)) {                                              // ← ADD
    this.emitEvent({
      type: "error",
      payload: {
        code: "FILE_LOCKED",
        message: `${basename(join(pair.local_path, entry.relative_path))} is in use — sync will retry when it's released`,
        pair_id: pair.pair_id,
      },
    });
    return "failed";                                                     // NOT "disk_full"
  }
  // ... existing queue_replay_failed emission
  return "failed";
}
```

---

#### 3. Message format

- **Sites 1–5 (reconcilePair):** `` `${basename(join(pair.local_path, item.relativePath))} is in use — sync will retry when it's released` ``
- **Site 6 (processQueueEntry):** `` `${basename(join(pair.local_path, entry.relative_path))} is in use — sync will retry when it's released` ``

`basename()` is used (not full path) because:
- The file is actively in use by the user — they know what it is
- The pair card already identifies the sync pair (folder context)
- The epic spec uses `"[file]"` (filename notation, not path notation)

---

#### 4. What NOT to touch

- **`engine/src/ipc.ts`** — `IpcPushEvent` uses `type: string`; no update needed
- **`engine/src/errors.ts`** — FILE_LOCKED is an IPC payload code, not a thrown TypeScript error; no new error class
- **`engine/src/watcher.ts`** — file lock errors don't occur at watch registration; no changes
- **`engine/src/state-db.ts`** — no schema change; entry stays in queue via normal `return "failed"` path
- **All UI files** — `_on_engine_error()`, `on_pair_error()`, `SyncPairRow`, `StatusFooterBar` — already complete from 5-5; no changes needed
- **`ui/data/ui/*.blp`** — no Blueprint changes
- **`ui/data/style.css`** — no CSS changes
- **`delete_local` catch** — `unlink()` EBUSY is uncommon on Linux and out of scope for AC1 ("reading or writing a file"); leave as `sync_file_error`

---

### Key file locations

| File | Change |
|------|--------|
| `engine/src/sync-engine.ts` | Add `isFileLocked` helper after `isPermissionDenied` |
| `engine/src/sync-engine.ts` | FILE_LOCKED check in conflict copy catch (Site 1) |
| `engine/src/sync-engine.ts` | FILE_LOCKED check in conflict_update download catch (Site 2) |
| `engine/src/sync-engine.ts` | FILE_LOCKED check in collision rename catch (Site 3) |
| `engine/src/sync-engine.ts` | FILE_LOCKED check in collision download catch (Site 4) |
| `engine/src/sync-engine.ts` | FILE_LOCKED check in main download loop catch (Site 5) |
| `engine/src/sync-engine.ts` | FILE_LOCKED check in processQueueEntry outer catch (Site 6) |
| `engine/src/sync-engine.test.ts` | FILE_LOCKED describe block (~7-9 tests) |

Note: Line numbers shift after 5-6 and 5-7 implementations. Use surrounding code patterns (comments, function names) rather than hard line numbers.

---

### Previous story learnings (5-1 through 5-7)

- **5-7**: No sync-engine.ts changes — all watcher.ts; doesn't affect line numbers in sync-engine.ts.
- **5-6**: `isPermissionDenied` added to sync-engine.ts for EACCES/EPERM — `isFileLocked` inserts after it; mirror the same null-guard pattern.
- **5-6**: PERMISSION_DENIED uses `continue` (not `diskFull = true; break;`) — FILE_LOCKED is identical.
- **5-6**: PERMISSION_DENIED uses `return "failed"` in processQueueEntry (not `"disk_full"`) — FILE_LOCKED is identical.
- **5-6**: `join(pair.local_path, entry.relative_path)` is the correct path construct in Site 6 (`entry.relative_path`, not `entry.relativePath` — snake_case in DB).
- **5-5**: `isDiskFull` null guard pattern (`err != null && typeof err === "object"`) — copy for `isFileLocked`.
- **5-5**: The ~117 pre-existing test failures (`bun test engine/`) are unrelated; run targeted files only.
- **5-4**: `engine.on_error()` registered at `main.py:102`; IPC dispatch at `engine.py:319-323` — don't touch.
- **5-1**: `SyncEngine` constructor takes 6 params — always pass all 6 when constructing in tests.

### Test baseline

**Assumes Stories 5-6 and 5-7 are done before implementing 5-8.**

Run first to confirm actual baseline:
```bash
bun test engine/src/sync-engine.test.ts engine/src/state-db.test.ts
```
Expected: ≥108 pass (101 from 5-5 baseline + 7 from 5-6 implementation), 0 fail. If your baseline shows more than 108, that's fine — the `≥` is intentional; trust the count you see.

```bash
bun test engine/src/watcher.test.ts
```
Expected: ≥17 pass (14 baseline + 3 from 5-7 implementation), 0 fail.

UI: `.venv/bin/pytest ui/tests/` → 572 passed.

---

## Tasks / Subtasks

- [x] **Task 1: Add `isFileLocked` helper (sync-engine.ts)** (AC: #1, #2)
  - [x] 1.1 Open `engine/src/sync-engine.ts`
  - [x] 1.2 Add `isFileLocked` function after `isPermissionDenied` (added by 5-6), before `// ── Internal types ──`
  - [x] 1.3 Include null/type guard (`err != null && typeof err === "object"`) — mirrors `isDiskFull`/`isPermissionDenied` pattern
  - [x] 1.4 Check `.code === "EBUSY" || .code === "ETXTBSY"`
  - [x] 1.5 Confirm `basename` is in the `node:path` import near the top of the file — look for `import { ..., basename, ... } from "node:path"`. It should be present from the engine's initial setup; if missing, add `basename` to the existing import.

- [x] **Task 2: Insert FILE_LOCKED checks at 6 catch sites (sync-engine.ts)** (AC: #1, #2, #3)
  - [x] 2.1 Site 1 — conflict copy catch: add after `isPermissionDenied` check, use `continue`
  - [x] 2.2 Site 2 — conflict_update download catch: add after `isPermissionDenied` check, use `continue`
  - [x] 2.3 Site 3 — collision rename catch: add after `isPermissionDenied` check, use `continue`
  - [x] 2.4 Site 4 — collision download catch: add after `isPermissionDenied` check, use `continue`
  - [x] 2.5 Site 5 — main download loop catch: add after `isPermissionDenied` check, use `continue`
  - [x] 2.6 Site 6 — processQueueEntry outer catch: add after `isPermissionDenied` check, use `return "failed"` (NOT `"disk_full"`)
  - [x] 2.7 Message at Sites 1–5: `` `${basename(join(pair.local_path, item.relativePath))} is in use — sync will retry when it's released` ``
  - [x] 2.8 Message at Site 6: `` `${basename(join(pair.local_path, entry.relative_path))} is in use — sync will retry when it's released` `` (note: `entry.relative_path` snake_case, not `entry.relativePath`)
  - [x] 2.9 `bunx tsc --noEmit` from `engine/` — zero type errors

- [x] **Task 3: Tests** (all ACs)
  - [x] 3.1 `engine/src/sync-engine.test.ts` — add describe block `"SyncEngine — FILE_LOCKED detection (Story 5-8)"`:
    - `isFileLocked(null)` → false (null guard test)
    - `isFileLocked({ code: "EBUSY" })` → true
    - `isFileLocked({ code: "ETXTBSY" })` → true
    - `isFileLocked({ code: "EACCES" })` → false (must not overlap PERMISSION_DENIED)
    - `isFileLocked({ code: "ENOSPC" })` → false (must not overlap DISK_FULL)
    - processQueueEntry mock: EBUSY thrown → emits FILE_LOCKED, returns "failed"
    - processQueueEntry mock: ETXTBSY thrown → emits FILE_LOCKED, returns "failed"
    - Regression: EACCES thrown → still emits PERMISSION_DENIED, returns "failed" (confirm 5-6 not broken)
    - Regression: ENOSPC thrown → still emits DISK_FULL, returns "disk_full" (confirm 5-5 not broken)
  - [x] 3.2 No queue-persistence unit test needed for AC3 — the mechanism (returning `"failed"` without calling `commitDequeue()`) is covered by the existing queue-drainer integration tests from Story 3-2; the regression tests above confirm return values remain correct.
  - [x] 3.3 No UI test changes needed — no UI code changed

- [x] **Task 4: Final validation**
  - [x] 4.1 `bunx tsc --noEmit` from `engine/` — zero type errors
  - [x] 4.2 `bun test engine/src/sync-engine.test.ts engine/src/state-db.test.ts` — 116 pass (107 baseline + 9 new), 0 fail
  - [x] 4.3 `bun test engine/src/watcher.test.ts` — 17 pass, no regressions
  - [x] 4.4 `meson compile -C ui/builddir` — zero errors (no UI changes, build clean)
  - [x] 4.5 `.venv/bin/pytest ui/tests/` → 572 passed, no regressions
  - [x] 4.6 Set story Status to `review`

---

## Dev Notes

### §1 — Why FILE_LOCKED does not abort the drain pass

DISK_FULL aborts because ENOSPC means every subsequent write will also fail. EBUSY/ETXTBSY are per-file: the locked file is in use by the user (e.g., a spreadsheet open in LibreOffice), but all other files in the pair sync fine. Aborting on first FILE_LOCKED would silently stall all other queued changes. Emit and `continue` is the correct behavior.

### §2 — Why ETXTBSY is included alongside EBUSY

EBUSY is the general "file locked" error. ETXTBSY ("text file busy") occurs specifically when attempting to write to a file that is currently being executed — e.g., a binary or script that's running. Both are transient (will resolve when the process finishes or releases the file). Both map to the same user message and retry behavior.

### §3 — Why `basename()` for the message (not full path)

PERMISSION_DENIED uses the full path because the user must navigate to the specific location to fix permissions. FILE_LOCKED uses just the filename because:
1. The user already has the file open — they know where it is
2. The message is informational/transient — no action required
3. The epic spec uses `"[file]"` notation (filename, not path)

### §4 — Why no new error class in `errors.ts`

Same reasoning as 5-5 and 5-6: FILE_LOCKED is an IPC event payload code, not a thrown TypeScript error. The engine catches the raw Node.js filesystem error and translates it to the IPC code at the emit site. No intermediate class needed.

### §5 — The retry is automatic — no special logic needed

When processQueueEntry returns `"failed"`, drainQueue increments `failed++` but does NOT call `commitDequeue()`. The entry stays in `change_queue`. The next drainQueue() call (triggered by the next sync cycle via inotify or periodic check) picks up all remaining entries. The message "sync will retry when it's released" is therefore accurate — the retry is guaranteed by the existing queue mechanism.

### §6 — Deferred items from 5-5 that interact with this story

Same as PERMISSION_DENIED and DISK_FULL:
- **Multi-pair error footer overwrite** — second FILE_LOCKED for a different pair replaces first pair name in StatusFooterBar — deferred to Story 5-9
- **`on_online` clears error state** — offline→online transition calls `row.set_state("synced")` regardless of error state — deferred to Story 5-9
- **Screen-reader flood** — multiple FILE_LOCKED events per cycle → multiple announces — deferred to Story 5-9

Do not attempt to fix these deferred items in this story.

### §7 — EBUSY vs Windows vs Linux behavior note

On Windows, EBUSY occurs frequently for files held open by other processes (file handle locking). On Linux, EBUSY is less common for file I/O (Linux uses advisory locks) but can occur when:
- A file is open with `O_EXCL` by another process
- A mount point is busy
- Certain filesystem operations on active files

ETXTBSY is Linux-specific. Both are valid to handle for robustness. The implementation is platform-safe since the null-guard pattern only checks `.code`, not platform-specific object shape.

### Project Structure Notes

**Files to modify:**
- `engine/src/sync-engine.ts` — `isFileLocked` helper + FILE_LOCKED checks at 6 catch sites
- `engine/src/sync-engine.test.ts` — FILE_LOCKED describe block (~9 tests)

**Files to create:** none

**Do NOT modify:**
- `engine/src/ipc.ts` — type is `string`, no update needed
- `engine/src/errors.ts` — no new error class
- `engine/src/watcher.ts` — watcher never touches file content; file lock doesn't apply at watch registration
- `engine/src/state-db.ts` — no schema changes
- All `ui/` files — pipeline complete from Story 5-5

---

### References

- Epic 5 story definition: `_bmad-output/planning-artifacts/epics/epic-5-token-expiry-error-recovery.md#Story-5.8`
- Story 5-6 (PERMISSION_DENIED — structural model for this story): `_bmad-output/implementation-artifacts/5-6-actionable-error-permission-denied.md`
- Story 5-5 (DISK_FULL — establishes all UI machinery): `_bmad-output/implementation-artifacts/5-5-actionable-error-disk-full.md`
- `isDiskFull` helper (model for `isFileLocked`): `engine/src/sync-engine.ts:29-31`
- `isPermissionDenied` helper (immediate predecessor, added by 5-6): `engine/src/sync-engine.ts` (after `isDiskFull`)
- 6 catch site patterns (with `isDiskFull` + `isPermissionDenied` already inserted): `engine/src/sync-engine.ts:306-510, 871-895`
- `engine.py` error dispatch (code-agnostic): `ui/src/protondrive/engine.py:319-323`
- `_on_engine_error()` (routes any non-fatal+pair_id to pair card): `ui/src/protondrive/main.py:507-512`
- `on_pair_error()`: `ui/src/protondrive/window.py`
- `SyncPairRow.set_state("error")`: `ui/src/protondrive/widgets/sync_pair_row.py`
- `StatusFooterBar.set_error()`: `ui/src/protondrive/widgets/status_footer_bar.py`
- Project context (naming, test commands, architecture rules): `_bmad-output/project-context.md`

---

## Review Findings

- [x] [Review][Decision] Direct predicate unit tests for `isFileLocked()` missing from spec — Spec task 3.1 lists 5 direct-call predicate tests (`isFileLocked(null)→false`, `isFileLocked({code:"EBUSY"})→true`, `isFileLocked({code:"ETXTBSY"})→true`, `isFileLocked({code:"EACCES"})→false`, `isFileLocked({code:"ENOSPC"})→false`). Implementation has 9 integration tests via `drainQueue()` that cover the same behaviors, but no direct calls. Function is private (not exported), so direct testing requires export or test-internal wrapper. Decision: accept integration coverage as sufficient (match established `isDiskFull` / `isPermissionDenied` pattern), or export function and add predicate tests. `engine/src/sync-engine.test.ts:2511`
- [x] [Review][Defer] Null guard test only asserts negative — Test "null error in processQueueEntry → FILE_LOCKED NOT emitted" at line 2539 asserts FILE_LOCKED is not emitted when `throw null` is used, but does not assert SDK_ERROR IS emitted. If null silently vanished from the error pipeline (regression), this test would not catch it. Low risk; null guard pattern is well-established and tested indirectly. `engine/src/sync-engine.test.ts:2539` — deferred, pre-existing test design choice
- [x] [Review][Defer] `delete_local` catch: PERMISSION_DENIED and FILE_LOCKED not checked — The `unlink()` failure path at `engine/src/sync-engine.ts:491` does not include `isPermissionDenied` or `isFileLocked` checks. An EPERM on `unlink()` (directory became read-only) emits SDK_ERROR instead of PERMISSION_DENIED. Story 5-8 spec explicitly excludes FILE_LOCKED for `delete_local`; Story 5-6 also omitted PERMISSION_DENIED here. `engine/src/sync-engine.ts:491` — deferred, pre-existing gap from 5-6, out of 5-8 scope

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- Added `isFileLocked(err)` helper after `isPermissionDenied` in `sync-engine.ts` — same null-guard pattern, checks EBUSY/ETXTBSY
- Inserted FILE_LOCKED catch block at all 6 error sites in `reconcilePair` (Sites 1–5, `continue`) and `processQueueEntry` (Site 6, `return "failed"`)
- Message uses `basename()` at all sites per spec — filename only, not full path
- Site 6 uses `entry.relative_path` (snake_case from DB), Sites 1–5 use `item.relativePath` (camelCase WorkItem)
- Zero UI changes — existing error routing pipeline from Story 5-5 handles FILE_LOCKED automatically
- Added 9-test describe block: null guard, EBUSY, ETXTBSY, message content, pair_id, non-locked EIO, and regressions for EACCES (5-6) and ENOSPC (5-5)
- Final: 116 pass / 0 fail (sync-engine + state-db), 17 pass (watcher), 572 pass (UI), tsc clean

### File List

- `engine/src/sync-engine.ts`
- `engine/src/sync-engine.test.ts`
