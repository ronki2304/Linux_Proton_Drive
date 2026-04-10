# Story 2.5: Sync Engine Core — Two-Way Sync

Status: ready-for-dev

## Story

As a user,
I want my files to sync in both directions continuously while the app is open,
So that my local files and ProtonDrive stay in sync automatically.

## Acceptance Criteria

**AC1 — Sync cycle delta detection:**
**Given** a sync pair is active
**When** a sync cycle runs
**Then** the engine reads all files under `local_path` and compares their mtimes against stored `sync_state` records
**And** fetches all files under the remote folder tree and compares their remote mtimes against stored values
**And** files changed only locally are uploaded; files changed only remotely are downloaded; files unchanged are skipped

**AC2 — Atomic download writes:**
**Given** a file is downloaded from ProtonDrive
**When** writing to disk
**Then** the file is written to `<destination_path>.protondrive-tmp-<unix_ms>` first
**And** on successful completion, `fs.rename()` moves it to the final destination path (NFR12)
**And** on failure, the tmp file is `fs.unlink()`ed — no partial files left at the destination path

**AC3 — Sync state persistence:**
**Given** a sync operation completes for a file
**When** the state is recorded
**Then** both local mtime and remote mtime are written to SQLite `sync_state` (via `upsertSyncState`) before the operation is considered complete (NFR15)
**And** no sync state exists only in memory — engine restart does not re-transfer up-to-date files

**AC4 — Concurrency cap:**
**Given** multiple files need syncing
**When** the sync engine processes them
**Then** concurrent file transfers are capped at a maximum of 3 (NFR4)
**And** additional transfers queue behind the semaphore rather than being rejected

**AC5 — Cold-start resilience:**
**Given** a pair is present in YAML config but absent from SQLite (cold-start or DB reset)
**When** the engine initialises or receives `add_pair_result` push from config
**Then** it treats the pair as a fresh full sync — no crash, no error, all files treated as new

**AC6 — Progress push events:**
**Given** the sync engine emits progress
**When** files are transferring
**Then** `sync_progress` push events are sent: `{pair_id, files_done, files_total, bytes_done, bytes_total}`
**And** `sync_complete` push event is sent: `{pair_id, timestamp}` when a full cycle finishes
**And** progress events are emitted at least once before any transfer and once after each file completes

**AC7 — Console suppression:**
**Given** the engine's console output
**When** in production mode (no `PROTONDRIVE_DEBUG=1` env var)
**Then** `console.log` and `console.error` are reassigned to no-ops at engine startup
**And** IPC framing is never corrupted by stray console output on stdout

**AC8 — StateDb sync_state CRUD:**
**Given** `state-db.ts`
**When** new methods are added
**Then** `upsertSyncState(state: SyncState)` inserts or replaces the record
**And** `getSyncState(pairId, relativePath)` returns the record or undefined
**And** `listSyncState(pairId)` returns all records for the pair ordered by `relative_path`
**And** `deleteSyncState(pairId, relativePath)` removes the record

**AC9 — Engine tests:**
**Given** unit tests in `sync-engine.test.ts`
**When** running `node --import tsx --test engine/src/sync-engine.test.ts`
**Then** tests verify: delta detection logic, atomic download path (tmp + rename), state write before completion, concurrency cap enforcement, cold-start handling, sync_progress/sync_complete events emitted

**AC10 — StateDb tests:**
**Given** unit tests for new CRUD methods in `state-db.test.ts`
**When** running `node --import tsx --test engine/src/state-db.test.ts`
**Then** tests verify: upsert inserts and replaces, getSyncState returns undefined for unknown, listSyncState is ordered, deleteSyncState removes record, all existing tests continue to pass

**AC11 — Main.ts wiring:**
**Given** the engine starts
**When** `main()` runs
**Then** `SyncEngine` is instantiated with `db`, `driveClient`, and `server`
**And** after a pair is added via `add_pair` (from Story 2-4), `syncEngine.start(pair)` is called
**And** on startup with existing YAML pairs (from `configManager.readPairs()`), `syncEngine.start(pair)` is called for each

## Tasks / Subtasks

- [ ] **Task 1: StateDb — add sync_state CRUD methods** (AC: #8, #10)
  - [ ] 1.1 Add `upsertSyncState(state: SyncState): void` to `StateDb` using `INSERT OR REPLACE`
  - [ ] 1.2 Add `getSyncState(pairId: string, relativePath: string): SyncState | undefined`
  - [ ] 1.3 Add `listSyncState(pairId: string): SyncState[]` ordered by `relative_path ASC`
  - [ ] 1.4 Add `deleteSyncState(pairId: string, relativePath: string): void`
  - [ ] 1.5 Expand `state-db.test.ts` with a `describe('sync_state CRUD')` suite verifying all four methods; use `:memory:` DB path

- [ ] **Task 2: SyncEngine class** (AC: #1, #2, #3, #4, #5, #6)
  - [ ] 2.1 Create `engine/src/sync-engine.ts`
    - Import `StateDb`, `SyncPair`, `SyncState` from `./state-db.js`
    - Import `DriveClient` from `./sdk.js`
    - Import `IpcServer` from `./ipc.js`
    - Import `SyncError`, `NetworkError` from `./errors.js`
    - Import `fs/promises` (`stat`, `readdir`, `rename`, `unlink`, `mkdir`)
    - `import { join, relative, dirname } from 'node:path'`
  - [ ] 2.2 Define internal types:
    ```typescript
    interface LocalFile { relativePath: string; mtime: Date; size: number; }
    interface RemoteFile { relativePath: string; nodeUid: string; remoteMtime: Date; size: number; }
    interface SyncPlan {
      toUpload: LocalFile[];
      toDownload: RemoteFile[];
      filesTotal: number;
    }
    ```
  - [ ] 2.3 Implement `Semaphore` helper class (private to file):
    ```typescript
    class Semaphore {
      constructor(private limit: number) {}
      async acquire(): Promise<() => void> { /* queue-based implementation */ }
    }
    ```
  - [ ] 2.4 Implement `SyncEngine` class:
    ```typescript
    export class SyncEngine {
      private readonly activeSyncs = new Map<string, AbortController>();
      constructor(
        private readonly db: StateDb,
        private readonly client: DriveClient,
        private readonly server: IpcServer,
      ) {}
      async start(pair: SyncPair): Promise<void>
      stop(pairId: string): void
    }
    ```
  - [ ] 2.5 Implement `start(pair)`:
    - Cancel any existing sync for the pair (`this.activeSyncs.get(pair.pair_id)?.abort()`)
    - Create new `AbortController`, store in `activeSyncs`
    - Call `runCycle(pair, signal)` in a non-blocking fire-and-forget (`void this.runCycle(...)`)
    - `runCycle` catches all errors and pushes `error` event to server; never throws out of `start`
  - [ ] 2.6 Implement `stop(pairId)`:
    - Retrieve and abort the `AbortController` for the pair
    - Remove from `activeSyncs`
  - [ ] 2.7 Implement `private async runCycle(pair, signal)`:
    - Call `collectLocalFiles(pair.local_path, signal)` → `LocalFile[]`
    - Call `collectRemoteFiles(pair.remote_id, '', signal)` → `RemoteFile[]`
    - Call `resolveDelta(pair.pair_id, local, remote)` → `SyncPlan`
    - Emit initial `sync_progress` with `files_done: 0, files_total: plan.filesTotal, bytes_done: 0, bytes_total: 0`
    - Call `executePlan(plan, pair, signal)`
    - Emit `sync_complete` with `{pair_id: pair.pair_id, timestamp: new Date().toISOString()}`
  - [ ] 2.8 Implement `private async collectLocalFiles(localPath, signal)`:
    - Use `fs.readdir(dir, { withFileTypes: true, recursive: true })` (Node.js 20+)
    - For each file entry: get `stat()`, compute `relative()` path from `localPath`
    - Return `LocalFile[]` sorted by `relativePath`
    - Respect `signal` — check `signal.aborted` before each readdir
  - [ ] 2.9 Implement `private async collectRemoteFiles(parentUid, parentRelPath, signal)`:
    - Call `this.client.listRemoteFolders(parentUid)` for subfolders, recurse
    - Call `this.client.listRemoteFiles(parentUid)` for files at current level
    - Assemble `RemoteFile[]` with `relativePath = parentRelPath + '/' + name`
    - Handle degraded nodes (empty result) gracefully — return empty array
    - Respect `signal`
  - [ ] 2.10 Implement `private resolveDelta(pairId, local, remote)`:
    - Fetch all `SyncState` records: `stored = Map<relativePath, SyncState>` via `db.listSyncState(pairId)`
    - `toUpload`: local files where `stored[path]` is missing OR local mtime > `new Date(stored[path].local_mtime)`
    - `toDownload`: remote files where `stored[path]` is missing OR remoteMtime > `new Date(stored[path].remote_mtime)`
    - Return `SyncPlan`
  - [ ] 2.11 Implement `private async executePlan(plan, pair, signal)`:
    - Create `Semaphore(3)` for concurrency control
    - Track `filesDone = 0`, `bytesDone = 0`
    - `Promise.all([...plan.toUpload.map(f => sem.acquire().then(release => uploadOne(f, release))), ...plan.toDownload.map(f => ...)])`
    - `uploadOne(f, release)`: call `this.client.uploadFile(pair, f)`, write state, increment counters, emit progress, call `release()`
    - `downloadOne(f, release)`: call `downloadAtomic(pair, f)`, write state, increment counters, emit progress, call `release()`
    - Abort on `signal.aborted` check before each operation
  - [ ] 2.12 Implement `private async downloadAtomic(pair, file, signal)`:
    - `tmpPath = join(pair.local_path, file.relativePath) + '.protondrive-tmp-' + Date.now()`
    - Ensure directory: `fs.mkdir(dirname(destPath), { recursive: true })`
    - Obtain bytes from `this.client.downloadFile(file.nodeUid, signal)`
    - `await fs.writeFile(tmpPath, content)`
    - On success: `await fs.rename(tmpPath, destPath)`
    - On any error: `await fs.unlink(tmpPath).catch(() => {})` then rethrow
  - [ ] 2.13 After each successful transfer, write sync state:
    ```typescript
    db.upsertSyncState({
      pair_id: pair.pair_id,
      relative_path: file.relativePath,
      local_mtime: localStat.mtime.toISOString(),
      remote_mtime: file.remoteMtime.toISOString(),
      content_hash: null,
    });
    ```
    State MUST be written before `release()` is called and progress is emitted.

- [ ] **Task 3: DriveClient — listRemoteFiles and file transfer** (AC: #1, #2)
  - [ ] 3.1 Export new interface: `RemoteFile = { nodeUid: string; name: string; remoteMtime: Date; size: number }`
  - [ ] 3.2 Implement `async listRemoteFiles(parentId: string): Promise<RemoteFile[]>` on `DriveClient`:
    - Call `this._sdk.iterateFolderChildren(parentId, { type: NodeType.File })`
    - For each `MaybeNode`: if `.ok` push `{ nodeUid: node.value.uid, name: node.value.name, remoteMtime: ..., size: ... }`
    - Check SDK `NodeEntity` fields for mtime/size — use `node.value.modificationTime` or `node.value.size` (verify against SDK source)
    - Wrap SDK errors in `NetworkError`
  - [ ] 3.3 Replace `uploadFile` stub with real implementation:
    - Signature: `async uploadFile(parentFolderUid: string, name: string, content: Uint8Array<ArrayBufferLike>, signal?: AbortSignal): Promise<string>`
    - Cast at boundary: `const sdkContent = content as unknown as Uint8Array<ArrayBuffer>`
    - Use `this._sdk.getFileUploader(parentFolderUid, name, { modificationTime: new Date() }, signal)` 
    - Return the created node UID
    - Wrap errors in `SyncError`
  - [ ] 3.4 Replace `downloadFile` stub with real implementation:
    - Signature: `async downloadFile(nodeUid: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBufferLike>>`
    - Use `this._sdk.getFileDownloader(nodeUid, signal)`
    - Collect downloaded bytes from the downloader's stream into a `Uint8Array`
    - Cast at boundary: `return sdkBytes as unknown as Uint8Array<ArrayBufferLike>`
    - Wrap errors in `SyncError`
  - [ ] 3.5 Add `sdk.test.ts` tests for `listRemoteFiles`, `uploadFile`, `downloadFile` using constructor-injected mock SDK
    - Test: `listRemoteFiles` returns mapped array; degraded nodes filtered
    - Test: `uploadFile` calls `getFileUploader` with correct args
    - Test: `downloadFile` calls `getFileDownloader` with correct nodeUid
    - Test: SDK errors wrapped in `SyncError`/`NetworkError`

- [ ] **Task 4: Console suppression in main.ts** (AC: #7)
  - [ ] 4.1 At the top of `main()`, before server setup, add:
    ```typescript
    if (!process.env['PROTONDRIVE_DEBUG']) {
      console.log = () => {};
      console.error = () => {};
    }
    ```
  - [ ] 4.2 Add test in `main.test.ts`: without `PROTONDRIVE_DEBUG`, `console.log` is a no-op after startup (test by checking `console.log === Function.prototype.call` is not the original implementation — use a spy approach)

- [ ] **Task 5: Wire SyncEngine into main.ts** (AC: #11)
  - [ ] 5.1 Import `SyncEngine` from `./sync-engine.js` in `main.ts`
  - [ ] 5.2 Add module-level `let syncEngine: SyncEngine | null = null;`
  - [ ] 5.3 In `main()`, after `stateDb` and `driveClient` initialisation (which happens in `handleTokenRefresh`), instantiate `SyncEngine`
    - Note: `SyncEngine` needs `driveClient` which is only available after `token_refresh`. Create `syncEngine` lazily in `handleTokenRefresh` after `driveClient = DriveClient.create(token)`:
      ```typescript
      syncEngine = new SyncEngine(stateDb, driveClient, server);
      ```
  - [ ] 5.4 In `handleAddPair` (from Story 2-4): after `configManager.addPair(pair)` and `stateDb.insertPair(pair)`, call `syncEngine?.start(pair)` if `syncEngine` is initialized
  - [ ] 5.5 In `handleTokenRefresh`, after creating `syncEngine`, start sync for any existing pairs:
    ```typescript
    const existingPairs = configManager.readPairs();
    for (const pair of existingPairs) {
      void syncEngine.start(pair);
    }
    ```
  - [ ] 5.6 Add tests in `main.test.ts`: after `token_refresh`, if pairs exist in config, `sync_progress` events are received (use mocked `SyncEngine` to verify `start()` is called)

- [ ] **Task 6: sync-engine.test.ts — unit tests** (AC: #9)
  - [ ] 6.1 Create `engine/src/sync-engine.test.ts`
    - Use `node:test` framework, `node:assert/strict`
    - All DriveClient calls mocked via `mock.fn()` (never import `@protontech/drive-sdk`)
    - Use `:memory:` `StateDb` for all tests
  - [ ] 6.2 Test: `resolveDelta` — local file missing from sync_state → appears in `toUpload`
  - [ ] 6.3 Test: `resolveDelta` — remote file missing from sync_state → appears in `toDownload`
  - [ ] 6.4 Test: `resolveDelta` — file up-to-date in sync_state → not in upload or download
  - [ ] 6.5 Test: `resolveDelta` — local mtime newer than stored → appears in `toUpload`
  - [ ] 6.6 Test: `downloadAtomic` — on success, tmp file is renamed to dest; tmp path does not exist after
  - [ ] 6.7 Test: `downloadAtomic` — on write failure, tmp file is unlinked; dest path does not exist after
  - [ ] 6.8 Test: concurrency — with 5 files and semaphore(3), no more than 3 concurrent `downloadFile` calls at any moment (use counting mock)
  - [ ] 6.9 Test: `runCycle` — emits `sync_progress` with `files_done: 0` before any transfer
  - [ ] 6.10 Test: `runCycle` — emits `sync_complete` after all transfers
  - [ ] 6.11 Test: state written before progress incremented (upsertSyncState call order)
  - [ ] 6.12 Test: cold-start — pair with no sync_state records → all local files in `toUpload`, all remote in `toDownload`

- [ ] **Task 7: Run full test suite** (AC: #9, #10)
  - [ ] 7.1 `node --import tsx --test 'engine/src/**/*.test.ts'` — all tests pass, no regressions

## Dev Notes

### Critical: Engine Runtime is Node.js 22, NOT Bun
CLAUDE.md Bun defaults DO NOT apply to the engine. All engine code runs under `node --import tsx`. `bun:sqlite`, `Bun.file`, etc. are forbidden.

### ProtonDriveAccount crypto constraint
Story 2-5 does NOT fully wire `ProtonDriveAccount` private key decryption. End-to-end encryption requires the user's **mailbox password** (derived via SRP from their login password), which is not available from the OAuth session token alone. This means:
- `listRemoteFiles()` may return empty arrays if SDK returns all-degraded nodes
- `uploadFile()` / `downloadFile()` may fail if SDK requires private key operations
- The sync engine is designed to handle these failures gracefully (empty plan = no transfers)

Full crypto wiring (implementing `getOwnPrimaryAddress` with real `PrivateKey` objects) is a separate concern tracked as Epic-level tech debt. The sync engine architecture is correct; it will work end-to-end once the account implementation is provided. This story ships the orchestration layer; crypto is the blocker for real transfers, not the architecture.

### SyncEngine is stateless across restart
No sync is persisted in memory between engine restarts. On restart: `handleTokenRefresh` recreates `SyncEngine`, reads existing YAML pairs, calls `syncEngine.start(pair)` for each. The SQLite `sync_state` records determine what is skipped vs re-transferred.

### Semaphore implementation
```typescript
class Semaphore {
  private count: number;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.count = limit;
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (this.count > 0) {
          this.count--;
          resolve(() => {
            this.count++;
            const next = this.queue.shift();
            if (next) next();
          });
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }
}
```

### collectLocalFiles — recursive readdir
```typescript
private async collectLocalFiles(
  localPath: string,
  signal: AbortSignal,
): Promise<LocalFile[]> {
  const entries = await readdir(localPath, { withFileTypes: true, recursive: true });
  const files: LocalFile[] = [];
  for (const entry of entries) {
    if (signal.aborted) break;
    if (!entry.isFile()) continue;
    const fullPath = join(entry.parentPath ?? entry.path, entry.name);
    const relPath = relative(localPath, fullPath);
    const s = await stat(fullPath);
    files.push({ relativePath: relPath, mtime: s.mtime, size: s.size });
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
```
Note: `entry.parentPath` is Node.js 21.2+ / 20.13+; `entry.path` is the legacy equivalent. Use `entry.parentPath ?? entry.path` for compat.

### downloadAtomic pattern
```typescript
private async downloadAtomic(
  pair: SyncPair,
  file: RemoteFile,
  signal: AbortSignal,
): Promise<{ localMtime: Date }> {
  const destPath = join(pair.local_path, file.relativePath);
  const tmpPath = `${destPath}.protondrive-tmp-${Date.now()}`;
  await mkdir(dirname(destPath), { recursive: true });
  let content: Uint8Array<ArrayBufferLike>;
  try {
    content = await this.client.downloadFile(file.nodeUid, signal);
    await writeFile(tmpPath, content);
    await rename(tmpPath, destPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
  const s = await stat(destPath);
  return { localMtime: s.mtime };
}
```

### sync_progress event shape
```typescript
server.emitEvent({
  type: 'sync_progress',
  payload: {
    pair_id: pair.pair_id,
    files_done: filesDone,
    files_total: plan.filesTotal,
    bytes_done: bytesDone,
    bytes_total: bytesTotal,   // sum of all file sizes in plan
  },
});
```
`bytes_total` is computed from `plan.toUpload.reduce((a, f) => a + f.size, 0) + plan.toDownload.reduce((a, f) => a + f.size, 0)`.

### State write ordering
Correct order within `uploadOne` / `downloadOne`:
```typescript
// 1. Transfer completes (upload or atomic download)
// 2. Write sync state to SQLite  ← MUST come before release()
db.upsertSyncState({ ... });
// 3. Increment counters
filesDone++;
bytesDone += file.size;
// 4. Emit progress
server.emitEvent({ type: 'sync_progress', payload: { ... } });
// 5. Release semaphore slot
release();
```
If the process crashes between step 2 and 3, the file won't be retransferred — this is correct (the state is committed). Partial transfers leave no tmp files (atomic pattern).

### DriveClient.listRemoteFiles — NodeType.File
```typescript
async listRemoteFiles(parentId: string): Promise<RemoteFile[]> {
  const files: RemoteFile[] = [];
  for await (const node of this._sdk.iterateFolderChildren(parentId, { type: NodeType.File })) {
    if (!node.ok) continue; // degraded node — skip
    files.push({
      nodeUid: node.value.uid,
      name: node.value.name,
      remoteMtime: node.value.modificationTime ?? new Date(0),
      size: node.value.size ?? 0,
    });
  }
  return files;
}
```
Check `NodeEntity` fields at `engine/node_modules/@protontech/drive-sdk/src/interface/nodes.ts` — field names may differ. Use `modificationTime` or `lastModified`; adjust as needed.

### FileUploader / FileDownloader SDK API
```typescript
// Upload:
const uploader = await this._sdk.getFileUploader(
  parentFolderUid,
  name,
  { modificationTime: new Date() },
  signal,
);
// uploader may have a method like upload(content) or write(stream) — check SDK source
// Verify actual API at: engine/node_modules/@protontech/drive-sdk/src/protonDriveClient.ts

// Download:
const downloader = await this._sdk.getFileDownloader(nodeUid, signal);
// downloader.downloadToStream(writable, progressCallback) — check SDK source
// For in-memory download, use a WritableStream that collects chunks
```
**Check the SDK source before implementing** — `getFileUploader` / `getFileDownloader` APIs may have changed in v0.14.3. The story uses best-effort type signatures; adjust to match actual SDK exports.

### Import extensions — .js not .ts
```typescript
import { SyncEngine } from './sync-engine.js'; // ✓ NodeESM
import { SyncEngine } from './sync-engine.ts'; // ✗ never
```

### Testing with in-memory StateDb
```typescript
const db = new StateDb(':memory:');
// All tests use ':memory:' — no filesystem cleanup needed
// db.close() in afterEach or after block
```

### Mock DriveClient for SyncEngine tests
```typescript
import { mock } from 'node:test';

const mockClient = {
  listRemoteFiles: mock.fn(async () => []),
  listRemoteFolders: mock.fn(async () => []),
  uploadFile: mock.fn(async () => 'new-uid'),
  downloadFile: mock.fn(async () => new Uint8Array([1, 2, 3])),
} as unknown as DriveClient;
```

### References
- [Source: engine/src/state-db.ts] — StateDb class + SyncState interface to extend
- [Source: engine/src/state-db.test.ts] — existing test patterns to follow
- [Source: engine/src/sdk.ts] — DriveClient to extend with listRemoteFiles, uploadFile, downloadFile
- [Source: engine/src/sdk.test.ts] — existing mock patterns for DriveClient tests
- [Source: engine/src/main.ts] — handleTokenRefresh and handleAddPair to update
- [Source: engine/src/ipc.ts] — IpcServer.emitEvent() signature
- [Source: engine/node_modules/@protontech/drive-sdk/src/protonDriveClient.ts] — getFileUploader, getFileDownloader
- [Source: engine/node_modules/@protontech/drive-sdk/src/interface/nodes.ts] — NodeEntity fields (mtime, size)
- [Source: _bmad-output/planning-artifacts/architecture.md#IPC Protocol] — sync_progress, sync_complete event shapes
- [Source: _bmad-output/planning-artifacts/epics.md#Story 2.5] — NFR4, NFR12, NFR15 references

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

### File List

- `engine/src/state-db.ts` — add upsertSyncState, getSyncState, listSyncState, deleteSyncState
- `engine/src/state-db.test.ts` — add sync_state CRUD tests
- `engine/src/sdk.ts` — implement listRemoteFiles, uploadFile, downloadFile (replace stubs)
- `engine/src/sdk.test.ts` — add listRemoteFiles, upload/download tests
- `engine/src/sync-engine.ts` — new: SyncEngine class + Semaphore
- `engine/src/sync-engine.test.ts` — new: SyncEngine unit tests
- `engine/src/main.ts` — console suppression, SyncEngine wiring, start on token_refresh + add_pair

## Change Log

- 2026-04-09: Story 2.5 created — Sync Engine Core Two-Way Sync
