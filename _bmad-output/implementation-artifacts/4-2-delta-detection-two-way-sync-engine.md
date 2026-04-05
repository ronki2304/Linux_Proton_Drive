# Story 4.2: Delta Detection & Two-Way Sync Engine

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a developer,
I want a sync engine that detects changed files using mtime+hash, syncs both directions atomically, and resolves conflicts without data loss,
so that the `sync` command only transfers what changed and never corrupts local files on interrupted transfers.

## Acceptance Criteria

1. **Given** `src/core/sync-engine.ts` exists, **When** `syncEngine.run(pairs, token, driveClient, options)` is called, **Then** it queries `StateDB` for last-sync state of each file in each configured pair.
2. **Given** a file whose `last_sync_mtime` has not changed, **When** the sync engine evaluates it, **Then** it is skipped — no transfer occurs.
3. **Given** a file whose mtime differs from `last_sync_mtime`, **When** the sync engine evaluates it, **Then** it computes a SHA-256 hash to confirm the content actually changed before transferring.
4. **Given** a file modified only on the local side, **When** the sync engine runs, **Then** it uploads the local version and updates `StateDB` with the new mtime and hash.
5. **Given** a file modified only on the remote side, **When** the sync engine runs, **Then** it downloads to `.protondrive-tmp` in the same directory, then atomically renames to the target path — original file never touched until rename.
6. **Given** a download is interrupted before the rename, **When** the sync engine handles the failure, **Then** the `.protondrive-tmp` file is deleted and the original local file is unchanged.
7. **Given** a file modified on both sides since last sync, **When** the sync engine detects the conflict, **Then** it creates a conflict copy via `conflict.ts`, syncs both original and conflict copy to remote, updates `StateDB` for both, and reports the conflict in the result.
8. **Given** `syncEngine.run()` completes on an unchanged folder, **When** called again immediately, **Then** it transfers nothing and returns 0 transferred files.
9. **Given** `bun test` is run, **Then** all sync engine unit tests pass.

## Tasks / Subtasks

- [x] Implement `src/core/sync-engine.ts` (AC: 1–8)
  - [x] Define `SyncOptions`: `{ onProgress?: (msg: string) => void }`
  - [x] Define `SyncResult`: `{ transferred: number; conflicts: ConflictRecord[]; errors: string[] }`
  - [x] Implement `SyncEngine` class:
    - [x] `constructor(stateDb: StateDB)`
    - [x] `async run(pairs: SyncPair[], token: SessionToken, driveClient: DriveClient, opts?: SyncOptions): Promise<SyncResult>`
  - [x] **Delta detection algorithm** (mtime-first, hash-on-change):
    - [x] For each file: compare current mtime to `StateDB.get(localPath).lastSyncMtime`
    - [x] If mtime unchanged → skip (AC: 2)
    - [x] If mtime changed → compute SHA-256 of local file content; compare to `last_sync_hash`
    - [x] If hash unchanged → skip (mtime changed but content identical — e.g., touch)
    - [x] If hash changed → proceed to transfer
  - [x] **Two-way sync logic**:
    - [x] Get remote file list via `driveClient.listFolder(remote)`
    - [x] For each file in the union of local + remote:
      - [x] Local only changed: upload, update StateDB (AC: 4)
      - [x] Remote only changed: atomic download to `.protondrive-tmp`, rename on success, clean up tmp on failure (AC: 5, 6)
      - [x] Both changed: `conflict.ts` creates conflict copy, upload original + conflict copy, update StateDB for both (AC: 7)
  - [x] **SHA-256 computation**: Use `crypto.createHash('sha256').update(fileBuffer).digest('hex')` (Node crypto, built-in in Bun)
  - [x] **Atomic download** (same pattern as Story 3.3):
    - [x] `tmpPath = localPath + '.protondrive-tmp'`
    - [x] Download to `tmpPath` → rename to `localPath` on success → unlink `tmpPath` on failure
  - [x] Update `StateDB` after each successful transfer with new `lastSyncMtime` and `lastSyncHash`
  - [x] Collect `ConflictRecord[]` and return in `SyncResult`
- [x] Write unit tests in `src/core/sync-engine.test.ts` (AC: 9)
  - [x] Test: delta skip — unchanged mtime → no transfer
  - [x] Test: local-only change → upload called
  - [x] Test: remote-only change → download called with atomic pattern
  - [x] Test: both changed → conflict copy created, both uploaded
  - [x] Test: interrupted download cleanup — tmp file deleted, original intact
  - [x] Test: idempotency — second run on unchanged folder transfers 0 files
  - [x] Mock `DriveClient` and `StateDB`

## Dev Notes

- **Delta algorithm** (mandatory, from architecture): mtime-first, hash-on-change. Never hash files whose mtime is unchanged — this is the performance optimization (NFR3). [Source: epics.md#Additional Requirements]
- **SHA-256 computation**: `import { createHash } from 'crypto'` (Node built-in, available in Bun). Hash the full file buffer: `createHash('sha256').update(fs.readFileSync(path)).digest('hex')`.
- **Atomic download** (NFR11): temp file in same directory, rename on success, cleanup on failure. This is the same pattern as Story 3.3 — reuse/extract if possible.
- **Conflict handling** (FR9–FR11):
  1. Call `createConflictCopy(localPath, new Date())` from `src/core/conflict.ts`
  2. Upload the original local version to its original remote path
  3. Upload the conflict copy to the same remote directory with the conflict copy name
  4. Update `StateDB` for both the original and the conflict copy
  5. Add to `SyncResult.conflicts`
- **`SyncEngine` does NOT call `process.exit()`** — it returns results or throws errors. The command layer handles exit codes.
- **No `console.log`** — use `opts.onProgress?.('...')` for progress messages.
- **`StateDB` interaction**: Call `stateDb.upsert()` after EACH successful file transfer. Do not batch — ensures partial sync progress is preserved if interrupted.
- **`DriveClient` is injected** — `SyncEngine` constructor does not create a `DriveClient`. This enables easy mocking in tests.
- **`SyncPair.id`** from config is the `sync_pair_id` stored in `StateDB`.
- **NFR14 idempotency**: Second run on unchanged folder must produce 0 transfers. Ensure `StateDB` is updated correctly after each run.

### Project Structure Notes

- `src/core/sync-engine.ts` — the heart of sync logic
- `src/core/sync-engine.test.ts` — co-located
- Depends on: `src/core/conflict.ts`, `src/core/state-db.ts`, `src/sdk/client.ts`, `src/types.ts`
- No Commander imports, no `process.exit()`, no direct `console.log`

### References

- Delta detection: mtime-first, hash-on-change [Source: epics.md#Additional Requirements]
- Atomic download: `.protondrive-tmp` + rename [Source: architecture.md#Additional Requirements]
- Conflict handling flow [Source: epics.md#Story 4.2]
- StateDB schema [Source: Story 1.5]
- `ConflictRecord` type [Source: Story 1.2]
- NFR3: delta-only, 3s repeat sync [Source: epics.md#NonFunctional Requirements]
- NFR11: atomic writes, consistent state [Source: epics.md#NonFunctional Requirements]
- NFR14: idempotency [Source: epics.md#NonFunctional Requirements]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- 2026-04-02: Story 4.2 implemented — delta detection (mtime-first, hash-on-change), two-way sync engine with atomic downloads, conflict handling, and StateDB upserts after each transfer.
- 14 unit tests covering: mtime-skip, hash-skip (touch), new file upload, changed file upload, remote-only download (atomic pattern), download failure cleanup, conflict detection+upload, idempotency, multi-file, error propagation.

### File List

- `src/core/sync-engine.ts` (new)
- `src/core/sync-engine.test.ts` (new)

### Review Findings

- [x] [Review][Patch] handleRemoteOnlyFile skip condition uses local mtime not remote mtime — `stored.lastSyncMtime === remoteItem.mtime` compares post-download local FS mtime against remote server mtime; these are from different clocks and will never match, causing every remote file to re-download on every run [src/core/sync-engine.ts:261-270]
- [x] [Review][Defer] handleRemoteOnlyFile missing SHA-256 hash check before downloading — DriveItem has no hash field; requires getFileMetadata() (currently a NOT_IMPLEMENTED stub) to compare remote hash; defer until SDK methods are wired [src/core/sync-engine.ts:258-267] — deferred, pre-existing
- [x] [Review][Patch] Conflict handling uses two separate new Date() calls — createConflictCopy(localPath, new Date()) at line 191 and remote path date at line 202 can produce different dates if they straddle UTC midnight; local conflict copy filename and remote path mismatch in StateDB [src/core/sync-engine.ts:191,202]
- [x] [Review][Patch] SyncEngine local file scan: fs.statSync TOCTOU — file deleted between readdirSync and statSync throws uncaught ENOENT; aborts entire syncPair (and all remaining pairs) rather than recording a per-file error [src/core/sync-engine.ts:99-112]
- [x] [Review][Defer] SyncEngine alreadyHandled uses Array.includes O(n²) scan — `[...localToRemote.values()].includes(remotePath)` per remote file; replace with Set for large directories [src/core/sync-engine.ts:137-138] — deferred, pre-existing
