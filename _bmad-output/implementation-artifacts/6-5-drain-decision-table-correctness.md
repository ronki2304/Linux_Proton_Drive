# Story 6.5: Drain Decision Table Correctness

Status: done
Review: done

## Story

As a user,
I want file deletions and uploads to be handled correctly by the drain queue in all edge cases,
so that deleted files are reliably trashed on ProtonDrive and remote-only files are downloaded rather than silently dropped.

## Background

The drain's `processQueueEntry` decision table had several incorrect outcomes discovered during live testing.
The table below is the sole source of truth for drain behaviour after this story.

### Decision Table

`state` = sync_state row exists in SQLite; `remote` = file present in live remote snapshot;
`mtime` = `state.remote_mtime` vs `remote.remote_mtime` (stored vs current API value).

#### created / modified entries

| state | remote | mtime / local | outcome | rationale |
|-------|--------|---------------|---------|-----------|
| undef | undef  | —             | upload  | New local file, not on remote yet |
| undef | def    | local newer   | upload  | Bootstrap: local wins over stale remote |
| undef | def    | local older   | download | Remote is authoritative — was wrong: conflict |
| undef | def    | local gone (ENOENT) | download | Local vanished before drain ran; remote is only truth — was wrong: conflict |
| def   | undef  | —             | upload  | Remote deleted elsewhere; local change wins, recreate it — was wrong: conflict |
| def   | def    | mtime match   | upload  | Local modified, remote stable → safe to overwrite |
| def   | def    | mtime differ  | conflict | Both sides changed; copy local to `.conflict-DATE-…`, dequeue |

#### deleted entries

| state | remote | mtime | outcome | rationale |
|-------|--------|-------|---------|-----------|
| undef | undef  | —     | dequeue | Both sides already gone — in sync |
| undef | def    | —     | dequeue | Local delete of file we never tracked; remote is unrelated — was wrong: conflict |
| def   | undef  | —     | dequeue + del state | Remote already gone elsewhere; clear state |
| def   | def    | mtime match | trashNode | User deleted; remote unchanged → safe to trash |
| def   | def    | mtime differ | download | Remote has newer version user hadn't seen; restore it — was wrong: conflict |

## Acceptance Criteria

1. **Fix 1 — created/mod, undef state, remote older**: `processQueueEntry` routes to `download` (was: conflict).
2. **Fix 2 — created/mod, undef state, local gone (ENOENT)**: routes to `download` (was: conflict).
3. **Fix 3 — created/mod, def state, remote undef**: routes to `upload` (was: conflict).
4. **Fix 4 — deleted, undef state, remote def**: routes to `dequeue` (was: conflict, silent drop).
5. **Fix 5 — deleted, def state, remote def, mtime differ**: routes to `download` (was: conflict, silent drop).
6. All existing `sync-engine.test.ts` tests pass. New tests cover each of the 5 fixed rows.
7. `bun test` exits 0 from `engine/`.

## Tasks / Subtasks

- [ ] Task 1 — Apply fixes to `processQueueEntry` in `engine/src/sync-engine.ts` (AC: 1–5)
  - [ ] 1.1 — Fix created/mod, undef/defined, local older: replace conflict outcome with inline `downloadOne` → update sync_state → dequeue
  - [ ] 1.2 — Fix created/mod, undef/defined, local gone (ENOENT): replace conflict outcome with inline `downloadOne` → update sync_state → dequeue
  - [ ] 1.3 — Fix created/mod, defined/undef: replace conflict outcome with upload
  - [ ] 1.4 — Fix deleted, undef/defined: replace conflict outcome with dequeue (leave remote untouched)
  - [ ] 1.5 — Fix deleted, defined/defined, mtime differ: replace conflict outcome with inline `downloadOne` → update sync_state → dequeue

- [ ] Task 2 — Tests for each fixed row (AC: 6)
  - [ ] 2.1 — Test: created/mod, no state, remote newer → downloadFile called, no upload
  - [ ] 2.2 — Test: created/mod, no state, local gone at drain time → downloadFile called
  - [ ] 2.3 — Test: created/mod, state exists, remote gone → uploadFile called
  - [ ] 2.4 — Test: deleted, no state, remote exists → dequeue only, trashNode NOT called
  - [ ] 2.5 — Test: deleted, state exists, remote mtime changed → downloadFile called, trashNode NOT called

## Dev Notes

- `downloadOne(pair, item, client)` is already available as a private method on `SyncEngine` — call it directly from `processQueueEntry`.
- After a successful inline download, commit via `stateDb.commitUpload({ local_mtime: remote.remote_mtime, remote_mtime: remote.remote_mtime, ... }, entry.id)` to atomically update sync_state and dequeue.
- For Fix 3 (upload when remote undef), the existing `upload` outcome path already handles the full flow — just route the outcome correctly.
- For Fix 4 (deleted, undef/defined), use `stateDb.dequeue(entry.id)` — no sync_state to delete since `state` is undefined.

## Review Findings

### Decision Needed
- [x] [Review][Decision] Fix 5 `inline_download` silently reverses local deletion with no user notification — **dismissed (D1-B)**: behavior matches spec ("restore it"), no event needed
- [x] [Review][Decision] `conflict` case in drainQueue dequeues unconditionally even when conflict copy creation fails — **resolved (D2-A)**: promote to patch — only dequeue after successful copy
- [x] [Review][Decision] `bootstrap_match` uses mtime-second + size as equality heuristic — **dismissed (D3-A)**: heuristic accepted, collision is very rare

### Patches
- [x] [Review][Patch] `inline_download` stores `remote!.remote_mtime` as `local_mtime` but `downloadOne` does not set file mtime — fixed: stat() after download, use real OS mtime [engine/src/sync-engine.ts ~1065]
- [x] [Review][Patch] `localStat.mtime.toISOString() >= remote.remote_mtime` string comparison is precision-sensitive — fixed: `new Date(...).getTime()` numeric comparison [engine/src/sync-engine.ts ~872]
- [x] [Review][Patch] FSWatcher `filename` argument can be `null` on Linux — fixed: `if (!filename || filename !== pairRootName) return;` [engine/src/watcher.ts ~101]
- [x] [Review][Patch] `conflict` handler in `reconcilePair` swallows remote download failure silently — fixed: emits SDK_ERROR when conflict-copy download fails [engine/src/sync-engine.ts ~454]
- [x] [Review][Patch] (from D2-A) `conflict` case in drainQueue dequeues unconditionally on copy failure — fixed: returns "conflict" without dequeuing on failure, retries next cycle [engine/src/sync-engine.ts ~1053]

### Deferred
- [x] [Review][Defer] Pre-seed crash window: if process crashes after `upsertSyncState` but before `enqueue` in bootstrap-upload path, the state row exists with `content_hash: null` and no queue entry — file silently skipped on next reconcile [engine/src/sync-engine.ts ~618] — deferred, inherent race without transactional DB writes
- [x] [Review][Defer] `deleteRevision` failure in `uploadFileRevision` falls through to `mapSdkError` on the original 2511 error, which classifies it as `NetworkError` and may trigger a false offline transition [engine/src/sdk.ts ~494] — deferred, acceptable failure mode; retry not possible without draft cleared
- [x] [Review][Defer] ENOENT in def/undef upload path returns `"conflict"` without dequeue — entry replays until `MAX_DRAIN_ATTEMPTS` and dead-letters, with no user-visible explanation that the local file is gone [engine/src/sync-engine.ts ~928] — deferred, pre-existing pattern
