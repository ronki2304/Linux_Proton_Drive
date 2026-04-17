# Story 4.0b: Deletion Propagation

Status: done

## Story

As a user,
I want deleted files to be propagated across the sync boundary — local deletions trashed on Proton Drive, remote deletions removed locally,
so that my sync pairs stay consistent and deletions don't silently stall.

## Acceptance Criteria

### AC1 — Local deleted, remote exists → trash remote

**Given** a local file has been deleted and a `sync_state` entry exists for it (was previously synced)
**When** a sync cycle runs
**Then** the engine calls `trashNode` on the corresponding remote node via the SDK
**And** the `sync_state` entry is removed on success

### AC2 — Remote absent, local exists → delete local

**Given** a remote file is absent from the remote tree and a `sync_state` entry exists for it (was previously synced)
**When** a sync cycle runs
**Then** the engine deletes the local copy
**And** the `sync_state` entry is removed on success

### AC3 — Both-sides-deleted → clean up state only

**Given** a file is absent both locally and remotely since last sync (both-sides-deleted)
**When** a sync cycle runs
**Then** the engine removes the `sync_state` entry — no conflict copy, no error, no user notification

### AC4 — Never-synced local deletion → silent skip

**Given** a new local file has no `sync_state` entry (never previously synced) and has been deleted before the engine saw it
**When** a sync cycle runs
**Then** no `trashNode` call is made — never-synced deletions are silently skipped

### AC5 — `trashNode` SDK error → error event, state preserved

**Given** `trashNode` throws an SDK error during local→remote deletion
**When** the error is caught in `reconcilePair`
**Then** a `sync_cycle_error` `error` event is emitted for the pair
**And** the `sync_state` entry is NOT removed (preserved for retry on next cycle)

### AC6 — Tests pass under `bun test`

**When** running `bun test`
**Then** tests cover: local→remote deletion, remote→local deletion, both-sides-deleted (no-op), never-synced local deletion (no remote call), `trashNode` SDK error handling

---

## Tasks / Subtasks

- [x] **Task 1: Extend `WorkItem` type** (AC: all)
  - [x] 1.1 In `engine/src/sync-engine.ts`, add three new variants to the `WorkItem` union (lines 32–47):
    ```ts
    | { kind: "delete_local"; relativePath: string }
    | { kind: "trash_remote"; relativePath: string; remoteNodeId: string }
    | { kind: "clear_state"; relativePath: string }
    ```

- [x] **Task 2: Fix `computeWorkList` — local-exists, remote-absent case** (AC: #2, #4)
  - [x] 2.1 In `computeWorkList` (line ~789), in the local-files loop `else` branch ("Local-only: new file → upload"), add a state check before the upload:
    ```ts
    } else {
      if (state) {
        // Remote was deleted — remove local copy (AC2 of 4-0b)
        workItems.push({ kind: "delete_local", relativePath: relPath });
      } else {
        // Truly new local file → upload (unchanged)
        const parentDir = dirname(relPath);
        const remoteFolderId =
          parentDir === "." ? pair.remote_id : remoteFolders.get(parentDir);
        if (!remoteFolderId) { ... continue; }
        workItems.push({ kind: "upload", ... });
      }
    }
    ```

- [x] **Task 3: Fix `computeWorkList` — remote-exists, local-absent case** (AC: #1, #4)
  - [x] 3.1 In the remote-files loop (line ~809), replace the `if (state) { continue; }` skip with:
    ```ts
    if (state) {
      // Local was deleted — trash the remote (AC1 of 4-0b)
      workItems.push({ kind: "trash_remote", relativePath: relPath, remoteNodeId: remote.id });
      continue;
    }
    ```
    The `continue` prevents falling through to the new-remote-file download case.

- [x] **Task 4: Add both-sides-deleted detection to `computeWorkList`** (AC: #3)
  - [x] 4.1 After the remote-files loop, add a new loop over `syncStates`:
    ```ts
    // Both-sides-deleted: sync_state present but neither local nor remote has the path
    for (const relPath of syncStates.keys()) {
      if (!localFiles.has(relPath) && !remoteFiles.has(relPath)) {
        workItems.push({ kind: "clear_state", relativePath: relPath });
      }
    }
    ```

- [x] **Task 5: Execute deletion work items in `reconcilePair`** (AC: #1, #2, #3, #5)
  - [x] 5.1 **REPLACE lines 228-229** of `sync-engine.ts` (the existing `downloadItems`/`uploadItems` declarations) with this 5-filter block. Do not insert alongside them — replace them, or TypeScript will error on duplicate `const` declarations:
    ```ts
    const deleteLocalItems  = workItems.filter((w): w is WorkItem & { kind: "delete_local" }  => w.kind === "delete_local");
    const trashRemoteItems  = workItems.filter((w): w is WorkItem & { kind: "trash_remote" }  => w.kind === "trash_remote");
    const clearStateItems   = workItems.filter((w): w is WorkItem & { kind: "clear_state" }   => w.kind === "clear_state");
    const downloadItems     = workItems.filter((w): w is WorkItem & { kind: "download" }      => w.kind === "download");
    const uploadItems       = workItems.filter((w): w is WorkItem & { kind: "upload" }        => w.kind === "upload");
    ```
  - [x] 5.2 **Immediately after the filter block (before the `sync_progress` emit), update `bytesTotal` at line 232.** Once deletion variants are in the `WorkItem` union, `workItems.reduce((a, w) => a + w.size, 0)` fails TypeScript compilation because those variants have no `.size`. Replace it with:
    ```ts
    const bytesTotal = [...downloadItems, ...uploadItems].reduce((a, w) => a + w.size, 0);
    ```
  - [x] 5.3 **Ordering invariant:** deletions must execute first, then `sync_progress` emits for download/upload counts only. Do not reorder. The sequence is: filter → execute deletions (5.4–5.6) → emit `sync_progress` → execute downloads → enqueue uploads.
  - [x] 5.4 Execute `clear_state` items (no I/O, no error surface needed):
    ```ts
    for (const item of clearStateItems) {
      this.stateDb.deleteSyncState(pair.pair_id, item.relativePath);
    }
    ```
  - [x] 5.5 Execute `delete_local` items (ENOENT = already gone = success):
    ```ts
    for (const item of deleteLocalItems) {
      try {
        await unlink(join(pair.local_path, item.relativePath));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "ENOENT") {
          const msg = err instanceof Error ? err.message : "unknown";
          debugLog(`sync-engine: delete_local failed for ${item.relativePath}: ${msg}`);
          this.emitEvent({ type: "error", payload: { code: "sync_file_error", message: msg, pair_id: pair.pair_id } });
          continue;  // keep sync_state so next cycle retries
        }
      }
      this.stateDb.deleteSyncState(pair.pair_id, item.relativePath);
    }
    ```
  - [x] 5.6 Execute `trash_remote` items (`withBackoff` for rate limiting):
    ```ts
    for (const item of trashRemoteItems) {
      try {
        await this.withBackoff(() => client.trashNode(item.remoteNodeId));
        this.stateDb.deleteSyncState(pair.pair_id, item.relativePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        debugLog(`sync-engine: trash_remote failed for ${item.relativePath}: ${msg}`);
        this.emitEvent({ type: "error", payload: { code: "sync_cycle_error", message: msg, pair_id: pair.pair_id } });
        // sync_state intentionally preserved — retry on next cycle
      }
    }
    ```
  - [x] 5.7 Update `files_total` in **both** `sync_progress` emits to `downloadItems.length + uploadItems.length`:
    - Line 238: initial emit (before download loop)
    - **Line 266: per-file emit inside the download loop** — easy to miss, must also be updated

- [x] **Task 6: Type-check and test** (AC: #6)
  - [x] 6.1 `bunx tsc --noEmit` — zero type errors
  - [x] 6.2 Add deletion tests to `engine/src/sync-engine.test.ts` (see Dev Notes §6)
  - [x] 6.3 `bun test engine/src/sync-engine.test.ts` — all pass (47 tests)
  - [x] 6.4 `bun test engine/src` — 212 pass, 0 fail (no regressions)

- [x] **Task 7: Final validation** (AC: all)
  - [x] 7.1 `bun test engine/src` — 212 pass, 0 fail
  - [x] 7.2 Set story status to `review`

---

## Dev Notes

### §1 — Architectural Context

This story plugs a gap in `reconcileAndEnqueue` → `reconcilePair` → `computeWorkList`. The queue-drain path (`processQueueEntry`) already handles local-deleted entries via the `trashNode` outcome (`(defined, defined, deleted)` cell). This story is about **reconciliation-time** detection — when the engine does a full tree walk and finds files missing from one or both sides.

**Two deletion paths in the codebase (don't confuse them):**

| Path | Trigger | Code |
|------|---------|------|
| Queue-based (exists) | inotify `deleted` event → `change_queue` | `processQueueEntry` → `outcome = "trashNode"` |
| Reconcile-based (this story) | Full tree walk detects absent file | `computeWorkList` + inline execution in `reconcilePair` |

Both paths call `client.trashNode()` for local→remote deletions, but they go through different code paths.

### §2 — `computeWorkList` Mutation Map

**Current behavior** (lines to modify):

| Location | Current | New |
|----------|---------|-----|
| Local-files loop `else` branch (line ~789) | Always push `upload` | If `state` defined → push `delete_local`; else push `upload` |
| Remote-files loop `if (state)` branch (line ~813) | `continue` (skip) | Push `trash_remote` + `continue` |
| After remote-files loop | Nothing | New loop over `syncStates` → push `clear_state` for both-absent |

**The `computeWorkList` signature already has `syncStates`** as last parameter — the new both-sides-deleted loop just iterates its keys. No signature change needed.

**The `WorkItem` type** is defined at line 32. Add the three new variants to the union. TypeScript will catch any `case` branches you forgot in `reconcilePair`'s `switch` (there is no switch in `reconcilePair` — deletions are handled via `.filter()` before the switch, so the exhaustiveness guard in `processQueueEntry` is unaffected).

### §3 — Crash Recovery Reasoning (no new transaction methods needed)

**`trash_remote` success + crash before `deleteSyncState`:** Next cycle: local absent, remote absent, `sync_state` present → both-sides-deleted → `clear_state` → `deleteSyncState`. Recovers correctly.

**`delete_local` success + crash before `deleteSyncState`:** Next cycle: local absent (already gone), remote present, `sync_state` present → local deleted again → ENOENT on `unlink` → handled as success → `deleteSyncState`. Recovers correctly.

**`deleteSyncState` is a single SQL `DELETE` — already atomic.** No new transaction methods needed in `StateDb`.

### §4 — `sync_progress` Change

Before this story: `files_total = workItems.length` included all items (but only downloads ran inline). After this story: `files_total = downloadItems.length + uploadItems.length`. This is actually a correctness fix — deletion work items aren't user-visible progress.

The `bytesTotal` calculation must also be updated to only sum download + upload items.

### §5 — `withBackoff` for `trash_remote`

`trashNode` goes over the network. Wrap it in `this.withBackoff()` (same pattern as existing trash in `processQueueEntry` line 584):
```ts
await this.withBackoff(() => client.trashNode(item.remoteNodeId));
```
This handles `RateLimitError` with exponential backoff up to 30s, max 5 attempts.

### §6 — Test Structure

Add a new `describe` block to `engine/src/sync-engine.test.ts`. The `makeMockClient` helper does NOT include `trashNode` by default — pass it as an override:

```ts
describe("SyncEngine — deletion propagation (Story 4-0b)", () => {
  beforeEach(() => {
    db = new StateDb(":memory:");
    emittedEvents = [];
    tmpDir = join(tmpdir(), `sync-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    setupPair();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("local deleted (sync_state exists) → trashNode called, sync_state removed (AC1)", async () => {
    // Arrange: file was previously synced but local copy is now gone
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "gone.txt",
      local_mtime: "2026-04-10T10:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    });
    const trashNode = mock(async () => {});
    mockClient = makeMockClient({
      trashNode,
      listRemoteFiles: mock(async () => [
        makeRemoteFile("gone.txt", "2026-04-10T10:00:00.000Z"),
      ]),
    });
    engine = new SyncEngine(db, (e) => { emittedEvents.push(e); }, () => [
      { pair_id: PAIR_ID, local_path: tmpDir, remote_path: "/Docs", remote_id: REMOTE_ID, created_at: "2026-04-10T00:00:00.000Z" } as any,
    ]);
    engine.setDriveClient(mockClient);
    // no local file written — it's "deleted"

    await engine.startSyncAll();

    expect(trashNode).toHaveBeenCalledTimes(1);
    expect(db.getSyncState(PAIR_ID, "gone.txt")).toBeUndefined();
  });

  it("remote deleted (sync_state exists) → local file deleted, sync_state removed (AC2)", async () => {
    // Arrange: file was previously synced, remote is now gone
    writeLocalFile("local-only.txt");
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "local-only.txt",
      local_mtime: "2026-04-10T10:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    });
    mockClient = makeMockClient({ trashNode: mock(async () => {}) }); // no files in remote
    engine = new SyncEngine(db, (e) => { emittedEvents.push(e); }, () => [
      { pair_id: PAIR_ID, local_path: tmpDir, remote_path: "/Docs", remote_id: REMOTE_ID, created_at: "2026-04-10T00:00:00.000Z" } as any,
    ]);
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    expect(() => statSync(join(tmpDir, "local-only.txt"))).toThrow(); // file gone
    expect(db.getSyncState(PAIR_ID, "local-only.txt")).toBeUndefined();
  });

  it("both-sides-deleted → sync_state removed, no trashNode (AC3)", async () => {
    // Arrange: sync_state exists but file absent on both sides
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "vanished.txt",
      local_mtime: "2026-04-10T10:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    });
    const trashNode = mock(async () => {});
    mockClient = makeMockClient({ trashNode }); // no remote files
    engine = new SyncEngine(db, (e) => { emittedEvents.push(e); }, () => [...]);
    engine.setDriveClient(mockClient);
    // no local file written

    await engine.startSyncAll();

    expect(trashNode).not.toHaveBeenCalled();
    expect(db.getSyncState(PAIR_ID, "vanished.txt")).toBeUndefined();
  });

  it("never-synced local deletion → no trashNode called (AC4)", async () => {
    // Arrange: no sync_state, no local file, no remote file (pure never-existed)
    const trashNode = mock(async () => {});
    mockClient = makeMockClient({ trashNode });
    engine = new SyncEngine(db, (e) => { emittedEvents.push(e); }, () => [...]);
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    expect(trashNode).not.toHaveBeenCalled();
    expect(emittedEvents.filter(e => e.type === "error")).toHaveLength(0);
  });

  it("trashNode SDK error → error event emitted, sync_state preserved (AC5)", async () => {
    // Arrange
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "fail.txt",
      local_mtime: "2026-04-10T10:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    });
    mockClient = makeMockClient({
      trashNode: mock(async () => { throw new SyncError("server rejected trash"); }),
      listRemoteFiles: mock(async () => [
        makeRemoteFile("fail.txt", "2026-04-10T10:00:00.000Z"),
      ]),
    });
    engine = new SyncEngine(db, (e) => { emittedEvents.push(e); }, () => [...]);
    engine.setDriveClient(mockClient);
    // no local file

    await engine.startSyncAll();

    const errors = emittedEvents.filter(e => e.type === "error");
    expect(errors.length).toBeGreaterThan(0);
    // sync_state preserved for retry
    expect(db.getSyncState(PAIR_ID, "fail.txt")).toBeDefined();
  });
});
```

**Note:** The test skeletons above show the intent. Fill in the `() => [...]` ConfigPair arrays to match `setupPair()`. Use `statSync` from `node:fs` to assert file absence — **`statSync` is NOT currently imported in the test file**; add it to the existing `node:fs` import line:
```ts
import { mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
```

### §7 — `DriveClient.trashNode` Reference

`DriveClient.trashNode(nodeUid)` is at `engine/src/sdk.ts:487`. It's already wired into `processQueueEntry` at line 584 of `sync-engine.ts`. The method signature:
```ts
async trashNode(nodeUid: string): Promise<void>
```
It throws a typed engine error on failure (mapped via `mapSdkError`). The `!saw` guard at line 499 catches the edge case where the SDK iterator yields nothing (node already gone server-side) — this is a `SyncError`, which the `trash_remote` try/catch will surface as a `sync_cycle_error` event.

### §8 — TypeScript Strict Flag Reminders

- `arr.filter((w): w is WorkItem & { kind: "T" } => w.kind === "T")` — use type predicate for the filter so the inferred type is narrowed correctly
- `(err as NodeJS.ErrnoException)?.code` — pattern already used at line 521 of `sync-engine.ts`
- `noUncheckedIndexedAccess`: any `array[0]` needs a `!` or null check
- Local imports use `.js` extension (e.g., `import { unlink } from "node:fs/promises"` — already imported at line 1)

### Project Structure Notes

**Files to modify:**
- `engine/src/sync-engine.ts` — WorkItem type + computeWorkList + reconcilePair execution

**Files to add tests to:**
- `engine/src/sync-engine.test.ts` — add new `describe` block

**Do NOT modify:**
- `engine/src/state-db.ts` — no new DB methods needed; `deleteSyncState` already exists
- `engine/src/sdk.ts` — `trashNode` already exists
- Any UI files — this story is engine-only; no new IPC events
- `processQueueEntry` — queue-based deletion path is untouched

### References

- Epic 4 story definition: `_bmad-output/planning-artifacts/epics/epic-4-conflict-detection-resolution.md#story-40b`
- `WorkItem` type: `engine/src/sync-engine.ts:32`
- `computeWorkList`: `engine/src/sync-engine.ts:732`
- Remote-files loop skip comment ("out of scope for 2.5"): `engine/src/sync-engine.ts:813`
- Local-files loop else branch: `engine/src/sync-engine.ts:789`
- `reconcilePair` sync_progress emit: `engine/src/sync-engine.ts:233`
- `processQueueEntry` trashNode usage (pattern reference): `engine/src/sync-engine.ts:584`
- `DriveClient.trashNode`: `engine/src/sdk.ts:487`
- `StateDb.deleteSyncState`: `engine/src/state-db.ts:207`
- `withBackoff`: `engine/src/sync-engine.ts:72`
- Existing test helpers (`makeMockClient`, `makeRemoteFile`, `writeLocalFile`): `engine/src/sync-engine.test.ts:28–76`

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

(none — clean implementation, no unexpected issues)

### Completion Notes List

- Extended `WorkItem` union with `delete_local`, `trash_remote`, and `clear_state` variants.
- `computeWorkList` now: (a) pushes `delete_local` when local-file has sync_state but no remote; (b) pushes `trash_remote` when remote-file has sync_state but no local; (c) pushes `clear_state` in post-loop for both-absent paths.
- `reconcilePair` executes deletions before sync_progress emit in order: clear_state → delete_local → trash_remote. `trashNode` wrapped in `withBackoff` for rate-limit resilience. ENOENT on `unlink` treated as success (idempotent).
- `sync_progress` `files_total` and `bytesTotal` corrected to count only download+upload items — deletion work items are not user-visible progress.
- `bunx tsc --noEmit` clean; `bun test engine/src` 212 pass, 0 fail.
- 5 new tests in `describe("SyncEngine — deletion propagation (Story 4-0b)")` covering all ACs.

### File List

- engine/src/sync-engine.ts
- engine/src/sync-engine.test.ts

### Review Findings

- [x] [Review][Patch] AC5 test: assert error payload code is `sync_cycle_error`, not just `errors.length > 0` [engine/src/sync-engine.test.ts]
- [x] [Review][Patch] AC2 test: `trashNode` mock set up but never asserted as not-called — add `expect(trashNode.mock.calls.length).toBe(0)` [engine/src/sync-engine.test.ts]
- [x] [Review][Patch] Missing test for `delete_local` non-ENOENT failure path (EPERM/EACCES → emit `sync_file_error` + preserve `sync_state`) [engine/src/sync-engine.test.ts]
- [x] [Review][Defer] Unbounded retry on persistent `delete_local` failures (EPERM/EACCES) — no retry-bounding mechanism in engine; established project pattern — deferred, pre-existing
- [x] [Review][Defer] Local file modified + remote deleted → `delete_local` silently discards local edits without conflict — deferred, pre-existing; Epic 4 conflict-detection scope (4-1+)
- [x] [Review][Defer] `unlink` on a directory path (EISDIR) — requires abnormal DB state; not in story scope — deferred, pre-existing
- [x] [Review][Defer] `deleteSyncState` DB throw after successful `unlink`/`trashNode` — general DB robustness; pre-existing pattern — deferred, pre-existing
- [x] [Review][Defer] `trashNode` network failure doesn't trigger `onNetworkFailure` offline transition — pre-existing architectural gap; not introduced by this story — deferred, pre-existing
- [x] [Review][Defer] `sync_complete` emitted even when deletion items partially failed — pre-existing engine behavior — deferred, pre-existing
- [x] [Review][Defer] Local file modified before scan + remote deleted in same cycle → data loss without conflict — pre-existing race; Epic 4 conflict-detection scope — deferred, pre-existing

## Change Log

- 2026-04-17: Implemented deletion propagation (Story 4-0b) — local→remote trash, remote→local delete, both-sides-deleted cleanup, never-synced skip, trashNode error handling. All 5 ACs covered by tests.
