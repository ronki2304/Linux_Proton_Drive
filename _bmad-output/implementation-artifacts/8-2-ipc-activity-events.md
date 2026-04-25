# Story 8.2: IPC Activity Events

Status: done

## Story

As a developer,
I want the engine to emit structured activity events over IPC,
so that the UI can display a live feed of what was synced without polling the engine.

## Acceptance Criteria

1. **Protocol schema** — two new typed payload interfaces exported from `engine/src/ipc.ts` document the wire shapes (see Task 1 for exact field names).

2. **`file_synced` payload contract:**
   - `type: "file_synced"`
   - `pair_id: string` — UUID of the sync pair
   - `file_name: string` — **bare file name only** (e.g., `"notes.md"`), never a full path; PII constraint
   - `direction: "upload" | "download"` — `"upload"` = local→remote; `"download"` = remote→local
   - `timestamp: string` — ISO 8601 UTC (`new Date().toISOString()`)

3. **`reconcile_progress` payload contract:**
   - `type: "reconcile_progress"`
   - `pair_id: string`
   - `phase: "scanning" | "uploading" | "downloading" | "idle"`
   - `files_processed: number` — best-effort; `0` is valid
   - `files_total: number` — best-effort; `0` is valid

4. **`file_synced` emission points** (three locations in `sync-engine.ts`):
   - After a successful **download** in `reconcilePair`'s download loop
   - After a successful **upload** in `processQueueEntry`'s `"upload"` case
   - After a successful **inline download** in `processQueueEntry`'s `"inline_download"` case

5. **`file_synced` NOT emitted for:** conflict copies, trash operations, dequeue no-ops, or failed transfers.

6. **`reconcile_progress` phase lifecycle per pair:**
   - `"scanning"` — emitted once at the start of `reconcilePair` (after `remote_id` resolution, before tree walk)
   - `"downloading"` — emitted before and after each download in `reconcilePair`'s download loop (if any downloads exist)
   - `"idle"` — emitted in `reconcilePair` when no uploads are pending (alongside the existing `sync_complete` emission)
   - `"uploading"` — emitted in `drainQueue` at the start of each pair's queue processing (when queue is non-empty)
   - `"idle"` — emitted in `drainQueue`'s `finally` block alongside `sync_complete` for `pairsWithSuccess`

7. **Headless safety** — events are always emitted via `emitEvent()` regardless of whether a UI client is connected. The IPC push mechanism already silently drops events when no client is present; no conditional emission logic needed.

8. **No regression** — all 389 engine unit tests continue to pass.

9. **New tests** cover: `file_synced` payload shape (download and upload cases), `reconcile_progress` phase transitions (scanning→downloading→idle, scanning→uploading→idle).

## Tasks / Subtasks

- [x] **Task 1 — Add typed payload interfaces to `engine/src/ipc.ts`** (AC: 1, 2, 3)
  - [x] 1.1 Export `FileSyncedPayload` interface after the existing `IpcPushEvent` block:
    ```typescript
    export interface FileSyncedPayload {
      pair_id: string;
      file_name: string;   // bare file name, never a path
      direction: "upload" | "download";
      timestamp: string;   // ISO 8601 UTC
    }
    ```
  - [x] 1.2 Export `ReconcileProgressPayload` interface:
    ```typescript
    export interface ReconcileProgressPayload {
      pair_id: string;
      phase: "scanning" | "uploading" | "downloading" | "idle";
      files_processed: number;
      files_total: number;
    }
    ```
  - Note: These are documentation interfaces; `IpcPushEvent.payload` remains `Record<string, unknown>`. No changes to `IpcPushEvent`, `IpcCommand`, `IpcResponse`, or `MessageReader`.

- [x] **Task 2 — Emit `file_synced` in `engine/src/sync-engine.ts`** (AC: 2, 4, 5)
  - [x] 2.1 Import `FileSyncedPayload` (type-only) and `ReconcileProgressPayload` (type-only) from `"./ipc.js"` — add to the existing `import type { IpcPushEvent } from "./ipc.js"` line
  - [x] 2.2 **`reconcilePair` download loop** (currently at `sync-engine.ts:763` — after `filesDone++; bytesDone += item.size;`):
    ```typescript
    this.emitEvent({
      type: "file_synced",
      payload: {
        pair_id: pair.pair_id,
        file_name: basename(item.relativePath),
        direction: "download",
        timestamp: new Date().toISOString(),
      } satisfies FileSyncedPayload,
    });
    ```
    Place this **before** the existing `sync_progress` emit (ordering: file_synced → sync_progress).
  - [x] 2.3 **`processQueueEntry` upload case** (currently at `sync-engine.ts:~1218` — after `commitUpload`):
    ```typescript
    this.emitEvent({
      type: "file_synced",
      payload: {
        pair_id: pair.pair_id,
        file_name: basename(entry.relative_path),
        direction: "upload",
        timestamp: new Date().toISOString(),
      } satisfies FileSyncedPayload,
    });
    ```
    Place immediately after `this.stateDb.commitUpload(...)` and before `remoteFiles.set(...)`.
  - [x] 2.4 **`processQueueEntry` inline_download case** (currently at `sync-engine.ts:~1278` — after `commitUpload`):
    ```typescript
    this.emitEvent({
      type: "file_synced",
      payload: {
        pair_id: pair.pair_id,
        file_name: basename(entry.relative_path),
        direction: "download",
        timestamp: new Date().toISOString(),
      } satisfies FileSyncedPayload,
    });
    ```
    Place immediately after `this.stateDb.commitUpload(...)` and before `return "synced"`.

- [x] **Task 3 — Emit `reconcile_progress` in `engine/src/sync-engine.ts`** (AC: 3, 6)
  - [x] 3.1 **`reconcilePair` start** — after `remote_id` resolution succeeds and `pair.remote_id` is set (currently at `sync-engine.ts:~465`, just before `walkLocalTree`):
    ```typescript
    this.emitEvent({
      type: "reconcile_progress",
      payload: {
        pair_id: pair.pair_id,
        phase: "scanning",
        files_processed: 0,
        files_total: 0,
      } satisfies ReconcileProgressPayload,
    });
    ```
  - [x] 3.2 **`reconcilePair` download loop start** — just before the `for (const item of downloadItems)` loop (currently `sync-engine.ts:~747`), emit once if `downloadItems.length > 0`:
    ```typescript
    if (downloadItems.length > 0) {
      this.emitEvent({
        type: "reconcile_progress",
        payload: {
          pair_id: pair.pair_id,
          phase: "downloading",
          files_processed: 0,
          files_total: downloadItems.length,
        } satisfies ReconcileProgressPayload,
      });
    }
    ```
  - [x] 3.3 **`reconcilePair` download loop per-file** — after emitting `file_synced` (task 2.2), emit phase update:
    ```typescript
    this.emitEvent({
      type: "reconcile_progress",
      payload: {
        pair_id: pair.pair_id,
        phase: "downloading",
        files_processed: filesDone,
        files_total: downloadItems.length,
      } satisfies ReconcileProgressPayload,
    });
    ```
    Insert this emit **before** the existing `sync_progress` emit. Keep `sync_progress` — do not remove it. Correct emission order: `file_synced` → `reconcile_progress` → `sync_progress`. (see Dev Notes: "Emit Order in Download Loop")
  - [x] 3.4 **`reconcilePair` idle** — in the `if (uploadItems.length === 0)` block (currently `sync-engine.ts:~841`) where `sync_complete` is emitted, add immediately after `sync_complete`:
    ```typescript
    this.emitEvent({
      type: "reconcile_progress",
      payload: {
        pair_id: pair.pair_id,
        phase: "idle",
        files_processed: filesDone,        // actual completions, not attempted
        files_total: downloadItems.length,
      } satisfies ReconcileProgressPayload,
    });
    ```
  - [x] 3.5 **`drainQueue` uploading** — inside the `for (const pair of pairs)` loop, immediately after the `if (pairQueue.length === 0) continue;` check (currently `sync-engine.ts:~903`):
    ```typescript
    this.emitEvent({
      type: "reconcile_progress",
      payload: {
        pair_id: pair.pair_id,
        phase: "uploading",
        files_processed: 0,
        files_total: pairQueue.length,
      } satisfies ReconcileProgressPayload,
    });
    ```
    Note: `pairQueue` may contain uploads, inline_downloads, trash entries, or deletes — `pairQueue.length` is a best-effort total estimate (AC permits this).
  - [x] 3.6 **`drainQueue` idle** — in the `finally` block, inside the `for (const pair_id of pairsWithSuccess)` loop (currently `sync-engine.ts:~1011`), emit immediately after `sync_complete`:
    ```typescript
    this.emitEvent({
      type: "reconcile_progress",
      payload: {
        pair_id,
        phase: "idle",
        files_processed: 0,
        files_total: 0,
      } satisfies ReconcileProgressPayload,
    });
    ```

- [x] **Task 4 — Unit tests in `engine/src/sync-engine.test.ts`** (AC: 9)
  - [x] 4.1 **`file_synced` for download** — test that `reconcilePair`/`startSyncAll` emits `file_synced` with `direction: "download"`, `file_name: "file.txt"` (not full path), and a valid ISO timestamp after a remote→local download:
    - Setup: local file exists, remote file newer → download triggered
    - Assert: at least one `file_synced` event with the correct payload shape
    - Assert: `file_name === "file.txt"` (bare name, not `/tmp/.../file.txt`)
  - [x] 4.2 **`file_synced` for upload** — test that `drainQueue` emits `file_synced` with `direction: "upload"` after a successful upload:
    - Setup: enqueue a `created` entry; mock `uploadFile` returns a node_uid; call `drainQueue()`
    - Assert: `file_synced` event with `direction: "upload"`, `file_name: "file.txt"`
  - [x] 4.3 **`file_synced` NOT emitted for conflict** — test that `file_synced` is NOT emitted when `processQueueEntry` resolves to `"conflict"`:
    - Setup: same-content-hash state + remote changed → conflict path
    - Assert: no `file_synced` event in `emittedEvents`
  - [x] 4.4 **`reconcile_progress` scanning phase** — test that `reconcilePair` emits `phase: "scanning"` at the start:
    - Call `startSyncAll()` with no local or remote changes
    - Assert: first `reconcile_progress` event has `phase: "scanning"`
  - [x] 4.5 **Phase transition scanning→downloading→idle** — test with a download-only scenario:
    - Setup: remote-only file (no local, no sync state) → triggers download
    - Call `startSyncAll()`
    - Extract all `reconcile_progress` events for the pair, assert:
      - First: `phase: "scanning"`
      - Contains at least one `phase: "downloading"`
      - Last: `phase: "idle"`
    - Assert no `phase: "uploading"` in events
  - [x] 4.6 **Phase transition scanning→uploading→idle** — test with an upload-only scenario:
    - Setup: enqueue a `created` entry; no remote file
    - Call `startSyncAll()` then `drainQueue()`
    - Assert `reconcile_progress` events include `phase: "scanning"`, `phase: "uploading"`, and `phase: "idle"`
  - [x] 4.7 **`reconcile_progress` files_processed/files_total** — test that `files_total` in the `"downloading"` phase matches `downloadItems.length`:
    - Setup: two remote-only files → two downloads
    - Assert: the initial `phase: "downloading"` event has `files_total: 2, files_processed: 0`
    - Assert: after second download, a `phase: "downloading"` event has `files_processed: 2`
  - [x] 4.8 **`file_synced` timestamp is ISO 8601** — assert `timestamp` field on a `file_synced` event matches `new Date(ts).toISOString() === ts` (valid ISO parse)
  - [x] 4.9 **`file_synced` NOT emitted for trash** — test that `file_synced` is NOT emitted when `processQueueEntry` resolves to `"synced"` via the `trashNode` path:
    - Setup: enqueue a `deleted` entry; mock `trashNode` succeeds; call `drainQueue()`
    - Assert: no `file_synced` event in `emittedEvents`
  - [x] 4.10 **`file_synced` NOT emitted for dequeue** — test that `file_synced` is NOT emitted when `processQueueEntry` resolves via the `dequeue` no-op path:
    - Setup: enqueue a `deleted` entry with no sync_state and no remote → dequeue path (direct, no stat)
    - Assert: no `file_synced` event in `emittedEvents`

- [x] **Task 5 — Validate** (AC: 8, 9)
  - [x] 5.1 `cd engine && bun test --path-ignore-patterns '__integration__'` — all tests pass; count ≥ 399 (389 baseline + 10 new)
  - [x] 5.2 `.venv/bin/pytest ui/tests/` — 0 regressions (UI tests unaffected; this story is engine-only)
  - [x] 5.3 Set story status to `review`

## Dev Notes

### Wire Format Is Snake_Case — Do NOT CamelCase Payload Fields

The epic spec shows `pairId`, `fileName`, `filesProcessed`, `filesTotal` — these are camelCase in the epic document. The **actual wire format uses `snake_case`** (project-context.md §IPC Wire Format). The correct field names are:
- `pair_id`, `file_name`, `files_processed`, `files_total`

The Python UI will parse these as snake_case. CamelCase fields will silently break the parser.

### `satisfies` Keyword for Type Safety

Use `satisfies FileSyncedPayload` / `satisfies ReconcileProgressPayload` on the payload objects. This catches mismatched field names at compile time while still allowing the object to be assigned to `Record<string, unknown>`. Example:
```typescript
this.emitEvent({
  type: "file_synced",
  payload: {
    pair_id: pair.pair_id,
    file_name: basename(entry.relative_path),
    direction: "upload",
    timestamp: new Date().toISOString(),
  } satisfies FileSyncedPayload,
});
```

### `file_name` Is Bare Name Only — PII Constraint

`file_name` must be `basename(relativePath)` — never `entry.relative_path` or the full local path. The full path leaks the user's folder structure over IPC (PII). `basename` is already imported in `sync-engine.ts` (line 3).

### `processQueueEntry` Is Private — `emitEvent` Is Available

`processQueueEntry` is a private method on `SyncEngine` but has access to `this.emitEvent` (it already calls it for errors). No access changes needed.

### Emit Order in Download Loop

The correct emission order after a successful download is:
1. `file_synced` (this story — new)
2. `reconcile_progress { phase: "downloading" }` (this story — new)
3. `sync_progress` (existing — keep, do not remove)

Do NOT remove the existing `sync_progress` event — the UI (Story 2-8) currently uses it for progress display.

### Phase "scanning" Placement

Emit `reconcile_progress { phase: "scanning" }` at `sync-engine.ts:~465` — after the `remote_id` resolution block (the `if (pair.remote_id === "")` block with its try/catch). Do NOT emit before remote_id resolution — if resolution fails, the function returns early and "scanning" would never be followed by "idle".

If resolution fails early (throws or emits `remote_path_not_found`), no "scanning" is emitted and no "idle" is needed either. The function already returns early in that case.

### `reconcile_progress` Idle From `drainQueue` — Only `pairsWithSuccess`

The idle in `drainQueue`'s finally block is only emitted for `pairsWithSuccess`. If all entries for a pair fail (returned `"failed"` or `"disk_full"`), no idle is emitted for that pair after the "uploading" phase. This is acceptable per AC ("best-effort estimates"). Story 8-3's UI can add a defensive timeout to dismiss the spinner regardless.

### `drainQueue` Is Also Called for Offline Queue Replay

`drainQueue` is used both for initial reconcile uploads AND offline queue replay. In both cases, `reconcile_progress { phase: "uploading" }` is appropriate — the UI will show a syncing indicator either way.

### No Changes to `main.ts` or `ipc.ts` Push Mechanics

The existing `pushEvent` in `main.ts` already fans events to all connected clients. When no UI is connected, the IPC layer drops the event silently. No changes needed to support the "headless" AC.

### Test Pattern: Filtering `emittedEvents`

In tests, filter for specific event types:
```typescript
const fileSyncedEvents = emittedEvents.filter(e => e.type === "file_synced");
const progressEvents = emittedEvents.filter(e => e.type === "reconcile_progress");
```

The `emittedEvents` array is shared across all emitted events; filtering avoids fragile index-based assertions.

### Project Structure Notes

All changes are confined to the engine (`engine/src/`). Engine source files stay flat — no subdirectories. Files to touch:

| File | Change |
|---|---|
| `engine/src/ipc.ts` | Export `FileSyncedPayload` and `ReconcileProgressPayload` interfaces |
| `engine/src/sync-engine.ts` | 3 `file_synced` emits + 6 `reconcile_progress` emits |
| `engine/src/sync-engine.test.ts` | 8 new tests |

No changes to `state-db.ts`, `sdk.ts`, `main.ts`, or any UI file.

### References

- [Source: engine/src/ipc.ts:22–27] — `IpcPushEvent` definition; add new interfaces after this block
- [Source: engine/src/sync-engine.ts:6] — `import type { IpcPushEvent } from "./ipc.js"` — extend to add new payload types
- [Source: engine/src/sync-engine.ts:745–773] — download loop in `reconcilePair`; add `file_synced` + `reconcile_progress` here
- [Source: engine/src/sync-engine.ts:1190–1230] — upload case in `processQueueEntry`; add `file_synced` after `commitUpload`
- [Source: engine/src/sync-engine.ts:1257–1281] — inline_download case in `processQueueEntry`; add `file_synced` after `commitUpload`
- [Source: engine/src/sync-engine.ts:395–441] — `reconcileAndEnqueue`: emits `pair_reconciling` before calling `reconcilePair`; no change needed here
- [Source: engine/src/sync-engine.ts:445–465] — `reconcilePair` start, after `remote_id` resolution; add `phase: "scanning"` here
- [Source: engine/src/sync-engine.ts:836–853] — `reconcilePair` sync_complete block; add `phase: "idle"` alongside
- [Source: engine/src/sync-engine.ts:901–903] — `drainQueue` per-pair start; add `phase: "uploading"` here
- [Source: engine/src/sync-engine.ts:1004–1026] — `drainQueue` finally block; add `phase: "idle"` inside `pairsWithSuccess` loop
- [Source: _bmad-output/implementation-artifacts/8-1-event-based-incremental-reconciliation.md] — 8-1 completion notes: `file_synced` and `reconcile_progress` were NOT implemented in 8-1; baseline is 389 tests
- [Source: _bmad-output/project-context.md §IPC Wire Format] — snake_case rule for IPC payloads
- [Source: _bmad-output/planning-artifacts/epics/epic-8-sdk-compliance-incremental-sync.md#Story 8.2] — authoritative AC source

## Review Findings

- [x] [Review][Defer] `reconcilePair` exceptions after `scanning` leave pair stuck in `scanning` with no `idle` — resolved: `error` events already emitted by the engine on blocking failures serve as the terminal signal; `idle` is intentionally only emitted on clean exits. Story 8-3 UI must treat an `error` event as a phase terminator for that pair. A future `"stalled"` phase would require coordinated changes across engine, Python IPC parser, and UI state machine — deferred to Story 8-3 scope. [engine/src/sync-engine.ts:465] — deferred, option 3: error event is the terminal signal
- [x] [Review][Defer] `diskFull` early return from download loop leaves pair stuck in `downloading` with no `idle` — resolved: same policy as above. Engine already emits `{ type: "error", payload: { code: "DISK_FULL", ... } }` before the early return. UI correlation of `error` event + no subsequent `idle` = blocked state. Not "idle/done" but "waiting for user to free space then retry via timer" — emitting `idle` here would be semantically wrong. [engine/src/sync-engine.ts:~838] — deferred, option 3: error event is the terminal signal
- [x] [Review][Patch] Missing test for `file_synced` in `inline_download` path — fixed: added test 4.11 covering `processQueueEntry` `inline_download` case (no sync state, remote newer → `direction: "download"`). 400 tests passing. [engine/src/sync-engine.test.ts]
- [x] [Review][Patch] Test 4.6 asserts phase presence only, not order — fixed: added `phases[0] === "scanning"`, `indexOf("uploading") > indexOf("scanning")`, `phases[last] === "idle"` assertions [engine/src/sync-engine.test.ts:4604]
- [x] [Review][Patch] Test 4.7 missing intermediate `files_processed === 1` check — fixed: added `afterFirst` assertion for `files_processed === 1` between the initial-0 and final-2 checks [engine/src/sync-engine.test.ts:4624]
- [x] [Review][Defer] `drainQueue` idle hardcodes `files_processed: 0, files_total: 0` — documented design per dev notes ("best-effort estimates"); Story 8-3 UI adds defensive timeout [engine/src/sync-engine.ts:~1082] — deferred, documented design decision
- [x] [Review][Defer] All uploads fail → `pairsWithSuccess` empty → no `idle` from `drainQueue` — explicitly documented as acceptable in dev notes under "reconcile_progress Idle From drainQueue — Only pairsWithSuccess" [engine/src/sync-engine.ts:~1079] — deferred, documented design decision
- [x] [Review][Defer] `walkRemoteTree` throws in `drainQueue` → `uploading` emitted with no matching `idle` — covered by "best-effort" AC and Story 8-3 defensive timeout policy [engine/src/sync-engine.ts:~968] — deferred, same policy as drainQueue idle

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- Test 4.10 initially failed in the full suite because `mock.module("node:fs/promises")` from prior describe blocks (DISK_FULL, PERMISSION_DENIED, local-folder-missing) persists across tests (`mock.restore()` does not undo module mocks per test file comment at line 3930). Fixed by using `deleted + no state + no remote → dequeue` path instead of `created + ENOENT`, which avoids `stat` entirely. Both are valid "dequeue no-op" scenarios per AC 5.

### Completion Notes List

- Added `FileSyncedPayload` and `ReconcileProgressPayload` interfaces to `engine/src/ipc.ts` after `IpcPushEvent` block. Snake_case wire format per project-context.md §IPC Wire Format.
- Extended `sync-engine.ts` import line to add both new payload types as type-only imports.
- Added 3 `file_synced` emits: reconcilePair download loop, processQueueEntry upload case, processQueueEntry inline_download case. All use `basename()` for `file_name` (PII constraint). All use `satisfies` keyword for compile-time type safety.
- Added 6 `reconcile_progress` emits: scanning (reconcilePair start), downloading loop start, downloading per-file, idle (reconcilePair no-upload path), uploading (drainQueue per-pair), idle (drainQueue finally pairsWithSuccess).
- Emit order in download loop: `file_synced` → `reconcile_progress` → `sync_progress` (existing `sync_progress` preserved).
- 10 unit tests added as `describe("SyncEngine — IPC activity events (Story 8-2)", ...)`. Tests cover all payload shapes, phase transitions, negative cases (no file_synced for conflict, trash, dequeue). `mock.restore()` added to beforeEach as safeguard against module mock leaks.
- Final test counts: 399 engine unit tests (389 baseline + 10 new), 672 UI tests (0 regressions).

### File List

- `engine/src/ipc.ts` — added `FileSyncedPayload` and `ReconcileProgressPayload` interfaces
- `engine/src/sync-engine.ts` — extended IPC import; added 3 `file_synced` emits and 6 `reconcile_progress` emits
- `engine/src/sync-engine.test.ts` — added 10 unit tests in `SyncEngine — IPC activity events (Story 8-2)` describe block
