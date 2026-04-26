# ProtonDrive Linux Client — Component Inventory

**Last Updated:** 2026-04-26

---

## Engine Components (TypeScript/Bun — `engine/src/`)

### `main.ts` — Orchestrator
Entry point and command dispatcher. Owns module-level singletons.

| Responsibility | Details |
|---------------|---------|
| Process lifecycle | Initializes StateDb, SyncEngine, IpcServer, NetworkMonitor |
| IPC command dispatch | `handleCommand()` routes all incoming commands |
| Session management | `handleTokenRefresh()`, `handleUnlockKeys()`, `_activateSession()` |
| Crash recovery | `runCrashRecovery()` — cleans `.protondrive-tmp-*` on dirty restart |
| DoH workaround | Custom undici Agent + Cloudflare DoH (active inside Flatpak only) |

**Key singletons:** `driveClient`, `stateDb`, `syncEngine`, `fileWatcher`, `networkMonitor`, `server`

---

### `ipc.ts` — IPC Server
Unix socket server; framing protocol: 4-byte big-endian length prefix + UTF-8 JSON.

| Class/Function | Role |
|---------------|------|
| `MessageReader` | Accumulates TCP chunks; emits complete messages |
| `IpcServer` | Manages single active connection; routes commands; emits push events |
| `encodeMessage()` | Serializes message to wire frame |
| `resolveSocketPath()` | `$XDG_RUNTIME_DIR/.../sync-engine.sock` |

**Key invariants:**
- Single connection enforced — second connection rejected with `ALREADY_CONNECTED`
- Backpressure via write queue + `'drain'` event (FIFO order preserved)
- `shutdown` command responds by closing socket (no `_result` response)

---

### `sync-engine.ts` — Sync Engine
All sync logic: reconcile, queue drain, conflict detection, remote event subscription.

| Method | Role |
|--------|------|
| `reconcileAndEnqueue()` | Full remote tree walk; builds work list; enqueues to change_queue |
| `drainQueue()` | Processes change_queue entries; applies decision table |
| `processQueueEntry()` | Per-entry: detect conflict, upload/download/trash/resolve |
| `startSyncPair()` | Targeted reconcile for one pair (after `add_pair`) |
| `startSyncAll()` | Calls `drainQueue()` across all pairs |
| `startRemoteEventSubscription()` | Subscribes to SDK event stream |
| `drainEventQueue()` | Processes `event_queue` rows: targeted or full reconcile |
| `withBackoff()` | Exponential backoff on `RateLimitError` (up to 30s, 5 retries) |
| `setDriveClient()` | Swaps auth client on re-auth |

**Decision table (processQueueEntry):**

| sync_state | remote | action |
|-----------|--------|--------|
| undefined | undefined | dequeue (both gone) |
| undefined | defined | download |
| defined | undefined | clear state |
| defined | defined | conflict check → upload/download/conflict copy |

---

### `sdk.ts` — SDK Boundary
**THE ONLY FILE that imports `@protontech/drive-sdk`.** All other engine files import `DriveClient` from here.

| Export | Role |
|--------|------|
| `DriveClient` interface | Narrow pick of SDK methods actually used |
| `createDriveClient()` | Factory; configures SDK with token, HTTP client, crypto proxy |
| `DriveClient.validateSession()` | Returns `AccountInfo` (display_name, email, storage, plan) |
| `DriveClient.applyKeyPassword()` | Silent key unlock from stored keyPassword |
| `DriveClient.deriveAndUnlock()` | bcrypt key derivation from login password + salts |
| `DriveClient.fetchKeySalts()` | Pre-fetches salts in locked-scope window |
| `DriveClient.listRemoteFolders()` | Lazy folder tree (parent_id: null = root) |
| `DriveClient.getRemoteNode()` | Fetch single node by UID; returns `MaybeNode` |
| `DriveClient.uploadFile()` | Upload with atomic tmp rename on server side |
| `DriveClient.downloadFile()` | Download to tmp path, then rename |
| `DriveClient.trashFile()` | Move remote file to trash |
| `ROOT_PARENT_ID` | Sentinel `"<root>"` for top-level folder parent |

**Critical SDK footguns:**
- `MaybeNode` must be checked via `.ok` before accessing `.value`
- `@protontech/drive-sdk` is pre-release; pin exact version (`0.14.3`), never `^`
- openpgp full bundle only — never `openpgp/lightweight`
- `Uint8Array<ArrayBufferLike>` ↔ `Uint8Array<ArrayBuffer>` casts required at boundary

---

### `state-db.ts` — State Database
SQLite via `bun:sqlite`. WAL mode, foreign keys enforced. 8 ordered migrations.

| Table | Purpose |
|-------|---------|
| `sync_pair` | Registered sync pairs (UUID, local path, remote path, remote_id) |
| `sync_state` | Per-file sync record (mtimes, content hash, remote node ID) |
| `change_queue` | Pending local changes (created/modified/deleted + attempt_count) |
| `dead_letter` | Changes that failed MAX_DRAIN_ATTEMPTS times |
| `session_state` | Dirty-session flag (crash detection) |
| `event_checkpoint` | Latest remote event ID per tree scope (incremental reconcile) |
| `event_queue` | Buffered remote SDK events (TreeRefresh, NodeCreated, etc.) |
| `sync_folder` | Known remote subfolder UIDs (for targeted event routing) |

Key atomic operations: `commitUpload()`, `commitTrash()`, `commitDequeue()` — all use `db.transaction()`.

---

### `watcher.ts` — File Watcher
inotify-based change detection via `node:fs.watch`.

| Feature | Details |
|---------|---------|
| Per-directory watches | One watcher per subdirectory (inotify watches directories, not recursive) |
| Parent-dir watch | Detects pair-root rename/delete (inotify fires on parent, not watched inode) |
| Debounce | 1000ms default; coalesces rapid changes |
| Offline-safe | Always enqueues; schedules drain only when `isOnline()` |
| INOTIFY_LIMIT | Emits `error {code: "INOTIFY_LIMIT"}` on `ENOSPC` |
| `local_folder_missing` | Emits when pair root is deleted or renamed |

---

### `network-monitor.ts` — Network Monitor
Periodic TCP probe to `1.1.1.1:443` (3s timeout). Emits `online`/`offline` events on transitions.

| Timing | Details |
|--------|---------|
| Poll when online | 30s interval |
| Poll when offline | 5s interval (faster recovery) |
| `forceCheck()` | Immediate check after a sync network failure |

---

### `conflict.ts` — Conflict Detector
Pure function, zero imports.

```
detectConflict(localMtime, storedLocalMtime, remoteMtime, storedRemoteMtime, storedHash, currentHash)
  → { isConflict, reason }
```

Reasons: `both_changed`, `same_second_hash_mismatch`, `hash_unavailable`

---

### `config.ts` — YAML Config
Read/write `$XDG_CONFIG_HOME/protondrive/config.yaml`. Atomic writes via `.tmp` + `rename()`.

---

### `errors.ts` / `debug-log.ts` — Leaves
Zero internal imports. `errors.ts` defines the error hierarchy. `debug-log.ts` writes to a capped (5 MB, 1 rotation) log file when `PROTONDRIVE_DEBUG=1`.

---

## UI Components (Python/GTK4 — `ui/src/protondrive/`)

### `main.py` — Application (Global State Hub)
`Adw.Application` subclass. Owns all cross-widget state.

| Responsibility | Details |
|---------------|---------|
| Engine event routing | Registers handlers for all engine push events in `do_startup()` |
| Auth completion | `on_auth_completed()` — stores token, sends `token_refresh` |
| Session ready | `_on_session_ready()` — routes to wizard or main window |
| Token expiry | `_on_token_expired()` — shows banner + ReauthDialog |
| Key unlock | `_on_key_unlock_required()` — shows `KeyUnlockDialog` or routes to pre-auth |
| Pair management | `_on_add_pair_complete()`, `_on_remove_pair_confirmed()`, `_on_update_pair_path()` |
| Desktop notification | `_send_conflict_notification()` via `Gio.Notification` |
| Logout | Clears credentials, shuts down engine, restarts engine for re-login |

**One-instance rule:** Application holds a single `Gio.Settings`, single `EngineClient`, single `CredentialManager`.

---

### `engine.py` — EngineClient (IPC Client)
Manages engine process lifecycle and IPC communication.

| Method | Role |
|--------|------|
| `start()` | Spawn engine subprocess via `Gio.SubprocessLauncher` |
| `_attempt_connection()` | Poll socket with exponential backoff (100ms → 2s, 10s total) |
| `_setup_reader()` | `Gio.DataInputStream.read_bytes_async()` read loop (never blocks main loop) |
| `_dispatch_event()` | Routes `_result` → pending callbacks; push events → `_event_handlers` |
| `send_token_refresh()` | Sends `token_refresh` with token + optional key_password/login_password/salts |
| `send_command_with_response()` | UUID correlation; fires callback exactly once (success/timeout/restart) |
| `send_shutdown()` / `restart()` | Graceful shutdown + kill timer; restart resets all state |
| `_clear_pending_responses()` | Cancels timeout sources; notifies waiting callbacks with `engine_restarted` |

**Protocol constraint:** `_result`-suffixed events are reserved for request/response. Push events must never use `_result` suffix.

---

### `window.py` — MainWindow (UI State Machine)
`Adw.ApplicationWindow` with split-view layout. Routes IPC events to widgets.

| State | Trigger | Effect |
|-------|---------|--------|
| Pre-auth | Startup / logout | Show `PreAuthScreen` |
| Auth browser | Sign in clicked | Show `AuthWindow` |
| Setup wizard | session_ready + no pairs | Show `SetupWizard` |
| Main view | session_ready + pairs exist | Show `toast_overlay` (split view) |

**Phase state machine** (per pair): `active` → `paused` → `paused_token` | cleared  
Managed by `on_pair_reconciling()`, `on_reconcile_progress()`, `on_sync_complete()`.

**Footer priority**: Error > Conflict > Conflict-pending > Syncing > Offline > All synced

---

### `auth_window.py` — AuthWindow (WebKitGTK Browser)
Embedded browser for Proton sign-in. Security boundary is the localhost callback server, not URL filtering.

| Feature | Details |
|---------|---------|
| Auth server bind-before-navigate | `AuthCallbackServer.start_async()` called before `webview.load_uri()` |
| JS injection | Captures `login_password` and key salts from Proton's web form |
| Cookie poller | GLib timer polls WebView cookies for `AUTH-*` cookie every 2s |
| Token dedup | Resends same token after 8s (catches scope upgrade after 2FA) |
| Rejected tokens | Set of engine-rejected tokens; cleared on `auth_success` signal |
| WebView teardown | `mark_auth_complete()` → stop cookie poller + WebView cleanup |

---

### `credential_store.py` — CredentialManager
Auto-selects backend: libsecret Secret portal → encrypted file fallback.

| Backend | When Used | Storage |
|---------|-----------|---------|
| `SecretPortalStore` | Preferred; D-Bus probe succeeds | GNOME Keyring via Secret portal |
| `EncryptedFileStore` | Fallback when keyring unavailable | PBKDF2(machine-id + APP_ID) + Fernet |

Stores two secrets: `session-token` and `key-password`. Both use the same schema attributes.

---

### Widgets

| Widget | File | Purpose |
|--------|------|---------|
| `AccountHeaderBar` | `account_header_bar.py` | Account avatar, name, email, storage ring |
| `ActivityFeed` | `activity_feed.py` | Recent `file_synced` event list (live-updating) |
| `AddPairDialog` | `add_pair_dialog.py` | Create new sync pair: local folder picker + remote tree |
| `ConflictLog` | `conflict_log.py` | Full conflict history; reveal-in-files + mark-resolved |
| `KeyUnlockDialog` | `key_unlock_dialog.py` | Password entry for bcrypt key derivation |
| `PairDetailPanel` | `pair_detail_panel.py` | Right panel: pair info, progress, conflict banner, activity feed |
| `ReauthDialog` | `reauth_dialog.py` | "Session expired — N changes queued, sign in to resume" |
| `RemoteFolderPicker` | `remote_folder_picker.py` | Lazy-expanding tree of ProtonDrive remote folders |
| `SettingsPage` | `settings.py` | Account info display + logout button |
| `SetupWizard` | `setup_wizard.py` | First-run: local folder + remote folder → `add_pair` |
| `StatusFooterBar` | `status_footer_bar.py` | App-level status: All synced / Syncing / Offline / Error / Conflict |
| `SyncPairRow` | `sync_pair_row.py` | Sidebar row with state dot (teal/grey/amber/red) |
| `SyncProgressCard` | `sync_progress_card.py` | files_done/files_total progress bar in detail panel |

**Widget isolation rule:** no widget file imports from another widget file. All coordination flows through `window.py`.
