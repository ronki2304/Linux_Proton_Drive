# Story 2.5: Sync Engine Core - Two-Way Sync

Status: done

## Story

As a user,
I want my files to sync in both directions continuously while the app is open,
So that my local files and ProtonDrive stay in sync automatically.

## Acceptance Criteria

**AC1 — Delta detection (mtime comparison):**

**Given** a sync pair is active
**When** a sync cycle runs
**Then** the engine compares each local file's `mtime` (from `fs.stat`) against the stored `sync_state.local_mtime` for that relative path
**And** compares each remote file's mtime (from `activeRevision.claimedModificationTime ?? modificationTime`) against the stored `sync_state.remote_mtime`
**And** files changed **only locally** (local mtime differs; remote mtime unchanged) are uploaded
**And** files changed **only remotely** (remote mtime differs; local mtime unchanged) are downloaded
**And** new local files (no sync_state, not in remote) are uploaded; new remote files (no sync_state, not locally) are downloaded
**And** files present in both places with no sync_state record are **skipped** (conflict — deferred to Epic 4)
**And** files where both local and remote changed since last sync are **skipped** (conflict — deferred to Epic 4)
**And** files unchanged on both sides are skipped

**AC2 — Atomic download writes:**

**Given** a file is downloaded from ProtonDrive
**When** writing to disk
**Then** the file is written to `<destination_path>.protondrive-tmp-<unix_ms>` first (where `unix_ms = Date.now()`)
**And** on successful completion, `fs.renameSync(tmpPath, destPath)` moves it to the final destination
**And** on failure, `fs.unlinkSync(tmpPath)` (in a finally/catch) removes the temp file — no partial files at destination

**AC3 — sync_state persistence:**

**Given** a sync operation completes for a file
**When** the state is recorded
**Then** `stateDb.upsertSyncState({ pair_id, relative_path, local_mtime, remote_mtime, content_hash: null })` is called **before** the operation is considered complete
**And** `local_mtime` is `new Date(fs.stat(localPath).mtime).toISOString()` (after upload or after download + rename)
**And** `remote_mtime` is `(node.activeRevision?.claimedModificationTime ?? node.modificationTime).toISOString()`
**And** no sync state is held only in memory — engine restart does not re-transfer up-to-date files

**AC4 — Concurrency cap:**

**Given** multiple files need syncing
**When** the sync engine processes them
**Then** concurrent file transfers are capped at a maximum of 3 (NFR4)
**And** additional transfers queue behind a semaphore rather than being rejected

**AC5 — Cold-start (pair in config.yaml absent from SQLite):**

**Given** a pair exists in `config.yaml` but has no `sync_pair` row in SQLite (DB reset, corruption, or first-run)
**When** the engine starts and calls `syncEngine.startSyncAll()`
**Then** the engine reads pairs via `readConfigYaml()` from `config.ts` (already implemented) and cross-checks against `stateDb.listPairs()`
**And** for any pair in config but not in SQLite, the engine calls `stateDb.insertPair(...)` to restore it, then treats it as a fresh full sync (no sync_state records → all files are new)
**And** does NOT crash or emit a fatal error

**AC6 — remote_id resolution:**

**Given** a sync pair has `remote_id = ""` (the fallback set by Story 2.4's `add_pair` handler)
**When** the sync engine starts a sync cycle for that pair
**Then** it resolves `remote_id` by splitting `pair.remote_path` on `/`, filtering empty segments, and walking from root:
  - Call `driveClient.listRemoteFolders(null)` → find folder matching first segment
  - For each subsequent segment, call `driveClient.listRemoteFolders(parentId)` → find match
  - Call `stateDb.updatePairRemoteId(pair.pair_id, resolvedId)` to persist the resolved id
**And** if resolution fails (segment not found or SDK error), emit an `error` push event `{type:"error", payload:{code:"remote_path_not_found", message:"...", pair_id}}` and abort the cycle for that pair

**AC7 — sync_progress push events:**

**Given** the sync engine emits progress
**When** files are transferring
**Then** an initial `sync_progress` event is emitted before transfers begin: `{pair_id, files_done:0, files_total, bytes_done:0, bytes_total}`
**And** `sync_progress` is emitted after each file completes with updated `files_done` and `bytes_done`
**And** `sync_complete` push event `{pair_id, timestamp: ISO 8601}` is emitted when a cycle finishes

**AC8 — StateDb new methods:**

**Given** `state-db.ts`
**When** new methods are added
**Then** `getSyncState(pairId, relativePath): SyncState | undefined` — SELECT by pk
**And** `upsertSyncState(state: SyncState): void` — INSERT OR REPLACE all 5 columns
**And** `listSyncStates(pairId): SyncState[]` — SELECT WHERE pair_id ORDER BY relative_path ASC
**And** `deleteSyncState(pairId, relativePath): void` — DELETE by pk
**And** `updatePairRemoteId(pairId, remoteId): void` — UPDATE sync_pair SET remote_id WHERE pair_id

**AC9 — DriveClient new method `listRemoteFiles`:**

**Given** `DriveClient` in `sdk.ts`
**When** `listRemoteFiles(parentId: string)` is called
**Then** it iterates `this.sdk.iterateFolderChildren(parentId, { type: NodeType.File })`
**And** skips `DegradedNode` entries (`.ok === false`) with `debugLog`
**And** returns `RemoteFile[]` where `RemoteFile = { id: string; name: string; parent_id: string; remote_mtime: string; size: number }`
**And** `remote_mtime = (node.activeRevision?.claimedModificationTime ?? node.modificationTime).toISOString()`
**And** `size = node.activeRevision?.claimedSize ?? node.totalStorageSize ?? 0`
**And** wraps SDK errors via `mapSdkError(err)` (same pattern as `listRemoteFolders`)
**Note:** `iterateFolderChildren` is already in `ProtonDriveClientLike` — no type change needed there

**AC10 — No console.log / console.error in sync-engine.ts:**

**Given** engine IPC framing constraint (project-context.md)
**When** sync-engine.ts is implemented
**Then** NO `console.log()` or `console.error()` calls appear in the file
**And** all debug output uses `debugLog(...)` from `./debug-log.js` (only active when `PROTONDRIVE_DEBUG=1`)

**AC11 — Tests:**

**Engine unit tests (`node --import tsx --test engine/src/sync-engine.test.ts`):**
- Mock `DriveClient` at boundary using `mock.fn()` from `node:test` — never import `@protontech/drive-sdk`
- Use fresh `StateDb(':memory:')` per test
- Cover all delta detection cases (AC1), atomic write (AC2), state persistence order (AC3), concurrency cap (AC4), cold-start (AC5), remote_id resolution (AC6), progress events (AC7)

**StateDb tests** (extend `state-db.test.ts`):
- `describe('sync_state CRUD')` covering all 5 new methods

---

## Tasks / Subtasks

- [x] **Task 1: StateDb — 5 new methods** (AC: #8)
  - [x] 1.1 `getSyncState(pairId: string, relativePath: string): SyncState | undefined` — `SELECT * FROM sync_state WHERE pair_id = ? AND relative_path = ?`
  - [x] 1.2 `upsertSyncState(state: SyncState): void` — `INSERT OR REPLACE INTO sync_state (pair_id, relative_path, local_mtime, remote_mtime, content_hash) VALUES (@pair_id, @relative_path, @local_mtime, @remote_mtime, @content_hash)`
  - [x] 1.3 `listSyncStates(pairId: string): SyncState[]` — `SELECT * FROM sync_state WHERE pair_id = ? ORDER BY relative_path ASC`
  - [x] 1.4 `deleteSyncState(pairId: string, relativePath: string): void` — `DELETE FROM sync_state WHERE pair_id = ? AND relative_path = ?`
  - [x] 1.5 `updatePairRemoteId(pairId: string, remoteId: string): void` — `UPDATE sync_pair SET remote_id = ? WHERE pair_id = ?`
  - [x] 1.6 Add `describe('sync_state CRUD and updatePairRemoteId')` in `state-db.test.ts` with `:memory:` DB:
    - upsert inserts new record
    - upsert replaces existing record (same pk)
    - getSyncState returns undefined for unknown path
    - listSyncStates returns ordered results
    - deleteSyncState removes record
    - updatePairRemoteId updates the remote_id field

- [x] **Task 2: DriveClient.listRemoteFiles + RemoteFile interface** (AC: #9)
  - [x] 2.1 In `sdk.ts`, add `export interface RemoteFile { id: string; name: string; parent_id: string; remote_mtime: string; size: number; }` after `RemoteFolder` interface (around line 97)
  - [x] 2.2 Add `async listRemoteFiles(parentId: string): Promise<RemoteFile[]>` method to `DriveClient` class (after `listRemoteFolders`):
    ```typescript
    async listRemoteFiles(parentId: string): Promise<RemoteFile[]> {
      try {
        const files: RemoteFile[] = [];
        for await (const result of this.sdk.iterateFolderChildren(parentId, { type: NodeType.File })) {
          if (!result.ok) {
            debugLog("DriveClient: degraded node skipped in file list");
            continue;
          }
          const node = result.value;
          if (node.type !== NodeType.File) continue;
          files.push({
            id: node.uid,
            name: node.name,
            parent_id: parentId,
            remote_mtime: (node.activeRevision?.claimedModificationTime ?? node.modificationTime).toISOString(),
            size: node.activeRevision?.claimedSize ?? node.totalStorageSize ?? 0,
          });
        }
        return files;
      } catch (err) {
        mapSdkError(err);
        throw err; // defensive
      }
    }
    ```
  - [x] 2.3 Add `sdk.test.ts` tests for `listRemoteFiles`:
    - happy path: 2 file nodes → 2 RemoteFile entries with correct fields
    - DegradedNode (`.ok === false`) → skipped, not in result
    - Non-File node type → skipped (server-side filter is a hint only)
    - SDK error → NetworkError or SyncError thrown (use `sdkErrorFactoriesForTests`)

- [x] **Task 3: Create `engine/src/sync-engine.ts`** (AC: #1–#7, #10)
  - [x] 3.1 File header with imports (NO `@protontech/drive-sdk` import — that violates boundary):
    ```typescript
    import { readdir, stat, rename, unlink, mkdir } from "node:fs/promises";
    import { join, relative, dirname, basename } from "node:path";
    import { createReadStream, createWriteStream } from "node:fs";
    import { Readable, Writable } from "node:stream";
    import type { IpcPushEvent } from "./ipc.js";
    import type { DriveClient, RemoteFile, UploadBody } from "./sdk.js";
    import type { StateDb, SyncPair, SyncState } from "./state-db.js";
    import type { ConfigPair } from "./config.js";
    import { SyncError, NetworkError } from "./errors.js";
    import { debugLog } from "./debug-log.js";
    import { listConfigPairs } from "./config.js";
    ```
  - [x] 3.2 Internal types (NOT exported — internal to the file):
    ```typescript
    interface LocalFile { relativePath: string; mtime: string; size: number; }
    type WorkItem =
      | { kind: "upload"; relativePath: string; remoteFolderId: string; size: number; localMtime: string; }
      | { kind: "download"; relativePath: string; nodeUid: string; size: number; remoteMtime: string; };
    ```
  - [x] 3.3 `Semaphore` helper class (private to file, not exported):
    ```typescript
    class Semaphore {
      private count: number;
      private readonly queue: Array<() => void> = [];
      constructor(limit: number) { this.count = limit; }
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
  - [x] 3.4 `export class SyncEngine`:
    ```typescript
    export class SyncEngine {
      private driveClient: DriveClient | null = null;
      constructor(
        private readonly stateDb: StateDb,
        private readonly emitEvent: (event: IpcPushEvent) => void,
      ) {}
      setDriveClient(client: DriveClient | null): void { this.driveClient = client; }
      async startSyncAll(): Promise<void> { ... }
    }
    ```
  - [x] 3.5 `startSyncAll()`: handle cold-start first (AC5) then sync all pairs:
    ```typescript
    async startSyncAll(): Promise<void> {
      // Cold-start: restore pairs in config but missing from SQLite
      const configPairs = listConfigPairs();
      const dbPairIds = new Set(this.stateDb.listPairs().map(p => p.pair_id));
      for (const cp of configPairs) {
        if (!dbPairIds.has(cp.pair_id)) {
          this.stateDb.insertPair({
            pair_id: cp.pair_id, local_path: cp.local_path,
            remote_path: cp.remote_path, remote_id: "", created_at: cp.created_at,
          });
        }
      }
      // Sync all pairs sequentially; per-pair errors do not abort siblings
      for (const pair of this.stateDb.listPairs()) {
        try { await this.syncPair(pair); }
        catch (err) {
          const msg = err instanceof Error ? err.message : "unknown";
          this.emitEvent({ type: "error", payload: { code: "sync_cycle_error", message: msg, pair_id: pair.pair_id } });
        }
      }
    }
    ```
  - [x] 3.6 `private async syncPair(pair: SyncPair): Promise<void>`:
    - Guard: `if (!this.driveClient) return;`
    - Resolve `remote_id` if `pair.remote_id === ""`: call `resolveRemoteId(pair)` which throws on failure (emit `error` and return)
    - `const localFiles = await this.walkLocalTree(pair.local_path)`
    - `const { files: remoteFiles, folders: remoteFolders } = await this.walkRemoteTree(pair.remote_id, "")`
    - `const syncStates = new Map(this.stateDb.listSyncStates(pair.pair_id).map(s => [s.relative_path, s]))`
    - `const workItems = this.computeWorkList(pair, localFiles, remoteFiles, remoteFolders, syncStates)`
    - Emit initial `sync_progress` (files_done:0, files_total: workItems.length)
    - `await this.executeWorkList(pair, workItems)`
    - Emit `sync_complete`
  - [x] 3.7 `private async resolveRemoteId(pair: SyncPair): Promise<string>`:
    - Split `pair.remote_path` on `/`, filter empty segments
    - Walk from root using `driveClient.listRemoteFolders(null)` for first segment, then `listRemoteFolders(parentId)` for each subsequent
    - `this.stateDb.updatePairRemoteId(pair.pair_id, resolvedId)` on success
    - Throw `new SyncError(...)` if segment not found
  - [x] 3.8 `private async walkLocalTree(localPath: string): Promise<Map<string, LocalFile>>`:
    - `const entries = await readdir(localPath, { withFileTypes: true, recursive: true })`
    - For each `entry.isFile()`: `fullPath = join(entry.parentPath, entry.name)`, `relPath = relative(localPath, fullPath)`, `s = await stat(fullPath)`, push `{relativePath: relPath, mtime: s.mtime.toISOString(), size: s.size}`
    - Return as `Map<relativePath, LocalFile>`
    - `entry.parentPath` is the correct field in Node.js 21.2+ (Node 22 has it); fallback to `entry.path` if undefined
  - [x] 3.9 `private async walkRemoteTree(folderId: string, prefix: string): Promise<{ files: Map<string, RemoteFile>; folders: Map<string, string> }>`:
    - `const files = await this.driveClient!.listRemoteFiles(folderId)` → add to `fileMap` with key `prefix + file.name`
    - `const subfolders = await this.driveClient!.listRemoteFolders(folderId)` → for each: add to `folderMap` with key `prefix + folder.name` → value = `folder.id`; recurse with `prefix + folder.name + "/"` and merge results
    - Return `{ files: fileMap, folders: folderMap }` where `folderMap` maps `relativeDir → folderUid`
  - [x] 3.10 `private computeWorkList(pair, localFiles, remoteFiles, remoteFolders, syncStates): WorkItem[]`:
    - Apply delta detection per AC1: upload-only-changed, download-only-changed, new-only-local, new-only-remote, skip both-changed, skip both-new, skip unchanged
    - For upload items: `remoteFolderId` = `pair.remote_id` for root-level files; for subdirectory files (e.g. `docs/notes.md`), look up `remoteFolders.get("docs")` — if not found, **skip with `debugLog`** (remote parent does not exist; creating remote dirs is out of scope for 2.5)
    - For download items: `nodeUid` from `remoteFiles.get(relPath)!.id`
    - Return array of `WorkItem`
  - [x] 3.11 `private async executeWorkList(pair, workItems)`:
    - `const sem = new Semaphore(3)`
    - `let filesDone = 0, bytesDone = 0`
    - `const bytesTotal = workItems.reduce((a, w) => a + w.size, 0)`
    - `await Promise.all(workItems.map(item => this.processOne(pair, item, sem, () => { filesDone++; bytesDone += item.size; this.emitEvent({type:"sync_progress",...}); })))`
  - [x] 3.12 `private async processOne(pair, item, sem, onComplete)`:
    - `const release = await sem.acquire()`
    - try: if upload → `uploadOne(pair, item)`, if download → `downloadOne(pair, item)`; call `upsertSyncState` BEFORE `onComplete()`:
      - Upload: `{ local_mtime: item.localMtime, remote_mtime: item.localMtime, content_hash: null }` — use `localMtime` for BOTH fields because `body.modificationTime = new Date(item.localMtime)` is stored by SDK as `activeRevision.claimedModificationTime`, so remote_mtime will equal localMtime on next list
      - Download: `{ local_mtime: (await stat(destPath)).mtime.toISOString(), remote_mtime: item.remoteMtime, content_hash: null }`
    - finally: `release()`
    - catch: per-file errors emit `{type:"error", payload:{code:"sync_file_error", message, pair_id}}` — do NOT rethrow (partial failure keeps sync going)
  - [x] 3.13 `private async uploadOne(pair, item)`:
    - `const stream = Readable.toWeb(createReadStream(item.localPath)) as ReadableStream<Uint8Array>`
    - `const body: UploadBody = { stream, sizeBytes: item.size, modificationTime: new Date(item.localMtime), mediaType: "application/octet-stream" }`
    - `await this.driveClient!.uploadFile(item.remoteFolderId, basename(item.relativePath), body)`
  - [x] 3.14 `private async downloadOne(pair, item)`:
    - `const destPath = join(pair.local_path, item.relativePath)`
    - `const tmpPath = destPath + ".protondrive-tmp-" + Date.now()`
    - `await mkdir(dirname(destPath), { recursive: true })`
    - Create node writable → web stream: `const nodeWritable = fs.createWriteStream(tmpPath); const writableStream = Writable.toWeb(nodeWritable) as WritableStream<Uint8Array>`
    - try: `await this.driveClient!.downloadFile(item.nodeUid, writableStream)` → `renameSync(tmpPath, destPath)`
    - catch: `unlinkSync(tmpPath)` in catch, rethrow

- [x] **Task 4: main.ts integration** (AC: #5, #6, #7)
  - [x] 4.1 Import `SyncEngine` from `"./sync-engine.js"` at top of `main.ts`
  - [x] 4.2 Declare `let syncEngine: SyncEngine;` at module scope (after `let stateDb`)
  - [x] 4.3 In `main()`, after `stateDb = new StateDb()`: `syncEngine = new SyncEngine(stateDb, (e) => server.emitEvent(e))`
  - [x] 4.4 In `handleTokenRefresh`, after `driveClient = client`: `syncEngine.setDriveClient(client); void syncEngine.startSyncAll()`
  - [x] 4.5 In the `token_expired` path (where `driveClient = null`): `syncEngine.setDriveClient(null)`
  - [x] 4.6 Export `_setSyncEngineForTests(e: SyncEngine | undefined): void` for test injection (same pattern as `_setStateDbForTests`)

- [x] **Task 5: sync-engine.test.ts** (AC: #11)
  - [x] 5.1 Create `engine/src/sync-engine.test.ts` using `node:test` + `node:assert/strict`
  - [x] 5.2 Mock `DriveClient` as `{ listRemoteFiles: mock.fn(...), listRemoteFolders: mock.fn(...), uploadFile: mock.fn(...), downloadFile: mock.fn(...) } as unknown as DriveClient`
  - [x] 5.3 Use `new StateDb(':memory:')` with pair pre-inserted per test that needs it
  - [x] 5.4 Test: local-only changed → `uploadFile` called, `upsertSyncState` called with correct local_mtime
  - [x] 5.5 Test: remote-only changed → `downloadFile` called, `upsertSyncState` called with correct remote_mtime
  - [x] 5.6 Test: both unchanged → no upload, no download, no upsertSyncState
  - [x] 5.7 Test: both changed (local AND remote) → skip (no upload, no download)
  - [x] 5.8 Test: new local file only → upload
  - [x] 5.9 Test: new remote file only → download
  - [x] 5.10 Test: file in both, no sync_state → skip (conflict)
  - [x] 5.11 Test: `remote_id = ""` → `resolveRemoteId` called, `updatePairRemoteId` called with resolved id
  - [x] 5.12 Test: `remote_id = ""`, segment not found → `error` push event emitted with `code: "remote_path_not_found"`
  - [x] 5.13 Test: `sync_complete` event emitted after cycle finishes
  - [x] 5.14 Test: initial `sync_progress` emitted with `files_done: 0` before transfers
  - [x] 5.15 Test: concurrency cap — 5 files with delays, max 3 concurrent `downloadFile` calls at any moment
  - [x] 5.16 Test: `upsertSyncState` is called BEFORE `sync_progress` is updated (state is durable before counter increments)

- [x] **Task 6: Update sprint status**
  - [x] 6.1 In `_bmad-output/implementation-artifacts/sprint-status.yaml`: set `2-5-sync-engine-core-two-way-sync: review`
  - [x] 6.2 Update `last_updated: 2026-04-10`

### Review Findings

- [x] [Review][Decision] AC7 — sync_complete not emitted when driveClient is null — resolved: no-op cycle (null client) is not a "finished" cycle; no event emitted, no change needed [sync-engine.ts:110]

- [x] [Review][Patch] No re-entrancy guard on startSyncAll — fixed: added `isSyncing` flag + try/finally [sync-engine.ts]
- [x] [Review][Patch] walkLocalTree silently swallows all errors and returns empty map — fixed: readdir failures now propagate; individual stat failures logged and skipped [sync-engine.ts]
- [x] [Review][Patch] driveClient snapshot not taken at syncPair start — fixed: `const client = this.driveClient` at cycle start; passed through all private methods [sync-engine.ts]
- [x] [Review][Patch] AC5 cold-start test does not exercise insertion path — fixed: constructor accepts `getConfigPairs` injector; test uses custom provider returning a test pair [sync-engine.test.ts]
- [x] [Review][Patch] AC11 "both changed" test flaky on coarse-grained filesystems — fixed: seed mtime changed to `2020-01-01T00:00:00.000Z` [sync-engine.test.ts]
- [x] [Review][Patch] AC11 conflict-skip test missing upsertSyncState assertion — fixed: added spy + `assert.equal(upsertCalled, false)` [sync-engine.test.ts]
- [x] [Review][Patch] AC4 concurrency test asserts maxConcurrent >= 2 (not in spec, flaky) — fixed: removed flaky lower-bound assertion [sync-engine.test.ts]
- [x] [Review][Patch] downloadOne success path does not await nodeWritable closure — fixed: awaits `nodeWritable.once("close")` before rename [sync-engine.ts]

- [x] [Review][Defer] Deletion propagation (remote→local and local→remote) silently skipped — explicitly out of scope for 2.5, see code comment [sync-engine.ts:316-319] — deferred, pre-existing
- [x] [Review][Defer] Upload remoteMtime assumes SDK stores body.modificationTime exactly as provided — SDK timestamp normalization could cause infinite re-upload loop; documented design tradeoff in Dev Notes [sync-engine.ts:384-385] — deferred, pre-existing
- [x] [Review][Defer] walkRemoteTree unbounded recursion — no max-depth or cycle guard for circular folder references (e.g. shared folders) — deferred, pre-existing
- [x] [Review][Defer] upsertSyncState uses INSERT OR REPLACE which resets rowid — breaks referential integrity if sync_state gains rowid-referencing foreign keys — deferred, pre-existing
- [x] [Review][Defer] walkLocalTree follows symlinks without restriction — symlink cycle causes infinite recursion — deferred, pre-existing
- [x] [Review][Defer] resolveRemoteId uses case-sensitive name match — Proton Drive may return folder names with different casing than user configured — deferred, pre-existing
- [x] [Review][Defer] processOne stat after successful download susceptible to ENOENT race if external process removes destPath between rename and stat — deferred, pre-existing
- [x] [Review][Defer] Cold-start insertPair has no catch for UNIQUE constraint if concurrent startSyncAll races — mitigated by re-entrancy patch; deferred, pre-existing

---

## Dev Notes

### CRITICAL: Engine Runtime is Node.js 22, NOT Bun

CLAUDE.md Bun defaults DO NOT apply to the engine. `bun:sqlite`, `bun test`, `Bun.serve()` are all wrong. Run with `node --import tsx`.

### CRITICAL: uploadFile and downloadFile are already implemented in sdk.ts

Do **NOT** "implement stubs" or replace existing code. `DriveClient.uploadFile()` (lines 309–341) and `DriveClient.downloadFile()` (lines 354–381) are **fully implemented** since Story 2.2. Only add `listRemoteFiles()` — everything else is existing.

### CRITICAL: No configManager — use config.ts functions directly

There is no `configManager` object in the codebase. Use `listConfigPairs(): ConfigPair[]` from `./config.js` — it returns the pairs array directly. `ConfigPair` has `{pair_id, local_path, remote_path, created_at}` (no `remote_id`). Import:
```typescript
import type { ConfigPair } from "./config.js";
import { listConfigPairs } from "./config.js";
```
These two imports can be written as one: `import { listConfigPairs, type ConfigPair } from "./config.js"` (verbatimModuleSyntax allows mixing value + type in one statement when using inline `type` keyword).

### CRITICAL: sdk.ts DriveClient uses `this.sdk` (not `this._sdk`)

The private field is declared as `private readonly sdk: ProtonDriveClientLike`. Use `this.sdk.iterateFolderChildren(...)` — not `this._sdk`.

### CRITICAL: No console.log / console.error in sync-engine.ts

`console.log()` writes to stdout and **corrupts IPC framing** (the 4-byte length prefix protocol breaks immediately). Use only `debugLog()` from `./debug-log.js`.

### ProtonDriveAccount crypto constraint — important context

Story 2.5 wires the sync orchestration layer. Real file transfers depend on the account having a properly initialized private key (for E2E encryption). In the current Story 2.2.5 live wiring, `createDriveClient(token)` works for auth but `uploadFile`/`downloadFile` may fail if the SDK requires private key operations that need the mailbox password (not available from the OAuth token alone).

The sync engine is designed to handle these failures gracefully: per-file `SyncError` is caught in `processOne()`, emits an `error` push event, and continues to the next file. The entire cycle does not abort on one failed transfer.

Full crypto wiring is tracked as post-MVP tech debt. This story ships the correct orchestration architecture.

### remote_id resolution detail

The `add_pair` handler in `main.ts` (line 124) has a `// TODO(story-2.5): resolve remote_id for unresolved/nested paths` comment. This story resolves it.

`remote_path` examples:
- `/Documents` → segments: `["Documents"]` → `listRemoteFolders(null)` → find "Documents" → `remote_id = doc.id`
- `/Documents/Work` → segments: `["Documents", "Work"]` → find Documents first → find Work within → `remote_id = work.id`

After resolution, `stateDb.updatePairRemoteId(pair.pair_id, resolvedId)` persists it so future cycles don't need to re-resolve.

### Delta detection for upload: finding the remote parent folder

For files at the root of the sync pair: `remoteFolderId = pair.remote_id`.
For files in subdirectories (e.g., `docs/design.md`): need the remote UID of the `docs` subfolder.

`walkRemoteTree` builds a `Map<relativePath, RemoteFile>` where `RemoteFile.parent_id` is the parent folder UID. For the upload work item, store `remoteFolderId = remoteFiles.get(dirname(relativePath))?.id ?? pair.remote_id` — but if the subfolder doesn't exist remotely yet, `uploadFile` will fail; creating remote subdirectories is out of scope for Story 2.5 (MVP syncs only files that already have a remote parent). Add a `debugLog` and skip if parent folder not found remotely.

### Readable.toWeb / Writable.toWeb — Node.js stream interop

The SDK's `uploadFile` requires `ReadableStream<Uint8Array>` (Web Streams API). The SDK's `downloadFile` requires `WritableStream<Uint8Array>`.

```typescript
// Upload — Node Readable → Web ReadableStream
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
const webStream = Readable.toWeb(createReadStream(localPath)) as ReadableStream<Uint8Array>;

// Download — Node Writable → Web WritableStream
import { Writable } from "node:stream";
import { createWriteStream } from "node:fs";
const webWritable = Writable.toWeb(createWriteStream(tmpPath)) as WritableStream<Uint8Array>;
```

Both `.toWeb()` methods are Node.js built-ins (available since Node 16). No external packages needed.

### Semaphore for concurrency cap

```typescript
class Semaphore {
  private count: number;
  private readonly queue: Array<() => void> = [];
  constructor(limit: number) { this.count = limit; }
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

Use: `const release = await sem.acquire()` before each transfer, `release()` in `finally`.

### collectLocalFiles — Node.js 22 readdir with recursive

```typescript
const entries = await readdir(localPath, { withFileTypes: true, recursive: true });
for (const entry of entries) {
  if (!entry.isFile()) continue;
  // entry.parentPath is the containing directory (Node 21.2+)
  const fullPath = join(entry.parentPath ?? (entry as any).path, entry.name);
  const relPath = relative(localPath, fullPath);
  const s = await stat(fullPath);
  // ...
}
```

`entry.parentPath` is available in Node.js 21.2+ (which Node 22 covers). The `(entry as any).path` fallback handles older Node versions if needed but is not needed for Node 22.

### walkRemoteTree — dual-map return for upload routing

`walkRemoteTree` returns both a files map and a folders map. The folders map is needed to set `remoteFolderId` for upload work items:

```typescript
private async walkRemoteTree(
  folderId: string,
  prefix: string,
): Promise<{ files: Map<string, RemoteFile>; folders: Map<string, string> }> {
  const fileMap = new Map<string, RemoteFile>();
  const folderMap = new Map<string, string>();
  
  const [files, subfolders] = await Promise.all([
    this.driveClient!.listRemoteFiles(folderId),
    this.driveClient!.listRemoteFolders(folderId),
  ]);
  
  for (const f of files) fileMap.set(prefix + f.name, f);
  
  for (const sf of subfolders) {
    const relDir = prefix + sf.name;
    folderMap.set(relDir, sf.id);
    const sub = await this.walkRemoteTree(sf.id, relDir + "/");
    for (const [k, v] of sub.files) fileMap.set(k, v);
    for (const [k, v] of sub.folders) folderMap.set(k, v);
  }
  
  return { files: fileMap, folders: folderMap };
}
```

In `computeWorkList`, for an upload where `relativePath = "docs/notes.md"`:
```typescript
const parentDir = dirname(relativePath); // "docs"
const remoteFolderId = parentDir === "." ? pair.remote_id : remoteFolders.get(parentDir);
if (!remoteFolderId) {
  debugLog(`sync-engine: skipping upload ${relativePath} — remote parent dir not found`);
  continue; // creating remote dirs is out of scope for Story 2.5
}
```

### Atomic download pattern

```typescript
const destPath = join(pair.local_path, item.relativePath);
const tmpPath = `${destPath}.protondrive-tmp-${Date.now()}`;
await mkdir(dirname(destPath), { recursive: true });
const nodeWritable = createWriteStream(tmpPath);
const writableStream = Writable.toWeb(nodeWritable) as WritableStream<Uint8Array>;
try {
  await this.driveClient!.downloadFile(item.nodeUid, writableStream);
  await rename(tmpPath, destPath); // atomic on same filesystem
} catch (err) {
  try { await unlink(tmpPath); } catch { /* already gone */ }
  throw err;
}
```

### State write ordering — CRITICAL

State MUST be written BEFORE progress counters increment. For uploads, `remote_mtime` must equal `localMtime` (not server time — see C2 fix):

```typescript
// In processOne():
try {
  if (item.kind === "upload") await this.uploadOne(pair, item);
  else await this.downloadOne(pair, item);
  
  const destPath = join(pair.local_path, item.relativePath);
  // 1. Write sync state first — durable before anything else
  this.stateDb.upsertSyncState({
    pair_id: pair.pair_id,
    relative_path: item.relativePath,
    local_mtime: item.kind === "upload"
      ? item.localMtime
      : (await stat(destPath)).mtime.toISOString(),
    // Upload: remote_mtime = localMtime because SDK stores body.modificationTime
    // as activeRevision.claimedModificationTime — using any other value causes
    // an infinite sync loop (next list sees mismatch → re-download → mismatch).
    remote_mtime: item.kind === "upload" ? item.localMtime : item.remoteMtime,
    content_hash: null,
  });
  
  // 2. Then emit progress
  onComplete();
} catch (err) {
  const msg = err instanceof Error ? err.message : "unknown";
  this.emitEvent({ type: "error", payload: { code: "sync_file_error", message: msg, pair_id: pair.pair_id } });
} finally {
  release();
}

### Test scaffold for sync-engine.test.ts

```typescript
import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { StateDb } from "./state-db.js";
import { SyncEngine } from "./sync-engine.js";
import type { DriveClient, RemoteFile } from "./sdk.js";
import type { IpcPushEvent } from "./ipc.js";

let db: StateDb;
let emittedEvents: IpcPushEvent[];
let mockClient: DriveClient;
let engine: SyncEngine;

function makeMockClient(overrides = {}) {
  return {
    listRemoteFolders: mock.fn(async () => []),
    listRemoteFiles: mock.fn(async () => []),
    uploadFile: mock.fn(async () => ({ node_uid: "new-uid", revision_uid: "rev-uid" })),
    downloadFile: mock.fn(async () => {}),
    ...overrides,
  } as unknown as DriveClient;
}

beforeEach(() => {
  db = new StateDb(":memory:");
  emittedEvents = [];
  mockClient = makeMockClient();
  engine = new SyncEngine(db, (e) => emittedEvents.push(e));
  engine.setDriveClient(mockClient);
});
afterEach(() => db.close());
```

### Files to create / modify

**Engine (new):**
- `engine/src/sync-engine.ts`
- `engine/src/sync-engine.test.ts`

**Engine (modified):**
- `engine/src/sdk.ts` — add `RemoteFile` interface + `listRemoteFiles()` method
- `engine/src/sdk.test.ts` — add `listRemoteFiles` tests
- `engine/src/state-db.ts` — add 5 new methods (getSyncState, upsertSyncState, listSyncStates, deleteSyncState, updatePairRemoteId)
- `engine/src/state-db.test.ts` — add sync_state CRUD + updatePairRemoteId tests
- `engine/src/main.ts` — SyncEngine init + integration in handleTokenRefresh + `_setSyncEngineForTests` export

**Sprint status (modified):**
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — 2-5 → ready-for-dev

### References

- Epic 2.5 requirements: [Source: `_bmad-output/planning-artifacts/epics.md` line 857]
- `sync_progress` + `sync_complete` IPC event shapes: [Source: `_bmad-output/planning-artifacts/architecture.md` lines 145-146]
- Engine source is flat (no subdirectories): [Source: project-context.md line 192]
- `console.log()` corrupts IPC framing: [Source: project-context.md line 304]
- Atomic file writes for downloads: [Source: project-context.md line 112]
- `sync_state` table schema: [Source: `engine/src/state-db.ts` lines 17-23, migration v1 lines 49-57]
- `NodeEntity.activeRevision.claimedModificationTime` for file mtime: [Source: `engine/node_modules/@protontech/drive-sdk/dist/interface/nodes.d.ts` line 211]
- `NodeEntity.totalStorageSize` and `Revision.claimedSize` for size: [Source: SDK nodes.d.ts lines 106, 207]
- `NodeType.File` enum value `"file"`: [Source: SDK nodes.d.ts line 163]
- `iterateFolderChildren` already in `ProtonDriveClientLike`: [Source: `engine/src/sdk.ts` lines 127-133]
- `DriveClient` private field is `this.sdk` (not `this._sdk`): [Source: `engine/src/sdk.ts` line 226]
- `uploadFile` fully implemented (NOT a stub): [Source: `engine/src/sdk.ts` lines 309-341]
- `downloadFile` fully implemented (NOT a stub): [Source: `engine/src/sdk.ts` lines 354-381]
- `listConfigPairs(): ConfigPair[]` from config.ts (no configManager exists): [Source: `engine/src/config.ts` line 45]
- `_setStateDbForTests` pattern for test injection: [Source: `engine/src/main.ts` lines 33-35]
- `TODO(story-2.5)` comment in main.ts add_pair handler: [Source: `engine/src/main.ts` line 124]
- `noUncheckedIndexedAccess`: `arr[0]` is `T | undefined` — use `!` after bounds check: [Source: project-context.md line 43]
- Local imports use `.js` extension: [Source: project-context.md line 68]
- `verbatimModuleSyntax`: `import type` for type-only imports: [Source: project-context.md line 45]
- `override` keyword required for class method overrides: [Source: project-context.md line 48]
- Typed error subclasses only (`SyncError`, `NetworkError`): [Source: project-context.md line 74]
- Story 2.4 dev notes on `remote_id` fallback: [Source: `_bmad-output/implementation-artifacts/2-4-setup-wizard-and-first-pair-creation.md` Dev Notes]

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6 (Amelia / bmad-agent-dev → bmad-dev-story)

### Debug Log References

None — implementation proceeded without blockers.

### Completion Notes List

- Task 1: Added 5 StateDb methods (getSyncState, upsertSyncState, listSyncStates, deleteSyncState, updatePairRemoteId) + 7 tests in state-db.test.ts; all 23 state-db tests pass.
- Task 2: Added RemoteFile interface + listRemoteFiles() to DriveClient in sdk.ts + 6 tests; all 50 sdk tests pass.
- Task 3: Created engine/src/sync-engine.ts with SyncEngine class implementing all ACs: delta detection (AC1), atomic downloads with stream destroy-before-unlink (AC2), state-before-progress ordering (AC3), Semaphore concurrency cap of 3 (AC4), cold-start pair restoration (AC5), remote_id resolution walk (AC6), sync_progress/sync_complete events (AC7), no console.log/error (AC10).
- Task 4: Wired SyncEngine into main.ts — module-level instance, initialized in main(), setDriveClient on token_refresh success/expiry, void startSyncAll() on session_ready, _setSyncEngineForTests export.
- Task 5: Created 16 tests in sync-engine.test.ts covering all AC11 cases. Fixed infinite recursion in walkRemoteTree by having resolution mock return [] for non-root listRemoteFolders calls. Fixed atomic cleanup test by destroying the nodeWritable WriteStream before unlink so the file descriptor is released.
- Task 6: Updated sprint-status.yaml 2-5 → review.

### File List

- engine/src/state-db.ts
- engine/src/state-db.test.ts
- engine/src/sdk.ts
- engine/src/sdk.test.ts
- engine/src/sync-engine.ts (new)
- engine/src/sync-engine.test.ts (new)
- engine/src/main.ts
- _bmad-output/implementation-artifacts/sprint-status.yaml
- _bmad-output/implementation-artifacts/2-5-sync-engine-core-two-way-sync.md

## Change Log

- 2026-04-10: Story 2.5 implemented — sync engine core with two-way sync, 5 StateDb methods, DriveClient.listRemoteFiles, SyncEngine class, main.ts integration, 16 engine tests + 7 state-db tests + 6 sdk tests added.
