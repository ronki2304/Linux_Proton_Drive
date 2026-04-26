# ProtonDrive Linux Client — Engine Data Models

**Last Updated:** 2026-04-26

Complete SQLite schema for the engine state database (`state.db`). 8 migrations, tracked via `PRAGMA user_version`.

---

## Database Configuration

```sql
PRAGMA journal_mode = WAL;       -- concurrent readers, non-blocking writes
PRAGMA synchronous  = NORMAL;    -- safe on Linux (ext4/btrfs) with WAL
PRAGMA foreign_keys = ON;        -- cascading deletes enforced
```

**Location:** `$XDG_DATA_HOME/protondrive/state.db`  
(default: `~/.local/share/protondrive/state.db`)

---

## Schema (Current — Version 8)

### `sync_pair`
Registered sync pairs. One row per active local ↔ remote folder mapping.

```sql
CREATE TABLE sync_pair (
    pair_id        TEXT PRIMARY KEY,   -- UUID v4
    local_path     TEXT NOT NULL,      -- absolute local folder path
    remote_path    TEXT NOT NULL,      -- display path on ProtonDrive
    remote_id      TEXT NOT NULL,      -- ProtonDrive folder UID
    created_at     TEXT NOT NULL,      -- ISO 8601 timestamp
    last_synced_at TEXT                -- ISO 8601; NULL if never synced (migration v2)
);
```

**Key operations:** `insertPair()`, `deletePair()`, `listPairs()`, `updatePairPath()`, `updateLastSynced()`

---

### `sync_state`
Per-file sync record. Tracks the last-known state on both sides for conflict detection.

```sql
CREATE TABLE sync_state (
    pair_id        TEXT NOT NULL REFERENCES sync_pair(pair_id) ON DELETE CASCADE,
    relative_path  TEXT NOT NULL,   -- path relative to pair local root
    local_mtime    TEXT NOT NULL,   -- ISO 8601 mtime at last successful sync
    remote_mtime   TEXT NOT NULL,   -- ISO 8601 mtime at last successful sync
    content_hash   TEXT,            -- SHA-256 hex; NULL when unavailable
    remote_node_id TEXT,            -- ProtonDrive node UID (migration v7)
    PRIMARY KEY (pair_id, relative_path)
);
```

**Conflict detection uses:** `local_mtime`, `remote_mtime`, `content_hash`  
**Targeted event routing uses:** `remote_node_id` (index lookup via `findSyncStateByRemoteNodeId()`)

**Key operations:** `getSyncState()`, `upsertSyncState()`, `deleteSyncState()`, `listSyncStates()`, `findSyncStateByRemoteNodeId()`

---

### `change_queue`
Pending local filesystem changes awaiting sync. FIFO drain order (ordered by `id ASC`).

```sql
CREATE TABLE change_queue (
    id             INTEGER PRIMARY KEY,
    pair_id        TEXT NOT NULL REFERENCES sync_pair(pair_id) ON DELETE CASCADE,
    relative_path  TEXT NOT NULL,
    change_type    TEXT NOT NULL,       -- "created" | "modified" | "deleted"
    queued_at      TEXT NOT NULL,       -- ISO 8601 timestamp
    attempt_count  INTEGER NOT NULL DEFAULT 0   -- migration v4
);
```

**Retry logic:** `attempt_count` incremented on each failed drain attempt. After `MAX_DRAIN_ATTEMPTS = 5` failures, entry is moved to `dead_letter` and removed from this table.

**Key operations:** `enqueue()`, `dequeue()`, `listQueue()`, `incrementAttemptCount()`, `queueSize()`

---

### `dead_letter`
Changes that failed `MAX_DRAIN_ATTEMPTS` times. Preserved for diagnostics; not retried automatically.

```sql
CREATE TABLE dead_letter (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    pair_id        TEXT NOT NULL,
    relative_path  TEXT NOT NULL,
    change_type    TEXT NOT NULL,
    reason         TEXT NOT NULL,    -- error message from last failure
    dead_at        TEXT NOT NULL     -- ISO 8601 timestamp
);
```

No FK constraint on `pair_id` — dead letter entries are kept even if the pair is deleted (forensic record). Dead letter entries are visible in the UI error state but require manual intervention to clear.

---

### `session_state`
Singleton table. Crash detection flag.

```sql
CREATE TABLE session_state (
    id    INTEGER PRIMARY KEY DEFAULT 1,   -- always row 1
    dirty INTEGER NOT NULL DEFAULT 0       -- 1 = session was active on last run
);
INSERT OR IGNORE INTO session_state (id, dirty) VALUES (1, 0);
```

**Lifecycle:**
- Set `dirty = 1` at session start (after `token_refresh` activates a session)
- Set `dirty = 0` on clean shutdown
- If `dirty = 1` on startup → previous session crashed → run `cleanTmpFilesInDir()`

---

### `event_checkpoint`
Latest processed remote event ID per tree scope. Enables incremental reconcile.

```sql
CREATE TABLE event_checkpoint (
    tree_event_scope_id TEXT PRIMARY KEY,   -- SDK scope identifier for a remote tree
    last_event_id       TEXT NOT NULL       -- last processed event ID for that scope
);
```

On reconnect, the engine resumes from `last_event_id` instead of doing a full tree walk. On `TreeRemove` events, the checkpoint for that scope is deleted (`clearEventCheckpoint()`), forcing a full reconcile.

---

### `event_queue`
Buffered remote SDK events awaiting processing. Drained by `drainEventQueue()`.

```sql
CREATE TABLE event_queue (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    tree_event_scope_id TEXT NOT NULL,    -- FK to event_checkpoint (logical, no constraint)
    event_type          TEXT NOT NULL,    -- "TreeRefresh" | "NodeCreated" | "NodeUpdated" | "TreeRemove"
    event_payload       TEXT NOT NULL    -- JSON-serialized SDK event data
);
```

Events are inserted atomically with checkpoint updates via `persistEvent()` (one transaction). Processed events are deleted individually via `deleteQueuedEvent()`.

---

### `sync_folder`
Known remote subfolder UIDs for targeted event routing.

```sql
CREATE TABLE sync_folder (
    pair_id        TEXT NOT NULL REFERENCES sync_pair(pair_id) ON DELETE CASCADE,
    relative_path  TEXT NOT NULL,     -- path relative to pair remote root
    remote_node_id TEXT NOT NULL,     -- ProtonDrive folder UID
    PRIMARY KEY (pair_id, relative_path)
);
```

Used by `drainEventQueue()` to route `NodeCreated`/`NodeUpdated` events to the correct pair without a full tree walk. Populated during `reconcileAndEnqueue()` as folder structure is traversed. Looked up via `findSyncFolderByRemoteNodeId()`.

---

## Migration History

| Version | Change |
|---------|--------|
| 1 | Initial schema: `sync_pair`, `sync_state`, `change_queue` |
| 2 | Add `sync_pair.last_synced_at` column |
| 3 | Add `session_state` table (crash detection) |
| 4 | Add `change_queue.attempt_count` column (retry tracking) |
| 5 | Add `dead_letter` table (permanent failures) |
| 6 | Add `event_checkpoint` + `event_queue` tables (remote event subscription) |
| 7 | Add `sync_state.remote_node_id` column (targeted event routing) |
| 8 | Add `sync_folder` table (folder UID index for event routing) |

Migrations run forward-only at startup via `PRAGMA user_version` comparison. Each migration runs in a transaction — partial migrations are impossible.

---

## Atomic Transaction Guarantees

Three commit functions ensure that DB state is never left partially updated:

### `commitUpload(state, queueEntryId)`
```
BEGIN
  INSERT OR REPLACE INTO sync_state ...   -- record new sync baseline
  DELETE FROM change_queue WHERE id = ?   -- remove processed entry
COMMIT
```
Invariant: an uploaded file is either fully committed (both rows updated) or neither (retry on restart).

### `commitTrash(pairId, relativePath, queueEntryId)`
```
BEGIN
  DELETE FROM sync_state WHERE ...        -- remove sync record
  DELETE FROM change_queue WHERE id = ?   -- remove processed entry
COMMIT
```
Invariant: a trashed file is either fully forgotten or both rows persist (retry on restart).

### `commitDequeue(pairId, relativePath, queueEntryId, deleteState)`
```
BEGIN
  [DELETE FROM sync_state WHERE ...]      -- optional: both-sides-gone case
  DELETE FROM change_queue WHERE id = ?
COMMIT
```
Used for the "both gone" dequeue path (no API call needed).

---

## TypeScript Interfaces

```typescript
interface SyncPair {
  pair_id:        string;
  local_path:     string;
  remote_path:    string;
  remote_id:      string;
  created_at:     string;        // ISO 8601
  last_synced_at: string | null; // ISO 8601, null if never synced
}

interface SyncState {
  pair_id:        string;
  relative_path:  string;
  local_mtime:    string;        // ISO 8601
  remote_mtime:   string;        // ISO 8601
  content_hash:   string | null; // SHA-256 hex
  remote_node_id: string | null; // ProtonDrive node UID
}

type ChangeType = "created" | "modified" | "deleted";

interface ChangeQueueEntry {
  id:            number;
  pair_id:       string;
  relative_path: string;
  change_type:   ChangeType;
  queued_at:     string;   // ISO 8601
  attempt_count: number;   // default 0
}

interface EventQueueEntry {
  id:                  number;
  tree_event_scope_id: string;
  event_type:          string;
  event_payload:       string; // JSON
}

interface SyncFolder {
  pair_id:        string;
  relative_path:  string;
  remote_node_id: string;
}
```
