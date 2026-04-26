# ProtonDrive Linux Client — Architecture

**Last Updated:** 2026-04-26

This document covers the full system architecture across both processes. For deep dives see:
- [Architecture — UI](./architecture-ui.md)
- [Architecture — Engine](./architecture-engine.md)
- [Integration Architecture](./integration-architecture.md)

---

## System Overview

```
┌────────────────────────────────────────────────────���─────────────┐
│                     Flatpak Sandbox                              │
│                                                                  │
│  ┌─────────────────────────┐       ┌──────────────────────────┐  │
│  │     UI Process          │       │    Engine Process        │  │
│  │  Python 3.12 / GTK4     │       │    TypeScript / Bun      │  │
│  │                         │       │                          │  │
│  │  Application            │  IPC  │  main.ts (orchestrator)  │  │
│  │  ├── MainWindow         │◄─────►│  ├── IpcServer           │  │
│  │  ├── EngineClient       │ sock  │  ├── SyncEngine          │  │
│  │  ├── AuthWindow         │       │  ├── DriveClient (sdk)   │  │
│  │  └── CredentialManager  │       │  ├── StateDb             │  │
│  │                         │       │  ├── FileWatcher         │  │
│  │                         │       │  └── NetworkMonitor      │  │
│  └─────────────────────────┘       └──────────────────────────┘  │
│                                                                  │
│  libsecret (credentials)   ProtonDrive API (HTTPS/TLS)          │
│  $XDG_RUNTIME_DIR (socket) $XDG_DATA_HOME (SQLite DB)           │
└──────────────────────────────────────────────────────────────────┘
```

---

## Process Roles

### UI Process (Python/GTK4)
- Owns the application window, all user interaction
- Holds the auth token in memory; stores it in libsecret or encrypted file
- Spawns and monitors the engine process
- Translates GTK signals into IPC commands
- Translates IPC push events into widget state updates

### Engine Process (TypeScript/Bun)
- Owns all sync state (SQLite database)
- Owns all Proton API calls (via `@protontech/drive-sdk`)
- Watches local filesystem (inotify via `node:fs.watch`)
- Monitors network connectivity
- Emits push events to the UI; never queries the UI

---

## Auth Flow

```
User clicks Sign In
    │
    ▼
UI: AuthWindow (WebKitGTK)
    │  JS injection captures login_password + key_salts
    │  Cookie poller extracts auth token from WebView cookies
    │
    ▼
UI → Engine: token_refresh {token, login_password, captured_salts}
    │
    ▼
Engine: createDriveClient(token)
  └─► validateSession() → account info
  └─► deriveAndUnlock(login_password, salts) → keyPassword
        │ (bcrypt key derivation, decrypts PGP private keys)
        │
        ▼
Engine → UI: session_ready {display_name, email, storage_*, plan, key_password}
    │
    ▼
UI: stores key_password in libsecret (for silent relaunch)
    route to Setup Wizard (first run) or Main Window (existing pairs)
```

**Silent relaunch** (subsequent launches): UI sends `token_refresh` with stored `key_password` → engine calls `applyKeyPassword()` → `session_ready` without user interaction.

**Key unlock dialog** (fallback): if stored `key_password` invalid, engine emits `key_unlock_required` → UI shows password dialog → user submits → engine derives and unlocks.

---

## Sync Flow

```
FileWatcher detects change
    │  debounce 1 second
    │  enqueueChange() → change_queue table
    │
    ▼
SyncEngine.drainQueue()
    │
    ├─ For each change_queue entry:
    │   │
    │   ├─ "created" / "modified":
    │   │   processQueueEntry()
    │   │    ├─ fetch current remote state
    │   │    ├─ detectConflict(localMtime, storedMtime, remoteMtime, storedRemote, hash)
    │   │    │   ├─ no conflict → upload (if local newer) or download (if remote newer)
    │   │    │   └─ conflict → create conflict copy, download remote winning version
    │   │    └─ commitUpload(syncState, queueId) — atomic DB transaction
    │   │
    │   └─ "deleted":
    │       └─ trash remote file → commitTrash(pairId, path, queueId)
    │
    └─ After MAX_DRAIN_ATTEMPTS failures: dead_letter entry
```

**Remote event subscription** runs in parallel:
```
SDK event stream → drainEventQueue()
  ├─ TreeRefresh → full reconcileAndEnqueue() walk
  ├─ NodeCreated/Updated → targeted enqueue (by remote node ID lookup)
  └─ TreeRemove → clear checkpoint, schedule reconcile
```

---

## Token Expiry / Re-auth Flow

```
Engine: SDK returns 401
    │
    ▼
Engine → UI: token_expired {queued_changes: N}
    │
    ▼
UI: show session_expired_banner, show ReauthDialog (N queued changes)
    │
    ▼
User clicks Sign In → AuthWindow opens
    │
    ▼
(Same as initial auth flow above)
    │
    ▼
Engine → UI: session_ready
    │
    ▼
UI: close banner, close ReauthDialog, refresh pair status
Engine: SyncEngine.drainQueue() replays all N queued changes
```

---

## Conflict Resolution

When both local and remote files have changed since last sync:

```
detectConflict() returns isConflict: true
    │
    ▼
1. Rename local file → localFile.ext.conflict-YYYY-MM-DD-N
2. Download remote "winning" version to localFile.ext
3. Emit conflict_detected {pair_id, local_path, conflict_copy_path}
    │
    ▼
UI: on_conflict_detected
  ├─ sidebar row → amber dot
  ├─ detail panel → conflict banner
  ├─ footer bar → "N conflicts need attention"
  └─ desktop notification (Gio.Notification)
```

User resolves by deleting the `.conflict-*` copy. UI detects on next `sync_complete`.

---

## Offline Handling

```
NetworkMonitor: TCP probe to 1.1.1.1:443 fails
    │
    ▼
Engine → UI: offline {}
    │
    ▼
UI: all rows → offline state; footer → "Offline"
FileWatcher: continues queueing changes (offline-safe)
SyncEngine.drainQueue(): skips API calls (networkMonitor.isCurrentlyOnline = false)

NetworkMonitor: probe succeeds
    │
    ▼
Engine → UI: online {}
    │
    ▼
UI: restore row states; footer → sync/synced
SyncEngine.drainQueue(): triggered by createNetworkMonitorCallback
```

---

## Error Hierarchy

### Engine (TypeScript)
```
EngineError
  ├─ SyncError      — sync operation failures
  ├─ NetworkError   — network/fetch failures
  ├─ RateLimitError — HTTP 429 (triggers backoff)
  ├─ AuthExpiredError — session token expired
  ├─ IpcError       — IPC framing/parse failures
  └─ ConfigError    — config file / XDG path failures
```

### UI (Python)
```
AppError
  ├─ AuthError         — libsecret / token storage failures
  ├─ IpcError          — engine communication failures
  ├─ ConfigError       — YAML parse failures
  └─ EngineNotFoundError — Bun or engine binary not found
```

---

## Security Properties

- **Token never in logs**: `PROTONDRIVE_DEBUG=1` explicitly excludes tokens from log lines
- **Token flow is one-directional**: libsecret → UI → IPC `token_refresh` → engine `sdk.ts` → SDK; engine never reads libsecret directly
- **Auth server binds localhost only**: `127.0.0.1` ephemeral port, closed after one callback
- **keyPassword stored separately**: bcrypt output (not raw password) stored in libsecret
- **Credentials never in plaintext**: libsecret primary; PBKDF2+Fernet encrypted file as fallback
