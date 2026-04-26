# ProtonDrive Linux Client — UI Architecture

**Last Updated:** 2026-04-26

Deep dive into the Python/GTK4 UI process. For the overall system, see [Architecture](./architecture.md).

---

## Module Map

```
ui/src/protondrive/
├── __main__.py          ← python -m protondrive entry point
├── main.py              ← Application (Adw.Application) — global state hub
├── window.py            ← MainWindow — split-view layout + event routing
├── engine.py            ← EngineClient — IPC client + engine process lifecycle
├── auth_window.py       ← AuthWindow — embedded WebKitGTK browser + cookie poller
├── auth.py              ← AuthCallbackServer — localhost OAuth callback server
├── pre_auth.py          ← PreAuthScreen — sign-in landing page
├── credential_store.py  ← CredentialManager — libsecret / encrypted-file backends
├── errors.py            ← Error hierarchy (zero internal imports)
└── widgets/
    ├── account_header_bar.py
    ├── activity_feed.py
    ├── add_pair_dialog.py
    ├── conflict_log.py
    ├── key_unlock_dialog.py
    ├── pair_detail_panel.py
    ├── reauth_dialog.py
    ├── remote_folder_picker.py
    ├── settings.py
    ├── setup_wizard.py
    ├── status_footer_bar.py
    ├── sync_pair_row.py
    └── sync_progress_card.py
```

**Widget isolation rule:** No widget file imports from another widget file. All inter-widget coordination flows through `window.py`. Widget files may only import from `main.py` (Application class reference), `engine.py` (for type hints), and `errors.py`.

---

## Application Class (`main.py`)

`Adw.Application` is the global state hub — it holds the single instances of all cross-cutting objects and registers all engine event handlers.

### Singleton Ownership

```python
class Application(Adw.Application):
    self._engine: EngineClient        # IPC client + engine process
    self._credentials: CredentialManager
    self._settings: Gio.Settings      # GSettings (window state)
    self._window: MainWindow | None
```

One-instance rule: the Application object is never recreated during a session. On logout, it shuts down the engine and restarts it — the Application itself stays alive.

### Startup Sequence

```
do_startup()
    │
    ├─ Load CSS (protondrive.css from GResource)
    ├─ Create CredentialManager (probes libsecret, falls back to encrypted file)
    ├─ Create EngineClient
    ├─ Register all engine event handlers (see table below)
    └─ EngineClient.start()
        └─ Engine process spawned → connection attempt loop → 'ready' event

on_activate()
    └─ Create MainWindow → show pre-auth screen
        (window reads stored credentials on first show)
```

### Engine Event Handler Registration

All engine push events are wired in `do_startup()`:

| Push Event | Handler | Effect |
|-----------|---------|--------|
| `ready` | `_on_engine_ready` | Send stored token if available |
| `session_ready` | `_on_session_ready` | Store key_password, route to wizard or main |
| `token_expired` | `_on_token_expired` | Show banner + ReauthDialog |
| `key_unlock_required` | `_on_key_unlock_required` | Show KeyUnlockDialog |
| `pair_reconciling` | forwarded to window | Update pair status |
| `reconcile_progress` | forwarded to window | Update progress bar |
| `sync_complete` | forwarded to window | Update pair status, clear errors |
| `file_synced` | forwarded to window | Update activity feed |
| `conflict_detected` | `_on_conflict_detected` | Desktop notification + update window |
| `rate_limited` | forwarded to window | Show "paused" state |
| `offline` | forwarded to window | All pairs → offline state |
| `online` | forwarded to window | Restore pair states |
| `error` | `_on_engine_error` | Show error banner |
| `local_folder_missing` | forwarded to window | Show missing folder warning |

### Auth Completion

```
on_auth_completed(token, login_password, salts)
    │
    ├─ credentials.store_token(token)
    ├─ Set GSettings flag: wizard-auth-complete = True
    └─ engine.send_token_refresh(token, login_password, salts)
```

### Session Ready

```
_on_session_ready(data)
    │
    ├─ Cancel auth timeout timer (if running)
    ├─ If key_password in data:
    │   └─ credentials.store_key_password(key_password)
    │
    └─ Route:
        ├─ No pairs configured → window.show_setup_wizard()
        └─ Pairs exist → window.show_main_view()
```

### Logout Flow

```
logout()
    │
    ├─ credentials.clear_all()
    ├─ engine.send_shutdown()
    └─ GLib.timeout_add(1000, _restart_engine)
        └─ engine.restart() → new engine process starts
            └─ 'ready' event → send_token_refresh (no token) → pre-auth screen
```

---

## Engine Client (`engine.py`)

Manages the engine subprocess lifecycle and all IPC communication. Never blocks the GTK main loop — all I/O is async via GLib.

### Process Lifecycle

```
EngineClient.start()
    │
    ├─ Determine engine path:
    │   ├─ Flatpak: compiled binary at /app/bin/sync-engine
    │   └─ Dev: [bun, /path/to/engine/src/main.ts]
    │
    ├─ Gio.SubprocessLauncher.spawnv(engine_cmd)
    └─ _attempt_connection()
        ├─ Poll Unix socket with exponential backoff: 100ms → 200ms → 400ms → ... → 2s (10s total)
        └─ On success: _setup_reader() → read loop starts
```

### IPC Read Loop (Never Blocks Main Loop)

```
_setup_reader()
    │
    └─ Gio.DataInputStream.read_bytes_async(4)  ← async read of 4-byte header
           │
           └─ _on_length_received(bytes)
               ├─ Parse big-endian uint32 → payload_length
               ├─ read_bytes_async(payload_length)  ← async read of body
               └─ _on_message_received(bytes)
                   ├─ JSON parse
                   ├─ _dispatch_event(event)
                   └─ read_bytes_async(4)  ← loop: wait for next header
```

### Event Dispatch

```
_dispatch_event(event)
    │
    ├─ If event_type ends with "_result":
    │   ├─ Look up correlation_id in pending_responses dict
    │   ├─ Cancel timeout GLib source
    │   └─ Fire callback(event_data)
    │
    ├─ If event_type == "ready":
    │   └─ _on_engine_ready()
    │
    └─ Else: call registered handler from _event_handlers dict
```

**Protocol invariant:** `_result`-suffixed events are reserved for command responses. Push events must never use the `_result` suffix to avoid accidental collision with pending response callbacks.

### Command / Response Correlation

```python
send_command_with_response(command, data, callback, timeout_s=30)
    │
    ├─ Generate UUID correlation_id
    ├─ Store {correlation_id: (callback, timeout_source)} in pending_responses
    ├─ Write framed JSON: {id: correlation_id, command: ..., **data}
    └─ GLib.timeout_add_seconds(timeout_s, _on_timeout)

_on_timeout():
    └─ Fire callback({"error": "timeout"}) and remove from dict

_clear_pending_responses():  ← called on restart/shutdown
    └─ For each pending: cancel timeout + call callback({"error": "engine_restarted"})
```

### Protocol Version

`SUPPORTED_PROTOCOL_VERSION = 1` — checked against engine's `ready` event. Mismatch → fatal error shown to user.

---

## Main Window (`window.py`)

`Adw.ApplicationWindow` with `Adw.NavigationSplitView` layout. Implements the per-pair phase state machine.

### Window Layout

```
MainWindow (Adw.ApplicationWindow)
├── PreAuthScreen          ← shown before login
│
└── [After login]
    ├── AccountHeaderBar   ← top bar (avatar, name, email, storage)
    ├── Adw.NavigationSplitView
    │   ├── [Sidebar] List of SyncPairRow widgets
    │   └── [Detail]  PairDetailPanel (for selected pair)
    │       ├── SyncProgressCard
    │       ├── ActivityFeed
    │       └── ConflictLog (shown when conflicts exist)
    └── StatusFooterBar    ← bottom bar (overall status)
```

### Phase State Machine (per pair)

Each sync pair has an independent phase tracked in `_pair_phase: dict[str, str]`.

```
States: active | paused | paused_token

Transitions:
    pair_reconciling received  → active (start 30s watchdog timer)
    reconcile_progress received → active (reset watchdog timer)
    sync_complete received     → cleared from _pair_phase
    rate_limited received      → paused
    token_expired received     → all pairs → paused_token

Watchdog: if no reconcile_progress for 30s → treat as sync_complete
    └─ Prevents stuck "syncing" state on engine errors

SyncPairRow dot colors:
    active       → teal  (syncing)
    paused       → amber (rate limited)
    paused_token → amber (auth expired)
    (none)       → teal  (synced) or grey (offline)
    error        → red
    missing      → red
```

### Footer Priority

`StatusFooterBar` shows exactly one status at a time. Priority (highest first):

```
1. Error          — at least one pair has a permanent error
2. Conflict       — unresolved conflict copies exist
3. Conflict-pending — conflict_detected received but sync not yet complete
4. Syncing        — at least one pair in active phase
5. Offline        — network offline
6. All synced     — everything idle and up to date
```

### Conflict Copy Tracking

```python
_conflict_copies_by_pair: dict[str, set[str]]   # pair_id → set of conflict copy paths
_conflict_log_entries: list[ConflictEntry]       # global conflict history

on_conflict_detected(pair_id, local_path, conflict_copy_path):
    ├─ Add conflict_copy_path to _conflict_copies_by_pair[pair_id]
    ├─ Append to _conflict_log_entries
    ├─ SyncPairRow → amber dot
    ├─ PairDetailPanel → conflict banner
    └─ StatusFooterBar → "N conflicts need attention"

on_sync_complete(pair_id, ...):
    └─ _scan_for_resolved_conflicts(pair_id)
        ├─ Walk local pair path for .conflict-* files
        ├─ Compare against _conflict_copies_by_pair[pair_id]
        └─ If a conflict copy is gone: remove from tracking, update UI
```

---

## Auth Window (`auth_window.py`)

Embedded WebKitGTK browser for Proton sign-in. The security boundary is the **localhost callback server**, not URL filtering.

### Auth Flow

```
User clicks Sign In
    │
    ├─ AuthCallbackServer.start_async()    ← MUST bind before navigate
    ├─ AuthWindow created + webview.load_uri(proton_login_url)
    │
    ├─ JS injection on page load:
    │   ├─ Capture login_password from password input (before hash)
    │   └─ Capture key salts from Proton's web form data
    │
    ├─ Cookie poller (2s GLib timer):
    │   └─ Check WebView cookie jar for AUTH-* cookie
    │       └─ If found: extract token, call _on_token_captured(token)
    │
    └─ _on_token_captured(token):
        ├─ Skip if token in _rejected_tokens set
        ├─ Send to engine via Application.on_auth_completed()
        │
        └─ Token dedup: if same token after 8s → resend
               └─ Catches scope upgrade after 2FA completion
```

### Security Notes

- Auth server binds `127.0.0.1` only (ephemeral port), closed after one successful callback
- `_rejected_tokens` prevents replay of tokens that the engine already rejected (invalid/expired before we processed them)
- JS injection runs only on `accounts.proton.me` pages — enforced by WebKit navigation policy
- `mark_auth_complete()` stops cookie poller and tears down WebView to prevent resource leaks

---

## Credential Store (`credential_store.py`)

Auto-selects backend at instantiation. Falls back gracefully.

### Backend Selection

```
CredentialManager.__init__()
    │
    ├─ Try SecretPortalStore:
    │   └─ D-Bus probe: org.freedesktop.secrets accessible?
    │       ├─ Yes → use SecretPortalStore
    │       └─ No → try EncryptedFileStore
    │
    ├─ Try EncryptedFileStore:
    │   └─ /etc/machine-id readable?
    │       ├─ Yes → use EncryptedFileStore
    │       └─ No → raise AuthError("no credential backend available")
    │
    └─ Store backend reference
```

### SecretPortalStore

Wraps GNOME Keyring via the freedesktop Secret portal. Schema attributes used for lookup:

```python
schema_attributes = {
    "application": APP_ID,   # io.github.ronki2304.ProtonDriveLinuxClient
    "secret_type": "..."     # "session-token" or "key-password"
}
```

### EncryptedFileStore

Used when keyring is unavailable (e.g., headless or non-GNOME desktops).

```
_derive_key(machine_id):
    salt = os.urandom(16)   ← unique per credential file
    key_material = pbkdf2_hmac(
        "sha256",
        (machine_id + APP_ID).encode(),
        salt,
        iterations=600_000   ← OWASP minimum for SHA-256
    )
    return base64url(key_material)  → Fernet key

Storage format: {salt_hex}:{fernet_token}
File permissions: 0o600 (owner read/write only)
Atomic write: tmp file → fsync → rename
```

---

## Error Hierarchy

```python
AppError (base)
  ├─ AuthError         — libsecret unavailable, token storage failures
  ├─ IpcError          — engine process not found, socket connection failures
  ├─ ConfigError       — YAML parse failures
  └─ EngineNotFoundError — Bun binary or engine source not found at expected path
```

---

## GSettings Schema

GSettings key used for session persistence across restarts:

| Key | Type | Purpose |
|-----|------|---------|
| `wizard-auth-complete` | boolean | First-run wizard: skip if already completed |
| `window-width` | int | Saved window width |
| `window-height` | int | Saved window height |
| `window-maximized` | boolean | Saved maximize state |

Schema ID: `io.github.ronki2304.ProtonDriveLinuxClient`
