# Story 5.3: Change Queue Replay After Re-Auth

Status: done

## Story

As a user,
I want my queued changes to sync automatically after I re-authenticate,
so that I don't lose any work that happened while my session was expired.

## Acceptance Criteria

### AC1 — `session_ready` triggers queue drain

**Given** re-auth completes successfully (`session_ready` received)
**When** the engine processes the new token via `token_refresh` → `_activateSession`
**Then** `startSyncAll()` is called immediately after `setDriveClient(client)`
**And** all entries accumulated in `change_queue` during the expiry window are processed

### AC2 — No false conflicts for locally-only-changed files

**Given** a queued file where `sync_state.remote_mtime === remoteFiles.get(path).remote_mtime` (remote unchanged since last sync)
**When** the post-reauth `drainQueue` processes the entry
**Then** the file is uploaded without creating a conflict copy
**And** the `sync_state` row is updated via `commitUpload`
**And** the queue entry is removed atomically

### AC3 — Conflict copy for files changed on both sides

**Given** a queued file where `sync_state.remote_mtime !== remoteFiles.get(path).remote_mtime` (remote also changed during expiry)
**When** the post-reauth `drainQueue` processes the entry
**Then** a conflict copy is created following the standard Epic 4 pattern
**And** the queue entry remains (conflict resolution deferred to Epic 4 handling)

### AC4 — Queue cleared and toast shown after successful replay

**Given** all queued changes are replayed
**When** `drainQueue` finishes
**Then** successfully synced entries are removed from the `change_queue` table (atomically via `commitUpload` / `commitTrash` / `commitDequeue`)
**And** a `queue_replay_complete` push event is emitted with `{synced: N, skipped_conflicts: M}`
**And** the UI shows an `AdwToast` "N files synced" (if N > 0) via the existing `on_queue_replay_complete` handler

---

## Developer Context

### How the re-auth drain path works today — READ THIS FIRST

The re-auth queue drain is **not a new code path**. It flows through the existing `_activateSession` helper in `engine/src/main.ts`:

```
token_refresh IPC command
  → handleTokenRefresh()             [engine/src/main.ts:257]
    → _activateSession(client, info) [engine/src/main.ts:229]
      → syncEngine?.setDriveClient(client)
      → void syncEngine?.startSyncAll()   ← triggers reconcile + drain
      → fileWatcher?.stop()
      → fileWatcher = new FileWatcher(...)
      → server.emitEvent({ type: "session_ready", payload })
```

`startSyncAll()` [sync-engine.ts:124] does:
1. `reconcileAndEnqueue()` — fresh remote tree walk, deduplicates against existing queue entries (so accumulated entries are NOT re-queued)
2. `drainQueue()` — processes ALL `change_queue` entries including accumulated ones

The conflict-detection decision table in `processQueueEntry` [sync-engine.ts:670] correctly handles the "expired session" scenario:
- `sync_state` defined + `remote.remote_mtime === state.remote_mtime` → **upload** (no false conflict) ✓ AC2
- `sync_state` defined + `remote.remote_mtime !== state.remote_mtime` → **conflict** ✓ AC3
- `sync_state` undefined + `remote` undefined → **upload** (new file, never synced before) ✓
- `sync_state` undefined + `remote` defined → **conflict** (collision) ✓

The `queue_replay_complete` event and "N files synced" toast are already fully implemented from Story 3-3 — no UI changes are needed.

### What this story actually delivers

**No new production code.** The existing `_activateSession → startSyncAll → drainQueue` path already correctly implements all four ACs. Story 5-3's work is:

1. **Task 1**: Add a clarifying comment to `_activateSession` in `engine/src/main.ts` documenting that this is also the re-auth queue drain entry point.
2. **Task 2**: Write engine unit tests in `sync-engine.test.ts` specifically covering the post-reauth accumulated-queue-drain scenario.
3. **Task 3**: Final validation.

### Critical implementation details

**`processQueueEntry` uses a fresh remote snapshot**: `drainQueue` calls `walkRemoteTree` once per pair before processing any entries. This means the conflict check compares `sync_state.remote_mtime` (last known state) against the CURRENT remote file's `remote_mtime` (fetched post-reauth). If remote was not touched during expiry, the mtimes match → upload. If remote changed during expiry, they differ → conflict. This is exactly the behavior required by AC2/AC3.

**Dedup in `reconcileAndEnqueue`**: [sync-engine.ts:484–499] The reconcile step builds `existingQueued` from the current `change_queue` contents before deciding what to enqueue. Accumulated entries are already in the queue, so they are NOT re-queued. Only net-new items from the remote walk are added. This prevents duplicate processing.

**`isDraining` re-entrancy guard**: If the new `FileWatcher` (created in `_activateSession`) fires a change event during the drain, it triggers `drainQueue()` again. The `isDraining` guard bounces the re-entrant call and `startSyncAll` handles this via the `setTimeout` retry [sync-engine.ts:131]. All accumulated entries will be processed.

**`commitUpload`/`commitTrash`/`commitDequeue` atomicity**: Each successful entry removes itself from `change_queue` atomically in the same SQLite transaction as its `sync_state` update [state-db.ts:254–288]. A crash mid-replay leaves a consistent state: queue entry stays (replay-on-restart is correct), partial writes are never committed.

**`queue_replay_complete` in `finally` block**: Even if re-auth happens while `drainQueue` is running (highly unlikely but possible), the `finally` block [sync-engine.ts:631–647] always emits `queue_replay_complete`. The UI never gets stuck waiting for a replay event that never arrives.

**`show_token_expired_warning` signature (post-5-2)**: `window.py:293` has signature `show_token_expired_warning(self) -> None` — no `queued_changes` param. The count is shown in the reauth modal body (5-2), not the banner. Do NOT add a param.

### Key file locations

| File | Relevance |
|------|-----------|
| `engine/src/main.ts:229` | `_activateSession` — add comment here (Task 1) |
| `engine/src/main.ts:257` | `handleTokenRefresh` — re-auth entry point |
| `engine/src/sync-engine.ts:124` | `startSyncAll` — calls reconcile then drain |
| `engine/src/sync-engine.ts:530` | `drainQueue` — processes all queue entries |
| `engine/src/sync-engine.ts:663` | `processQueueEntry` — conflict decision table |
| `engine/src/sync-engine.ts:690` | mtime comparison: `state!.remote_mtime === remote!.remote_mtime` |
| `engine/src/state-db.ts:254` | `commitUpload` — atomic upload + dequeue |
| `engine/src/state-db.ts:269` | `commitTrash` — atomic trash + dequeue |
| `engine/src/state-db.ts:281` | `commitDequeue` — atomic dequeue only |
| `engine/src/sync-engine.test.ts` | Add new describe block here (Task 2) |
| `ui/src/protondrive/window.py:420` | `on_queue_replay_complete` — toast already implemented |

### What NOT to touch

- `ui/src/protondrive/main.py` — no changes needed; `_on_session_ready` already calls `window.on_session_ready()` → `clear_token_expired_warning()`; no drain trigger needed in Python
- `ui/src/protondrive/window.py` — no changes needed; toast already handled
- `engine/src/state-db.ts` — no schema changes needed; `change_queue` persists correctly through token expiry
- `ui/tests/test_main.py` — no changes needed
- `engine/src/sync-engine.ts` — no production code changes (comment in `main.ts` only)

### Previous story learnings (5-1, 5-2)

- **5-1**: `FileWatcher` intentionally NOT stopped on `token_expired` — watcher keeps enqueueing during expiry. Story 5-3 drains these entries. Do NOT change watcher lifecycle on token expiry.
- **5-1**: `onTokenExpired` callback in `SyncEngine` constructor is 5th param (between `onNetworkFailure` and `sleepMs`). All test constructions must pass `sleepMs` as 6th arg if overriding it.
- **5-2**: `show_reauth_dialog()` is mocked in `_make_app()` — do not remove this mock; existing UI tests depend on it.
- **5-2**: `AdwAlertDialog` is the correct widget for the reauth modal. Do NOT use `AdwDialog` for new confirmation dialogs.
- **5-1/5-2**: The `_pending_reauth_dialog` lifecycle: set in `show_reauth_dialog()`, cleared in `_on_reauth_response()` and `_on_session_ready()`. Do NOT reset it elsewhere.

### Test patterns (engine)

New tests go in `engine/src/sync-engine.test.ts` in a new `describe("SyncEngine — post-reauth queue drain", ...)` block. Follow the existing pattern for the `describe("SyncEngine — 401 auth expiry detection", ...)` block added in Story 5-1 (around line 540 in sync-engine.test.ts).

Setup pattern for queue-drain tests:
```ts
// Seed sync_state (simulates file synced BEFORE token expired)
db.upsertSyncState({
  pair_id: PAIR_ID,
  relative_path: "notes.md",
  local_mtime: "2026-04-10T10:00:00.000Z",
  remote_mtime: "2026-04-10T10:00:00.000Z",
  content_hash: null,
});
// Seed change_queue (simulates local edit DURING token expiry)
db.enqueue({
  pair_id: PAIR_ID,
  relative_path: "notes.md",
  change_type: "modified",
  queued_at: "2026-04-10T11:00:00.000Z",
});
```

For AC2 (no false conflict): mock `listRemoteFiles` to return the file with `remote_mtime: "2026-04-10T10:00:00.000Z"` (unchanged). Assert `uploadFile` called once, queue empty after drain.

For AC3 (conflict): mock `listRemoteFiles` to return the file with `remote_mtime: "2026-04-10T10:30:00.000Z"` (changed during expiry). Assert no `uploadFile` call, queue entry still present, `skipped_conflicts: 1` in `queue_replay_complete` payload.

Use `makeMockClient` for mocking (same helper as other sync-engine tests). Check `emittedEvents` for `queue_replay_complete` payload.

---

## Tasks / Subtasks

- [x] **Task 1: Add re-auth drain comment to `_activateSession`** (AC: #1)
  - [x] 1.1 Open `engine/src/main.ts`, locate `_activateSession` (line ~229)
  - [x] 1.2 Add a comment on the `void syncEngine?.startSyncAll()` line:
    ```ts
    // startSyncAll() = reconcile (fresh remote walk) + drainQueue (processes any
    // change_queue entries accumulated during the token-expiry window, Story 5-3).
    void syncEngine?.startSyncAll();
    ```
  - [x] 1.3 `bunx tsc --noEmit` — zero type errors (comment-only change; this should trivially pass)

- [x] **Task 2: Add engine unit tests for post-reauth queue drain** (AC: #1, #2, #3, #4)
  - [x] 2.1 Open `engine/src/sync-engine.test.ts`
  - [x] 2.2 Add the following describe block AFTER the existing `describe("SyncEngine — 401 auth expiry detection", ...)` block. Each sibling describe block in the file has its own `beforeEach`/`afterEach` — this block must too (no shared outer setup exists):
    ```ts
    describe("SyncEngine — post-reauth queue drain (Story 5-3)", () => {
      beforeEach(() => {
        db = new StateDb(":memory:");
        emittedEvents = [];
        tmpDir = join(tmpdir(), `sync-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
        setupPair(); // uses REMOTE_ID ("remote-folder-uid") as remote_id
      });

      afterEach(() => {
        db.close();
        rmSync(tmpDir, { recursive: true, force: true });
        mock.restore();
      });

      it("AC1: accumulated queue entries are drained after setDriveClient + drainQueue", async () => {
        // Simulate a file that was synced before expiry.
        db.upsertSyncState({
          pair_id: PAIR_ID,
          relative_path: "notes.md",
          local_mtime: "2026-04-10T10:00:00.000Z",
          remote_mtime: "2026-04-10T10:00:00.000Z",
          content_hash: null,
        });
        // Simulate a local edit during expiry window.
        db.enqueue({
          pair_id: PAIR_ID,
          relative_path: "notes.md",
          change_type: "modified",
          queued_at: "2026-04-10T11:00:00.000Z",
        });
        // Write the local file so stat() succeeds in processQueueEntry.
        writeLocalFile("notes.md", "updated content");

        // Remote: file unchanged (same remote_mtime as sync_state) — AC2 scenario.
        mockClient = makeMockClient({
          listRemoteFiles: mock(async () => [
            makeRemoteFile("notes.md", "2026-04-10T10:00:00.000Z", 15, "node-1"),
          ]),
          uploadFile: mock(async () => ({ node_uid: "node-1", revision_uid: "rev-1" })),
        });
        engine = new SyncEngine(db, (e) => emittedEvents.push(e));
        engine.setDriveClient(mockClient);

        await engine.drainQueue();

        // AC4: queue entry removed
        expect(db.queueSize(PAIR_ID)).toBe(0);
        // AC4: queue_replay_complete emitted with synced: 1
        const complete = emittedEvents.find((e) => e.type === "queue_replay_complete");
        expect(complete).toBeTruthy();
        expect((complete!.payload as { synced: number }).synced).toBe(1);
        // AC2: uploadFile called (no false conflict)
        expect(mockClient.uploadFile).toHaveBeenCalledTimes(1);
      });

      it("AC2: remote-unchanged entry → upload, no conflict", async () => {
        db.upsertSyncState({
          pair_id: PAIR_ID,
          relative_path: "doc.md",
          local_mtime: "2026-04-10T10:00:00.000Z",
          remote_mtime: "2026-04-10T10:00:00.000Z",
          content_hash: null,
        });
        db.enqueue({
          pair_id: PAIR_ID,
          relative_path: "doc.md",
          change_type: "modified",
          queued_at: "2026-04-10T11:00:00.000Z",
        });
        writeLocalFile("doc.md", "local edit during expiry");

        mockClient = makeMockClient({
          listRemoteFiles: mock(async () => [
            makeRemoteFile("doc.md", "2026-04-10T10:00:00.000Z", 10, "node-doc"), // unchanged
          ]),
          uploadFile: mock(async () => ({ node_uid: "node-doc", revision_uid: "rev-doc" })),
        });
        engine = new SyncEngine(db, (e) => emittedEvents.push(e));
        engine.setDriveClient(mockClient);

        const result = await engine.drainQueue();

        expect(result.synced).toBe(1);
        expect(result.skipped_conflicts).toBe(0);
        expect(db.queueSize(PAIR_ID)).toBe(0);
      });

      it("AC3: both-sides-changed entry → conflict, entry stays in queue", async () => {
        db.upsertSyncState({
          pair_id: PAIR_ID,
          relative_path: "shared.md",
          local_mtime: "2026-04-10T10:00:00.000Z",
          remote_mtime: "2026-04-10T10:00:00.000Z",
          content_hash: null,
        });
        db.enqueue({
          pair_id: PAIR_ID,
          relative_path: "shared.md",
          change_type: "modified",
          queued_at: "2026-04-10T11:00:00.000Z",
        });
        writeLocalFile("shared.md", "my local edit");

        mockClient = makeMockClient({
          listRemoteFiles: mock(async () => [
            makeRemoteFile("shared.md", "2026-04-10T10:30:00.000Z", 10, "node-shared"), // changed during expiry
          ]),
          uploadFile: mock(async () => ({ node_uid: "node-shared", revision_uid: "rev-shared" })),
        });
        engine = new SyncEngine(db, (e) => emittedEvents.push(e));
        engine.setDriveClient(mockClient);

        const result = await engine.drainQueue();

        expect(result.synced).toBe(0);
        expect(result.skipped_conflicts).toBe(1);
        // Queue entry stays — conflict resolution is Epic 4's job
        expect(db.queueSize(PAIR_ID)).toBe(1);
        // uploadFile must NOT be called
        expect(mockClient.uploadFile).not.toHaveBeenCalled();
      });

      it("AC4: queue_replay_complete payload has correct synced count", async () => {
        // Two entries: one clean upload, one conflict.
        db.upsertSyncState({
          pair_id: PAIR_ID,
          relative_path: "a.md",
          local_mtime: "2026-04-10T10:00:00.000Z",
          remote_mtime: "2026-04-10T10:00:00.000Z",
          content_hash: null,
        });
        db.upsertSyncState({
          pair_id: PAIR_ID,
          relative_path: "b.md",
          local_mtime: "2026-04-10T10:00:00.000Z",
          remote_mtime: "2026-04-10T10:00:00.000Z",
          content_hash: null,
        });
        db.enqueue({ pair_id: PAIR_ID, relative_path: "a.md", change_type: "modified", queued_at: new Date().toISOString() });
        db.enqueue({ pair_id: PAIR_ID, relative_path: "b.md", change_type: "modified", queued_at: new Date().toISOString() });
        writeLocalFile("a.md", "edit a");
        writeLocalFile("b.md", "edit b");

        mockClient = makeMockClient({
          listRemoteFiles: mock(async () => [
            makeRemoteFile("a.md", "2026-04-10T10:00:00.000Z", 6, "n-a"),  // unchanged
            makeRemoteFile("b.md", "2026-04-10T10:45:00.000Z", 6, "n-b"),  // changed
          ]),
          uploadFile: mock(async () => ({ node_uid: "n-a", revision_uid: "rev-a" })),
        });
        engine = new SyncEngine(db, (e) => emittedEvents.push(e));
        engine.setDriveClient(mockClient);

        await engine.drainQueue();

        const complete = emittedEvents.find((e) => e.type === "queue_replay_complete");
        expect(complete).toBeTruthy();
        const p = complete!.payload as { synced: number; skipped_conflicts: number };
        expect(p.synced).toBe(1);
        expect(p.skipped_conflicts).toBe(1);
      });
    });
    ```
  - [x] 2.3 Confirm `writeLocalFile` helper is available at the top of the test file (line ~75 — it wraps `writeFileSync` from `node:fs`). Do NOT import `writeFile` from `node:fs/promises`; the test file uses the synchronous `writeFileSync` pattern throughout.
  - [x] 2.4 `bunx tsc --noEmit` — zero type errors

- [x] **Task 3: Final validation**
  - [x] 3.1 `bunx tsc --noEmit` from `engine/` — zero type errors
  - [x] 3.2 `bun test` from `engine/` — all existing tests pass; new `SyncEngine — post-reauth queue drain` tests pass (235/235)
  - [x] 3.3 `distrobox-enter -n LinuxProtonDrive -- bash -c "/usr/bin/meson compile -C builddir"` — zero errors (engine-only change; Blueprint/GResource unchanged)
  - [x] 3.4 `.venv/bin/pytest ui/tests/` — all pass (544/544)
  - [x] 3.5 Set story status to `review`

---

## Dev Notes

### §1 — Why no new production code

The entire AC1–AC4 behavior is already delivered by the existing engine path:
- `handleTokenRefresh` → `_activateSession` → `startSyncAll` → `reconcileAndEnqueue` + `drainQueue`
- `processQueueEntry` decision table (remote_mtime comparison) handles AC2/AC3 correctly
- `commitUpload`/`commitTrash`/`commitDequeue` handle queue cleanup (AC4)
- `queue_replay_complete` → `on_queue_replay_complete` → `AdwToast` handles UI feedback (AC4)

Story 5-3's value is verification that these paths work together correctly for the re-auth scenario. The tests prove this for the first time explicitly (prior tests covered offline-reconnect drain and general drain behavior, but not the accumulated-queue-after-token-expiry pattern).

### §2 — The `drainQueue` null-client guard and re-auth timing

During token expiry, any `drainQueue` call (from FileWatcher events) hits the null-client early return [sync-engine.ts:548–552]:
```ts
const client = this.driveClient;
if (!client) {
  return { synced: 0, skipped_conflicts: 0, failed: 0 };
}
```
The `finally` block still runs, emitting `queue_replay_complete` with zero counts. This is **expected** — the UI receiving `queue_replay_complete{synced:0}` during expiry is correct behavior (nothing was drained; entries stay queued).

After `setDriveClient(client)` in `_activateSession`, the next `drainQueue` call (via `startSyncAll`) will have a non-null client and process all accumulated entries.

### §3 — Use `writeLocalFile` helper, not `writeFile` from `node:fs/promises`

The test file uses `writeFileSync` from `node:fs` (line 11) throughout, with a `writeLocalFile(name, content)` convenience wrapper at line 75. Do NOT import `writeFile` from `node:fs/promises` — it's the wrong pattern for this test file and would add an unnecessary async import. Call `writeLocalFile("notes.md", "content")` directly.

### §4 — `makeMockClient` shape

`makeMockClient` (defined in `sync-engine.test.ts` near the top) takes a partial override object. For the AC2/AC3 tests:
- `listRemoteFiles` must return `RemoteFile[]` with the correct shape: `{ id, name, parent_id, remote_mtime, size }`
- `uploadFile` must return `{ node_uid: string }`
- `listRemoteFolders` defaults in `makeMockClient` to returning `[]` — this is correct for flat-directory tests
- `walkRemoteTree` is NOT mocked directly; `drainQueue` calls `walkRemoteTree` which internally calls `listRemoteFiles` and `listRemoteFolders`

### §5 — `drainQueue` vs `startSyncAll` in tests

For the Story 5-3 unit tests, call `engine.drainQueue()` directly (not `startSyncAll()`). Rationale:
- `startSyncAll` calls `reconcileAndEnqueue` first, which does a full remote tree walk — mocking this correctly adds complexity
- The queue entries are pre-seeded in the test DB; calling `drainQueue` directly tests the exact drain behavior
- `startSyncAll` is tested in other test blocks; do not duplicate that setup here

### §6 — Use `setupPair()` and `makeRemoteFile()` helpers

**`setupPair()`** (defined at line 64 of the test file) inserts the pair using the module-level `REMOTE_ID = "remote-folder-uid"` constant. Call it in `beforeEach` — do NOT repeat `db.insertPair(...)` in individual tests.

**`makeRemoteFile(name, mtime, size, id)`** (defined at line 29) creates `RemoteFile` objects with `parent_id: REMOTE_ID`. Use it in `listRemoteFiles` mocks instead of manual object literals. Example: `makeRemoteFile("notes.md", "2026-04-10T10:00:00.000Z", 15, "node-1")`.

`listRemoteFolders` in `makeMockClient` defaults to returning `[]`, correct for flat-directory tests.

### §7 — `on_queue_replay_complete` is already tested (do not add duplicate UI tests)

`ui/tests/test_window_routing.py:310–370` already covers the toast behavior for `queue_replay_complete`. `ui/tests/test_main.py:97–132` covers the `_on_queue_replay_complete` event wiring. Story 5-3 adds no new UI code, so no new UI tests are needed.

### §8 — Deferred from deferred-work.md (context only)

The 2026-04-12 deferred-work.md entry about Story 2-12 ("Unified Queue Drainer Refactor") notes that post-2-12, re-auth replay would be "just another call to drainQueue()." This is effectively already true — `_activateSession → startSyncAll → drainQueue` IS "just a call to drainQueue" from the queue's perspective. Story 2-12 would unify the reconcile + drain further but does not block Story 5-3.

### Project Structure Notes

**Files to create:** none

**Files to modify:**
- `engine/src/main.ts` — add one comment to `_activateSession` (line ~236, `void syncEngine?.startSyncAll()`)
- `engine/src/sync-engine.test.ts` — add `describe("SyncEngine — post-reauth queue drain (Story 5-3)", ...)` block

**Files to verify (no modification expected):**
- `engine/src/sync-engine.ts` — confirm `processQueueEntry` decision table and `drainQueue` logic are correct
- `ui/src/protondrive/window.py:420` — confirm `on_queue_replay_complete` shows toast
- `ui/src/protondrive/main.py` — confirm no drain trigger needed in Python

**Do NOT modify:**
- `engine/src/sync-engine.ts` — production logic is correct; comment goes in `main.ts` only
- `engine/src/state-db.ts` — schema is correct; no changes
- Any UI Python files or Blueprint files
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — dev agent sets to `review`, not `done`

### References

- Epic 5 story definition: `_bmad-output/planning-artifacts/epics/epic-5-token-expiry-error-recovery.md#Story-5.3`
- Story 5-1 (completed): `_bmad-output/implementation-artifacts/5-1-401-detection-and-sync-halt.md`
- Story 5-2 (completed): `_bmad-output/implementation-artifacts/5-2-re-auth-modal-with-queued-change-count.md`
- `_activateSession` function: `engine/src/main.ts:229`
- `handleTokenRefresh` function: `engine/src/main.ts:257`
- `startSyncAll`: `engine/src/sync-engine.ts:124`
- `drainQueue` with null-client guard: `engine/src/sync-engine.ts:548`
- `drainQueue` with `AuthExpiredError` catch: `engine/src/sync-engine.ts:624`
- `processQueueEntry` decision table: `engine/src/sync-engine.ts:676–696`
- `commitUpload` (atomic upload + dequeue): `engine/src/state-db.ts:254`
- `commitTrash` (atomic trash + dequeue): `engine/src/state-db.ts:269`
- `commitDequeue` (atomic dequeue): `engine/src/state-db.ts:281`
- `on_queue_replay_complete` (toast): `ui/src/protondrive/window.py:420`
- `_on_queue_replay_complete` (wiring): `ui/src/protondrive/main.py:211`
- 401-halt test pattern (model for new tests): `engine/src/sync-engine.test.ts` (search "SyncEngine — 401 auth expiry detection")
- `makeMockClient` helper: `engine/src/sync-engine.test.ts` (search "function makeMockClient")
- Deferred-work note on 2-12 + 5-3: `_bmad-output/implementation-artifacts/deferred-work.md`
- Project context (test commands, no GTK in engine tests): `_bmad-output/project-context.md`

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- AC1 test initially asserted `uploadFile` was called, but since `notes.md` already exists remotely (has a `node_uid`), `uploadOne` routes to `uploadFileRevision`. Fixed assertion to check `uploadFileRevision`.

### Completion Notes List

- Task 1: Added 2-line clarifying comment above `void syncEngine?.startSyncAll()` in `_activateSession` (engine/src/main.ts:236). No production logic changed.
- Task 2: Added `describe("SyncEngine — post-reauth queue drain (Story 5-3)", ...)` block with 4 tests (AC1–AC4) in sync-engine.test.ts after the 401 auth expiry detection block. Tests use `setupPair()`, `makeRemoteFile()`, `writeLocalFile()`, and `makeMockClient()` helpers per story spec.
- Task 3: All validation gates passed — 0 tsc errors, 235/235 bun tests, meson build clean, 544/544 pytest.

### File List

- engine/src/main.ts
- engine/src/sync-engine.test.ts

### Review Findings

- [x] [Review][Decision] AC1 trigger chain untested — resolved: added `AC1(integration)` test calling `engine.startSyncAll()` directly; exercises the full `reconcileAndEnqueue + drainQueue` path with pre-seeded queue entries and dedup logic [engine/src/sync-engine.test.ts]

- [x] [Review][Patch] Dead `uploadFile` mock override in AC1, AC2, AC4 — removed; file exists remotely so `uploadOne` routes to `uploadFileRevision`; mocks cleaned up [engine/src/sync-engine.test.ts]
- [x] [Review][Patch] AC2 missing upload-method assertion — added `expect(mockClient.uploadFileRevision).toHaveBeenCalledTimes(1)` [engine/src/sync-engine.test.ts:AC2]
- [x] [Review][Patch] AC3 conflict assertion incomplete — added `expect(mockClient.uploadFileRevision).not.toHaveBeenCalled()` alongside the existing `uploadFile` check [engine/src/sync-engine.test.ts:AC3]
- [x] [Review][Patch] No test for null-client guard path — added `null-client guard` test; verifies `drainQueue` short-circuits and emits `queue_replay_complete{synced:0}` before `setDriveClient` [engine/src/sync-engine.test.ts]
- [x] [Review][Patch] AC4 event-count assertion uses `find`, not exact-count — replaced with `filter(...).length === 1` [engine/src/sync-engine.test.ts:AC4]

- [x] [Review][Defer] `failed` return value never asserted in any 5-3 test — deferred, pre-existing gap outside story scope
- [x] [Review][Defer] `change_type='deleted'` during expiry window not tested — deferred, pre-existing gap outside story scope
- [x] [Review][Defer] New file (no sync_state) queued during expiry not tested — deferred, pre-existing gap outside story scope
- [x] [Review][Defer] ENOENT during drain mid-replay not tested — deferred, pre-existing gap outside story scope
- [x] [Review][Defer] `tmpDir` uniqueness collision risk via `Date.now()` — deferred, pre-existing pattern across all test suites
- [x] [Review][Defer] `afterEach` cleanup ordering: if `db.close()` throws, `rmSync`/`mock.restore()` skipped — deferred, pre-existing
- [x] [Review][Defer] AC4 UI toast coverage not verifiable from diff alone — deferred, pre-existing tests cited in Dev Note §7
