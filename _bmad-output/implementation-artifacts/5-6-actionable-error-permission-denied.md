# Story 5.6: Actionable Error — Permission Denied

Status: done

## Story

As a user,
I want a clear message when sync fails due to folder permissions,
so that I can fix the permissions and resume syncing.

## Acceptance Criteria

### AC1 — PERMISSION_DENIED error emitted on EACCES/EPERM during file operation

**Given** the sync engine encounters an EACCES or EPERM error when reading or writing a file
**When** the error is processed
**Then** an `error` push event is emitted with:
  - `code: "PERMISSION_DENIED"`
  - `message: "Check folder permissions for <local_file_path>"` (where `<local_file_path>` is the specific file path that failed, e.g. `join(pair.local_path, item.relativePath)`)
  - `pair_id: <affected pair's pair_id>`

### AC2 — Non-EACCES/EPERM errors continue to emit existing generic codes

**Given** the sync engine encounters a filesystem error other than EACCES or EPERM (e.g. EIO, ENOENT, ENOSPC)
**When** the error is processed
**Then** the existing error code (`sync_file_error`, `DISK_FULL`, `queue_replay_failed`, etc.) is emitted unchanged
**And** no `PERMISSION_DENIED` event is emitted

### AC3 — Error displayed inline on affected sync pair card

**Given** the UI receives a `PERMISSION_DENIED` error event with `pair_id`
**When** rendering the error
**Then** the affected `SyncPairRow` shows a **red dot** (error state)
**And** the `status_label` shows "Sync error"
**And** the accessible label is `"[pair name] — error"`
**And** the error is non-fatal — no app-level banner, no restart button

### AC4 — Footer bar shows sync error state

**Given** the UI receives a `PERMISSION_DENIED` error event with `pair_id`
**When** rendering the error
**Then** the `StatusFooterBar` shows `"Sync error in [pair name]"` with a **red dot**

---

## Developer Context

### Architecture overview — READ THIS FIRST

PERMISSION_DENIED is a pure engine-side classification layer. The engine already emits `{type: "error", payload: {...}}` on file errors; this story adds an `isPermissionDenied()` check that intercepts EACCES and EPERM before the generic `sync_file_error`/`queue_replay_failed` emission.

**The UI requires ZERO changes.** The error routing pipeline built in Story 5-5 handles any `error` event with a `pair_id` automatically:

```
Engine:  EACCES/EPERM → isPermissionDenied() → emit PERMISSION_DENIED event
                                ↓
UI:      error event → engine.py:319-323 → _on_engine_error() (main.py:507)
                                            → window.on_pair_error(pair_id, message)
                                              → SyncPairRow.set_state("error")  ← already done
                                              → StatusFooterBar.set_error()     ← already done
```

The `engine.py:319-323` dispatch reads `payload.get("message")` and forwards to `_on_engine_error` WITHOUT filtering by `payload.get("code")`. Any error event with a `pair_id` routes to the pair card — PERMISSION_DENIED included.

### Critical behavioral difference from DISK_FULL

| Behavior | DISK_FULL (Story 5-5) | PERMISSION_DENIED (this story) |
|---|---|---|
| After emitting event | `diskFull = true; break;` → abort drain | `continue` / `return "failed"` — process next file |
| Why | ENOSPC: all further writes will also fail | EACCES/EPERM: per-file; other files in the pair may sync fine |
| Drain abort | Yes — `reconcilePair` returns early; `processQueueEntry` returns `"disk_full"` | No — same control flow as `sync_file_error` |

**Never set `diskFull = true` or `diskFullAbort = true` for PERMISSION_DENIED.**

### What this story delivers

1. **`engine/src/sync-engine.ts`** — `isPermissionDenied` helper + PERMISSION_DENIED classification at 6 error catch sites

That is the entire scope. No UI files change. No Blueprint, CSS, or Python changes.

---

### Critical implementation details

#### 1. Engine: `isPermissionDenied` helper (sync-engine.ts)

Add after `isDiskFull` (line 31), before `// ── Internal types ──` (inserts 5 lines; Sites 2–6 shift accordingly — use surrounding code patterns, not hard line numbers):

```ts
function isPermissionDenied(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}
```

This mirrors the `isDiskFull` null guard pattern added in Story 5-5 review. Never cast directly — EPERM and EACCES are the two POSIX permission-denied codes. EACCES = permission denied on a path; EPERM = operation not permitted (often on protected files or cross-device operations).

---

#### 2. Engine: 6 catch sites to modify (sync-engine.ts)

Insert the PERMISSION_DENIED check **after** the existing `isDiskFull` check and **before** the generic `emitEvent` call. Never reorder with respect to `isAuthExpired` (must remain first).

**Emit pattern (Sites 1–5, in `reconcilePair`):**
```ts
if (isPermissionDenied(err)) {
  this.emitEvent({
    type: "error",
    payload: {
      code: "PERMISSION_DENIED",
      message: `Check folder permissions for ${join(pair.local_path, item.relativePath)}`,
      pair_id: pair.pair_id,
    },
  });
  continue;  // NOT: diskFull = true; break; — other files may still sync
}
```

**Site 1 — conflict copy `copyFile`/`rename` catch (~line 306)**

Current (after 5-5):
```ts
} catch (err) {
  try { await unlink(tmpPath); } catch { /* already gone */ }
  const msg = err instanceof Error ? err.message : String(err);
  debugLog(`sync-engine: conflict copy creation failed for ${item.relativePath}: ${msg}`);
  if (isDiskFull(err)) {
    this.emitEvent({ type: "error", payload: { code: "DISK_FULL", ... } });
    diskFull = true; break;
  }
  this.emitEvent({ type: "error", payload: { code: "sync_file_error", msg, pair_id } });
  continue;
}
```

Insert after the `isDiskFull` block, before the existing `emitEvent`:
```ts
if (isPermissionDenied(err)) {
  this.emitEvent({ type: "error", payload: { code: "PERMISSION_DENIED", message: `Check folder permissions for ${join(pair.local_path, item.relativePath)}`, pair_id: pair.pair_id } });
  continue;
}
```

**Site 2 — conflict_update download catch (~line 347)**

`item` is the `conflict_update` WorkItem; `item.relativePath` gives the destination file. Same pattern as Site 1. Insert after `isDiskFull` check, before generic `emitEvent`.

**Site 3 — collision rename catch (~line 371)**

`item.relativePath` gives the colliding local file. Same pattern.

**Site 4 — collision download catch (~line 411)**

`item.relativePath` gives the destination file. Same pattern.

**Site 5 — main download loop catch (~line 497)**

`item.relativePath` gives the destination file. Same pattern.

**Site 6 — `processQueueEntry` outer catch (~line 871)**

`entry.relative_path` gives the file path. Use `return "failed"` (not `return "disk_full"`):

```ts
} catch (err) {
  if (isAuthExpired(err)) throw err;
  if (isDiskFull(err)) {
    this.emitEvent({ type: "error", payload: { code: "DISK_FULL", ... } });
    return "disk_full";
  }
  if (isPermissionDenied(err)) {                                          // ← ADD
    this.emitEvent({
      type: "error",
      payload: {
        code: "PERMISSION_DENIED",
        message: `Check folder permissions for ${join(pair.local_path, entry.relative_path)}`,
        pair_id: pair.pair_id,
      },
    });
    return "failed";                                                       // ← NOT "disk_full"
  }
  // ... existing queue_replay_failed emission
  return "failed";
}
```

---

#### 3. What NOT to touch

- **`engine/src/ipc.ts`** — `IpcPushEvent` uses `type: string`; no update needed
- **`engine/src/errors.ts`** — PERMISSION_DENIED is an IPC payload code, not a thrown TypeScript error; no new error class
- **`engine/src/watcher.ts`** — INOTIFY_LIMIT (Story 5-7) handles ENOSPC in inotify; watcher EACCES on `readdir` (inaccessible subdirectories) is already silently skipped (only the subdirectory is omitted from watching) — do not change this behavior
- **`delete_local` catch (~line 431)** — `unlink()` EACCES/EPERM is out of scope per AC1 ("reading or writing a file"); deletion permission errors emit `sync_file_error` by design — do NOT add PERMISSION_DENIED here
- **All UI files** — `_on_engine_error()`, `on_pair_error()`, `SyncPairRow`, `StatusFooterBar` — already complete from 5-5; no changes needed
- **`ui/data/ui/*.blp`** — no Blueprint changes
- **`ui/data/style.css`** — no CSS changes

---

### Key file locations

| File | Change |
|------|--------|
| `engine/src/sync-engine.ts:31` | Add `isPermissionDenied` helper after `isDiskFull` |
| `engine/src/sync-engine.ts:~310` | PERMISSION_DENIED check in conflict copy catch (Site 1) |
| `engine/src/sync-engine.ts:~351` | PERMISSION_DENIED check in conflict_update download catch (Site 2) |
| `engine/src/sync-engine.ts:~374` | PERMISSION_DENIED check in collision rename catch (Site 3) |
| `engine/src/sync-engine.ts:~415` | PERMISSION_DENIED check in collision download catch (Site 4) |
| `engine/src/sync-engine.ts:~501` | PERMISSION_DENIED check in main download loop catch (Site 5) |
| `engine/src/sync-engine.ts:~874` | PERMISSION_DENIED check in processQueueEntry outer catch (Site 6) |

Note: Line numbers are from Story 5-5 completion. After inserting the `isPermissionDenied` helper (2 lines), Sites 2–6 shift by +2. Use the surrounding code patterns (comments, function names) rather than hard line numbers.

---

### Previous story learnings (5-1 through 5-5)

- **5-5**: `isDiskFull` helper is at line 29–31 with null guard — mirror this pattern exactly for `isPermissionDenied`.
- **5-5**: `diskFull = true; break;` aborts reconcilePair loop — do NOT use this for PERMISSION_DENIED.
- **5-5**: `return "disk_full"` signals drainQueue to abort — do NOT use for PERMISSION_DENIED; use `return "failed"`.
- **5-5**: The 117 pre-existing test failures (`bun test engine/`) are unrelated; run targeted `bun test engine/src/sync-engine.test.ts engine/src/state-db.test.ts` → 101 pass baseline.
- **5-5 review patch**: `isDiskFull` originally had an unsafe cast; the null guard `err != null && typeof err === "object"` was added post-review — copy this guard for `isPermissionDenied`.
- **5-4**: `engine.on_error()` registered at `main.py:102`; IPC dispatch at `engine.py:319-323` — don't touch these.
- **5-1**: `SyncEngine` constructor takes 6 params — if adding test describe blocks that construct the engine, always pass all 6.

### Test baseline (from 5-5 completion)

- Engine: `bun test engine/src/sync-engine.test.ts engine/src/state-db.test.ts` → 101 pass, 0 fail
- UI: `.venv/bin/pytest ui/tests/` → 572 passed

---

## Tasks / Subtasks

- [x] **Task 1: Add `isPermissionDenied` helper (sync-engine.ts)** (AC: #1, #2)
  - [x] 1.1 Open `engine/src/sync-engine.ts`
  - [x] 1.2 Add `isPermissionDenied` function after `isDiskFull` (line 31), before `// ── Internal types ──`
  - [x] 1.3 Include null/type guard (`err != null && typeof err === "object"`) — mirrors `isDiskFull` post-review pattern
  - [x] 1.4 Check `.code === "EACCES" || .code === "EPERM"`

- [x] **Task 2: Insert PERMISSION_DENIED checks at 6 catch sites (sync-engine.ts)** (AC: #1, #2)
  - [x] 2.1 Site 1 — conflict copy catch (~line 306): add after `isDiskFull` check, use `continue` (not `diskFull = true; break;`)
  - [x] 2.2 Site 2 — conflict_update download catch (~line 347): add after `isDiskFull` check, use `continue`
  - [x] 2.3 Site 3 — collision rename catch (~line 371): add after `isDiskFull` check, use `continue`
  - [x] 2.4 Site 4 — collision download catch (~line 411): add after `isDiskFull` check, use `continue`
  - [x] 2.5 Site 5 — main download loop catch (~line 497): add after `isDiskFull` check, use `continue`
  - [x] 2.6 Site 6 — processQueueEntry outer catch (~line 871): add after `isDiskFull` check, use `return "failed"` (NOT `"disk_full"`)
  - [x] 2.7 Message format at Sites 1–5: `` `Check folder permissions for ${join(pair.local_path, item.relativePath)}` ``
  - [x] 2.8 Message format at Site 6: `` `Check folder permissions for ${join(pair.local_path, entry.relative_path)}` ``
  - [x] 2.9 `bunx tsc --noEmit` from `engine/` — zero type errors

- [x] **Task 3: Tests** (all ACs)
  - [x] 3.1 `engine/src/sync-engine.test.ts` — added describe block `"SyncEngine — PERMISSION_DENIED detection (Story 5-6)"` with 6 tests (EACCES emits PERMISSION_DENIED, EPERM emits PERMISSION_DENIED, ENOSPC regression, EIO non-permission regression, message format, null guard). Also updated 2 pre-existing tests that used chmod 0o555 (which generates EACCES) to expect PERMISSION_DENIED instead of sync_file_error — this is correct behavior change.
  - [x] 3.2 No UI test changes needed — no UI code changed

- [x] **Task 4: Final validation**
  - [x] 4.1 `bunx tsc --noEmit` from `engine/` — zero type errors
  - [x] 4.2 `bun test engine/src/sync-engine.test.ts engine/src/state-db.test.ts` — 107 pass (101 baseline + 6 new), 0 fail
  - [x] 4.3 `meson compile -C ui/builddir` — zero errors
  - [x] 4.4 `.venv/bin/pytest ui/tests/` — 572 passed, no regressions
  - [x] 4.5 Set story Status to `review`

---

## Dev Notes

### §1 — Why PERMISSION_DENIED does not abort the drain pass

DISK_FULL aborts the entire drain pass because ENOSPC means every subsequent write will also fail — there is no point trying the next queued entry. EACCES/EPERM are per-file — the user's `~/ProtonDrive/readonly-folder/file.txt` may be read-only while `~/ProtonDrive/normal-folder/doc.txt` is perfectly writable. Aborting on first PERMISSION_DENIED would silently stall all other queued changes. Emit and `continue` is the correct behavior.

### §2 — Why EPERM is included alongside EACCES

EACCES is the classic "permission denied" error (insufficient file mode bits). EPERM means "operation not permitted" — it occurs on operations the OS disallows regardless of file mode (e.g., creating hard links across filesystems, overwriting immutable files, renaming across mounts). Both are user-fixable by adjusting filesystem permissions or attributes. A user who sees "Check folder permissions for /path/file" will understand both cases, even if EPERM is technically broader.

### §3 — Why no new error class in `errors.ts`

Same reasoning as Story 5-5 §2: PERMISSION_DENIED is an IPC event payload code, not a thrown TypeScript error. The engine catches the raw Node.js filesystem error and translates it to the IPC code at the emit site. No intermediate class needed.

### §4 — UI works without any changes

Story 5-5 built the complete error display pipeline:
1. `engine.py:319-323` dispatches any `error` event with `pair_id` → `_on_engine_error()`
2. `main.py:507-512` routes non-fatal errors with `pair_id` → `window.on_pair_error()`
3. `window.on_pair_error()` calls `row.set_state("error")` and `status_footer_bar.set_error()`

None of these check `payload.code`. PERMISSION_DENIED flows through identically to DISK_FULL. The pair card shows "Sync error" (red dot), footer shows "Sync error in [pair name]". This is correct behavior.

### §5 — Test strategy for EACCES

Triggering real EACCES in tests is possible (`chmod(path, 0o000)`) but unreliable in CI (tests may run as root; `chmod` is platform-dependent). Use the same mock approach as Story 5-5 §5: construct an error object with `.code = "EACCES"` and pass it via mock to `processQueueEntry`. The `isPermissionDenied` helper is a one-liner — unit-test it directly with constructed error objects, no real filesystem needed.

### §6 — Deferred items from 5-5 that interact with this story

From the 5-5 Review Findings, these deferred issues also apply to PERMISSION_DENIED:
- **Multi-pair error footer overwrite** — second PERMISSION_DENIED for a different pair replaces first pair name in StatusFooterBar (same as DISK_FULL) — deferred to Story 5-9
- **`on_online` clears error state** — offline→online transition calls `row.set_state("synced")` regardless of error state — deferred to Story 5-9
- **Screen-reader flood** — multiple PERMISSION_DENIED events per cycle → multiple HIGH-priority announces — deferred to Story 5-9

Do not attempt to fix these deferred items in this story.

### Project Structure Notes

**Files to modify:**
- `engine/src/sync-engine.ts` — `isPermissionDenied` helper + PERMISSION_DENIED checks at 6 catch sites
- `engine/src/sync-engine.test.ts` — PERMISSION_DENIED describe block (~7 tests)

**Files to create:** none

**Do NOT modify:**
- `engine/src/ipc.ts` — type is `string`, no update needed
- `engine/src/errors.ts` — no new error class
- `engine/src/watcher.ts` — INOTIFY_LIMIT is separate; watcher EACCES on readdir is intentionally silenced
- All `ui/` files — complete from Story 5-5

---

### References

- Epic 5 story definition: `_bmad-output/planning-artifacts/epics/epic-5-token-expiry-error-recovery.md#Story-5.6`
- Story 5-5 (completed predecessor, establishes all UI machinery): `_bmad-output/implementation-artifacts/5-5-actionable-error-disk-full.md`
- `isDiskFull` helper (model for `isPermissionDenied`): `engine/src/sync-engine.ts:29-31`
- `isAuthExpired` helper: `engine/src/sync-engine.ts:25-27`
- 6 catch site patterns (with `isDiskFull` already inserted): `engine/src/sync-engine.ts:306-510, 871-895`
- `engine.py` error dispatch (code-agnostic): `ui/src/protondrive/engine.py:319-323`
- `_on_engine_error()` (routes any non-fatal+pair_id to pair card): `ui/src/protondrive/main.py:507-512`
- `on_pair_error()`: `ui/src/protondrive/window.py`
- `SyncPairRow.set_state("error")`: `ui/src/protondrive/widgets/sync_pair_row.py`
- `StatusFooterBar.set_error()`: `ui/src/protondrive/widgets/status_footer_bar.py`
- Project context (naming, test commands, architecture rules): `_bmad-output/project-context.md`
- INOTIFY_LIMIT ENOSPC detection (watcher, NOT this story): `engine/src/watcher.ts:66`

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

None — implementation was straightforward. Two pre-existing tests that used `chmodSync(tmpDir, 0o555)` to trigger rename/copyFile failures now correctly expect `PERMISSION_DENIED` instead of `sync_file_error` (EACCES from chmod now routes through the new helper). The subfolder path test was adjusted to use flat paths because `processQueueEntry` bails early with `queue_replay_failed` when the remote parent folder is not in `remoteFolders` map.

### Completion Notes List

- Added `isPermissionDenied` helper at `engine/src/sync-engine.ts:33-38` — mirrors `isDiskFull` null guard pattern
- Inserted PERMISSION_DENIED checks at all 6 catch sites (Sites 1–5 use `continue`, Site 6 uses `return "failed"`)
- Added 6-test describe block in `engine/src/sync-engine.test.ts` covering EACCES, EPERM, ENOSPC regression, EIO regression, message format, and null guard
- Updated 2 pre-existing tests to expect `PERMISSION_DENIED` (correct behavior — they were testing chmod-induced EACCES)
- Final counts: 107 pass / 0 fail (engine tests), 572 passed (UI tests), zero TypeScript errors, zero meson errors

### File List

- `engine/src/sync-engine.ts`
- `engine/src/sync-engine.test.ts`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

### Review Findings

- [x] [Review][Defer] Sites 2–5 in reconcilePair lack dedicated PERMISSION_DENIED tests [engine/src/sync-engine.test.ts] — deferred, pre-existing; reconcilePair Sites 2 (conflict_update download), 3 (collision rename), 4 (collision download), 5 (main download loop) have no dedicated tests for PERMISSION_DENIED; Site 1 covered by updated pre-existing test, Site 6 covered by 6 new drainQueue tests; pattern is identical across all sites
- [x] [Review][Defer] stat() inner catch emits queue_replay_failed not PERMISSION_DENIED for EACCES/EPERM [engine/src/sync-engine.ts:796-818] — deferred, pre-existing; inner try/catch for stat() fires before outer isPermissionDenied check at line 903; out of scope for the 6 specified catch sites; relevant path documented in code comment ("Other errors (EACCES, EPERM, EIO, …) are genuine failures")
- [x] [Review][Defer] Infinite retry risk on permanently permission-denied files (no backoff/dead-letter) [engine/src/sync-engine.ts] — deferred, pre-existing architecture; PERMISSION_DENIED uses continue same as sync_file_error; no retry counter or dead-letter mechanism exists; pre-existing pattern also deferred in earlier stories
