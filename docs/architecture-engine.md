# ProtonDrive Linux Client — Engine Architecture

**Last Updated:** 2026-04-26

Deep dive into the TypeScript/Bun sync engine process. For the overall system, see [Architecture](./architecture.md).

---

## Module Map

```
engine/src/
├── main.ts           ← orchestrator + singletons + IPC command dispatch
├── ipc.ts            ← Unix socket server (framing, backpressure, push events)
├── sync-engine.ts    ← all sync logic (reconcile, drain, event subscription)
├── sdk.ts            ← SDK boundary (ONLY importer of @protontech/drive-sdk)
├── state-db.ts       ← SQLite via bun:sqlite (WAL mode, 8 migrations)
├── watcher.ts        ← inotify file change detection + debounce
├── network-monitor.ts← TCP probe network status
├── conflict.ts       ← pure conflict detection (mtime + hash)
├── config.ts         ← YAML config read/write (XDG_CONFIG_HOME)
├── errors.ts         ← error hierarchy (zero internal imports)
└── debug-log.ts      ← capped file logger (PROTONDRIVE_DEBUG=1)
```

**Dependency rule:** Only leaf modules (`errors.ts`, `debug-log.ts`) have zero internal imports. `sdk.ts` is the sole entry point for `@protontech/drive-sdk`. All other modules import from `sdk.ts`, never directly from the SDK package.

---

## Startup Sequence

```
bun run engine/src/main.ts
    │
    ├─ Create StateDb (open SQLite, run migrations if needed)
    ├─ Create SyncEngine(stateDb)
    ├─ Create NetworkMonitor → start polling 1.1.1.1:443
    ├─ Create IpcServer → bind Unix socket
    │
    ├─ [Flatpak only] Install DoH fetch override
    │   └─ globalThis.fetch = undici with custom Agent(_resolveViaDoH)
    │
    └─ server.listen() → await IPC commands
```

No sync activity begins until `token_refresh` arrives from the UI process.

---

## IPC Command Dispatch (`main.ts`)

All engine behavior is driven by IPC commands. `handleCommand()` is the single dispatch point.

| Command | Handler | Side Effects |
|---------|---------|-------------|
| `token_refresh` | `handleTokenRefresh()` | Create/swap DriveClient, unlock keys, activate session |
| `unlock_keys` | `handleUnlockKeys()` | Derive keyPassword from cached salts, activate session |
| `add_pair` | inline | Validate paths, write config, call `startSyncPair()` |
| `remove_pair` | inline | Remove from config, clear DB state, stop watchers |
| `update_pair_path` | inline | Update config, restart watchers |
| `get_status` | inline | Return queued change count |
| `list_remote_folders` | inline | Forward to `driveClient.listRemoteFolders()` |
| `shutdown` | inline | `process.exit(0)` (socket closes, no `_result` response) |

### Auth Command Flow

```
token_refresh arrives
    │
    ├─ Parse "uid:accesstoken" format
    ├─ createDriveClient(token)
    │
    ├─ Try stored key_password (if provided in command)
    │   └─ applyKeyPassword() → success → _activateSession()
    │
    ├─ Else try captured salts (if login_password + salts in command)
    │   └─ deriveAndUnlock(loginPassword, salts) → _activateSession()
    │
    └─ Else emit key_unlock_required {salts}
           │
           ▼
       unlock_keys arrives (user enters password in dialog)
           └─ handleUnlockKeys() → deriveAndUnlock() → _activateSession()

_activateSession():
    ├─ setDriveClient(client) on SyncEngine
    ├─ validateSession() → AccountInfo
    ├─ startRemoteEventSubscription()
    ├─ init FileWatcher for all existing pairs
    ├─ emit session_ready {display_name, email, storage_*, plan, key_password}
    └─ drainQueue() for all pairs
```

---

## Sync Engine Deep Dive (`sync-engine.ts`)

### Work Item Types

The reconciler produces typed work items, each handled by `processWorkItem()`:

| WorkItem Type | Meaning | Action |
|--------------|---------|--------|
| `upload` | Local file newer / no remote | `driveClient.uploadFile()` |
| `download` | Remote file newer / no local | `driveClient.downloadFile()` |
| `delete_local` | Remote deleted, local has no changes | Delete local file |
| `trash_remote` | Local deleted | `driveClient.trashFile()` |
| `clear_state` | Both sides gone | Remove from sync_state |
| `conflict` | Both sides changed | Create conflict copy, download remote |
| `new_file_collision` | Same name, no sync history | Treat as conflict |
| `bootstrap_match` | New pair, file exists on both sides | Attempt hash match → skip or conflict |

### Reconcile and Enqueue

```
reconcileAndEnqueue(pairId)
    │
    ├─ Walk remote tree via listRemoteFolders() (lazy, breadth-first)
    ├─ Walk local filesystem (recursive readdir)
    ├─ Join on relative path
    │
    ├─ For each file:
    │   ├─ Look up sync_state in DB
    │   ├─ Classify into WorkItem (upload/download/conflict/etc.)
    │   └─ INSERT into change_queue (or update if exists)
    │
    └─ drainQueue(pairId)
```

**Bootstrap case:** When a new sync pair is created and both local and remote have files at the same path, `bootstrap_match` checks content hash. Hash match → record sync_state (skip transfer). Hash mismatch → treat as conflict.

### Drain Queue

```
drainQueue(pairId?)
    │
    ├─ isDraining guard (prevents re-entrancy)
    ├─ For each change_queue entry (ordered by created_at):
    │   │
    │   ├─ processQueueEntry(entry)
    │   │   ├─ Fetch current remote state
    │   │   ├─ detectConflict()
    │   │   └─ Upload / Download / Trash / ClearState
    │   │
    │   ├─ On success: commitUpload() / commitTrash() / commitDequeue()
    │   └─ On failure: increment attempt_count
    │       └─ attempt_count >= MAX_DRAIN_ATTEMPTS(5) → dead_letter entry
    │
    ├─ emit sync_complete {pair_id, files_synced, errors}
    └─ isDraining = false
```

### Rate Limit Backoff

```typescript
withBackoff<T>(fn: () => Promise<T>): Promise<T>
    Retry up to 5 times on RateLimitError
    Delay: min(2^attempt, 30) seconds
    Emits rate_limited push event on each retry
    Throws after 5th failure
```

### Remote Event Subscription

```
startRemoteEventSubscription()
    │
    └─ SDK event stream → drainEventQueue() loop

drainEventQueue():
    ├─ TreeRefresh → full reconcileAndEnqueue() for affected scope
    ├─ NodeCreated → findSyncStateByRemoteNodeId() → targeted enqueue
    ├─ NodeUpdated → findSyncStateByRemoteNodeId() → targeted enqueue
    └─ TreeRemove  → clear event_checkpoint, schedule full reconcile

Checkpoint tracking: event_checkpoint table stores latest event ID per scope.
Incremental: only events after last checkpoint are processed on reconnect.
```

---

## State Database (`state-db.ts`)

### Migration Strategy

Schema version tracked via `PRAGMA user_version`. On open, engine reads current version and runs only pending migrations (idempotent). Hard failure if migration fails — no partial states.

```
PRAGMA journal_mode=WAL;       — concurrent readers, single writer
PRAGMA synchronous=NORMAL;     — safe on Linux with ext4/btrfs
PRAGMA foreign_keys=ON;        — referential integrity enforced
```

### Table Relationships

```
sync_pair (id PK)
    │
    ├──< sync_state (pair_id FK, relative_path)
    │       ├── local_mtime, stored_local_mtime
    │       ├── remote_mtime, stored_remote_mtime
    │       ├── content_hash (SHA-256 of file contents)
    │       └── remote_node_id (UID from ProtonDrive)
    │
    ├──< change_queue (pair_id FK, relative_path)
    │       ├── change_type: created | modified | deleted
    │       └── attempt_count (→ dead_letter after MAX_DRAIN_ATTEMPTS)
    │
    ├──< dead_letter (pair_id FK, relative_path)
    │       └── error_message, failed_at
    │
    └──< sync_folder (pair_id FK, remote_folder_id)
            └── relative_path (for event routing)

session_state (singleton row)
    └── dirty BOOLEAN  ← crash detection flag

event_checkpoint (scope_id PK)
    └── last_event_id  ← incremental reconcile pointer

event_queue (id PK)
    ├── scope_id FK → event_checkpoint
    ├── event_type: TreeRefresh | NodeCreated | NodeUpdated | TreeRemove
    └── payload JSON, processed BOOLEAN
```

### Atomic Transactions

Three commit functions ensure consistency — no partial state is ever written:

```typescript
commitUpload(syncState, queueId):
    BEGIN
    INSERT OR REPLACE INTO sync_state ...
    DELETE FROM change_queue WHERE id = queueId
    COMMIT

commitTrash(pairId, relativePath, queueId):
    BEGIN
    DELETE FROM sync_state WHERE pair_id = pairId AND relative_path = relativePath
    DELETE FROM change_queue WHERE id = queueId
    COMMIT

commitDequeue(queueId):
    BEGIN
    DELETE FROM change_queue WHERE id = queueId
    COMMIT
```

---

## File Watcher (`watcher.ts`)

### inotify Architecture

Linux `inotify` watches **directories**, not individual files. The watcher sets up:
- One `fs.watch()` per subdirectory (recursive traversal on pair init)
- One additional watch on the **parent** of the pair root (detects root rename/delete — inotify fires on the parent directory when a watched inode is renamed)

```
Pair root: /home/user/DriveSync/
    │
    ├── Watch: /home/user/           ← parent watch (detects root deletion)
    ├── Watch: /home/user/DriveSync/ ← root watch
    ├── Watch: /home/user/DriveSync/docs/
    └── Watch: /home/user/DriveSync/photos/
        ...
```

### Change Pipeline

```
inotify event (rename/change/delete)
    │
    ├─ Filter: skip hidden files, tmp files
    ├─ Debounce: coalesce changes within 1000ms window
    │
    └─ queueFileChange(pairId, relativePath, changeType)
        ├─ stateDb.enqueueChange()
        └─ if isOnline(): scheduleSync()
                              └─ syncEngine.drainQueue(pairId)
```

**Offline safety:** Changes are always written to `change_queue`. The drain is only scheduled when online — so offline changes queue up and are processed on reconnect.

### INOTIFY_LIMIT Error

When the system inotify watch limit is exhausted (`ENOSPC` from `fs.watch()`):
```
watcher.emit('error', { code: 'INOTIFY_LIMIT' })
    └─ main.ts → IpcServer.push('error', { code: 'INOTIFY_LIMIT', message: '...' })
        └─ UI: shows error banner with instructions to raise fs.inotify.max_user_watches
```

---

## Network Monitor (`network-monitor.ts`)

Simple TCP probe; no HTTP — avoids DNS and TLS issues at the monitoring layer.

```
Poll loop:
    ├─ Connect TCP to 1.1.1.1:443, 3s timeout
    ├─ Success:
    │   ├─ If was offline: emit 'online'
    │   └─ Schedule next poll: 30s
    └─ Failure:
        ├─ If was online: emit 'offline'
        └─ Schedule next poll: 5s (faster recovery checks)

forceCheck(): cancel pending timer → run immediately
    └─ Called by SyncEngine after a network error during drain
```

---

## Flatpak DNS-over-HTTPS Workaround

Flatpak sandboxes block outgoing UDP port 53 (standard DNS). The engine patches the global fetch client on startup when running inside Flatpak:

```typescript
if (process.env.FLATPAK_ID) {
    const dohAgent = new undici.Agent({
        connect: { lookup: _resolveViaDoH }
    });
    globalThis.fetch = (url, opts) => undici.fetch(url, { ...opts, dispatcher: dohAgent });
}

_resolveViaDoH(hostname):
    POST https://1.1.1.1:443/dns-query (application/dns-json)
    Returns IPv4 address for hostname
    Falls back to original lookup on failure
```

This affects all `fetch()` calls in the process, including those made by `@protontech/drive-sdk`. The SDK never needs to know about the DNS workaround.

---

## Error Hierarchy

```
EngineError (base)
  ├─ SyncError        — file operation failures (upload, download, conflict handling)
  ├─ NetworkError     — fetch/TCP failures not specific to auth
  ├─ RateLimitError   — HTTP 429 (triggers withBackoff() in SyncEngine)
  ├─ AuthExpiredError — HTTP 401 from SDK (triggers token_expired push event)
  ├─ IpcError         — framing failures, payload too large, parse errors
  └─ ConfigError      — YAML parse failures, XDG path resolution failures
```

All errors are defined in `errors.ts` which has zero imports from other engine modules — safe to import anywhere without circular dependency risk.

---

## Crash Recovery

The engine sets a `session_state.dirty = true` flag when a session is active and clears it on clean shutdown. On startup:

```
runCrashRecovery():
    ├─ Read session_state.dirty
    ├─ If dirty:
    │   ├─ Walk all pair local paths
    │   ├─ Delete any .protondrive-tmp-* files (max depth 50)
    │   └─ Clear dirty flag
    └─ Set dirty = true (mark new session as active)
```

Tmp files are created by `downloadFile()` during transfer. If the engine crashes mid-download, the incomplete tmp file is cleaned up on next start.

---

## SDK Boundary Invariants

`sdk.ts` enforces a strict boundary. All SDK types and calls are wrapped:

1. **Single import point**: `import { ... } from '@protontech/drive-sdk'` appears only in `sdk.ts`
2. **MaybeNode pattern**: All `getRemoteNode()` calls must check `.ok` before accessing `.value`
3. **Type cast at boundary**: SDK uses `Uint8Array<ArrayBufferLike>` internally; engine uses `Uint8Array<ArrayBuffer>`; casts are done in `sdk.ts`
4. **Sub-path imports**: SDK doesn't export everything via its main entry — some imports use sub-paths with `@ts-ignore` to bypass missing declarations
5. **Exact version pin**: `@protontech/drive-sdk: 0.14.3` (no `^`) — pre-release API is unstable
