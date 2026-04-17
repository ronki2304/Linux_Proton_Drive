# Story 4.2: New-File Collision Detection

Status: done

## Story

As a user,
I want the sync engine to handle collisions when I add a new file that already exists remotely,
so that neither my local file nor the remote file is lost.

## Acceptance Criteria

### AC1 — Collision detected: new local file, remote counterpart exists, no sync_state

**Given** a local file exists with no `sync_state` entry (never previously synced)
**And** a remote file exists at the same relative path
**When** `computeWorkList` processes the local file
**Then** a `new_file_collision` WorkItem is pushed (not an `upload`, not skipped)

### AC2 — Rename to conflict copy

**Given** a `new_file_collision` WorkItem
**When** `reconcilePair` processes it
**Then** the local file is renamed to `<original_path>.conflict-YYYY-MM-DD` (local date, after extension)
**And** example: `/home/user/sync/notes.md` → `/home/user/sync/notes.md.conflict-2026-04-17`
**And** the rename uses the OS `rename()` syscall (atomic on same filesystem)
**And** the `conflict_copy_path` is constructed before any I/O attempt

### AC3 — Both versions preserved

**Given** a successful rename
**When** `reconcilePair` proceeds
**Then** the remote file is downloaded to the original path (using `downloadOne`)
**And** `upsertSyncState` is called with `remote_mtime` from the collision WorkItem
**And** `content_hash: null` in the upserted state (Story 4-3 populates hashes)
**And** the conflict copy retains its original content (the user's local file before the cycle)

### AC4 — `conflict_detected` push event emitted

**Given** a successful rename
**When** the event is emitted
**Then** `conflict_detected` is sent with `{ pair_id, local_path, conflict_copy_path }`
**And** the event is emitted BEFORE the download begins
**And** `local_path` is the absolute path to the original file (pre-rename)
**And** `conflict_copy_path` is the absolute path to the renamed conflict copy

### AC5 — Rename failure: emit error, do NOT download

**Given** `rename()` throws (e.g., ENOENT, EACCES)
**When** the error is caught
**Then** a `sync_file_error` event is emitted with the error message and `pair_id`
**And** `conflict_detected` is NOT emitted
**And** `downloadOne` is NOT called (original file may still exist at original path)
**And** execution continues with the next collision item (no full-cycle abort)

### AC6 — No remote collision → normal upload (unchanged)

**Given** a new local file with no `sync_state` entry
**And** no remote file at the same path
**When** `computeWorkList` processes it
**Then** it is pushed as a normal `upload` WorkItem (existing behavior preserved)

### AC7 — `sync_progress` event unaffected by collision items

**Given** collision items in the workList
**When** the initial `sync_progress` event is emitted
**Then** collision items are NOT counted in `files_total` or `bytes_total`
**And** collision downloads happen in the collision loop (before the progress-tracked download loop)

### AC8 — Unit tests

**When** running `bun test engine/src/sync-engine.test.ts`
**Then** the existing test "file in both, no sync_state → skip" is updated to assert the NEW behavior
**And** a new test verifies: collision → local file renamed, conflict_detected emitted, downloadFile called
**And** a new test verifies: rename failure → sync_file_error emitted, downloadFile NOT called
**And** a new test verifies: no remote collision → upload proceeds normally (existing test passes unchanged)

### AC9 — Type-check passes

**When** running `bunx tsc --noEmit`
**Then** zero type errors

---

## Tasks / Subtasks

- [x] **Task 1: Add `new_file_collision` WorkItem variant to `sync-engine.ts`** (AC: 1)
  - [x] 1.1 Add variant to the `WorkItem` union (after the existing `conflict` variant):
    ```ts
    | {
        kind: "new_file_collision";
        relativePath: string;
        remoteNodeId: string;
        remoteMtime: string;
        remoteSize: number;
      }
    ```

- [x] **Task 2: Replace the stub in `computeWorkList`** (AC: 1, 6)
  - [x] 2.1 Locate the stub at `sync-engine.ts:816-819`:
    ```ts
    if (!state) {
      // Both exist but no sync state → conflict, skip (Epic 4)
      debugLog(`sync-engine: skipping conflict (no sync_state) for ${relPath}`);
      continue;
    }
    ```
  - [x] 2.2 Replace with:
    ```ts
    if (!state) {
      // New-file collision: local and remote both exist with no prior sync record (Story 4-2)
      workItems.push({
        kind: "new_file_collision",
        relativePath: relPath,
        remoteNodeId: remote.id,
        remoteMtime: remote.remote_mtime,
        remoteSize: remote.size,
      });
      continue;
    }
    ```

- [x] **Task 3: Add `newFileCollisionItems` filter in `reconcilePair`** (AC: 2, 3, 4, 5, 7)
  - [x] 3.1 Add alongside the existing filters at `sync-engine.ts:240-245`:
    ```ts
    const newFileCollisionItems = workItems.filter(
      (w): w is WorkItem & { kind: "new_file_collision" } => w.kind === "new_file_collision"
    );
    ```
  - [x] 3.2 `bytesTotal` calculation (`sync-engine.ts:247`) must NOT include collision items — no change needed (it only sums `downloadItems` and `uploadItems`)

- [x] **Task 4: Implement collision handling block in `reconcilePair`** (AC: 2, 3, 4, 5)
  - [x] 4.1 Insert AFTER the `conflictItems` logging block (after line 257) and BEFORE the `deleteLocalItems` loop (before line 259):
    ```ts
    // ── Execute new_file_collision items (rename local → conflict copy, download remote) ──
    for (const item of newFileCollisionItems) {
      const localFilePath = join(pair.local_path, item.relativePath);
      const d = new Date();
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const conflictCopyPath = `${localFilePath}.conflict-${date}`;
      try {
        await rename(localFilePath, conflictCopyPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`sync-engine: collision rename failed for ${item.relativePath}: ${msg}`);
        this.emitEvent({
          type: "error",
          payload: { code: "sync_file_error", message: msg, pair_id: pair.pair_id },
        });
        continue;
      }
      this.emitEvent({
        type: "conflict_detected",
        payload: {
          pair_id: pair.pair_id,
          local_path: localFilePath,
          conflict_copy_path: conflictCopyPath,
        },
      });
      try {
        const downloadItem: WorkItem & { kind: "download" } = {
          kind: "download",
          relativePath: item.relativePath,
          nodeUid: item.remoteNodeId,
          size: item.remoteSize,
          remoteMtime: item.remoteMtime,
        };
        await this.downloadOne(pair, downloadItem, client);
        const destPath = join(pair.local_path, item.relativePath);
        const s = await stat(destPath);
        this.stateDb.upsertSyncState({
          pair_id: pair.pair_id,
          relative_path: item.relativePath,
          local_mtime: s.mtime.toISOString(),
          remote_mtime: item.remoteMtime,
          content_hash: null,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`sync-engine: collision download failed for ${item.relativePath}: ${msg}`);
        this.emitEvent({
          type: "error",
          payload: { code: "sync_file_error", message: msg, pair_id: pair.pair_id },
        });
      }
    }
    ```

- [x] **Task 5: Update and expand tests in `sync-engine.test.ts`** (AC: 8)
  - [x] 5.1 Update the existing test at `sync-engine.test.ts:281`: "file in both, no sync_state → skip (conflict deferred to Epic 4)". Change description and assertions to verify collision behavior:
    - Add `existsSync` to the existing `import { ... } from "node:fs"` block at line 11 if not already present
    - Local file renamed to `<file>.conflict-<date>` (use `existsSync` to check)
    - `conflict_detected` event emitted in `emittedEvents`
    - `downloadFile` called once (remote version downloaded)
    - `uploadFile`/`uploadFileRevision` NOT called
    - `upsertSyncState` called (from the collision download handler)
  - [x] 5.2 Add a new `it` test: "rename fails → sync_file_error emitted, no download":
    - **The local file MUST exist** (`writeLocalFile("conflict.txt")`) so that `computeWorkList` produces a `new_file_collision` WorkItem — without it, the engine never reaches the rename code path
    - Use `chmodSync(tmpDir, 0o555)` to make the directory non-writable so `rename()` fails with EACCES (`chmodSync` is already imported at test line 11)
    - Wrap `startSyncAll()` in a `try/finally` block and call `chmodSync(tmpDir, 0o755)` in the `finally` to restore permissions before `afterEach` cleanup
    - Verify `sync_file_error` event emitted, `downloadFile` NOT called
  - [x] 5.3 Verify existing test at `sync-engine.test.ts:242` ("new local file only → upload") still passes — it covers AC6

- [x] **Task 6: Validate** (AC: 9)
  - [x] 6.1 `bunx tsc --noEmit` — zero type errors
  - [x] 6.2 `bun test engine/src/sync-engine.test.ts` — all tests pass (53/53)
  - [x] 6.3 `bun test engine/src/conflict.test.ts` — no regressions (8/8)
  - [x] 6.4 `bun test engine/src` — full suite passes (226/226)

---

## Dev Notes

### §1 — `rename` Is Already Imported — No New Imports Needed

`engine/src/sync-engine.ts:1` already has:
```ts
import { readdir, stat, rename, unlink, mkdir } from "node:fs/promises";
```
`rename` (used by `downloadOne` at line 978), `stat`, and all other needed utilities are already present. **Do not add new imports for these.**

### §2 — The Stub Being Replaced

The exact stub at `sync-engine.ts:816-819` (inside the `remote` branch of the local-files loop, `!state` guard):
```ts
if (!state) {
  // Both exist but no sync state → conflict, skip (Epic 4)
  debugLog(`sync-engine: skipping conflict (no sync_state) for ${relPath}`);
  continue;
}
```
Story 4-1 Dev Notes §8 explicitly preserved this stub for Story 4-2. Replace the entire `if (!state) { ... continue; }` block with the `new_file_collision` WorkItem push.

**Do NOT touch the `state`-present branches above this stub** (the `localChanged && remoteChanged` block with `detectConflict`, the `localChanged`-only upload, and the `remoteChanged`-only download). Those belong to Story 4-1 and are correct.

### §3 — Collision Handling Execution Order in `reconcilePair`

Current execution order (from `sync-engine.ts:249` onward):
1. `clearStateItems` (no I/O) — line 249
2. `conflictItems` logging — line 254 (Story 4-1 stub; Story 4-3 adds copy creation)
3. ← **INSERT collision handling block HERE** (after line 257, before line 259)
4. `deleteLocalItems` — line 259
5. `trashRemoteItems` — line 275
6. Initial `sync_progress` emit — line 288
7. Downloads loop — line 301
8. Uploads enqueue — later

Placing collision handling at step 3 ensures:
- Rename happens before download (structural guarantee)
- Collision downloads complete BEFORE the `sync_progress` initial event — so `files_total` and `bytes_total` (which only count regular `downloadItems`/`uploadItems`) remain correct
- No mutation of `downloadItems` or `bytesTotal` needed

### §4 — `downloadOne` Call Inside the Collision Loop

After a successful rename, construct a `download` WorkItem inline and call `downloadOne` directly:
```ts
const downloadItem: WorkItem & { kind: "download" } = {
  kind: "download",
  relativePath: item.relativePath,
  nodeUid: item.remoteNodeId,
  size: item.remoteSize,
  remoteMtime: item.remoteMtime,
};
await this.downloadOne(pair, downloadItem, client);
```
`downloadOne` (`sync-engine.ts:952`) uses the atomic `tmp → rename` write pattern internally. After it resolves, `stat(destPath)` gives the actual on-disk mtime for `upsertSyncState`.

**Do NOT add the collision download to `downloadItems`.** Adding to `downloadItems` would require mutable `let downloadItems = [...]`, would double-count in `bytesTotal`, and would re-execute in the regular download loop.

### §5 — `conflict_detected` IPC Event Shape

The IPC event type (`IpcPushEvent` in `ipc.ts:22`) is generic — `type: string; payload: Record<string, unknown>`. No changes to `ipc.ts` are needed. Just emit:
```ts
this.emitEvent({
  type: "conflict_detected",
  payload: {
    pair_id: pair.pair_id,
    local_path: localFilePath,        // absolute path — pre-rename original
    conflict_copy_path: conflictCopyPath, // absolute path — post-rename destination
  },
});
```
Story 4-4 (UI) will subscribe to this event. The payload field names must match exactly — IPC wire format is `snake_case` (project-context.md §IPC Wire Format).

### §6 — Conflict Copy Date Format

Use **local date** (project-context.md: "conflict copy suffix uses `YYYY-MM-DD` local date"):
```ts
const d = new Date();
const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
```
This gives local-timezone `YYYY-MM-DD` without relying on `toLocaleDateString` locale support. The resulting suffix: `.conflict-2026-04-17`.

**Do NOT use `new Date().toISOString().slice(0, 10)`** — that gives UTC date, which differs from local date around midnight.

### §7 — `noUncheckedIndexedAccess` and TypeScript Strict Flags

No array index access patterns are introduced in this story. The `WorkItem & { kind: "new_file_collision" }` type narrowing via the filter guard fully types the collision items. No `!` non-null assertions needed.

The `WorkItem` union is exhaustively handled by the existing filter structure. Adding `new_file_collision` to the union and filtering it into `newFileCollisionItems` is sufficient — the TypeScript compiler will not complain about unhandled variants in the filter block.

### §8 — Existing Test to Update (Line 281)

The test at `sync-engine.test.ts:281` currently asserts:
- `uploadFile` NOT called ✓ (still correct)
- `downloadFile` NOT called ✗ (must change — download IS called after rename)
- `upsertCalled = false` ✗ (must change — upsert IS called)

Updated assertions:
- `downloadFile` called once
- `conflict_detected` event in `emittedEvents`
- `uploadFile` NOT called
- `existsSync(join(tmpDir, "conflict.txt"))` is `false` (renamed away)
- `existsSync(join(tmpDir, \`conflict.txt.conflict-\${date}\`))` is `true`

The `downloadFile` mock must write actual bytes for `downloadOne` to complete (see existing download tests at line 134 for pattern). The mock must:
```ts
downloadFile: mock(async (_uid: string, target: WritableStream<Uint8Array>) => {
  const writer = target.getWriter();
  await writer.write(new Uint8Array([1, 2, 3]));
  await writer.close();
}),
```

### §9 — Story 4-3 Relationship

**Story 4-3 (Conflict Copy Creation)** handles the OTHER conflict case: existing files that conflict (detected by Story 4-1). The 4-1 `conflict` WorkItem currently just logs. Story 4-3 will replace that logging with copy creation + download.

**Story 4-2 is self-contained** — it introduces its own WorkItem type (`new_file_collision`), its own handling block, and its own event. The 4-3 story touches the `conflictItems` block; 4-2 adds a separate `newFileCollisionItems` block. The two are independent and don't share code paths.

### §10 — `processQueueEntry` Is NOT Affected

The `drainQueue` → `processQueueEntry` path (change_queue driven) has its own collision handling at `sync-engine.ts` around line 520-535 — specifically the `"conflict"` guard in `processQueueEntry`. **Do NOT modify `processQueueEntry`** in this story. The stub in `computeWorkList` (replaced here) is on the `startSyncAll` → `reconcilePair` code path only. The two paths are separate.

### §11 — Test Infrastructure Note

The test suite uses actual temp filesystem I/O (real files via `writeLocalFile`, real SQLite `:memory:` DB). The `rename` call in the collision handler will operate on real files. Tests should use `existsSync` (from `node:fs`) to assert that the conflict copy file exists and the original is gone.

`existsSync` is available via `import { existsSync } from "node:fs"` — check if it's already imported in the test file. If not, add it to the existing `import { ... } from "node:fs"` block.

### §12 — Same-Day Conflict Copy Overwrite (Known Limitation)

On Linux, `rename(src, dst)` atomically replaces `dst` if it already exists. If `notes.md.conflict-2026-04-17` was created by an earlier collision on the same day, a second collision will silently overwrite the first conflict copy. This is a known MVP limitation — no guard is implemented in this story. Do NOT add any exists-check or counter suffix: that complexity is deferred.

### §13 — Rename Success + Download Failure: Next-Cycle Behavior

If `rename()` succeeds but `downloadOne` throws: the local file is now at `<path>.conflict-date`, the original path is empty, and no sync state is recorded for either path. On the next sync cycle: the engine downloads the remote file to the original path (remote-only, no sync state → `download` WorkItem) and uploads the conflict copy to Proton Drive (local-only, no sync state, no remote counterpart → `upload` WorkItem). The user's local file (the conflict copy) will therefore appear in Proton Drive as a new file. This is the correct MVP failure-mode behavior — no special handling needed in this story.

### Project Structure Notes

- Files modified: `engine/src/sync-engine.ts`, `engine/src/sync-engine.test.ts`
- Files created: none
- Files NOT modified: `engine/src/conflict.ts`, `engine/src/conflict.test.ts`, `engine/src/ipc.ts`, `engine/src/state-db.ts`, any UI files
- Engine source is flat — no subdirectories created

### References

- Epic 4 story 4-2 definition: `_bmad-output/planning-artifacts/epics/epic-4-conflict-detection-resolution.md#story-42`
- WorkItem union: `engine/src/sync-engine.ts:33-59`
- Stub to replace: `engine/src/sync-engine.ts:816-819`
- `reconcilePair` filter block: `engine/src/sync-engine.ts:240-245`
- `conflictItems` logging block (Story 4-1): `engine/src/sync-engine.ts:254-257`
- `deleteLocalItems` loop (insert collision block before this): `engine/src/sync-engine.ts:259`
- `bytesTotal` calculation: `engine/src/sync-engine.ts:247`
- Initial `sync_progress` emit: `engine/src/sync-engine.ts:288`
- `downloadOne` method: `engine/src/sync-engine.ts:952`
- All node:fs/promises imports already present: `engine/src/sync-engine.ts:1`
- Existing test to update: `engine/src/sync-engine.test.ts:281`
- Existing download mock pattern: `engine/src/sync-engine.test.ts:134`
- Story 4-1 dev notes §8 (why stub was preserved): `_bmad-output/implementation-artifacts/4-1-conflict-detection-existing-files.md#§8`
- Deferred items (4-0b review): `_bmad-output/implementation-artifacts/deferred-work.md` — W2 specifically: "Local file modified + remote deleted → delete_local silently discards unsaved edits" — still deferred, not in scope for 4-2
- Current test count (baseline): 225 pass across `bun test engine/src` as of 2026-04-17 (per 4-1 story)
- `IpcPushEvent` interface: `engine/src/ipc.ts:22` — generic, no changes needed

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

None — implementation was straightforward; no unexpected deviations.

### Completion Notes List

- Added `new_file_collision` variant to `WorkItem` union after existing `conflict` variant (sync-engine.ts)
- Replaced `computeWorkList` stub (lines 816-819) with `new_file_collision` WorkItem push — local+remote, no sync_state
- Added `newFileCollisionItems` filter alongside existing filters in `reconcilePair`; `bytesTotal` unchanged (collision downloads not counted)
- Implemented collision handling block after `conflictItems` logging, before `deleteLocalItems` loop: rename → `conflict_detected` emit → `downloadOne` → `upsertSyncState`; rename failure path emits `sync_file_error` and continues
- Updated existing test "file in both, no sync_state → skip" to assert new collision behavior (rename, conflict_detected, download, upsert)
- Added new test "rename fails → sync_file_error emitted, downloadFile NOT called" using `chmodSync(tmpDir, 0o555)` + try/finally
- Added `existsSync` to node:fs import in test file
- All 226 engine tests pass; zero tsc errors

### File List

- `engine/src/sync-engine.ts`
- `engine/src/sync-engine.test.ts`

### Change Log

- feat(4-2): new-file collision detection — rename local to conflict copy, download remote, emit conflict_detected (2026-04-17)

---

## Review Findings

- [x] [Review][Patch] Missing `existsSync` assertions in collision test [engine/src/sync-engine.test.ts] — Added: conflict copy exists (toBe(true)) + original path re-populated with remote version (toBe(true)). Note: Dev Notes §8 said original should be `false` but that's incorrect — `downloadOne` recreates the file at the original path.
- [x] [Review][Patch] Rename-failure test does not assert `pair_id` or `message` on error payload [engine/src/sync-engine.test.ts] — Added assertions for `errorEvent.payload.pair_id` (= PAIR_ID) and `typeof message === "string"` (AC5).
- [x] [Review][Defer] `conflict` WorkItem only logs — Story 4-3 handles copy creation [engine/src/sync-engine.ts] — deferred, by design (4-1 stub, 4-3 scope)
- [x] [Review][Defer] Rename success + download failure → orphaned conflict copy, no sync_state recovery [engine/src/sync-engine.ts] — deferred, pre-existing; documented in Dev Notes §13 as accepted MVP failure-mode behavior
- [x] [Review][Defer] Same-day conflict copy path overwrites prior copy without guard [engine/src/sync-engine.ts] — deferred, pre-existing; documented in Dev Notes §12 as explicit MVP deferral
- [x] [Review][Defer] `delete_local` and `new_file_collision` + change_queue orphan interactions [engine/src/sync-engine.ts] — deferred, pre-existing architectural gap; change_queue/sync-cycle coupling out of scope for 4-2
- [x] [Review][Defer] `hashLocalFile` race with active concurrent writer yields partial-content hash [engine/src/sync-engine.ts] — deferred, pre-existing; conservative path (null hash → isConflict) handles it safely
- [x] [Review][Defer] `stat(destPath)` after collision download may record coarse mtime on ext4/btrfs [engine/src/sync-engine.ts] — deferred, pre-existing pattern identical to existing download path
