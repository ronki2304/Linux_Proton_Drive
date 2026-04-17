# Story 4.3: Conflict Copy Creation

Status: done

## Story

As a user,
I want the sync engine to preserve my local file changes when a conflict is detected,
so that my work is never silently overwritten.

## Acceptance Criteria

### AC1 — Conflict copy naming: suffix after extension

**Given** a `conflict` WorkItem is processed in `reconcilePair`
**When** the conflict copy is created
**Then** it is named `filename.ext.conflict-YYYY-MM-DD` where the date is the local date at creation time
**And** example: `/home/user/sync/notes.md` → `/home/user/sync/notes.md.conflict-2026-04-17`

### AC2 — Atomic write for conflict copy

**Given** the conflict copy path is determined
**When** the conflict copy is written
**Then** the local file is first copied to `<conflictCopyPath>.protondrive-tmp-<timestamp>`
**And** on successful copy, `rename()` atomically moves tmp → conflict copy path
**And** the original file at `localFilePath` is never overwritten before the conflict copy is committed
**And** if the copy or rename fails, the tmp file is deleted and a `sync_file_error` event is emitted

### AC3 — `conflict_detected` push event

**Given** the conflict copy is successfully created
**When** the event is emitted
**Then** `conflict_detected` is sent with `{ pair_id, local_path, conflict_copy_path }`
**And** `local_path` is the absolute path of the original file (pre-download)
**And** `conflict_copy_path` is the absolute path of the conflict copy

### AC4 — Remote version downloaded to original path

**Given** the conflict copy has been created (local version safe)
**When** the remote version is downloaded
**Then** `downloadOne` is called with a `download` WorkItem built from the `conflict` WorkItem's `remoteNodeId`, `remoteMtime`, `remoteSize`
**And** `upsertSyncState` is called after download with `local_mtime` from `stat(destPath)`, `remote_mtime` from the WorkItem, and a non-null `content_hash` (SHA-256 of the downloaded file)

### AC5 — Error handling: copy fails → no download

**Given** the `copyFile` or `rename` call for the conflict copy throws
**When** the error is caught
**Then** a `sync_file_error` event is emitted with the error message and `pair_id`
**And** `conflict_detected` is NOT emitted
**And** `downloadOne` is NOT called
**And** the tmp file is cleaned up
**And** execution continues with the next conflict item (no full-cycle abort)

### AC6 — Error handling: download fails after copy

**Given** the conflict copy is created successfully but `downloadOne` throws
**When** the error is caught
**Then** a `sync_file_error` event is emitted
**And** the conflict copy remains at `conflictCopyPath` (user's local changes preserved)
**And** no `upsertSyncState` call is made

### AC7 — Hash population: all `content_hash: null` sites updated

**Given** a file is downloaded (regular download in `reconcilePair`, new_file_collision download, or conflict resolution download)
**When** `upsertSyncState` is called
**Then** `content_hash` is the SHA-256 hex digest of the file at `destPath` (via `hashLocalFile`)
**And** if `hashLocalFile` returns null (unreadable), `content_hash` is stored as null (conservative fallback)

**Given** a file is uploaded via `processQueueEntry`
**When** `commitUpload` is called
**Then** `content_hash` is the SHA-256 hex digest of the local file (via `hashLocalFile`)
**And** if `hashLocalFile` returns null, `content_hash` is stored as null

### AC8 — Existing `new_file_collision` and `conflict` WorkItem filters not broken

**Given** both WorkItem types exist in `reconcilePair`
**When** the story ships
**Then** `newFileCollisionItems` filter (4-2) is unchanged
**And** `conflictItems` filter (4-1) is unchanged
**And** only the logging stub loop (lines 263-265) is replaced

### AC9 — Unit tests

**When** running `bun test engine/src/sync-engine.test.ts`
**Then** the existing test "both mtimes changed → conflict WorkItem logged, no overwrite" is updated to verify Story 4-3 behavior
**And** a new test verifies: copy-creation failure → `sync_file_error` emitted, `downloadFile` NOT called
**And** existing 4-2 tests (new_file_collision) still pass unchanged

### AC10 — Type-check passes

**When** running `bunx tsc --noEmit`
**Then** zero type errors

---

## Tasks / Subtasks

- [x] **Task 1: Add `copyFile` to imports** (AC: 2)
  - [x] 1.1 Add `copyFile` to the `node:fs/promises` import at `sync-engine.ts:1`:
    ```ts
    import { readdir, stat, rename, unlink, mkdir, copyFile } from "node:fs/promises";
    ```

- [x] **Task 2: Replace `conflictItems` logging stub with copy-creation loop** (AC: 1, 2, 3, 4, 5, 6)
  - [x] 2.1 Locate the stub at `sync-engine.ts:263-265`:
    ```ts
    // Story 4-1: log detected conflicts — Story 4-3 adds conflict copy creation and conflict_detected event
    for (const item of conflictItems) {
      debugLog(`sync-engine: conflict detected for ${item.relativePath} (both sides changed — Story 4-3 will handle copy creation)`);
    }
    ```
  - [x] 2.2 Replace entirely with:
    ```ts
    // ── Execute conflict items (copy local version → conflict copy, download remote version) ──
    for (const item of conflictItems) {
      const localFilePath = join(pair.local_path, item.relativePath);
      const d = new Date();
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const conflictCopyPath = `${localFilePath}.conflict-${date}`;
      const tmpPath = `${conflictCopyPath}.protondrive-tmp-${Date.now()}`;
      try {
        await copyFile(localFilePath, tmpPath);
        await rename(tmpPath, conflictCopyPath);
      } catch (err) {
        try { await unlink(tmpPath); } catch { /* already gone */ }
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`sync-engine: conflict copy creation failed for ${item.relativePath}: ${msg}`);
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
        const hash = await this.hashLocalFile(destPath);
        this.stateDb.upsertSyncState({
          pair_id: pair.pair_id,
          relative_path: item.relativePath,
          local_mtime: s.mtime.toISOString(),
          remote_mtime: item.remoteMtime,
          content_hash: hash,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`sync-engine: conflict download failed for ${item.relativePath}: ${msg}`);
        this.emitEvent({
          type: "error",
          payload: { code: "sync_file_error", message: msg, pair_id: pair.pair_id },
        });
      }
    }
    ```

- [x] **Task 3: Populate `content_hash` for `new_file_collision` download** (AC: 7)
  - [x] 3.1 Locate `upsertSyncState` at `sync-engine.ts:303` (inside the `newFileCollisionItems` loop, after `downloadOne`):
    ```ts
    this.stateDb.upsertSyncState({
      pair_id: pair.pair_id,
      relative_path: item.relativePath,
      local_mtime: s.mtime.toISOString(),
      remote_mtime: item.remoteMtime,
      content_hash: null,
    });
    ```
  - [x] 3.2 Compute hash before the upsert call (add one line before the upsert):
    ```ts
    const hash = await this.hashLocalFile(destPath);
    this.stateDb.upsertSyncState({
      pair_id: pair.pair_id,
      relative_path: item.relativePath,
      local_mtime: s.mtime.toISOString(),
      remote_mtime: item.remoteMtime,
      content_hash: hash,
    });
    ```
    Note: `destPath` is already declared in that scope (`const destPath = join(pair.local_path, item.relativePath)`).

- [x] **Task 4: Populate `content_hash` for regular downloads** (AC: 7)
  - [x] 4.1 Locate `upsertSyncState` at `sync-engine.ts:369` (inside the `downloadItems` loop):
    ```ts
    this.stateDb.upsertSyncState({
      pair_id: pair.pair_id,
      relative_path: item.relativePath,
      local_mtime: s.mtime.toISOString(),
      remote_mtime: (item as WorkItem & { kind: "download" }).remoteMtime,
      content_hash: null,
    });
    ```
  - [x] 4.2 Add hash computation before the upsert (at this point `destPath` and `s` are already declared in scope):
    ```ts
    const hash = await this.hashLocalFile(destPath);
    this.stateDb.upsertSyncState({
      pair_id: pair.pair_id,
      relative_path: item.relativePath,
      local_mtime: s.mtime.toISOString(),
      remote_mtime: (item as WorkItem & { kind: "download" }).remoteMtime,
      content_hash: hash,
    });
    ```

- [x] **Task 5: Populate `content_hash` for uploads via `processQueueEntry`** (AC: 7)
  - [x] 5.1 Locate `commitUpload` at `sync-engine.ts:676` (inside `processQueueEntry`, `case "upload"`):
    ```ts
    this.stateDb.commitUpload(
      {
        pair_id: pair.pair_id,
        relative_path: entry.relative_path,
        local_mtime: workItem.localMtime,
        remote_mtime: workItem.localMtime,
        content_hash: null,
      },
      entry.id,
    );
    ```
  - [x] 5.2 Compute hash of the just-uploaded local file and pass it in:
    ```ts
    const uploadedPath = join(pair.local_path, entry.relative_path);
    const hash = await this.hashLocalFile(uploadedPath);
    this.stateDb.commitUpload(
      {
        pair_id: pair.pair_id,
        relative_path: entry.relative_path,
        local_mtime: workItem.localMtime,
        remote_mtime: workItem.localMtime,
        content_hash: hash,
      },
      entry.id,
    );
    ```
    Note: `pair` is already in scope (parameter of `processQueueEntry`). `hashLocalFile` is a private method of `SyncEngine`, callable via `this.hashLocalFile`.

- [x] **Task 6: Update conflict test in `sync-engine.test.ts`** (AC: 9)
  - [x] 6.1 Locate test at `sync-engine.test.ts:1624`: "both mtimes changed → conflict WorkItem logged, no overwrite"
  - [x] 6.2 Update `downloadFn` mock to write actual bytes (required for `downloadOne` to complete — it writes to a tmp file then renames):
    ```ts
    const downloadFn = mock(async (_uid: string, target: WritableStream<Uint8Array>) => {
      const writer = target.getWriter();
      await writer.write(new Uint8Array([10, 20, 30]));
      await writer.close();
    });
    ```
  - [x] 6.3 Replace the assertions block starting at line 1656:
    ```ts
    // Conflict copy must exist (preserving local "local content")
    const date = new Date().toISOString().slice(0, 10);  // local date pattern: YYYY-MM-DD
    // Use local date (same as engine implementation)
    const d = new Date();
    const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(existsSync(join(tmpDir, `conflict.txt.conflict-${localDate}`))).toBe(true);

    // conflict_detected event emitted
    const conflictEvent = emittedEvents.find((e) => e.type === "conflict_detected");
    expect(conflictEvent).toBeTruthy();
    expect((conflictEvent!.payload as Record<string, unknown>).local_path).toBe(join(tmpDir, "conflict.txt"));
    expect((conflictEvent!.payload as Record<string, unknown>).conflict_copy_path).toBe(join(tmpDir, `conflict.txt.conflict-${localDate}`));

    // Remote version was downloaded to original path
    expect(downloadFn.mock.calls.length).toBe(1);

    // Upload NOT called (conflict, not an upload)
    expect(uploadFn.mock.calls.length).toBe(0);

    // sync_state updated (remote version now tracked)
    const state = db.getSyncState(PAIR_ID, "conflict.txt");
    expect(state).toBeTruthy();
    expect(state!.remote_mtime).toBe(newRemoteMtime);
    expect(state!.content_hash).not.toBeNull(); // hash populated by Story 4-3
    ```
  - [x] 6.4 Update the test name to reflect new behavior: "both mtimes changed → conflict copy created, conflict_detected emitted, remote downloaded"
  - [x] 6.5 Compute `localDate` the same way as the engine (local timezone, not UTC):
    ```ts
    const d = new Date();
    const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    ```

- [x] **Task 7: Add new test: conflict copy creation fails** (AC: 9, AC5)
  - [x] 7.1 Add `it` block inside `describe("SyncEngine — conflict detection (Story 4-1)")` immediately after the updated test:
    ```ts
    it("conflict copy creation fails → sync_file_error emitted, no download", async () => {
      writeLocalFile("conflict.txt", "local content");

      const storedLocalMtime  = "2020-01-01T00:00:00.000Z";
      const storedRemoteMtime = "2020-01-01T00:00:00.000Z";
      const newRemoteMtime    = "2026-04-10T12:00:00.000Z";

      db.upsertSyncState({
        pair_id: PAIR_ID,
        relative_path: "conflict.txt",
        local_mtime: storedLocalMtime,
        remote_mtime: storedRemoteMtime,
        content_hash: null,
      });

      const downloadFn = mock(async (_uid: string, target: WritableStream<Uint8Array>) => {
        const writer = target.getWriter();
        await writer.write(new Uint8Array([10, 20, 30]));
        await writer.close();
      });

      mockClient = makeMockClient({
        listRemoteFiles: mock(async () => [
          makeRemoteFile("conflict.txt", newRemoteMtime),
        ]),
        downloadFile: downloadFn,
      });
      engine = new SyncEngine(db, (e) => emittedEvents.push(e));
      engine.setDriveClient(mockClient);

      // Make tmpDir non-writable so copyFile to tmp fails
      chmodSync(tmpDir, 0o555);
      try {
        await engine.startSyncAll();
      } finally {
        chmodSync(tmpDir, 0o755);
      }

      // sync_file_error emitted
      const errorEvent = emittedEvents.find((e) => e.type === "error");
      expect(errorEvent).toBeTruthy();
      expect((errorEvent!.payload as Record<string, unknown>).code).toBe("sync_file_error");
      expect(typeof (errorEvent!.payload as Record<string, unknown>).message).toBe("string");
      expect((errorEvent!.payload as Record<string, unknown>).pair_id).toBe(PAIR_ID);

      // conflict_detected NOT emitted
      const conflictEvent = emittedEvents.find((e) => e.type === "conflict_detected");
      expect(conflictEvent).toBeUndefined();

      // downloadFile NOT called
      expect(downloadFn.mock.calls.length).toBe(0);
    });
    ```

- [x] **Task 8: Validate** (AC: 10)
  - [x] 8.1 `bunx tsc --noEmit` — zero type errors
  - [x] 8.2 `bun test engine/src/sync-engine.test.ts` — 54/54 pass
  - [x] 8.3 `bun test engine/src/conflict.test.ts` — 8/8 pass (unchanged)
  - [x] 8.4 `bun test engine/src` — 227/227 pass

---

## Dev Notes

### §1 — Conflict Copy vs New-File Collision: Key Difference

**Story 4-2 (`new_file_collision`):** uses `rename(localFilePath, conflictCopyPath)` — **moves** the original away, then downloads remote to the now-empty original path.

**Story 4-3 (`conflict`):** uses `copyFile(localFilePath, tmpPath)` → `rename(tmpPath, conflictCopyPath)` — **copies** the original to the conflict path (original remains), then downloads remote to original path (overwriting local).

Why the difference? 4-2 involves a file that was never synced (no sync_state) — the file appeared locally while a remote version existed. 4-3 involves a file that was previously synced but has since been modified on both sides. In both cases, the user's local work ends up at `<originalPath>.conflict-date` and the remote version ends up at the original path. The mechanism differs because we need the copy-then-download sequence to be safe: after the `rename(tmpPath, conflictCopyPath)`, both the original file AND the conflict copy exist simultaneously — there is no window where local changes are lost.

### §2 — Why `copyFile` + `rename`, Not Direct `rename`

The AC specifies "write to `<path>.protondrive-tmp-<timestamp>` then `rename()`". This two-step sequence provides:
1. **Non-destructive**: original stays at `localFilePath` while copy is being written — ensures we can `continue` safely if copy is interrupted
2. **Atomic commit**: `rename(tmp, conflictCopyPath)` is atomic on the same filesystem — conflict copy either fully exists or doesn't, never partial
3. **Error recovery**: if `copyFile` fails mid-write, we delete `tmpPath` and the original is untouched

Using `rename(localFilePath, conflictCopyPath)` directly would also be atomic, but it moves the original — leaving `localFilePath` empty and preventing error recovery on download failure.

### §3 — Hash Population: All Four Sites

Story 4-1 §7 explicitly defers hash computation to Story 4-3. Four `content_hash: null` sites must be updated:

| Location | `sync-engine.ts` line | Scope |
|---|---|---|
| `conflictItems` loop (new in 4-3) | NEW | After download, hash `destPath` |
| `newFileCollisionItems` loop | ~303 | After download, hash `destPath` |
| Regular `downloadItems` loop | ~369 | After download, hash `destPath` |
| `processQueueEntry` → `commitUpload` | ~676 | After upload, hash local file |

`hashLocalFile` (line 786) is already a private method — reuse it for all four.

For uploads in `processQueueEntry`, compute hash of the local file AFTER `uploadOne` resolves. The file content doesn't change between upload and hash — this is safe.

### §4 — `copyFile` Is in `node:fs/promises`

`copyFile` has been in `node:fs/promises` since Node.js 10.x and is fully supported in Bun. No new package is needed. Add it to the existing import line:
```ts
import { readdir, stat, rename, unlink, mkdir, copyFile } from "node:fs/promises";
```

`copyFile` defaults to no flags — it will overwrite `tmpPath` if it already exists (safe for tmp paths with timestamps).

### §5 — `hashLocalFile` Is Already Private on `SyncEngine`

```ts
// sync-engine.ts:786
private async hashLocalFile(fullPath: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(fullPath)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}
```

Call via `this.hashLocalFile(destPath)`. Returns `null` on read error — `upsertSyncState` accepts `string | null` for `content_hash` so null is a valid value.

### §6 — `processQueueEntry` is `private async` — Hash Computation Is Valid

`hashLocalFile` is a private async method. `processQueueEntry` is also private async and belongs to the same class — `this.hashLocalFile(...)` is accessible.

The `pair.local_path` is available as the `pair: SyncPair` parameter to `processQueueEntry`. Construct the full path: `const uploadedPath = join(pair.local_path, entry.relative_path)`.

### §7 — Conflict Item NOT Added to `files_total` / `bytesTotal`

`conflictItems` is already excluded from `bytesTotal` (only `downloadItems` and `uploadItems` are summed). The conflict download loop (Task 2) runs BEFORE the initial `sync_progress` emission — consistent with the `newFileCollisionItems` pattern from 4-2. Do NOT add conflict items to `downloadItems` or `bytesTotal`.

### §8 — `conflict_detected` IPC Event Shape Is Already Correct

The `IpcPushEvent` in `ipc.ts:22` is generic (`type: string; payload: Record<string, unknown>`). The event shape used by 4-2 and 4-3 is identical: `{ pair_id, local_path, conflict_copy_path }` with `snake_case` field names (IPC wire format rule from project-context.md). No changes to `ipc.ts` needed.

### §9 — Test Update: `downloadFn` Must Write Real Bytes

The existing test at line 1641 uses:
```ts
const downloadFn = mock(async () => {});
```

`downloadOne` creates a writable stream, writes to it, calls `nodeWritable.end()`, waits for `finish`, then renames `tmpPath → destPath`. An empty mock never calls `writer.close()` or ends the stream, so `downloadOne` hangs waiting for the `finish` event.

The correct mock pattern (same as 4-2 tests):
```ts
const downloadFn = mock(async (_uid: string, target: WritableStream<Uint8Array>) => {
  const writer = target.getWriter();
  await writer.write(new Uint8Array([10, 20, 30]));
  await writer.close();
});
```

### §10 — Local Date Computation in Tests

The engine uses local date (not UTC) for the suffix:
```ts
const d = new Date();
const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
```

Tests must compute the local date the same way. **Do NOT** use `new Date().toISOString().slice(0, 10)` — that gives UTC date, which may differ from local date around midnight.

### §11 — `chmodSync` Pattern for Failure Tests

Same pattern as 4-2 story:
- `chmodSync(tmpDir, 0o555)` makes the directory non-writable — `copyFile` to any path inside `tmpDir` fails with EACCES
- Wrap `startSyncAll()` in `try/finally` with `chmodSync(tmpDir, 0o755)` restore
- `chmodSync` is already imported in `sync-engine.test.ts:11` from `node:fs`

### §12 — Test Count Baseline

Story 4-2 final state: 226 tests pass across `bun test engine/src`. Story 4-3 adds 1 new test and updates 1 test. Expect 227 tests passing after this story.

### §13 — Execution Order in `reconcilePair` After 4-3

Updated execution order (with 4-3 change):
1. `clearStateItems` — no I/O
2. `conflictItems` — **copy local → conflict copy, download remote** ← **4-3 replaces logging stub**
3. `newFileCollisionItems` — rename local → conflict copy, download remote (4-2)
4. `deleteLocalItems`
5. `trashRemoteItems`
6. Initial `sync_progress` emit
7. `downloadItems` loop
8. Enqueue uploads

### §14 — Known Deferred Limitation (Same-Day Overwrite)

If two conflicts occur for the same file on the same calendar day, `rename(tmpPath, conflictCopyPath)` atomically replaces the earlier conflict copy. The first local version is silently destroyed. This is the same limitation documented in 4-2 §12 — no counter suffix is added in this story.

### Project Structure Notes

- **Files modified:** `engine/src/sync-engine.ts`, `engine/src/sync-engine.test.ts`
- **Files created:** none
- **Files NOT modified:** `engine/src/conflict.ts`, `engine/src/conflict.test.ts`, `engine/src/ipc.ts`, `engine/src/state-db.ts`, any UI files
- Engine source is flat (`engine/src/`) — no subdirectories created

### References

- Epic 4 story definition: `_bmad-output/planning-artifacts/epics/epic-4-conflict-detection-resolution.md#story-43`
- Story 4-1 (conflict detection): `_bmad-output/implementation-artifacts/4-1-conflict-detection-existing-files.md`
- Story 4-2 (new_file_collision): `_bmad-output/implementation-artifacts/4-2-new-file-collision-detection.md`
- `WorkItem` union (conflict variant with remoteNodeId/remoteMtime/remoteSize): `engine/src/sync-engine.ts:53-59`
- `conflictItems` filter: `engine/src/sync-engine.ts:252`
- `conflictItems` logging stub to replace: `engine/src/sync-engine.ts:263-265`
- `newFileCollisionItems` loop (do NOT touch): `engine/src/sync-engine.ts:267-318`
- Regular download loop with `content_hash: null`: `engine/src/sync-engine.ts:369`
- `new_file_collision` download with `content_hash: null`: `engine/src/sync-engine.ts:303`
- `processQueueEntry` `commitUpload` with `content_hash: null`: `engine/src/sync-engine.ts:676`
- `hashLocalFile` method: `engine/src/sync-engine.ts:786`
- Test to update: `engine/src/sync-engine.test.ts:1624`
- `chmodSync` import: `engine/src/sync-engine.test.ts:11` (already present)
- Deferred 4-2 item: "conflict WorkItem only logs — Story 4-3 handles copy creation": `_bmad-output/implementation-artifacts/deferred-work.md`

---

## Review Findings

- [x] [Review][Defer] `stat()`/`hashLocalFile()` failure after successful download skips `upsertSyncState` [`engine/src/sync-engine.ts`] — deferred, pre-existing pattern in `newFileCollisionItems` loop; file re-synced on next cycle (source: blind+edge)
- [x] [Review][Defer] `hashLocalFile()` doesn't distinguish ENOENT vs EACCES on read failure — deferred, pre-existing, not introduced by this story (source: blind)
- [x] [Review][Defer] Same-day conflict copy overwrite — deferred, documented in §14 as known MVP limitation (source: blind)
- [x] [Review][Defer] Error handling style differs between `conflictItems` and `newFileCollisionItems` loops — deferred, different design intent, not a bug (source: blind)
- [x] [Review][Defer] Date formatting code duplicated in two sites [`engine/src/sync-engine.ts`] — deferred, minor smell, low risk (source: blind)
- [x] [Review][Defer] Failure test doesn't verify tmp file cleanup [`engine/src/sync-engine.test.ts`] — deferred, directory EACCES prevents `copyFile` from creating `tmpPath`; nothing to clean up (source: blind+auditor)
- [x] [Review][Defer] Local file deleted between conflict detection and `copyFile` call — deferred, ENOENT caught, `sync_file_error` emitted, `continue`; correct per AC5 (source: edge)
- [x] [Review][Defer] `conflict_detected` emitted before download; no rollback event if `downloadOne` subsequently fails [`engine/src/sync-engine.ts`] — deferred, design choice per spec; conflict copy preserves user data regardless (source: edge+blind)
- [x] [Review][Defer] `copyFile` fails mid-write, `unlink` of tmp silently fails leaving zombie tmp file — deferred, best-effort cleanup acceptable (source: edge)
- [x] [Review][Defer] `Date.now()` collision in concurrent sync cycles produces identical `tmpPath` names — deferred, blocked by `isDraining` guard (source: edge)
- [x] [Review][Defer] AC6 download-failure-after-copy path has no explicit test [`engine/src/sync-engine.test.ts`] — deferred, not required by AC9 (source: auditor)

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- Pre-4-3 "both changed → skip" test in delta-detection describe block also triggered conflict code — updated to reflect new 4-3 behavior (provides proper downloadFn mock, asserts download=1 and conflict copy exists).

### Completion Notes List

- Task 1: Added `copyFile` to `node:fs/promises` import (`sync-engine.ts:1`)
- Task 2: Replaced 3-line logging stub with 50-line copy-creation loop. Implements: atomic tmp→conflictCopy rename, `sync_file_error` on failure, `conflict_detected` event, `downloadOne` call, `upsertSyncState` with real hash.
- Task 3: `newFileCollisionItems` loop — added `hashLocalFile(destPath)` before `upsertSyncState`, replacing `content_hash: null`.
- Task 4: Regular `downloadItems` loop — added `hashLocalFile(destPath)` before `upsertSyncState`, replacing `content_hash: null`.
- Task 5: `processQueueEntry` → `commitUpload` — added `hashLocalFile(uploadedPath)` before `commitUpload`, replacing `content_hash: null`.
- Task 6: Updated existing "both mtimes changed" test — proper `downloadFn` mock writing bytes, updated assertions verifying conflict copy, `conflict_detected` event, download called, hash non-null.
- Task 7: Added new test "conflict copy creation fails" — uses `chmodSync(tmpDir, 0o555)` to make copy fail; asserts `sync_file_error` emitted, `conflict_detected` NOT emitted, `downloadFile` NOT called.
- Incidental fix: "both changed → skip" test in delta-detection describe updated to match 4-3 semantics (was asserting downloadFn=0, now asserts downloadFn=1 with proper mock and conflict copy assertion).
- All 227 engine tests pass. Type check clean.

### File List

- `engine/src/sync-engine.ts`
- `engine/src/sync-engine.test.ts`
- `_bmad-output/implementation-artifacts/4-3-conflict-copy-creation.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
